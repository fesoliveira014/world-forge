import type {
  Geology,
  Grid,
  HotspotSource,
  VolcanicConstructionSource,
  WorldConfig,
} from '../model';
import { clamp, normalizeVector, readVector } from '../math';
import { nearestCell } from '../grid/build';
import { createScalarSampler } from '../operators/scalar-sampling';
import { hotspotRateAt } from './volcanism';

/** These compact provinces summarize emplacement already integrated by evolveCrust.
 * Repeated activity merges by fault seed or hotspot/plate; it does not retain a
 * record for every destination cell or geological time step.
 */
export function createVolcanicSourceRecorder(grid: Grid, config: WorldConfig) {
  const records = new Map<string, { source: VolcanicConstructionSource; cell: number }>();
  const faultVolume = new Float64Array(grid.count);

  const add = (
    key: string,
    position: [number, number, number],
    plate: number,
    radius: number,
    volume: number,
  ) => {
    if (!(volume > 0)) {
      return;
    }

    const previous = records.get(key);

    if (!previous || previous.source.plate !== plate) {
      records.set(key, {
        source: { position, plate, radius, volume, age: 0 },
        cell: nearestCell(grid, ...position),
      });
      return;
    }

    const source = previous.source;
    const total = source.volume + volume;
    const fraction = volume / total;
    const separation =
      Math.acos(
        clamp(
          position.reduce((sum, value, axis) => sum + value * source.position[axis], 0),
          -1,
          1,
        ),
      ) * config.radius;
    // Retain the second moment of the transported province instead of growing a
    // new marker each step. It broadens a moving track without inventing volume.
    source.radius = Math.sqrt(
      (1 - fraction) * source.radius ** 2 +
        fraction * radius ** 2 +
        fraction * (1 - fraction) * separation ** 2,
    );
    source.position = normalizeVector(
      position.map((value, axis) => source.position[axis] * (1 - fraction) + value * fraction),
    );
    source.age *= 1 - fraction;
    source.volume = total;
    previous.cell = nearestCell(grid, ...source.position, previous.cell);
  };

  return {
    advect(inverseIncrement: Float64Array, owners: Uint16Array, timeStep: number) {
      const decay = Math.exp(-timeStep / 220);

      for (const [key, record] of records) {
        const source = record.source;
        const offset = source.plate * 9;
        const [x, y, z] = source.position;
        // The transpose of the existing inverse step rotates deposits forward.
        source.position = normalizeVector([
          inverseIncrement[offset] * x +
            inverseIncrement[offset + 3] * y +
            inverseIncrement[offset + 6] * z,
          inverseIncrement[offset + 1] * x +
            inverseIncrement[offset + 4] * y +
            inverseIncrement[offset + 7] * z,
          inverseIncrement[offset + 2] * x +
            inverseIncrement[offset + 5] * y +
            inverseIncrement[offset + 8] * z,
        ]);
        record.cell = nearestCell(grid, ...source.position, record.cell);

        if (owners[record.cell] !== source.plate) {
          records.delete(key);
          continue;
        }

        source.volume *= decay;
        source.age += timeStep;
      }
    },
    record(
      owners: Uint16Array,
      faultOrigins: Int32Array,
      hotspots: HotspotSource[],
      elapsed: number,
      previous: Float32Array,
      constructed: Float32Array,
      rates: Float32Array,
    ) {
      faultVolume.fill(0);
      const active = hotspots
        .map((source, index) => ({ source, index }))
        .filter(({ source }) => elapsed >= source.start && elapsed <= source.end);
      const hotspotVolume = new Float64Array(active.length);
      const hotspotPlate = active.map(
        ({ source }) => owners[nearestCell(grid, ...source.position)],
      );

      for (let cell = 0; cell < grid.count; cell++) {
        if (!(rates[cell] > 0)) {
          continue;
        }

        const addedVolume =
          Math.max(0, constructed[cell] - previous[cell]) * grid.areas[cell] * config.radius ** 2;
        let hotspotRate = 0;

        for (let sourceIndex = 0; sourceIndex < active.length; sourceIndex++) {
          const contribution =
            hotspotRateAt(
              active[sourceIndex].source,
              ...readVector(grid.positions, cell),
              config.radius,
            ) * config.volcanicActivity;
          hotspotRate += contribution;

          if (owners[cell] === hotspotPlate[sourceIndex]) {
            hotspotVolume[sourceIndex] += addedVolume * Math.min(1, contribution / rates[cell]);
          }
        }

        const origin = faultOrigins[cell];

        if (origin >= 0) {
          faultVolume[origin] += addedVolume * clamp(1 - hotspotRate / rates[cell]);
        }
      }

      for (let cell = 0; cell < grid.count; cell++) {
        if (faultVolume[cell] > 0) {
          add(
            `fault/${cell}`,
            readVector(grid.positions, cell),
            owners[cell],
            45000 * config.tectonicWidth,
            faultVolume[cell],
          );
        }
      }

      for (let sourceIndex = 0; sourceIndex < active.length; sourceIndex++) {
        const { source, index } = active[sourceIndex];
        const plate = hotspotPlate[sourceIndex];
        add(
          `hotspot/${index}/${plate}`,
          [...source.position],
          plate,
          source.radius * 0.4,
          hotspotVolume[sourceIndex],
        );
      }
    },
    sources(): VolcanicConstructionSource[] {
      return [...records.values()].map(({ source }) => source);
    },
  };
}

export interface VolcanicDetail {
  height: Float32Array;
  assignedVolume: number;
  depositedVolume: number;
  fineVolume: number;
}

/** Redistribute the already-resolved volcanic inventory into physical edifices.
 * This field replaces broad volcanic height. Every kernel is area-normalized;
 * unresolved or height-limited volume remains in the broad component.
 */
export function buildVolcanicDetail(
  grid: Grid,
  processGrid: Grid,
  geology: Geology,
  config: WorldConfig,
): VolcanicDetail {
  const height = new Float32Array(grid.count);
  const crust = geology.crust;

  if (!crust || config.volcanicActivity <= 0) {
    return { height, assignedVolume: 0, depositedVolume: 0, fineVolume: 0 };
  }

  const radius2 = config.radius ** 2;
  let assignedVolume = 0;

  for (let cell = 0; cell < processGrid.count; cell++) {
    assignedVolume += Math.max(0, crust.volcanic[cell]) * processGrid.areas[cell] * radius2;
  }

  if (!(assignedVolume > 0)) {
    return { height, assignedVolume: 0, depositedVolume: 0, fineVolume: 0 };
  }

  const sampleBroad = createScalarSampler(processGrid, crust.volcanic);
  const broad = new Float64Array(grid.count);
  let broadVolume = 0;

  for (let cell = 0; cell < grid.count; cell++) {
    broad[cell] = Math.max(0, sampleBroad(...readVector(grid.positions, cell)));
    broadVolume += broad[cell] * grid.areas[cell] * radius2;
  }

  if (!(broadVolume > 0)) {
    // A surface coarser than the process mesh can miss an entire narrow province
    // at its centers. Preserve that unresolved inventory in its receiving cells.
    let receivingCell = 0;

    for (let cell = 0; cell < processGrid.count; cell++) {
      if (!(crust.volcanic[cell] > 0)) {
        continue;
      }

      receivingCell = nearestCell(grid, ...readVector(processGrid.positions, cell), receivingCell);
      broad[receivingCell] +=
        (crust.volcanic[cell] * processGrid.areas[cell]) / grid.areas[receivingCell];
    }

    broadVolume = assignedVolume;
  }

  const sources = (crust.volcanicSources ?? []).filter(
    (source) => source.volume > 0 && source.radius > 0,
  );
  const sourceVolume = sources.reduce((sum, source) => sum + source.volume, 0);
  const detailBudget = Math.min(assignedVolume * 0.35, sourceVolume);
  const fine = new Float64Array(grid.count);
  const visited = new Uint32Array(grid.count);
  let generation = 0;

  for (const source of sources) {
    generation++;
    const center = nearestCell(grid, ...source.position);
    const cosineAtCell = source.position.reduce(
      (sum, value, axis) => sum + value * grid.positions[center * 3 + axis],
      0,
    );
    // A subcell edifice is still represented by a cell average until insertion
    // resolves its physical radius. No assigned volume disappears between sites.
    const radius = Math.max(
      source.radius,
      Math.acos(clamp(cosineAtCell, -1, 1)) * config.radius * 1.001,
      Math.sqrt(grid.areas[center] / Math.PI) * config.radius * 1.5,
    );
    const cells = [center];
    const weights: number[] = [];
    visited[center] = generation;
    let normalization = 0;

    for (let head = 0; head < cells.length; head++) {
      const cell = cells[head];
      const cosine = source.position.reduce(
        (sum, value, axis) => sum + value * grid.positions[cell * 3 + axis],
        0,
      );
      const distance = Math.acos(clamp(cosine, -1, 1)) * config.radius;
      const kernel = Math.max(0, 1 - (distance / radius) ** 2) ** 2;
      weights.push(kernel);
      normalization += kernel * grid.areas[cell] * radius2;

      for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
        const neighbor = grid.neighbors[offset];

        if (visited[neighbor] === generation) {
          continue;
        }

        visited[neighbor] = generation;
        const neighborCosine = source.position.reduce(
          (sum, value, axis) => sum + value * grid.positions[neighbor * 3 + axis],
          0,
        );

        if (Math.acos(clamp(neighborCosine, -1, 1)) * config.radius < radius) {
          cells.push(neighbor);
        }
      }
    }

    if (!(normalization > 0)) {
      continue;
    }

    const allocated = (detailBudget * source.volume) / sourceVolume;
    const amplitude = Math.min(6000, allocated / normalization);

    for (let index = 0; index < cells.length; index++) {
      fine[cells[index]] += amplitude * weights[index];
    }
  }

  let fineVolume = 0;

  for (let cell = 0; cell < grid.count; cell++) {
    fine[cell] = Math.min(10000, fine[cell]);
    fineVolume += fine[cell] * grid.areas[cell] * radius2;
  }

  const broadScale = broadVolume > 0 ? Math.max(0, assignedVolume - fineVolume) / broadVolume : 0;
  let depositedVolume = 0;

  for (let cell = 0; cell < grid.count; cell++) {
    height[cell] = broad[cell] * broadScale + fine[cell];
    depositedVolume += height[cell] * grid.areas[cell] * radius2;
  }

  return { height, assignedVolume, depositedVolume, fineVolume };
}
