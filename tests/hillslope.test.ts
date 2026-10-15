import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, type Grid, type Terrain } from '../src/core/model';
import { evolveHillslopes } from '../src/core/generation/hillslope';
import { buildGrid } from '../src/core/grid/build';
import { createRegionSpacing, refineGrid } from '../src/core/grid/refine';

const config = { ...DEFAULT_CONFIG, radius: 1, erosion: 1, hillslopeStrength: 1 };

function terrainWithSediment(bedrock: ArrayLike<number>, sediment: ArrayLike<number>): Terrain {
  const count = bedrock.length;

  return {
    bedrock: new Float32Array(bedrock),
    sediment: new Float32Array(sediment),
    height: Float32Array.from(bedrock, (height, cell) => height + sediment[cell]),
    ocean: new Uint8Array(count),
    surfaceChange: new Float32Array(count),
  } as Terrain;
}

function twoCells(firstArea = 1, secondArea = 4): Grid {
  return {
    count: 2,
    areas: new Float64Array([firstArea, secondArea]),
    edgeCells: new Uint32Array([0, 1]),
    edgeLength: new Float64Array([1]),
    edgeDistance: new Float64Array([1]),
  } as Grid;
}

test('hillslope exchanges one physical volume across unequal cells', () => {
  const terrain = terrainWithSediment([0, 0], [10, 0]);
  const result = evolveHillslopes(twoCells(), terrain, config, 0.00001);
  assert.equal(result.steps, 1);
  assert.equal(result.diffusivityM2PerMyr, 5000);
  assert.equal(result.movedVolume, 0.5);
  assert.equal(terrain.sediment[0], 9.5);
  assert.equal(terrain.sediment[1], 0.125);
  assert.equal(result.sedimentVolumeBefore, 10);
  assert.equal(result.sedimentVolumeAfter, 10);
  assert.equal(result.sedimentResidual, 0);
  assert.deepEqual([...terrain.bedrock], [0, 0]);
});

test('several downhill interfaces share one donor sediment limit', () => {
  const grid = {
    count: 3,
    areas: new Float64Array([100, 1, 2]),
    edgeCells: new Uint32Array([0, 1, 0, 2]),
    edgeLength: new Float64Array([1, 1]),
    edgeDistance: new Float64Array([1, 1]),
  } as Grid;
  const terrain = terrainWithSediment([100, 0, 0], [0.01, 0, 0]);
  const initialSediment = terrain.sediment[0] * 100;
  const result = evolveHillslopes(grid, terrain, config, 0.00001);
  assert.equal(terrain.sediment[0], 0, 'the scarce loose layer is exhausted exactly once');
  assert.equal(terrain.height[0], terrain.bedrock[0]);
  assert.ok(Math.abs(result.movedVolume - initialSediment) < 1e-12);
  assert.ok(Math.abs(terrain.sediment[1] - initialSediment / 2) < 1e-7);
  assert.ok(Math.abs(terrain.sediment[2] - initialSediment / 4) < 1e-7);
  assert.ok(Math.abs(result.sedimentResidual) < initialSediment * 1e-7);
  assert.ok(terrain.sediment.every((depth) => depth >= 0));
});

test('stable subdivision respects the smallest physical area and simulates the entire interval', () => {
  const grid = twoCells(0.01, 100);
  const terrain = terrainWithSediment([0, 0], [10, 0]);
  const duration = 0.003;
  const result = evolveHillslopes(grid, terrain, config, duration);
  const limit = (0.45 * grid.areas[0]) / result.diffusivityM2PerMyr;
  assert.equal(result.steps, Math.ceil(duration / limit));
  assert.ok(result.steps > 3000, 'requested time is never truncated to a timestep cap');
  assert.ok(result.timeStepMyr <= limit);
  assert.ok(Math.abs(result.timeStepMyr * result.steps - duration) < 1e-15);
  assert.ok(
    terrain.height.every((height) => Number.isFinite(height) && height >= 0 && height <= 10),
  );
  assert.ok(Math.abs(result.sedimentResidual) < result.sedimentVolumeBefore * 1e-7);
});

test('zero interval, zero strength, flat ground and bare rock leave material unchanged', () => {
  const grid = twoCells();
  const cases = [
    { terrain: terrainWithSediment([0, 0], [10, 0]), duration: 0, strength: 1 },
    { terrain: terrainWithSediment([0, 0], [10, 0]), duration: 1, strength: 0 },
    { terrain: terrainWithSediment([0, 9], [10, 1]), duration: 0.001, strength: 1 },
    { terrain: terrainWithSediment([10, 0], [0, 0]), duration: 1, strength: 1 },
  ];

  for (const scenario of cases) {
    const initialHeight = new Float32Array(scenario.terrain.height);
    const initialSediment = new Float32Array(scenario.terrain.sediment);
    const result = evolveHillslopes(
      grid,
      scenario.terrain,
      { ...config, hillslopeStrength: scenario.strength },
      scenario.duration,
    );
    assert.deepEqual(scenario.terrain.height, initialHeight);
    assert.deepEqual(scenario.terrain.sediment, initialSediment);
    assert.equal(result.movedVolume, 0);
    assert.equal(result.maxHeightChange, 0);
  }
});

test('soil creep leaves the separately modeled underwater terrain unchanged', () => {
  const terrain = terrainWithSediment([0, -10], [20, 1]);
  terrain.ocean[1] = 1;
  const initialHeight = new Float32Array(terrain.height);
  const result = evolveHillslopes(twoCells(), terrain, config, 1);
  assert.deepEqual(terrain.height, initialHeight);
  assert.equal(result.movedVolume, 0);
});

test('adaptive hillslopes preserve material, bedrock and height bounds under repeated updates', () => {
  const radius = 1000;
  const grid = refineGrid(
    buildGrid(2, 'hillslope-budget', 0.65),
    radius,
    'hillslope-budget',
    createRegionSpacing(500, radius, [
      { center: [1, 0, 0], radiusMetres: 200, targetSpacingMetres: 60 },
    ]),
  );
  const bedrock = Float32Array.from(
    { length: grid.count },
    (_, cell) => 50 * (1 + grid.positions[cell * 3 + 1]),
  );
  const sediment = Float32Array.from(
    { length: grid.count },
    (_, cell) => 20 + 10 * grid.positions[cell * 3],
  );
  const terrain = terrainWithSediment(bedrock, sediment);
  const minimum = Math.min(...terrain.height);
  const maximum = Math.max(...terrain.height);
  const result = evolveHillslopes(grid, terrain, { ...config, radius }, 2);
  assert.ok(Math.max(...grid.areas) > Math.min(...grid.areas) * 20);
  assert.ok(result.steps > 1);
  assert.ok(result.movedVolume > 0);
  assert.ok(Math.abs(result.sedimentResidual) < result.sedimentVolumeBefore * 1e-7);
  assert.deepEqual(terrain.bedrock, bedrock);

  for (let cell = 0; cell < grid.count; cell++) {
    assert.ok(Number.isFinite(terrain.height[cell]));
    assert.ok(terrain.sediment[cell] >= 0);
    assert.ok(terrain.height[cell] >= minimum && terrain.height[cell] <= maximum);
    assert.equal(terrain.height[cell], Math.fround(terrain.bedrock[cell] + terrain.sediment[cell]));
  }
});

test('invalid intervals fail explicitly rather than skipping or truncating time', () => {
  const terrain = terrainWithSediment([0, 0], [10, 0]);

  for (const duration of [-1, NaN, Infinity]) {
    assert.throws(() => evolveHillslopes(twoCells(), terrain, config, duration), /duration/);
  }
});
