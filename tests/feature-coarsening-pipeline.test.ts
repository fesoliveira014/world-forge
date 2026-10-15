import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONFIG, type World } from '../src/core/model';
import { generateWorld, generateWorldAsync } from '../src/core/pipeline';
import { solveClimate } from '../src/core/generation/climate';
import {
  planFeatureCoarsening,
  validateResolvedFeatureCoarseningPlan,
} from '../src/core/grid/feature-coarsening';
import { refinementConfigSignature } from '../src/core/grid/refinement-config';
import { readWorldProject, worldProject } from '../src/core/project';

// Broad, subdued continents leave a few quiet interiors even on this small
// mesh. Earlier adaptive detail is enabled to exercise all three recipe stages.
const config = {
  ...DEFAULT_CONFIG,
  seed: 'quiet-integration',
  surfaceLevel: 4,
  processLevel: 3,
  oceanFraction: 0.2,
  plates: 6,
  reliefScale: 0.4,
  tectonicDuration: 10,
  volcanicActivity: 0,
  erosion: 0.1,
  fluvialDuration: 0.1,
  landscapeBatches: 1,
  refinementStrength: 0.4,
  refinementMinSpacing: 200000,
  featureRefinementPasses: 2,
  featureRefinementSpacing: 100000,
  featureRefinementBudget: 20,
  featureCoarseningBudget: 10,
  featureCoarseningSpacing: 1000000,
  featureCoarseningTolerance: 200,
};

let fixture: { base: World; adapted: World; progress: [number, number][] } | undefined;
function worlds() {
  if (!fixture) {
    const progress: [number, number][] = [];
    fixture = {
      base: generateWorld({ ...config, featureRefinementPasses: 0 }),
      adapted: generateWorld(config, (_, completed, total) => progress.push([completed, total])),
      progress,
    };
  }
  return fixture;
}

function assertSameWorld(actual: World, expected: World) {
  for (const key of [
    'grid',
    'terrain',
    'water',
    'drainage',
    'rivers',
    'ecology',
    'resources',
    'evolution',
    'refinementPlans',
    'featureRefinementPlans',
    'featureRefinementStats',
    'featureCoarseningPlans',
  ] as const) {
    assert.deepEqual(actual[key], expected[key], key);
  }
  // Replay validates the stored removals without scanning rejected candidates.
  const appliedCoarsening = (world: World) =>
    world.featureCoarseningStats!.map(({ candidateCells: _candidateCells, ...applied }) => applied);
  assert.deepEqual(appliedCoarsening(actual), appliedCoarsening(expected));
}

test('two final passes share independent insertion and removal budgets without advancing physical time', () => {
  const { base, adapted, progress } = worlds();
  const insertionBudget = Math.floor((base.grid.count * config.featureRefinementBudget) / 100);
  const removalBudget = Math.floor((base.grid.count * config.featureCoarseningBudget) / 100);
  assert.ok(base.refinementPlans.length > 0, 'initial adaptive refinement precedes final passes');
  assert.equal(adapted.featureCoarseningPlans!.length, 2);
  assert.equal(adapted.featureCoarseningStats!.length, 2);
  assert.equal(adapted.featureRefinementPlans!.length, 2);
  assert.equal(adapted.featureRefinementStats!.length, 2);

  let removed = 0;
  let inserted = 0;
  let priorCount = base.grid.count;
  for (let pass = 0; pass < 2; pass++) {
    const quiet = adapted.featureCoarseningStats![pass];
    const detail = adapted.featureRefinementStats![pass];
    assert.equal(quiet.beforeCells, priorCount);
    assert.equal(quiet.budgetCells, Math.ceil((removalBudget - removed) / (2 - pass)));
    assert.equal(quiet.beforeCells - quiet.afterCells, quiet.removedCells);
    assert.ok(quiet.removedCells <= quiet.budgetCells);
    assert.equal(adapted.featureCoarseningPlans![pass].removedCells.length, quiet.removedCells);
    assert.equal(detail.beforeCells, quiet.afterCells);
    assert.equal(
      detail.budget,
      Math.ceil((insertionBudget - inserted) / (2 - pass)),
      'removed cells never increase the insertion allowance',
    );
    assert.ok(detail.afterCells - detail.beforeCells <= detail.budget);
    removed += quiet.removedCells;
    inserted += detail.afterCells - detail.beforeCells;
    priorCount = detail.afterCells;
  }
  assert.ok(adapted.featureCoarseningStats![0].removedCells > 0);
  assert.ok(removed > 0 && inserted > 0, 'exercise real deletion and insertion, not no-op plans');
  assert.ok(removed <= removalBudget);
  assert.ok(inserted <= insertionBudget);
  assert.equal(adapted.grid.count, base.grid.count + inserted - removed);
  assert.equal(priorCount, adapted.grid.count);
  assert.deepEqual(adapted.process, base.process);
  assert.deepEqual(adapted.geology, base.geology);
  assert.deepEqual(adapted.climate, base.climate);
  assert.deepEqual(adapted.climateReferenceHeight, base.climateReferenceHeight);
  assert.deepEqual(adapted.evolution, base.evolution);
  assert.equal(adapted.sedimentExport, base.sedimentExport);
  assert.deepEqual(adapted.resources.deposits, base.resources.deposits);

  for (const key of ['sediment', 'fluvialIncision', 'deltaSediment'] as const) {
    const inventory = (world: World) =>
      world.terrain[key].reduce((sum, depth, cell) => sum + depth * world.grid.areas[cell], 0);
    const before = inventory(base);
    assert.ok(Math.abs(inventory(adapted) - before) < Math.max(1, before) * 1e-7, key);
  }
  const residual =
    adapted.drainage.runoffTotal - adapted.drainage.oceanDischarge - adapted.drainage.lakeExchange;
  assert.ok(Math.abs(residual) < Math.max(1, adapted.drainage.runoffTotal) * 1e-8);
  assert.equal(adapted.water.runoff.length, adapted.grid.count);
  assert.equal(adapted.rivers.channel.length, adapted.grid.triangles.length / 3);
  assert.ok(adapted.terrain.height.every(Number.isFinite));
  assert.ok(adapted.terrain.sediment.every((depth) => Number.isFinite(depth) && depth >= 0));

  const stages = adapted.timings.map(({ name }) => name);
  let previous = stages.indexOf('Headwaters & channels');
  for (let pass = 1; pass <= 2; pass++) {
    for (const stage of [
      'Quiet land mesh',
      'Quiet land transfers',
      'Quiet land water & drainage',
      'Quiet land channels',
      'Final feature plan',
      'Final feature mesh',
      'Final feature transfers',
      'Final feature water & drainage',
      'Final feature channels',
    ]) {
      const index = stages.indexOf(`${stage} · ${pass} / 2`);
      assert.ok(index > previous, `${stage} follows its prerequisite`);
      previous = index;
    }
  }
  assert.ok(previous < stages.indexOf('River courses & deltas'));
  assert.deepEqual(
    stages.filter((stage) => !/^(Quiet land|Final feature) /.test(stage)),
    base.timings.map(({ name }) => name),
    'resolution changes do not introduce extra physical simulation stages',
  );
  assert.deepEqual(progress.at(-1), [stages.length, stages.length]);
});

test('saved initial, coarsening and feature plans reproduce the same terrain and hydrology', () => {
  const { adapted } = worlds();
  const project = readWorldProject(JSON.parse(JSON.stringify(worldProject(adapted))));
  assert.deepEqual(project.featureCoarseningPlans, adapted.featureCoarseningPlans);
  assert.deepEqual(project.featureRefinementPlans, adapted.featureRefinementPlans);
  assert.deepEqual(project.refinementPlans, adapted.refinementPlans);
  const replay = generateWorld(project.config, undefined, {
    refinementPlans: project.refinementPlans,
    featureCoarseningPlans: project.featureCoarseningPlans,
    featureRefinementPlans: project.featureRefinementPlans,
  });
  assertSameWorld(replay, adapted);
});

test('asynchronous climate execution retains the same coarsening and refinement result', async () => {
  const { adapted } = worlds();
  let calls = 0;
  const asynchronous = await generateWorldAsync(config, undefined, {
    climateConcurrency: 3,
    solveClimate: async (request) => {
      calls++;
      return solveClimate(
        request.grid,
        request.height,
        request.ocean,
        request.config,
        request.referenceOcean,
        request.recycledEvapotranspiration,
      );
    },
  });
  assert.equal(calls, 2, 'resolution changes reuse settled climate');
  assert.equal(asynchronous.execution.climateWorkers, 3);
  assertSameWorld(asynchronous, adapted);
  assert.deepEqual(asynchronous.featureCoarseningStats, adapted.featureCoarseningStats);
});

test('quiet-land coarsening can remove cells with a zero insertion budget', () => {
  const { base } = worlds();
  const coarsened = generateWorld({ ...config, featureRefinementBudget: 0 });
  const removed = coarsened.featureCoarseningStats!.reduce(
    (sum, stats) => sum + stats.removedCells,
    0,
  );
  assert.ok(removed > 0);
  assert.equal(coarsened.grid.count, base.grid.count - removed);
  for (const stats of coarsened.featureRefinementStats!) {
    assert.equal(stats.budget, 0);
    assert.equal(stats.beforeCells, stats.afterCells);
    assert.equal(stats.selectedCells, 0);
  }
  assert.deepEqual(coarsened.climate, base.climate);
  assert.deepEqual(coarsened.evolution, base.evolution);
});

test('coarsening replay uses saved selections without rediscovering quiet regions', () => {
  const { base, adapted } = worlds();
  const saved = adapted.featureCoarseningPlans![0];
  const replay = planFeatureCoarsening(
    {
      grid: base.grid,
      terrain: base.terrain,
      config,
      get ecology(): World['ecology'] {
        throw Error('Saved coarsening must not rerun biome selection.');
      },
      get drainage(): World['drainage'] {
        throw Error('Saved coarsening must not rerun lake district selection.');
      },
      get rivers(): World['rivers'] {
        throw Error('Saved coarsening must not rerun river protection selection.');
      },
    },
    0,
    adapted.featureCoarseningStats![0].budgetCells,
    saved,
  );
  assert.deepEqual(replay.removedSourceCells, saved.removedCells);
  assert.equal(replay.grid.count, base.grid.count - saved.removedCells.length);
});

test('coarsening replay rejects stale geometry, configuration, pass order and invalid selections', () => {
  const { base, adapted } = worlds();
  const saved = adapted.featureCoarseningPlans![0];
  const context = { ...base, config };
  const budget = adapted.featureCoarseningStats![0].budgetCells;
  for (const replacement of [
    { sourceGeometrySignature: 'stale-mesh' },
    { sourceCellCount: saved.sourceCellCount + 1 },
    { configSignature: refinementConfigSignature({ ...config, seed: 'another-world' }) },
    { pass: 1 },
  ]) {
    assert.throws(
      () => planFeatureCoarsening(context, 0, budget, { ...saved, ...replacement }),
      /does not match/,
    );
  }
  assert.throws(() => planFeatureCoarsening(context, 0, 0, saved), /cell budget/);
  const changedHeight = base.terrain.height.slice();
  changedHeight[saved.removedCells[0]] += 10000;
  assert.throws(
    () =>
      planFeatureCoarsening(
        { ...context, terrain: { ...base.terrain, height: changedHeight } },
        0,
        budget,
        saved,
      ),
    /height tolerance/,
  );
  const tightSpacing = { ...config, featureCoarseningSpacing: 10000 };
  assert.throws(
    () =>
      planFeatureCoarsening({ ...context, config: tightSpacing }, 0, budget, {
        ...saved,
        configSignature: refinementConfigSignature(tightSpacing),
      }),
    /spacing limit/,
  );
  for (const removedCells of [[-1], [base.grid.count], [0.5], [NaN], [0, 0]]) {
    assert.throws(
      () => validateResolvedFeatureCoarseningPlan({ ...saved, removedCells }),
      /invalid geometry or cell selections/,
    );
  }
});

test('recipe replay rejects missing or extra coarsening passes before starting generation', () => {
  const { adapted } = worlds();
  const plans = adapted.featureCoarseningPlans!;
  for (const featureCoarseningPlans of [[], plans.slice(0, 1), [...plans, plans[0]]]) {
    assert.throws(
      () => generateWorld(config, undefined, { featureCoarseningPlans }),
      /coarsening plan count/,
    );
  }
  assert.throws(
    () =>
      generateWorld({ ...config, featureCoarseningBudget: 0 }, undefined, {
        featureCoarseningPlans: plans,
      }),
    /coarsening plan count/,
  );
  assert.throws(
    () =>
      generateWorld({ ...config, featureRefinementPasses: 0 }, undefined, {
        featureCoarseningPlans: plans,
      }),
    /coarsening plan count/,
  );
});
