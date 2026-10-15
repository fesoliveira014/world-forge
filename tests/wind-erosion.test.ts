import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGrid, nearestCell } from '../src/core/grid/build';
import { createRegionSpacing, refineGrid } from '../src/core/grid/refine';
import { transportWindSediment } from '../src/core/generation/wind-erosion';
import {
  DEFAULT_CONFIG,
  type Climate,
  type Grid,
  type LandWater,
  type Terrain,
} from '../src/core/model';

const radius = 1000;
const config = { ...DEFAULT_CONFIG, radius, erosion: 1, windErosion: 1 };
const base = buildGrid(2, 'wind-sediment', 0.65);

function terrainFor(grid: Grid): Terrain {
  return {
    bedrock: new Float32Array(grid.count).fill(100),
    sediment: new Float32Array(grid.count),
    height: new Float32Array(grid.count).fill(100),
    surfaceChange: new Float32Array(grid.count),
    ocean: new Uint8Array(grid.count),
    coastDistance: new Float32Array(grid.count),
    seaThreshold: 0,
    fluvialIncision: new Float32Array(grid.count),
    deltaSediment: new Float32Array(grid.count),
    oxbows: [],
  };
}

function waterFor(grid: Grid): LandWater {
  return {
    soil: new Float32Array(grid.count),
    snow: new Float32Array(grid.count),
    aridity: new Float32Array(grid.count).fill(3),
  } as LandWater;
}

function rotatingClimate(grid: Grid, directions = [1, 1, 1, 1]): Climate {
  return {
    wind: directions.map((direction) => {
      const wind = new Float32Array(grid.count * 3);
      for (let cell = 0; cell < grid.count; cell++) {
        wind[cell * 3] = -12 * grid.positions[cell * 3 + 2] * direction;
        wind[cell * 3 + 2] = 12 * grid.positions[cell * 3] * direction;
      }
      return wind;
    }),
  } as Climate;
}

function identity(grid: Grid) {
  return Uint32Array.from({ length: grid.count }, (_, cell) => cell);
}

function setSediment(terrain: Terrain, cell: number, depth: number) {
  terrain.sediment[cell] = depth;
  terrain.height[cell] = terrain.bedrock[cell] + terrain.sediment[cell];
}

test('directional wind deposits loose sediment downwind without resuspending new deposits', () => {
  const terrain = terrainFor(base);
  const donor = nearestCell(base, 1, 0, 0);
  setSediment(terrain, donor, 2);
  const beforeBedrock = terrain.bedrock.slice();
  const result = transportWindSediment(
    base,
    base,
    identity(base),
    terrain,
    rotatingClimate(base),
    waterFor(base),
    config,
    0.001,
  );
  let downwind = 0;
  let upwind = 0;
  const neighbors = new Set(base.neighbors.subarray(base.offsets[donor], base.offsets[donor + 1]));

  for (let cell = 0; cell < base.count; cell++) {
    if (cell === donor) {
      continue;
    }
    const volume = terrain.sediment[cell] * base.areas[cell] * radius ** 2;
    const direction = base.positions[cell * 3 + 2] - base.positions[donor * 3 + 2];
    if (direction > 0) {
      downwind += volume;
    } else {
      upwind += volume;
    }
    if (!neighbors.has(cell)) {
      assert.equal(
        terrain.sediment[cell],
        0,
        'incoming material must not be spent again in this interval',
      );
    }
  }

  assert.ok(downwind > 0);
  assert.ok(downwind > 100 * upwind);
  assert.ok(terrain.sediment[donor] < 2);
  assert.ok(result.movedVolume > 0);
  assert.ok(Math.abs(result.residual) / result.initialVolume < 1e-7);
  assert.deepEqual(terrain.bedrock, beforeBedrock);
});

test('all neighbors and opposing seasons share one combined donor inventory cap', () => {
  const terrain = terrainFor(base);
  const donor = nearestCell(base, 1, 0, 0);
  setSediment(terrain, donor, 0.125);
  const result = transportWindSediment(
    base,
    base,
    identity(base),
    terrain,
    rotatingClimate(base, [1, -1, 1, -1]),
    waterFor(base),
    config,
    1e6,
  );
  const depositedCells = terrain.sediment.filter(
    (depth, cell) => cell !== donor && depth > 0,
  ).length;
  assert.ok(depositedCells >= 4, 'multiple outgoing edges must compete for the same inventory');
  assert.ok(terrain.sediment[donor] < 1e-12);
  assert.ok(terrain.sediment.every((depth) => Number.isFinite(depth) && depth >= 0));
  assert.ok(result.maxDonorFraction <= 1 + 1e-14);
  assert.ok(Math.abs(result.movedVolume - result.initialVolume) / result.initialVolume < 1e-13);
  assert.ok(Math.abs(result.residual) / result.initialVolume < 1e-7);
});

test('zero duration, disabled forcing, wet ground, bare rock, and calm wind do not transport', () => {
  for (const condition of [
    'duration',
    'wind-toggle',
    'erosion-toggle',
    'wet-soil',
    'wet-climate',
    'bare-rock',
    'calm',
  ]) {
    const terrain = terrainFor(base);
    const donor = nearestCell(base, 1, 0, 0);
    setSediment(terrain, donor, condition === 'bare-rock' ? 0 : 2);
    const water = waterFor(base);
    if (condition === 'wet-soil') {
      water.soil.fill(config.soilCapacity);
    }
    if (condition === 'wet-climate') {
      water.aridity.fill(0.5);
    }
    const climate = rotatingClimate(base, condition === 'calm' ? [0, 0, 0, 0] : undefined);
    const before = terrain.sediment.slice();
    const result = transportWindSediment(
      base,
      base,
      identity(base),
      terrain,
      climate,
      water,
      {
        ...config,
        windErosion: condition === 'wind-toggle' ? 0 : 1,
        erosion: condition === 'erosion-toggle' ? 0 : 1,
      },
      condition === 'duration' ? 0 : 1,
    );
    assert.deepEqual(terrain.sediment, before, condition);
    assert.equal(result.movedVolume, 0, condition);
    assert.equal(result.residual, 0, condition);
  }
});

test('moisture and snow constrain entrainment while ocean cells can receive deposition', () => {
  const donor = nearestCell(base, 1, 0, 0);
  const run = (soil: number, snow: number) => {
    const terrain = terrainFor(base);
    terrain.ocean.fill(1);
    terrain.ocean[donor] = 0;
    setSediment(terrain, donor, 2);
    const water = waterFor(base);
    water.soil.fill(soil);
    water.snow.fill(snow);
    return transportWindSediment(
      base,
      base,
      identity(base),
      terrain,
      rotatingClimate(base),
      water,
      config,
      0.001,
    );
  };
  const dry = run(0, 0);
  const moist = run(config.soilCapacity * 0.5, 0);
  const snowy = run(0, 90);
  assert.ok(dry.movedVolume > 0);
  assert.ok(Math.abs(moist.movedVolume / dry.movedVolume - 0.25) < 1e-12);
  assert.ok(Math.abs(snowy.movedVolume / dry.movedVolume - 0.1) < 1e-12);
  assert.ok(Math.abs(dry.residual) / dry.initialVolume < 1e-7);
});

test('adaptive unequal-area transport conserves volume and continuously samples the process wind', () => {
  const grid = refineGrid(
    base,
    radius,
    'wind-sediment',
    createRegionSpacing(500, radius, [
      { center: [1, 0, 0], radiusMetres: 200, targetSpacingMetres: 45 },
    ]),
  );
  const process = buildGrid(1, 'process-wind', 0.4);
  const transfer = Uint32Array.from({ length: grid.count }, (_, cell) =>
    nearestCell(
      process,
      grid.positions[cell * 3],
      grid.positions[cell * 3 + 1],
      grid.positions[cell * 3 + 2],
    ),
  );
  const terrain = terrainFor(grid);
  const repeat = terrainFor(grid);
  for (let cell = 0; cell < grid.count; cell++) {
    setSediment(terrain, cell, 0.25 + (cell % 7) * 0.125);
    setSediment(repeat, cell, terrain.sediment[cell]);
  }
  const climate = rotatingClimate(process);
  const result = transportWindSediment(
    grid,
    process,
    transfer,
    terrain,
    climate,
    waterFor(grid),
    config,
    0.03,
  );
  transportWindSediment(
    grid,
    process,
    new Uint32Array(grid.count),
    repeat,
    climate,
    waterFor(grid),
    config,
    0.03,
  );
  assert.ok(Math.max(...grid.areas) / Math.min(...grid.areas) > 50);
  assert.ok(result.movedVolume > 0);
  assert.ok(Math.abs(result.residual) / result.initialVolume < 1e-7);
  assert.ok(terrain.sediment.every((depth) => Number.isFinite(depth) && depth >= 0));
  assert.ok(terrain.bedrock.every((height) => height === 100));
  for (let cell = 0; cell < grid.count; cell++) {
    assert.ok(
      Math.abs(terrain.sediment[cell] - repeat.sediment[cell]) < 1e-6,
      'categorical transfer is only a search hint, never the wind sampler',
    );
  }
});
