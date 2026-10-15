import {
  YEAR,
  type Drainage,
  type Grid,
  type Lake,
  type LakeSalinity,
  type LandWater,
  type Terrain,
  type WorldConfig,
} from '../model';
import { computeCornerSupport } from '../operators/corner-fields';
import { nearestCell } from '../grid/build';

/** Generic evaporite saturation proxy, not a mineral-specific chemistry model. */
export const SALT_SATURATION = 260;

export interface LakeSaltForcing {
  years: number;
  inputSaltRate: number; // kg/s, averaged over the assigned interval
  initialSaltMass: number; // kg, liquid plus precipitated salt
}

export interface LakeSaltBalance extends LakeSalinity {
  initialSalt: number;
  inputSalt: number;
  exportedSalt: number;
}

const positive = (value: number) => (Number.isFinite(value) ? Math.max(0, value) : 0);

/** Water utility only; salinity does not change the climatic biome. */
export function salinityFreshwaterSuitability(concentration: number): number {
  return Math.exp(-Math.max(0, positive(concentration) - 0.5) / 3);
}

export function salinityClass(
  concentration: number,
): 'freshwater' | 'brackish' | 'saline' | 'hypersaline' {
  return concentration < 0.5
    ? 'freshwater'
    : concentration < 5
      ? 'brackish'
      : concentration < 50
        ? 'saline'
        : 'hypersaline';
}

/** Exact bounded-work solution for one representative annual mixed reservoir.
 * dM/dt = salt input - outflow * min(M / water storage, saturation).
 * Evaporation has already reduced water storage/outflow in the water budget: it
 * never removes salt here. Excess salt resides on the bed and redissolves before
 * concentration falls below saturation. Years are physical scenario time, never
 * reservoir initialization iterations. This does not reconstruct seasonal chemistry.
 */
export function solveLakeSalt(
  lake: Pick<Lake, 'storage' | 'outflow'>,
  forcing: LakeSaltForcing,
): LakeSaltBalance {
  const initial = positive(forcing.initialSaltMass);
  const rate = positive(forcing.inputSaltRate);
  const years = positive(forcing.years);
  const duration = years * YEAR;
  const volume = positive(lake.storage);
  const flow = positive(lake.outflow);
  const capacity = volume * SALT_SATURATION;
  const saturatedExport = flow * SALT_SATURATION;
  let remaining = duration;
  let mass = initial;

  if (volume <= 0 || flow <= 0) {
    mass += rate * remaining;
  } else {
    // First dissolve any precipitated bed inventory while exporting saturated water.
    if (mass > capacity) {
      const loss = saturatedExport - rate;
      const time = loss > 0 ? Math.min(remaining, (mass - capacity) / loss) : remaining;
      mass += (rate - saturatedExport) * time;
      remaining -= time;
    }
    if (remaining > 0) {
      const equilibrium = (rate * volume) / flow;
      if (mass >= capacity && rate >= saturatedExport) {
        mass += (rate - saturatedExport) * remaining;
      } else {
        const decay = flow / volume;
        // Unsaturated concentration approaches input / outflow exponentially.
        // When that equilibrium exceeds solubility, stop exactly at saturation.
        const toSaturation =
          equilibrium > capacity
            ? Math.log1p((capacity - mass) / (equilibrium - capacity)) / decay
            : Infinity;
        const time = Math.min(remaining, Math.max(0, toSaturation));
        mass += (equilibrium - mass) * -Math.expm1(-decay * time);
        remaining -= time;
        if (remaining > 0) {
          mass = capacity + (rate - saturatedExport) * remaining;
        }
      }
    }
  }
  const inputSalt = rate * duration;
  mass = Math.max(0, Math.min(initial + inputSalt, mass));
  const dissolvedSalt = Math.min(mass, capacity);
  const concentration = volume > 0 ? dissolvedSalt / volume : 0;
  return {
    initialSalt: initial,
    inputSalt,
    exportedSalt: Math.max(0, initial + inputSalt - mass),
    dissolvedSalt,
    bedSalt: Math.max(0, mass - dissolvedSalt),
    concentration,
    inflowSalt: rate,
    outflowSalt: concentration * flow,
    elapsedYears: years,
  };
}

export interface SalinityOptions {
  /** Omitted: initialize a new world for config.salinityYears, or reconcile an
   * existing geographic inventory at zero time. Only explicit evolution advances it. */
  advanceYears?: number;
}

/** Initialize or reconcile salt after the final water/mesh solve.
 *
 * Sparse geographic parcels are authoritative, so lake IDs may split, merge or
 * vanish. Source positions never move during a zero-time remesh. Unlike a single
 * cell aggregate, parcels retain separate ownership for lakes sharing a coarse
 * cell. Sampling new lake support at each original point cannot create chemistry
 * detail finer than the original parcel distribution.
 * A virtual-lake DAG follows the finalized shoreline routing, not flood-order rank.
 * During initialization, upstream *interval-average* exported salt feeds downstream
 * budgets; this conserves mass without simulating centuries. Contemporary channels
 * separately use the final outlet concentrations. Transient arrival times between
 * lakes and seasonal salt fluctuations are intentionally not reconstructed.
 */
export function solveSalinity(
  grid: Grid,
  terrain: Terrain,
  water: LandWater,
  drainage: Drainage,
  config: WorldConfig,
  options: SalinityOptions = {},
): void {
  const existing = terrain.saltMass;
  if (existing && existing.length !== grid.count) {
    throw Error('Salt inventory must be conservatively remapped before solving a new mesh.');
  }
  const originalParcels = terrain.saltParcels;
  let parcels = originalParcels;
  if (!parcels && existing) {
    const cells = Array.from(existing.keys()).filter((cell) => existing[cell] > 0);
    parcels = {
      positions: Float64Array.from(
        cells.flatMap((cell) => Array.from(grid.positions.subarray(cell * 3, cell * 3 + 3))),
      ),
      masses: Float64Array.from(cells, (cell) => existing[cell]),
    };
  }
  const initialized = !!existing || !!parcels;
  const years = positive(options.advanceYears ?? (initialized ? 0 : config.salinityYears));
  const age = positive(terrain.saltAgeYears ?? 0) + years;
  const duration = years * YEAR;
  const weathering = positive(config.weatheringSalinity);
  const support = computeCornerSupport(grid);
  const corners = drainage.receiver.length;
  const size = corners + drainage.lakes.length;
  const next = new Int32Array(size).fill(-1);
  const incoming = new Uint32Array(size);
  const queue = new Uint32Array(size);
  const historyRate = new Float64Array(size);
  const currentRate = new Float64Array(size);
  const initialLakeMass = new Float64Array(drainage.lakes.length);
  const lakeMass = new Float64Array(drainage.lakes.length);
  const lakeWeights = new Float64Array(drainage.lakes.length);
  const inventory = new Float64Array(grid.count);
  let initialSalt = 0;
  let weatheringRate = 0;

  const footprintWeight = (corner: number, lake: Lake): number =>
    lake.area > 0
      ? drainage.lakeFraction[corner] * Math.max(0.01, lake.level - drainage.height[corner])
      : Math.max(0.01, lake.spill - drainage.height[corner]);

  const parcelCells = new Uint32Array(parcels?.masses.length ?? 0);
  const parcelLakes = new Int32Array(parcelCells.length).fill(-1);
  let previousCell = 0;
  for (let parcel = 0; parcel < parcelCells.length; parcel++) {
    const x = parcels!.positions[parcel * 3];
    const y = parcels!.positions[parcel * 3 + 1];
    const z = parcels!.positions[parcel * 3 + 2];
    const cell = nearestCell(grid, x, y, z, previousCell);
    previousCell = cell;
    parcelCells[parcel] = cell;
    let corner = grid.cellCorners[grid.offsets[cell]];
    let bestDistance = Infinity;
    for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
      const candidate = grid.cellCorners[offset];
      const distance =
        (grid.corners[candidate * 3] - x) ** 2 +
        (grid.corners[candidate * 3 + 1] - y) ** 2 +
        (grid.corners[candidate * 3 + 2] - z) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        corner = candidate;
      }
    }
    const lake = terrain.ocean[cell] ? undefined : drainage.lakes[drainage.lakeId[corner]];
    const salt = positive(parcels!.masses[parcel]);
    initialSalt += salt;
    if (lake) {
      parcelLakes[parcel] = lake.id;
      initialLakeMass[lake.id] += salt;
    }
  }

  for (let cell = 0; cell < grid.count; cell++) {
    // Salt enters from exposed catchment runoff. Direct rain adds fresh water;
    // water displaced by a lake footprint must not manufacture extra weathering.
    const localRate = terrain.ocean[cell]
      ? 0
      : positive(water.runoff[cell]) * Math.max(0, 1 - drainage.lakeCoverage[cell]) * weathering;
    weatheringRate += localRate;
    for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
      const corner = grid.cellCorners[offset];
      const fraction = support.cellCornerFraction[offset];
      historyRate[corner] += localRate * fraction;
      currentRate[corner] += localRate * fraction;
      const lake = drainage.lakes[drainage.lakeId[corner]];
      if (lake && !terrain.ocean[cell]) {
        lakeWeights[lake.id] += support.cellCornerArea[offset] * footprintWeight(corner, lake);
      }
    }
  }
  if (!initialized) {
    for (const lake of drainage.lakes) {
      const seed = positive(config.inheritedMarineSalinity) * positive(lake.storage);
      initialLakeMass[lake.id] += seed;
      initialSalt += seed;
    }
  }

  for (let corner = 0; corner < corners; corner++) {
    const lakeId = drainage.lakeId[corner];
    next[corner] =
      lakeId >= 0 && (drainage.lakeFraction[corner] > 0 || drainage.receiver[corner] < 0)
        ? corners + lakeId
        : drainage.receiver[corner];
  }
  for (const lake of drainage.lakes) {
    if (lake.outflow > 0) {
      next[corners + lake.id] = lake.outlet;
    }
  }
  for (const target of next) {
    if (target >= 0) {
      incoming[target]++;
    }
  }
  let head = 0;
  let tail = 0;
  for (let node = 0; node < size; node++) {
    if (!incoming[node]) {
      queue[tail++] = node;
    }
  }
  let exportedSalt = 0;
  const channel = new Float32Array(corners);
  while (head < tail) {
    const node = queue[head++];
    const target = next[node];
    if (node >= corners) {
      const lake = drainage.lakes[node - corners];
      const result = solveLakeSalt(lake, {
        years,
        initialSaltMass: initialLakeMass[lake.id],
        inputSaltRate: historyRate[node],
      });
      lakeMass[lake.id] = result.dissolvedSalt + result.bedSalt;
      lake.salinity = {
        dissolvedSalt: result.dissolvedSalt,
        bedSalt: result.bedSalt,
        concentration: result.concentration,
        inflowSalt: currentRate[node],
        outflowSalt: result.outflowSalt,
        elapsedYears: age,
      };
      historyRate[node] = duration > 0 ? result.exportedSalt / duration : result.outflowSalt;
      currentRate[node] = result.outflowSalt;
    } else {
      channel[node] =
        drainage.discharge[node] > 0 ? currentRate[node] / drainage.discharge[node] : 0;
    }
    if (target >= 0) {
      historyRate[target] += historyRate[node];
      currentRate[target] += currentRate[node];
      if (--incoming[target] === 0) {
        queue[tail++] = target;
      }
    } else {
      // Terminal runoff or direct lake spill leaves the land network. Closed
      // reservoirs export zero because their integrated export is zero.
      exportedSalt += historyRate[node] * duration;
    }
  }
  if (tail !== size) {
    throw Error('Salt routing contains a cycle.');
  }

  // Reconciliation never relocates a source support, so an untouched pair of
  // lakes cannot exchange mass merely because their symbols occupy the same cell.
  const newPositions: number[] = [];
  const newMasses: number[] = [];
  let retainedParcels = parcels;
  if (parcels && years > 0) {
    const masses = new Float64Array(parcels.masses);
    for (let parcel = 0; parcel < masses.length; parcel++) {
      const id = parcelLakes[parcel];
      if (id >= 0 && initialLakeMass[id] > 0) {
        masses[parcel] *= lakeMass[id] / initialLakeMass[id];
      }
    }
    retainedParcels = { positions: parcels.positions, masses };
  }
  for (let corner = 0; corner < corners; corner++) {
    const lake = drainage.lakes[drainage.lakeId[corner]];
    if (!lake || lakeMass[lake.id] <= 0 || (parcels && initialLakeMass[lake.id] > 0)) {
      continue;
    }
    // Original corner support is owned by exactly one reservoir. Positions stay
    // fixed when later subdivisions create new cell/corner IDs around this point.
    let geographicArea = 0;
    for (let incident = 0; incident < 3; incident++) {
      if (!terrain.ocean[grid.triangles[corner * 3 + incident]]) {
        geographicArea += support.cornerCellArea[corner * 3 + incident];
      }
    }
    const weight = geographicArea * footprintWeight(corner, lake);
    if (weight <= 0 || lakeWeights[lake.id] <= 0) {
      continue;
    }
    newPositions.push(
      grid.corners[corner * 3],
      grid.corners[corner * 3 + 1],
      grid.corners[corner * 3 + 2],
    );
    newMasses.push((lakeMass[lake.id] * weight) / lakeWeights[lake.id]);
  }
  for (const lake of drainage.lakes) {
    if (
      lakeMass[lake.id] <= 0 ||
      lakeWeights[lake.id] > 0 ||
      (parcels && initialLakeMass[lake.id] > 0)
    ) {
      continue;
    }
    const corner = drainage.lakeId.findIndex((id) => id === lake.id);
    if (corner < 0) {
      throw Error('Salt-bearing lake has no geographic support.');
    }
    newPositions.push(
      grid.corners[corner * 3],
      grid.corners[corner * 3 + 1],
      grid.corners[corner * 3 + 2],
    );
    newMasses.push(lakeMass[lake.id]);
  }
  if (newMasses.length > 0 || !retainedParcels) {
    const before = retainedParcels?.masses.length ?? 0;
    const positions = new Float64Array(before * 3 + newPositions.length);
    const masses = new Float64Array(before + newMasses.length);
    if (retainedParcels) {
      positions.set(retainedParcels.positions);
      masses.set(retainedParcels.masses);
    }
    positions.set(newPositions, before * 3);
    masses.set(newMasses, before);
    retainedParcels = { positions, masses };
  }
  // Project only for the inspector/ecology cache. The sparse parcel ledger remains
  // independent of cell resolution and is never replaced by this lossy projection.
  previousCell = 0;
  for (let parcel = 0; parcel < retainedParcels.masses.length; parcel++) {
    const x = retainedParcels.positions[parcel * 3];
    const y = retainedParcels.positions[parcel * 3 + 1];
    const z = retainedParcels.positions[parcel * 3 + 2];
    const cell = nearestCell(grid, x, y, z, previousCell);
    previousCell = cell;
    inventory[cell] += retainedParcels.masses[parcel];
  }
  terrain.saltParcels = retainedParcels;
  // The geometric spill anchor is drawn as the lake's outgoing channel although
  // its incoming tributary is consumed by the virtual reservoir during routing.
  for (let corner = 0; corner < corners; corner++) {
    const lake = drainage.lakes[drainage.lakeId[corner]];
    if (
      lake &&
      lake.outflow > 0 &&
      drainage.receiver[corner] === lake.outlet &&
      drainage.lakeId[lake.outlet] !== lake.id
    ) {
      channel[corner] = lake.salinity!.concentration;
    }
  }

  const soil = new Float32Array(grid.count);
  const affected = new Float32Array(grid.count);
  const soilDepth = Math.max(0.05, positive(config.soilCapacity) * 0.001 * 0.35);
  const radiusSquared = config.radius ** 2;
  for (let cell = 0; cell < grid.count; cell++) {
    if (terrain.ocean[cell]) {
      continue;
    }
    const coverage = Math.min(1, Math.max(0, drainage.lakeCoverage[cell]));
    const exposed = 1 - coverage;
    if (exposed <= 0) {
      continue;
    }
    let wetLakeShare = 0;
    let wetConcentration = 0;
    let dryLakeShare = 0;
    for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
      const lake = drainage.lakes[drainage.lakeId[grid.cellCorners[offset]]];
      if (!lake) {
        continue;
      }
      const fraction = support.cellCornerFraction[offset];
      if (lake.area > 0) {
        wetLakeShare += fraction;
        wetConcentration += lake.salinity!.concentration * fraction;
      } else if (lake.salinity!.bedSalt > 0) {
        dryLakeShare += fraction;
      }
    }
    const cellArea = grid.areas[cell] * radiusSquared;
    let low = coverage;
    let high = coverage;
    for (const field of drainage.seasonalLakeCoverage ?? []) {
      low = Math.min(low, field[cell]);
      high = Math.max(high, field[cell]);
    }
    // A 300 m shore fringe plus recorded seasonal drawdown keeps saline damage
    // local. It does not turn all land sharing a coarse lake cell into salt soil.
    const fringe = Math.min(exposed, coverage) * Math.min(1, 1200 / Math.sqrt(cellArea));
    const shoreFraction = Math.min(exposed, Math.max(0, high - low) + fringe);
    const shoreConcentration = wetLakeShare > 0 ? wetConcentration / wetLakeShare : 0;
    const dryFraction =
      inventory[cell] > 0 && wetLakeShare === 0
        ? exposed
        : Math.min(exposed - shoreFraction, dryLakeShare);
    const dryConcentration =
      dryFraction > 0
        ? Math.min(
            SALT_SATURATION,
            inventory[cell] / Math.max(1, cellArea * dryFraction * soilDepth),
          )
        : 0;
    const fraction = Math.min(exposed, shoreFraction + dryFraction);
    if (fraction > 0) {
      soil[cell] = (shoreConcentration * shoreFraction + dryConcentration * dryFraction) / fraction;
      affected[cell] = fraction;
    }
  }
  let retainedSalt = 0;
  for (const mass of inventory) {
    retainedSalt += mass;
  }
  terrain.saltMass = inventory;
  terrain.saltAgeYears = age;
  drainage.riverSalinity = channel;
  drainage.soilSalinity = soil;
  drainage.soilSalinityFraction = affected;
  drainage.salinityBudget = {
    initialSalt,
    weatheringSalt: weatheringRate * duration,
    exportedSalt,
    retainedSalt,
    residual: initialSalt + weatheringRate * duration - exportedSalt - retainedSalt,
    elapsedYears: years,
  };
}
