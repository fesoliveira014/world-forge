import type { Grid, Geology, Terrain, WorldConfig } from '../model';
import { readVector, clamp } from '../math';
import { computeDistances } from '../operators/spatial';
import { createTerrainSampler, sampleUplift } from './geology';
import { shapeContinentalBasins } from './continental-basins';
import { referencePoint } from './crust-evolution';

export function createTerrain(
  grid: Grid,
  processGrid: Grid,
  surfaceToProcess: Uint32Array,
  geology: Geology,
  config: WorldConfig,
): Terrain {
  const sample = createTerrainSampler(config);
  const coarse = new Float32Array(processGrid.count);

  for (let cellIndex = 0; cellIndex < processGrid.count; cellIndex++) {
    coarse[cellIndex] =
      sample(...readVector(processGrid.positions, cellIndex)).base + geology.uplift[cellIndex];
  }

  const order = Uint32Array.from({ length: processGrid.count }, (_, cellIndex) => cellIndex);
  order.sort((firstCell, secondCell) => coarse[firstCell] - coarse[secondCell]);
  let total = 0;
  let seaThreshold = 0;

  // Fixed reference quantile preserves the datum when only surface detail changes.
  for (const cellIndex of order) {
    total += processGrid.areas[cellIndex];

    if (total >= config.oceanFraction * 4 * Math.PI) {
      seaThreshold = coarse[cellIndex];
      break;
    }
  }

  if (geology.crust) {
    seaThreshold = geology.crust.seaThreshold;
  }

  const bedrock = new Float32Array(grid.count);
  const sediment = new Float32Array(grid.count);
  const height = new Float32Array(grid.count);

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    const [x, y, z] = readVector(grid.positions, cellIndex);
    const crust = geology.crust;
    const processCell = surfaceToProcess[cellIndex];
    const origin = crust
      ? referencePoint(crust.inverse, geology.plate[processCell], x, y, z)
      : [x, y, z];
    const terrainSample = sample(origin[0], origin[1], origin[2]);
    const uplift = sampleUplift(processGrid, geology.uplift, x, y, z, processCell);
    let baseElevation = terrainSample.base - seaThreshold;

    if (crust) {
      let coherent = crust.material[processCell];

      for (
        let neighborOffset = processGrid.offsets[processCell];
        neighborOffset < processGrid.offsets[processCell + 1];
        neighborOffset++
      ) {
        const neighbor = processGrid.neighbors[neighborOffset];

        if (geology.plate[neighbor] !== geology.plate[processCell] || !crust.material[neighbor]) {
          coherent = 0;
        }
      }

      const residual = coherent
        ? clamp(
            terrainSample.base -
              seaThreshold -
              sampleUplift(processGrid, crust.materialBase, x, y, z, processCell),
            -900,
            900,
          )
        : 0;
      baseElevation = sampleUplift(processGrid, crust.base, x, y, z, processCell) + residual;
    }

    // The continent field chooses land and broad drainage gradients, not mountain altitude.
    // A monotone lowland profile retains those gradients; concentrated uplift supplies ranges.
    const recentVolcanics =
      (crust?.volcanic[processCell] ?? 0) > 500
        ? Math.exp(-(crust?.volcanicAge[processCell] ?? 0) / 20)
        : 0;
    const young = Math.max(
      clamp(uplift / 3500),
      recentVolcanics,
      clamp((Math.abs(y) - 0.72) / 0.2),
    );
    const maturity = config.tectonicDuration * config.erosion * (1 - young * 0.85);
    const inheritedRelief = 0.2 + 0.8 * Math.exp(-maturity / 65);
    const plains = 950 * -Math.expm1(-Math.max(0, baseElevation) / 5500);
    const valleys = Math.min(140, plains * 0.65) * terrainSample.lowlandRelief * inheritedRelief;
    const basement = baseElevation > 0 ? plains + valleys : baseElevation * 0.55;
    const volcanic = crust ? sampleUplift(processGrid, crust.volcanic, x, y, z, processCell) : 0;
    const relief =
      Math.max(0, uplift) * terrainSample.mountainTexture + Math.min(0, uplift) + volcanic;
    const elevation = basement + relief;
    // Uplift must pay the depth of the seabed. Crossing zero does not suddenly
    // replace a submerged base with the full height of an above-water mountain.
    height[cellIndex] = bedrock[cellIndex] =
      elevation > 0 ? elevation * config.reliefScale : elevation;
  }

  const { ocean, coastDistance } = classifyWater(grid, height, config.radius);
  shapeContinentalBasins(grid, height, ocean);
  bedrock.set(height);

  return {
    bedrock,
    sediment,
    height,
    surfaceChange: new Float32Array(grid.count),
    fluvialIncision: new Float32Array(grid.count),
    deltaSediment: new Float32Array(grid.count),
    oxbows: [],
    ocean,
    coastDistance,
    seaThreshold,
  };
}

export function classifyWater(grid: Grid, height: Float32Array, radius: number) {
  const component = new Int32Array(grid.count).fill(-1);
  const queue = new Uint32Array(grid.count);
  let largest = -1;
  let maxArea = 0;
  let componentIndex = 0;

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    if (height[cellIndex] < 0 && component[cellIndex] < 0) {
      let head = 0;
      let tail = 1;
      let area = 0;
      queue[0] = cellIndex;
      component[cellIndex] = componentIndex;

      while (head < tail) {
        const componentCell = queue[head++];
        area += grid.areas[componentCell];

        for (
          let neighborOffset = grid.offsets[componentCell];
          neighborOffset < grid.offsets[componentCell + 1];
          neighborOffset++
        ) {
          const neighborCell = grid.neighbors[neighborOffset];

          if (height[neighborCell] < 0 && component[neighborCell] < 0) {
            component[neighborCell] = componentIndex;
            queue[tail++] = neighborCell;
          }
        }
      }

      if (area > maxArea) {
        maxArea = area;
        largest = componentIndex;
      }

      componentIndex++;
    }
  }

  const ocean = new Uint8Array(grid.count);
  const coasts: number[] = [];

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    ocean[cellIndex] = +(largest >= 0 && component[cellIndex] === largest);
  }

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    for (
      let neighborOffset = grid.offsets[cellIndex];
      neighborOffset < grid.offsets[cellIndex + 1];
      neighborOffset++
    ) {
      if (ocean[cellIndex] !== ocean[grid.neighbors[neighborOffset]]) {
        coasts.push(cellIndex);
        break;
      }
    }
  }

  return { ocean, coastDistance: computeDistances(grid, coasts, radius) };
}
