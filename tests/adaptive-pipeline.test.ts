import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWorld } from '../src/core/pipeline';
import { DEFAULT_CONFIG, type Drainage, type Geology, type Terrain } from '../src/core/model';
import { worldProject, readWorldProject } from '../src/core/project';
import { buildGrid } from '../src/core/grid/build';
import { planSurfaceRefinement } from '../src/core/grid/refinement-plan';

test('an adaptive recipe completes once before erosion and reproduces geometry and physical fields', () => {
  const config = {
    ...DEFAULT_CONFIG,
    seed: 'adaptive-release',
    surfaceLevel: 3,
    processLevel: 3,
    refinementMinSpacing: 400000,
    refinementStrength: 0.6,
  };
  const progress: [number, number][] = [];
  const world = generateWorld(config, (_, completed, total) => progress.push([completed, total]));
  const repeated = generateWorld(readWorldProject(worldProject(world)).config);
  assert.ok(world.grid.count > world.process.count);
  assert.equal(world.process.count, 642);
  assert.notEqual(world.grid, world.process);
  assert.equal(world.process.refinement, undefined);
  assert.deepEqual(
    world.grid.positions.subarray(0, world.process.positions.length),
    world.process.positions,
  );
  assert.deepEqual(world.grid.positions, repeated.grid.positions);
  assert.deepEqual(world.grid.triangles, repeated.grid.triangles);
  assert.deepEqual(world.terrain.height, repeated.terrain.height);
  assert.deepEqual(world.water.rain, repeated.water.rain);
  assert.deepEqual(world.drainage.receiver, repeated.drainage.receiver);
  assert.deepEqual(world.ecology.biome, repeated.ecology.biome);
  assert.deepEqual(world.resources.deposits, repeated.resources.deposits);
  assert.ok(world.terrain.height.every(Number.isFinite));
  assert.ok(world.terrain.sediment.every((value) => Number.isFinite(value) && value >= 0));
  assert.ok(world.terrain.surfaceChange.some((value) => value !== 0));
  const stages = world.timings.map((stage) => stage.name);
  assert.equal(stages.filter((stage) => stage === 'Crust evolution').length, 1);
  assert.equal(stages.filter((stage) => stage === 'Adaptive surface mesh').length, 1);
  assert.ok(stages.indexOf('Crust evolution') < stages.indexOf('Adaptive surface mesh'));
  assert.ok(
    stages.indexOf('Adaptive surface mesh') < stages.indexOf('Landscape weathering & sediment'),
  );
  assert.ok(stages.indexOf('River landscape evolution') < stages.indexOf('Final climate'));
  assert.equal(progress.at(-1)![0], progress.at(-1)![1]);
  assert.equal(progress.at(-1)![0], stages.length);
  const routingResidual =
    world.drainage.runoffTotal - world.drainage.oceanDischarge - world.drainage.lakeExchange;
  assert.ok(Math.abs(routingResidual) / Math.max(1, world.drainage.runoffTotal) < 1e-8);
  for (let season = 0; season < 4; season++) {
    const source = world.climate.rain[season].reduce(
      (sum, value, cell) => sum + value * world.process.areas[cell],
      0,
    );
    const target = world.water.seasonalRain[season].reduce(
      (sum, value, cell) => sum + value * world.grid.areas[cell],
      0,
    );
    assert.ok(Math.abs(source - target) / Math.max(1, source) < 1e-7);
  }
});

test('adaptive final climate reconciles the refined terrain even with erosion and recycling disabled', () => {
  const world = generateWorld({
    ...DEFAULT_CONFIG,
    surfaceLevel: 3,
    processLevel: 3,
    refinementMinSpacing: 600000,
    refinementStrength: 0.5,
    erosion: 0,
    recycling: 0,
    tectonicDuration: 0,
  });
  const stages = world.timings.map((stage) => stage.name);
  assert.ok(world.grid.count > world.process.count);
  assert.ok(stages.includes('Final climate'));
  assert.ok(stages.includes('Final water & drainage'));
  assert.ok(!stages.includes('Landscape weathering & sediment'));
  assert.ok(!stages.includes('Crust evolution'));
  assert.ok(world.terrain.surfaceChange.every((value) => value === 0));
});

test('low lake outlets and sparse volcanic sources request detail without a slope signal', () => {
  const grid = buildGrid(3, 'flat-planning', 0.65);
  const config = { ...DEFAULT_CONFIG, refinementStrength: 1, refinementMinSpacing: 100000 };
  const terrain = {
    height: new Float32Array(grid.count),
    ocean: new Uint8Array(grid.count),
  } as Terrain;
  const drainage = {
    height: new Float32Array(grid.corners.length / 3),
    discharge: new Float64Array(grid.corners.length / 3),
    receiver: new Int32Array(grid.corners.length / 3).fill(-1),
    order: Uint32Array.from({ length: grid.corners.length / 3 }, (_, corner) => corner),
    lakes: [],
  } as unknown as Drainage;
  const geology = { hotspots: [] } as unknown as Geology;
  const transfer = Uint32Array.from({ length: grid.count }, (_, cell) => cell);
  const flat = planSurfaceRefinement(grid, terrain, drainage, geology, transfer, config);
  assert.ok(flat.targetSpacing.every((spacing) => spacing === flat.baseSpacing));
  drainage.lakes = [{ outlet: 0 }] as Drainage['lakes'];
  const outlet = planSurfaceRefinement(grid, terrain, drainage, geology, transfer, config);
  for (const cell of grid.triangles.subarray(0, 3)) {
    assert.ok(outlet.targetSpacing[cell] <= config.refinementMinSpacing * (1 + 1e-12));
  }
  drainage.lakes = [];
  const position = Array.from(grid.corners.subarray(3, 6)) as [number, number, number];
  geology.hotspots = [{ position, radius: 500, start: 0, end: 300, rate: 1 }];
  const volcanic = planSurfaceRefinement(grid, terrain, drainage, geology, transfer, config);
  assert.ok(volcanic.spacingAt(...position) <= config.refinementMinSpacing * (1 + 1e-12));
  const inactive = planSurfaceRefinement(grid, terrain, drainage, geology, transfer, {
    ...config,
    volcanicActivity: 0,
  });
  assert.ok(inactive.spacingAt(...position) > config.refinementMinSpacing);
});
