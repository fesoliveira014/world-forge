import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, type Drainage, type Terrain, type Rivers } from '../src/core/model';
import { buildGrid } from '../src/core/grid/build';
import { analyzeLakeDistricts, lakeShoreEvidence } from '../src/core/grid/feature-districts';
import {
  lakeDistrictDetector,
  planFeatureRefinement,
  replayFeatureRefinement,
  type FeatureRefinementContext,
} from '../src/core/grid/feature-refinement';
import { refineGrid } from '../src/core/grid/refine';

function fixture(): FeatureRefinementContext {
  const config = {
    ...DEFAULT_CONFIG,
    seed: 'physical-lake-districts',
    radius: 1_000_000,
    featureRefinementSpacing: 10_000,
    featureDistrictStrength: 60,
    featureDistrictRadius: 300_000,
    featureDistrictThreshold: 5,
  };
  const grid = buildGrid(4, config.seed, 0.25);
  return {
    grid,
    config,
    terrain: { ocean: new Uint8Array(grid.count), height: new Float32Array(grid.count) } as Terrain,
    drainage: {
      lakeCoverage: new Float32Array(grid.count),
      seasonalLakeCoverage: Array.from({ length: 4 }, () => new Float32Array(grid.count)),
    } as unknown as Drainage,
    rivers: {} as Rivers,
  };
}

function populate(context: FeatureRefinementContext, center = [1, 0, 0]) {
  const { grid, drainage } = context;
  for (let cell = 0; cell < grid.count; cell++) {
    const dot = center.reduce(
      (sum, value, axis) => sum + value * grid.positions[cell * 3 + axis],
      0,
    );
    if (dot > Math.cos(0.55) && cell % 3 === 0) {
      drainage.seasonalLakeCoverage![0][cell] = 0.35;
      drainage.lakeCoverage[cell] = 0.35 / 4;
    }
  }
}

test('lake districts extend through dry gaps but do not classify distant uniform terrain', () => {
  const context = fixture();
  populate(context);
  const result = analyzeLakeDistricts(context);
  const { grid, drainage } = context;
  const dryInterior: number[] = [];
  let distant = 0;
  for (let cell = 0; cell < grid.count; cell++) {
    if (grid.positions[cell * 3] > Math.cos(0.2) && drainage.lakeCoverage[cell] === 0) {
      dryInterior.push(cell);
    }
    if (grid.positions[cell * 3] < 0) {
      distant++;
      assert.equal(result.strength[cell], 0);
    }
  }
  assert.ok(dryInterior.length > 10);
  assert.ok(distant > 1000);
  assert.ok(dryInterior.every((cell) => result.strength[cell] > 0));
  assert.ok(result.candidates.length > 5);
  assert.ok(result.candidates.every((candidate) => candidate.radiusMetres === 300_000));
});

test('districts need spatially distributed physical water evidence and ignore annual season mixing', () => {
  const context = fixture();
  context.drainage.seasonalLakeCoverage![0][12] = 0.35;
  assert.equal(
    analyzeLakeDistricts(context).candidates.length,
    0,
    'one small lake stays a fine feature',
  );
  context.drainage.seasonalLakeCoverage![0].fill(0);
  context.drainage.seasonalLakeCoverage![1].fill(1);
  context.drainage.seasonalLakeCoverage![3].fill(1);
  context.drainage.lakeCoverage.fill(0.5);
  assert.ok(lakeShoreEvidence(context).every((value) => value === 0));
  assert.equal(analyzeLakeDistricts(context).candidates.length, 0);
});

test('district analysis is geographic at the longitude seam and pole and excludes oceans', () => {
  for (const center of [
    [-1, 0, 0],
    [0, 1, 0],
  ]) {
    const context = fixture();
    populate(context, center);
    const result = analyzeLakeDistricts(context);
    assert.ok(result.candidates.length > 5);
    for (let cell = 0; cell < context.grid.count; cell++) {
      const dot = center.reduce(
        (sum, value, axis) => sum + value * context.grid.positions[cell * 3 + axis],
        0,
      );
      if (dot > Math.cos(0.15)) {
        assert.ok(result.strength[cell] > 0);
      }
    }
    context.terrain.ocean.fill(1);
    assert.equal(analyzeLakeDistricts(context).candidates.length, 0);
  }
});

test('district knobs disable detection or require stronger regional evidence', () => {
  const context = fixture();
  populate(context);
  const low = analyzeLakeDistricts(context);
  const high = analyzeLakeDistricts({
    ...context,
    config: { ...context.config, featureDistrictThreshold: 30 },
  });
  assert.ok(low.candidates.length > high.candidates.length);
  const disabled = analyzeLakeDistricts({
    ...context,
    config: { ...context.config, featureDistrictStrength: 0 },
  });
  assert.equal(disabled.candidates.length, 0);
  assert.ok(disabled.strength.every((value) => value === 0));
});

test('large districts fit bounded continuous caps and retain exact saved-plan replay', () => {
  const context = fixture();
  populate(context);
  const plan = planFeatureRefinement(context, 400, [lakeDistrictDetector]);
  assert.ok(plan.resolved.caps.length > 0);
  assert.ok(plan.resolved.caps.some((cap) => cap.radiusMetres > 60_000));
  assert.ok(
    plan.resolved.caps.some((cap) => cap.radiusMetres < context.config.featureDistrictRadius),
  );
  assert.ok(plan.stats.estimatedAddedCells <= 400);
  let coveredDryCells = 0;
  for (const cap of plan.resolved.caps) {
    const cosine = Math.cos((cap.radiusMetres * 0.8) / context.config.radius);
    for (let cell = 0; cell < context.grid.count; cell++) {
      if (context.drainage.lakeCoverage[cell] > 0) {
        continue;
      }
      const point: [number, number, number] = [
        context.grid.positions[cell * 3],
        context.grid.positions[cell * 3 + 1],
        context.grid.positions[cell * 3 + 2],
      ];
      if (point.reduce((dot, value, axis) => dot + value * cap.center[axis], 0) < cosine) {
        continue;
      }
      coveredDryCells++;
      assert.ok(plan.spacingAt(...point) <= cap.targetSpacingMetres * (1 + 1e-9));
    }
  }
  assert.ok(
    coveredDryCells > 5,
    'the selected district refines dry gaps, not just wet source cells',
  );
  const saved = JSON.parse(JSON.stringify(plan.resolved));
  const replay = replayFeatureRefinement(context, saved, 400);
  const a = refineGrid(context.grid, context.config.radius, context.config.seed, plan.spacingAt, {
    maxAddedCells: 400,
  });
  const b = refineGrid(context.grid, context.config.radius, context.config.seed, replay.spacingAt, {
    maxAddedCells: 400,
  });
  assert.ok(a.count > context.grid.count);
  assert.ok(a.count <= context.grid.count + 400);
  assert.deepEqual(a.positions, b.positions);
  assert.deepEqual(a.triangles, b.triangles);
});
