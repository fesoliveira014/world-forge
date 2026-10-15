import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  type Drainage,
  type Lake,
  type Rivers,
  type Terrain,
} from '../src/core/model';
import { buildGrid } from '../src/core/grid/build';
import { refineGrid } from '../src/core/grid/refine';
import {
  coastlineDetector,
  lakeShoreDetector,
  planFeatureRefinement,
  replayFeatureRefinement,
  riverFeatureDetector,
  terrainReliefDetector,
  validateResolvedFeatureRefinementPlan,
  type FeatureDetector,
  type FeatureRefinementContext,
} from '../src/core/grid/feature-refinement';

function fixture(): FeatureRefinementContext {
  const config = {
    ...DEFAULT_CONFIG,
    seed: 'final-feature-selection',
    featureRefinementSpacing: 10000,
  };
  const grid = buildGrid(2, config.seed, 0.25);
  const corners = grid.corners.length / 3;
  return {
    grid,
    config,
    terrain: { height: new Float32Array(grid.count), ocean: new Uint8Array(grid.count) } as Terrain,
    drainage: {
      lakeCoverage: new Float32Array(grid.count),
      seasonalLakeCoverage: Array.from({ length: 4 }, () => new Float32Array(grid.count)),
      lakeFraction: new Float32Array(corners),
      lakeId: new Int32Array(corners).fill(-1),
      lakes: [],
      receiver: new Int32Array(corners).fill(-1),
      discharge: new Float64Array(corners),
    } as unknown as Drainage,
    rivers: { channel: new Uint8Array(corners) } as Rivers,
  };
}

function emitted(context: FeatureRefinementContext, detector: FeatureDetector) {
  const cells = new Map<number, number>();
  detector.detect(context, ({ cell, score }) =>
    cells.set(cell, Math.max(score, cells.get(cell) ?? 0)),
  );
  return cells;
}

test('lake detector distinguishes geometric shores from annually mixed seasonal interiors', () => {
  const context = fixture();
  context.drainage.lakeCoverage.fill(0.5);
  context.drainage.seasonalLakeCoverage![1].fill(1);
  context.drainage.seasonalLakeCoverage![3].fill(1);
  assert.equal(
    emitted(context, lakeShoreDetector).size,
    0,
    'annual wet/dry switching alone is not unresolved shoreline',
  );
  context.drainage.seasonalLakeCoverage![0][12] = 0.35;
  assert.deepEqual([...emitted(context, lakeShoreDetector).keys()], [12]);
  context.drainage.seasonalLakeCoverage![0][12] = 1;
  assert.ok(
    emitted(context, lakeShoreDetector).has(12),
    'a fully wet boundary still needs an outline',
  );
  context.terrain.ocean[12] = 1;
  assert.equal(
    emitted(context, lakeShoreDetector).size,
    0,
    'open oceans belong to the coastal detector',
  );
});

test('tiny reservoirs receive detail even when their partial-water color is barely perceptible', () => {
  const context = fixture();
  context.drainage.lakes.push({ id: 0, area: 1000 } as Lake);
  context.drainage.lakeId[10] = 0;
  context.drainage.lakeFraction[10] = 0.00001;
  const cells = emitted(context, lakeShoreDetector);
  assert.deepEqual(
    [...cells.keys()].sort((a, b) => a - b),
    [...context.grid.triangles.subarray(30, 33)].sort((a, b) => a - b),
  );
  context.drainage.lakes[0].area = 0;
  assert.equal(
    emitted(context, lakeShoreDetector).size,
    0,
    'empty depressions are not small lakes',
  );
});

test('feature signals merge deterministically and retain detector provenance without double counting', () => {
  const context = fixture();
  const first: FeatureDetector = {
    id: 'first',
    detect: (_, emit) => {
      emit({ cell: 12, score: 0.6 });
      emit({ cell: 12, score: 0.8 });
    },
  };
  const second: FeatureDetector = {
    id: 'second',
    detect: (_, emit) => emit({ cell: 12, score: 0.9 }),
  };
  const plan = planFeatureRefinement(context, 500, [first, second]);
  assert.equal(plan.stats.candidateCells, 1);
  assert.equal(plan.stats.selectedCells, 1);
  assert.deepEqual(plan.resolved.caps[0].features, ['first', 'second']);
  assert.deepEqual(plan.stats.byDetector, {
    first: { candidates: 1, selected: 1 },
    second: { candidates: 1, selected: 1 },
  });
  assert.deepEqual(plan.resolved, planFeatureRefinement(context, 500, [second, first]).resolved);
  assert.throws(() => planFeatureRefinement(context, 500, [first, first]), /unique/);
});

test('compact detector scores retain provenance beyond 32 independent detectors', () => {
  const context = fixture();
  const detectors: FeatureDetector[] = Array.from({ length: 40 }, (_, index) => ({
    id: `feature-${String(index).padStart(2, '0')}`,
    detect: (_, emit) => {
      emit({ cell: 12, score: 0.5 + index / 100 });
      emit({ cell: 12, score: 0.4 });
    },
  }));
  const first = planFeatureRefinement(context, 500, detectors);
  const reverse = planFeatureRefinement(context, 500, [...detectors].reverse());
  assert.deepEqual(first.resolved, reverse.resolved);
  assert.equal(first.stats.candidateCells, 1);
  assert.deepEqual(
    first.resolved.caps[0].features,
    detectors.map((detector) => detector.id),
  );
  for (const detector of detectors) {
    assert.deepEqual(first.stats.byDetector[detector.id], { candidates: 1, selected: 1 });
  }
});

test('per-detector reserves protect independent coast and relief features from stronger outlet scores', () => {
  const context = fixture();
  const { grid } = context;
  const independent: number[] = [];
  const blocked = new Uint8Array(grid.count);
  for (let cell = 0; cell < grid.count && independent.length < 12; cell++) {
    if (blocked[cell]) {
      continue;
    }
    independent.push(cell);
    blocked[cell] = 1;
    for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
      blocked[grid.neighbors[offset]] = 1;
    }
  }
  assert.equal(independent.length, 12);
  const detectors: FeatureDetector[] = [
    {
      id: 'coast',
      detect: (_, emit) => {
        emit({ cell: independent[0], score: 0.1 });
        emit({ cell: independent[10], score: 0.5 });
      },
    },
    {
      id: 'outlet',
      detect: (_, emit) => {
        for (const cell of independent.slice(0, 10)) {
          emit({ cell, score: 1 });
        }
      },
    },
    {
      id: 'relief',
      detect: (_, emit) => {
        emit({ cell: independent[1], score: 0.1 });
        emit({ cell: independent[11], score: 0.4 });
      },
    },
  ];
  const plan = planFeatureRefinement(context, 600, detectors);
  const selected = (cell: number) =>
    plan.resolved.caps.some((cap) =>
      cap.center.every((value, axis) => value === grid.positions[cell * 3 + axis]),
    );
  assert.ok(
    selected(independent[10]),
    'coast reserve ranks its own coastal evidence, not the merged outlet score',
  );
  assert.ok(selected(independent[11]), 'relief reserve retains independent terrain detail');
  assert.ok(
    plan.stats.byDetector.outlet.selected > 1,
    'unused global capacity still prioritizes stronger remaining features',
  );
  assert.ok(plan.stats.estimatedAddedCells <= 600);
  assert.ok(plan.stats.stoppedByBudget);
  assert.deepEqual(
    plan.resolved,
    planFeatureRefinement(context, 600, [...detectors].reverse()).resolved,
  );
  for (const budget of [0, 1]) {
    const empty = planFeatureRefinement(context, budget, detectors);
    assert.equal(empty.stats.selectedCells, 0);
    assert.equal(empty.stats.budgetSkippedCells, independent.length);
    assert.equal(empty.resolved.caps.length, 0);
    assert.doesNotThrow(() => validateResolvedFeatureRefinementPlan(empty.resolved));
  }
});

test('selection stops at the estimated budget and valid empty plans record exhausted passes', () => {
  const context = fixture();
  const everywhere: FeatureDetector = {
    id: 'all',
    detect: ({ grid }, emit) => {
      for (let cell = 0; cell < grid.count; cell++) {
        emit({ cell, score: 1 });
      }
    },
  };
  const plan = planFeatureRefinement(context, 500, [everywhere]);
  assert.ok(plan.stats.selectedCells > 0);
  assert.ok(plan.stats.selectedCells < context.grid.count);
  assert.ok(plan.stats.estimatedAddedCells <= 500);
  assert.ok(plan.stats.stoppedByBudget);
  assert.ok(plan.stats.coveredCells > 0, 'adjacent proposals share a cap and graded halo');
  const empty = planFeatureRefinement(context, 0, [everywhere]);
  assert.equal(empty.resolved.caps.length, 0);
  assert.equal(empty.stats.candidateCells, context.grid.count);
  assert.equal(empty.stats.estimatedAddedCells, 0);
  assert.ok(empty.stats.stoppedByBudget);
  assert.doesNotThrow(() =>
    validateResolvedFeatureRefinementPlan(JSON.parse(JSON.stringify(empty.resolved))),
  );
  const noChange = refineGrid(
    context.grid,
    context.config.radius,
    context.config.seed,
    empty.spacingAt,
  );
  assert.equal(noChange.count, context.grid.count);
});

test('saved feature selection reproduces geometry independently of detector execution', () => {
  const context = fixture();
  const detector: FeatureDetector = {
    id: 'point',
    detect: (_, emit) => emit({ cell: 12, score: 1 }),
  };
  const first = planFeatureRefinement(context, 500, [detector]);
  const saved = JSON.parse(JSON.stringify(first.resolved));
  const replay = replayFeatureRefinement(context, saved, 500);
  const a = refineGrid(context.grid, context.config.radius, context.config.seed, first.spacingAt);
  const b = refineGrid(context.grid, context.config.radius, context.config.seed, replay.spacingAt);
  assert.ok(a.count > context.grid.count);
  assert.deepEqual(a.positions, b.positions);
  assert.deepEqual(a.triangles, b.triangles);
  assert.throws(() => replayFeatureRefinement(context, saved, 499), /does not match/);
  assert.throws(
    () => replayFeatureRefinement({ ...context, config: { ...context.config, erosion: 0 } }, saved),
    /does not match/,
  );
  const moved = { ...context.grid, positions: context.grid.positions.slice() };
  moved.positions[0] += 1e-10;
  assert.throws(
    () => replayFeatureRefinement({ ...context, grid: moved }, saved),
    /does not match/,
  );
});

test('feature plans reject invalid caps, provenance and statistics before mesh insertion', () => {
  const context = fixture();
  const detector: FeatureDetector = {
    id: 'point',
    detect: (_, emit) => emit({ cell: 12, score: 1 }),
  };
  const { resolved } = planFeatureRefinement(context, 500, [detector]);
  for (const mutate of [
    (copy: typeof resolved) => {
      copy.caps[0].center = [0, 0, 0];
    },
    (copy: typeof resolved) => {
      copy.caps[0].targetSpacingMetres = NaN;
    },
    (copy: typeof resolved) => {
      copy.caps[0].features = ['unknown'];
    },
    (copy: typeof resolved) => {
      copy.stats.selectedCells++;
    },
    (copy: typeof resolved) => {
      copy.maxAddedCells = 0;
    },
  ]) {
    const copy = structuredClone(resolved);
    mutate(copy);
    assert.throws(() => validateResolvedFeatureRefinementPlan(copy), /invalid geometry/);
  }
});

test('feature targets respect the physical floor and limit refinement to one local halving', () => {
  const context = fixture();
  const detector: FeatureDetector = {
    id: 'point',
    detect: (_, emit) => emit({ cell: 12, score: 1, targetSpacingMetres: 1 }),
  };
  const { resolved, spacingAt } = planFeatureRefinement(context, 500, [detector]);
  const cap = resolved.caps[0];
  assert.ok(cap.targetSpacingMetres >= context.config.featureRefinementSpacing);
  assert.ok(cap.targetSpacingMetres >= (cap.radiusMetres * Math.sqrt(3)) / 2);
  assert.ok(Math.abs(spacingAt(...cap.center) - cap.targetSpacingMetres) < 1e-7);
  const alreadyFine = planFeatureRefinement(
    { ...context, config: { ...context.config, featureRefinementSpacing: 1e9 } },
    500,
    [detector],
  );
  assert.equal(alreadyFine.stats.candidateCells, 0);
  assert.equal(alreadyFine.resolved.caps.length, 0);
});

test('coast and river detectors select physical transitions and receiving outlets', () => {
  const context = fixture();
  context.terrain.ocean[0] = 1;
  const coasts = emitted(context, coastlineDetector);
  assert.ok(!coasts.has(0));
  assert.deepEqual(
    [...coasts.keys()].sort((a, b) => a - b),
    [...context.grid.neighbors.subarray(context.grid.offsets[0], context.grid.offsets[1])].sort(
      (a, b) => a - b,
    ),
  );
  context.drainage.lakes.push({ id: 0, outlet: 11, outflow: 2 } as Lake);
  assert.deepEqual(
    [...emitted(context, riverFeatureDetector).keys()].sort((a, b) => a - b),
    [...context.grid.triangles.subarray(33, 36)]
      .filter((cell) => !context.terrain.ocean[cell])
      .sort((a, b) => a - b),
  );
});

test('river confluences outrank ordinary reaches before the final courses are built', () => {
  const context = fixture();
  const junction = 10;
  const [first, second, downstream] = context.grid.cornerNeighbors.subarray(
    junction * 3,
    junction * 3 + 3,
  );
  for (const corner of [first, second, junction, downstream]) {
    context.rivers.channel[corner] = 1;
  }
  context.drainage.receiver[first] = junction;
  context.drainage.receiver[second] = junction;
  context.drainage.receiver[junction] = downstream;
  context.drainage.discharge[first] = 10;
  context.drainage.discharge[second] = 5;
  const cells = emitted(context, riverFeatureDetector);
  for (const cell of context.grid.triangles.subarray(junction * 3, junction * 3 + 3)) {
    assert.ok(cells.get(cell)! >= 0.95, 'joining channels are a high-priority feature');
  }
  assert.ok(
    [...cells.values()].some((score) => score < 0.95),
    'ordinary source reaches keep their lower priority',
  );
});

test('terrain detector ignores a consistently reconstructed slope but selects a sharp local peak', () => {
  const context = fixture();
  const { grid } = context;
  const x = grid.positions[0];
  const z = grid.positions[2];
  const length = Math.hypot(x, z);
  const tangent = [-z / length, 0, x / length];
  for (let cell = 0; cell < grid.count; cell++) {
    context.terrain.height[cell] =
      10000 * (grid.positions[cell * 3] * tangent[0] + grid.positions[cell * 3 + 2] * tangent[2]);
  }
  assert.ok(
    !emitted(context, terrainReliefDetector).has(0),
    'local tangent-plane slope reconstructs without a curvature signal',
  );
  context.terrain.height[0] += 500;
  assert.ok(emitted(context, terrainReliefDetector).has(0));
});
