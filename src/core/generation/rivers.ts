import {
  type Drainage,
  type Grid,
  type LandWater,
  type Rivers,
  type Terrain,
  type WorldConfig,
} from '../model';
import { clamp } from '../math';
import { computeCornerSupport } from '../operators/corner-fields';

export const RIVER_SOURCES = [
  'None',
  'Rainfall runoff',
  'Snowmelt',
  'Spring / baseflow',
  'Lake release',
  'Wetland headwaters',
  'Mixed supply',
];

export const RIVER_REGIMES = ['None', 'Perennial potential', 'Seasonal', 'Intermittent potential'];

export function flowRegime(seasons: number[]): number {
  const mean = seasons.reduce((totalFraction, fraction) => totalFraction + fraction, 0) / 4;

  if (mean <= 0) {
    return 0;
  }

  const minimum = Math.min(...seasons);

  return minimum < mean * 0.05
    ? 3
    : minimum < mean * 0.3 || Math.max(...seasons) > mean * 2
      ? 2
      : 1;
}

/** All runoff is routed, but only supported headwaters start visible channels.
 * Collapse wet reservoir members temporarily so catchments and supply cross real spills.
 * A single topological pass handles even deep lake chains without recursion.
 */
export function selectRivers(
  grid: Grid,
  terrain: Terrain,
  water: LandWater,
  drainage: Drainage,
  config: WorldConfig,
): Rivers {
  const cornerCount = drainage.receiver.length;
  const size = cornerCount + drainage.lakes.length;
  const next = new Int32Array(size).fill(-1);
  const incoming = new Uint32Array(size);
  const queue = new Uint32Array(size);
  const area = new Float64Array(size);
  const supply = new Float64Array(size);
  const active = new Uint8Array(size);
  const streamOrder = new Uint8Array(size);
  const equalOrder = new Uint8Array(size);
  const spillFrom = new Int32Array(drainage.lakes.length).fill(-1);
  const channel = new Uint8Array(cornerCount);
  const seasonal = Array.from({ length: 4 }, () => new Float32Array(size));
  // These are disjoint delivery pathways, not four independent sources of water.
  // Slow release can itself originate as rain or snow. A lake resets the pathway
  // to lake release while retaining the already computed seasonal timing.
  const origins = Array.from({ length: 4 }, () => new Float32Array(size));
  const support = computeCornerSupport(grid);

  for (let cornerIndex = 0; cornerIndex < cornerCount; cornerIndex++) {
    const lakeIndex = drainage.lakeId[cornerIndex];
    const lake = lakeIndex >= 0 ? drainage.lakes[lakeIndex] : undefined;

    if (lake && drainage.lakeFraction[cornerIndex] > 0) {
      next[cornerIndex] = cornerCount + lakeIndex;

      if (lake.outflow > 0 && drainage.receiver[cornerIndex] === lake.outlet) {
        spillFrom[lakeIndex] = cornerIndex;
      }
    } else {
      next[cornerIndex] = drainage.receiver[cornerIndex];
    }
  }

  for (const lake of drainage.lakes) {
    if (lake.outflow > 0) {
      next[cornerCount + lake.id] = lake.outlet;
    }
  }

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    if (terrain.ocean[cellIndex]) {
      continue;
    }

    for (
      let neighborOffset = grid.offsets[cellIndex];
      neighborOffset < grid.offsets[cellIndex + 1];
      neighborOffset++
    ) {
      const cornerIndex = grid.cellCorners[neighborOffset];
      const fraction = support.cellCornerFraction[neighborOffset];
      area[cornerIndex] += support.cellCornerArea[neighborOffset] * config.radius ** 2;
      supply[cornerIndex] += water.channelRunoff[cellIndex] * fraction;
      origins[0][cornerIndex] +=
        Math.max(
          0,
          water.runoff[cellIndex] - water.meltRunoff[cellIndex] - water.baseflowRunoff[cellIndex],
        ) * fraction;
      origins[1][cornerIndex] += water.meltRunoff[cellIndex] * fraction;
      origins[2][cornerIndex] += water.baseflowRunoff[cellIndex] * fraction;

      for (let seasonIndex = 0; seasonIndex < 4; seasonIndex++) {
        seasonal[seasonIndex][cornerIndex] +=
          water.seasonalRunoff[seasonIndex][cellIndex] * fraction;
      }
    }
  }

  for (const downstreamNode of next) {
    if (downstreamNode >= 0) {
      incoming[downstreamNode]++;
    }
  }

  let head = 0;
  let tail = 0;

  for (let cornerIndex = 0; cornerIndex < size; cornerIndex++) {
    if (!incoming[cornerIndex]) {
      queue[tail++] = cornerIndex;
    }
  }

  while (head < tail) {
    const cornerIndex = queue[head++];
    const downstreamNode = next[cornerIndex];

    if (cornerIndex >= cornerCount) {
      // Reservoir outflow has already passed through storage and evaporation. It is a
      // valid supply, not proof of perennial flow (our climate has four seasonal samples).
      const lake = drainage.lakes[cornerIndex - cornerCount];
      supply[cornerIndex] = lake.outflow;

      for (let sourceIndex = 0; sourceIndex < 4; sourceIndex++) {
        origins[sourceIndex][cornerIndex] = sourceIndex === 3 ? lake.outflow : 0;
      }

      for (let seasonIndex = 0; seasonIndex < 4; seasonIndex++) {
        seasonal[seasonIndex][cornerIndex] = lake.seasonal?.outflow[seasonIndex] ?? lake.outflow;
      }
    } else {
      supply[cornerIndex] = Math.min(supply[cornerIndex], drainage.discharge[cornerIndex]);
    }

    const supported =
      area[cornerIndex] >= config.riverSourceArea * 1e6 &&
      supply[cornerIndex] >= config.riverSourceFlow;

    if (supported) {
      active[cornerIndex] = 1;
    }

    if (active[cornerIndex]) {
      streamOrder[cornerIndex] = Math.max(1, streamOrder[cornerIndex] + equalOrder[cornerIndex]);
    }

    if (
      cornerIndex < cornerCount &&
      downstreamNode === drainage.receiver[cornerIndex] &&
      downstreamNode >= 0 &&
      drainage.discharge[cornerIndex] > 0
    ) {
      channel[cornerIndex] = active[cornerIndex];
    }

    if (downstreamNode >= 0) {
      area[downstreamNode] += area[cornerIndex];
      supply[downstreamNode] += supply[cornerIndex];

      for (let seasonIndex = 0; seasonIndex < 4; seasonIndex++) {
        seasonal[seasonIndex][downstreamNode] += seasonal[seasonIndex][cornerIndex];
      }

      for (let sourceIndex = 0; sourceIndex < 4; sourceIndex++) {
        origins[sourceIndex][downstreamNode] += origins[sourceIndex][cornerIndex];
      }

      // A closed lake ends the network; a spill continues it through the existing outlet.
      if (active[cornerIndex] && supply[cornerIndex] > 0) {
        active[downstreamNode] = 1;

        if (streamOrder[cornerIndex] > streamOrder[downstreamNode]) {
          streamOrder[downstreamNode] = streamOrder[cornerIndex];
          equalOrder[downstreamNode] = 0;
        } else if (streamOrder[cornerIndex] === streamOrder[downstreamNode]) {
          equalOrder[downstreamNode] = 1;
        }
      }

      if (--incoming[downstreamNode] === 0) {
        queue[tail++] = downstreamNode;
      }
    }
  }

  if (tail !== size) {
    throw Error('River catchments contain a drainage cycle.');
  }

  // Lake rain, evaporation and displaced land runoff were accounted for annually by
  // routeWater. Preserve that mean exactly, using routed quarters only for timing.
  for (let cornerIndex = 0; cornerIndex < cornerCount; cornerIndex++) {
    const mean = seasonal.reduce((sum, field) => sum + field[cornerIndex], 0) / 4;

    for (let seasonIndex = 0; seasonIndex < 4; seasonIndex++) {
      seasonal[seasonIndex][cornerIndex] =
        drainage.discharge[cornerIndex] *
        (mean > 0 ? seasonal[seasonIndex][cornerIndex] / mean : 1);
    }
  }

  // The same temporary lake-aware graph identifies whole river systems. Separate
  // ocean mouths remain separate systems; a real spill connects its upstream lake.
  const system = new Uint32Array(size);

  for (let orderIndex = tail - 1; orderIndex >= 0; orderIndex--) {
    const cornerIndex = queue[orderIndex];
    system[cornerIndex] = next[cornerIndex] < 0 ? cornerIndex : system[next[cornerIndex]];
  }

  for (const lake of drainage.lakes) {
    const cornerIndex = spillFrom[lake.id];
    const node = cornerCount + lake.id;

    if (cornerIndex < 0) {
      continue;
    }

    area[cornerIndex] = area[node];
    supply[cornerIndex] = supply[node];
    channel[cornerIndex] = active[node];
    streamOrder[cornerIndex] = streamOrder[node];

    for (let seasonIndex = 0; seasonIndex < 4; seasonIndex++) {
      seasonal[seasonIndex][cornerIndex] = seasonal[seasonIndex][node];
    }

    for (let sourceIndex = 0; sourceIndex < 4; sourceIndex++) {
      origins[sourceIndex][cornerIndex] = origins[sourceIndex][node];
    }
  }

  const headwater = new Uint8Array(channel);
  const source = new Uint8Array(cornerCount);
  const regime = new Uint8Array(cornerCount);

  for (let cornerIndex = 0; cornerIndex < cornerCount; cornerIndex++) {
    if (channel[cornerIndex] && drainage.receiver[cornerIndex] >= 0) {
      headwater[drainage.receiver[cornerIndex]] = 0;
    }

    if (!channel[cornerIndex]) {
      streamOrder[cornerIndex] = 0;
    }

    const total = origins.reduce((sum, field) => sum + field[cornerIndex], 0);
    let dominant = 0;

    for (let sourceIndex = 0; sourceIndex < 4; sourceIndex++) {
      origins[sourceIndex][cornerIndex] = total > 0 ? origins[sourceIndex][cornerIndex] / total : 0;

      if (origins[sourceIndex][cornerIndex] > origins[dominant][cornerIndex]) {
        dominant = sourceIndex;
      }
    }

    if (channel[cornerIndex]) {
      source[cornerIndex] = origins[dominant][cornerIndex] >= 0.55 ? dominant + 1 : 6;
      regime[cornerIndex] = flowRegime(seasonal.map((field) => field[cornerIndex]));
    }
  }

  return {
    channel,
    headwater,
    catchmentArea: area.slice(0, cornerCount),
    supportFlow: supply.slice(0, cornerCount),
    system: system.slice(0, cornerCount),
    streamOrder: streamOrder.slice(0, cornerCount),
    seasonalDischarge: seasonal.map((field) => field.slice(0, cornerCount)),
    sourceFractions: origins.map((field) => field.slice(0, cornerCount)),
    source,
    regime,
    courses: {
      corner: new Uint32Array(0),
      offsets: new Uint32Array(1),
      points: new Float32Array(0),
      sinuosity: new Float32Array(0),
    },
    deltas: [],
  };
}

/** Physical bank-access distance for ecology, not the exaggerated display width. */
export function riverbankHalfWidth(supply: number): number {
  return clamp(200 + 60 * Math.sqrt(Math.max(0, supply)), 200, 4000);
}
