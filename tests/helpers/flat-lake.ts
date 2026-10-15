import { buildGrid } from '../../src/core/grid/build';
import { classifyWater } from '../../src/core/generation/terrain';
import {
  DEFAULT_CONFIG,
  YEAR,
  type Grid,
  type LandWater,
  type Terrain,
} from '../../src/core/model';

export const flatLakeConfig = {
  ...DEFAULT_CONFIG,
  seed: 'flat-lake-route',
  radius: 3000000,
  surfaceLevel: 3,
  processLevel: 3,
  riverSourceArea: 30000,
};

/** A level sediment-filled inland sea with a genuine raised island. Alternating
 * deposit thickness is buried below the same physical surface, not terrain noise.
 */
export function createFlatLakeTerrain() {
  const grid = buildGrid(3, flatLakeConfig.seed, 0.65);
  const height = Float32Array.from({ length: grid.count }, (_, cell) => {
    const angle = Math.acos(grid.positions[cell * 3]);
    return angle < 0.11
      ? 650
      : angle < 0.43
        ? 598
        : angle < 0.73
          ? 598 + (22 * (angle - 0.43)) / 0.3
          : angle < 1.23
            ? 620 - (820 * (angle - 0.73)) / 0.5
            : -200;
  });
  const sediment = Float32Array.from(height, (_, cell) => 20 + (cell % 7) * 30);
  const terrain: Terrain = {
    height,
    sediment,
    bedrock: Float32Array.from(height, (value, cell) => value - sediment[cell]),
    surfaceChange: new Float32Array(grid.count),
    fluvialIncision: new Float32Array(grid.count),
    deltaSediment: new Float32Array(grid.count),
    oxbows: [],
    seaThreshold: 0,
    ...classifyWater(grid, height, flatLakeConfig.radius),
  };
  return { grid, terrain };
}

/** The same physical areal supply on every mesh; routing still computes its real
 * seasonal reservoir ledger, submerged runoff replacement, and spill downstream.
 */
export function flatLakeWater(grid: Grid, terrain: Terrain): LandWater {
  const count = grid.count;
  const field = (value = 0) => new Float32Array(count).fill(value);
  const runoff = Float64Array.from(grid.areas, (area, cell) =>
    terrain.ocean[cell] ? 0 : (area * flatLakeConfig.radius ** 2 * 1.5) / YEAR,
  );
  return {
    runoff,
    channelRunoff: new Float64Array(runoff),
    rain: field(2000),
    temperature: field(20),
    pet: field(500),
    aet: field(500),
    soil: field(100),
    snow: field(),
    aridity: field(4),
    seasonalRain: Array.from({ length: 4 }, () => field(500)),
    seasonalTemperature: Array.from({ length: 4 }, () => field(20)),
    seasonalLiquid: Array.from({ length: 4 }, () => field(500)),
    seasonalPet: Array.from({ length: 4 }, () => field(125)),
    seasonalRunoff: [1.3, 0.8, 0.6, 1.3].map((scale) =>
      Float32Array.from(runoff, (value) => value * scale),
    ),
    meltRunoff: field(),
    baseflowRunoff: Float32Array.from(runoff),
    saturatedSeasons: new Uint8Array(count),
    oxbowDepth: Array.from({ length: 4 }, () => new Float32Array()),
    residual: 0,
  };
}
