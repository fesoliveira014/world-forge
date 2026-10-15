import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWorld } from '../src/core/pipeline';
import { DEFAULT_CONFIG, VERSION } from '../src/core/model';
import { readWorldProject, worldProject } from '../src/core/project';

const config = {
  ...DEFAULT_CONFIG,
  seed: 'evolved-history',
  surfaceLevel: 3,
  processLevel: 3,
  refinementStrength: 0.7,
  refinementMinSpacing: 400000,
  evolutionRefinements: 2,
  landscapeBatches: 1,
  tectonicDuration: 30,
  fluvialDuration: 0.75,
};

test('staged refinement preserves material and advances one landscape interval with fresh drainage', () => {
  const progress: [number, number][] = [];
  const world = generateWorld(config, (_, completed, total) => progress.push([completed, total]));
  assert.equal(world.evolution.durationMyr, 0.75);
  assert.equal(world.evolution.batches, 3);
  assert.equal(world.evolution.drainageRefreshes, 5);
  assert.equal(world.evolution.remeshes.length, 2);
  assert.equal(world.refinementPlans.length, 3);
  assert.deepEqual(
    world.evolution.remeshes.map((pass) => pass.elapsedMyr),
    [0.25, 0.5],
  );
  for (const pass of world.evolution.remeshes) {
    assert.ok(pass.afterCells > pass.beforeCells);
    assert.ok(
      Math.abs(pass.sedimentAfter - pass.sedimentBefore) / Math.max(1, pass.sedimentBefore) < 1e-7,
    );
  }
  assert.equal(world.grid.refinement?.baseCount, 642);
  assert.equal(world.grid.refinement?.passes, 3);
  assert.equal(world.grid.refinement?.insertedCount, world.grid.count - 642);
  assert.ok(world.grid.refinement?.sourceCell.every((cell) => cell < 642));
  assert.equal(world.process.count, 642);
  assert.ok(world.terrain.fluvialIncision.some((depth) => depth > 0));
  for (let cell = 0; cell < world.grid.count; cell++) {
    assert.ok(world.terrain.sediment[cell] >= 0);
    assert.equal(
      world.terrain.height[cell],
      Math.fround(world.terrain.bedrock[cell] + world.terrain.sediment[cell]),
    );
  }
  assert.equal(world.drainage.receiver.length, world.grid.corners.length / 3);
  assert.equal(world.water.runoff.length, world.grid.count);
  assert.equal(world.rivers.catchmentArea.length, world.grid.corners.length / 3);
  const stages = world.timings.map((stage) => stage.name);
  assert.equal(stages.filter((name) => name === 'Crust evolution').length, 1);
  assert.equal(stages.filter((name) => name === 'Landscape weathering & sediment').length, 1);
  assert.equal(stages.filter((name) => name.startsWith('Fine hillslope transport')).length, 3);
  assert.equal(stages.filter((name) => name.startsWith('Landscape water & drainage')).length, 3);
  assert.deepEqual(progress.at(-1), [stages.length, stages.length]);
  const waterResidual =
    world.drainage.runoffTotal - world.drainage.oceanDischarge - world.drainage.lakeExchange;
  assert.ok(Math.abs(waterResidual) / Math.max(1, world.drainage.runoffTotal) < 1e-8);

  const recipe = JSON.parse(JSON.stringify(worldProject(world)));
  const imported = readWorldProject(recipe);
  const replay = generateWorld(imported.config, undefined, {
    refinementPlans: imported.refinementPlans,
  });
  assert.deepEqual(world.grid.positions, replay.grid.positions);
  assert.deepEqual(world.grid.triangles, replay.grid.triangles);
  assert.deepEqual(world.terrain.height, replay.terrain.height);
  assert.deepEqual(world.terrain.sediment, replay.terrain.sediment);
  assert.deepEqual(world.drainage.receiver, replay.drainage.receiver);
  assert.deepEqual(world.refinementPlans, replay.refinementPlans);
});

test('zero recent duration skips fine evolution and evolved remeshing without replaying geology', () => {
  const world = generateWorld({ ...config, fluvialDuration: 0 });
  assert.equal(world.evolution.durationMyr, 0);
  assert.equal(world.evolution.batches, 0);
  assert.equal(world.evolution.remeshes.length, 0);
  assert.equal(world.evolution.hillslopeMoved, 0);
  assert.equal(world.evolution.windMoved, 0);
  assert.equal(world.refinementPlans.length, 1);
  assert.ok(world.terrain.fluvialIncision.every((depth) => depth === 0));
  assert.ok(world.timings.some((stage) => stage.name === 'Landscape weathering & sediment'));
});

test('evolution controls default for earlier recipes and reject fractional or invalid counts', () => {
  const legacy = Object.fromEntries(
    Object.entries(DEFAULT_CONFIG).filter(
      ([key]) => !['evolutionRefinements', 'landscapeBatches', 'hillslopeStrength'].includes(key),
    ),
  );
  const imported = readWorldProject({ version: '2.14.0', config: legacy });
  assert.equal(imported.config.evolutionRefinements, 0);
  assert.equal(imported.config.landscapeBatches, 4);
  assert.equal(imported.config.hillslopeStrength, 1);
  for (const key of ['evolutionRefinements', 'landscapeBatches'] as const) {
    for (const invalid of [-1, 0.5, 13, NaN]) {
      assert.throws(() =>
        readWorldProject({ version: VERSION, config: { ...config, [key]: invalid } }),
      );
    }
  }
  assert.throws(() => readWorldProject({ version: VERSION, config, refinementPlans: {} }), /array/);
  assert.throws(
    () => readWorldProject({ version: VERSION, config, refinementPlans: [{}] }),
    /invalid physical/,
  );
  assert.throws(() => generateWorld(config, undefined, { refinementPlans: [] }), /plan count/);
});
