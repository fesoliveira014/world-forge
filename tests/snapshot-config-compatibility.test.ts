import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshotHandle } from '../src/app/useWorldGeneration';
import { DEFAULT_CONFIG, type WorldConfig } from '../src/core/model';
import { SNAPSHOT_SCHEMA_VERSION } from '../src/core/storage/codec';
import type { SnapshotDescriptor } from '../src/core/storage';

function savedSnapshot(config: Partial<WorldConfig>) {
  const summary = {
    config,
    surfaceCells: 327837,
    processCells: 10242,
    refinement: { baseCount: 40962, insertedCount: 286875, passes: 2 },
    nearestCenterSpacingM: {
      min: 5200,
      max: 210000,
      mean: 36000,
      p10: 10000,
      median: 25000,
      p90: 91000,
    },
  };
  const snapshot: SnapshotDescriptor = {
    id: 'saved-aether-2408',
    name: 'AETHER-2408 desert study',
    createdAt: 100,
    updatedAt: 200,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    worldVersion: '2.17.1',
    seed: 'AETHER-2408',
    surfaceCells: summary.surfaceCells,
    processCells: summary.processCells,
    bytes: 302000000,
    summary,
  };
  return { snapshot, summary };
}

test('legacy saved-world handles fill controls with legacy defaults without changing stored data', () => {
  const {
    featureRefinementPasses: _passes,
    featureRefinementSpacing: _spacing,
    featureRefinementBudget: _budget,
    featureDistrictStrength: _districtStrength,
    featureDistrictRadius: _districtRadius,
    featureDistrictThreshold: _districtThreshold,
    featureCoarseningBudget: _coarseningBudget,
    featureCoarseningSpacing: _coarseningSpacing,
    featureCoarseningTolerance: _coarseningTolerance,
    salinityYears: _salinityYears,
    weatheringSalinity: _weatheringSalinity,
    inheritedMarineSalinity: _inheritedMarineSalinity,
    ...legacyConfig
  } = DEFAULT_CONFIG;
  legacyConfig.seed = 'AETHER-2408';
  const { snapshot, summary } = savedSnapshot(legacyConfig);
  const before = structuredClone(snapshot);
  Object.freeze(legacyConfig);
  Object.freeze(summary);
  Object.freeze(snapshot);

  const handle = snapshotHandle(snapshot);
  assert.equal(handle.config.featureRefinementPasses, 0);
  assert.equal(handle.config.featureRefinementSpacing, 10000);
  assert.equal(handle.config.featureRefinementBudget, 20);
  assert.equal(handle.config.featureDistrictStrength, 0);
  assert.equal(handle.config.featureDistrictRadius, 300000);
  assert.equal(handle.config.featureDistrictThreshold, 5);
  assert.equal(handle.config.featureCoarseningBudget, 0);
  assert.equal(handle.config.featureCoarseningSpacing, 250000);
  assert.equal(handle.config.featureCoarseningTolerance, 25);
  assert.equal(handle.config.salinityYears, 100);
  assert.equal(handle.config.weatheringSalinity, 0.05);
  assert.equal(handle.config.inheritedMarineSalinity, 0);
  assert.equal(handle.config, handle.summary.config);
  assert.notEqual(handle.config, legacyConfig);
  assert.notEqual(handle.summary, summary);
  assert.deepEqual(snapshot, before, 'opening must not rewrite the stored snapshot');
  assert.equal(handle.snapshotId, snapshot.id);
  assert.equal(handle.name, snapshot.name);
  assert.equal(handle.version, snapshot.worldVersion);
  assert.equal(handle.saved, true, 'older snapshots without a saved flag remain saved');
  assert.equal(handle.config.seed, snapshot.seed);
  assert.equal(handle.summary.surfaceCells, snapshot.surfaceCells);
  assert.equal(handle.summary.processCells, snapshot.processCells);
  assert.equal(handle.summary.refinement, summary.refinement);
  assert.equal(handle.summary.nearestCenterSpacingM, summary.nearestCenterSpacingM);
});

test('saved handles preserve explicit feature settings, including disabled passes and zero budget', () => {
  for (const settings of [
    { featureRefinementPasses: 2, featureRefinementSpacing: 4000, featureRefinementBudget: 35 },
    { featureRefinementPasses: 0, featureRefinementSpacing: 100, featureRefinementBudget: 0 },
    {
      featureDistrictStrength: 85,
      featureDistrictRadius: 700000,
      featureDistrictThreshold: 8,
      featureCoarseningBudget: 15,
      featureCoarseningSpacing: 120000,
      featureCoarseningTolerance: 8,
    },
    { salinityYears: 0, weatheringSalinity: 0, inheritedMarineSalinity: 0 },
    { salinityYears: 700, weatheringSalinity: 0.12, inheritedMarineSalinity: 35 },
  ]) {
    const config = { ...DEFAULT_CONFIG, ...settings, seed: 'AETHER-2408-custom' };
    const { snapshot, summary } = savedSnapshot(config);
    snapshot.saved = false;
    const before = structuredClone(snapshot);
    const handle = snapshotHandle(snapshot);
    assert.deepEqual(handle.config, config);
    assert.equal(handle.config, handle.summary.config);
    assert.equal(handle.saved, false, 'configuration hydration must not save a draft');
    assert.equal(handle.name, snapshot.name);
    assert.equal(handle.snapshotId, snapshot.id);
    assert.equal(handle.config.seed, config.seed);
    assert.equal(handle.summary.refinement, summary.refinement);
    assert.equal(handle.summary.nearestCenterSpacingM, summary.nearestCenterSpacingM);
    assert.deepEqual(snapshot, before);
  }
});
