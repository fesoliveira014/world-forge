import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  NEW_WORLD_CONFIG,
  VERSION,
  type ResolvedRegionalRefinement,
  type World,
} from '../src/core/model';
import { SETTING_GROUPS, validateConfig } from '../src/core/config';
import { readWorldProject, worldProject } from '../src/core/project';
import {
  applyQualityPreset,
  matchingQualityPreset,
  QUALITY_PRESETS,
} from '../src/core/quality-presets';
import {
  normalizedRefinementConfigSignature,
  refinementConfigSignature,
} from '../src/core/grid/refinement-config';
import { buildGrid } from '../src/core/grid/build';
import {
  refinementGeometryHash,
  replaySurfaceRefinement,
  type ResolvedRefinementPlan,
} from '../src/core/grid/refinement-plan';
import { replayRegionalRefinements } from '../src/core/regional-refinement';
import type { ResolvedFeatureRefinementPlan } from '../src/core/grid/feature-refinement';
import type { ResolvedFeatureCoarseningPlan } from '../src/core/grid/feature-coarsening';

function legacyConfig() {
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
    ...config
  } = DEFAULT_CONFIG;
  return config;
}

function legacySignature() {
  return JSON.stringify(
    Object.entries(legacyConfig()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

test('legacy recipes keep final feature refinement disabled while fresh worlds enable it', () => {
  const legacy = { version: '2.17.1', config: legacyConfig() };
  const original = structuredClone(legacy);
  const imported = readWorldProject(legacy);
  assert.equal(imported.config.featureRefinementPasses, 0);
  assert.equal(imported.config.featureRefinementSpacing, 10000);
  assert.equal(imported.config.featureRefinementBudget, 20);
  assert.equal(imported.config.featureDistrictStrength, 0);
  assert.equal(imported.config.featureCoarseningBudget, 0);
  assert.equal(imported.config.featureDistrictRadius, 300000);
  assert.equal(imported.config.featureCoarseningSpacing, 250000);
  assert.deepEqual(legacy, original, 'import must not rewrite the supplied recipe');
  assert.equal(NEW_WORLD_CONFIG.featureRefinementPasses, 1);
  assert.equal(DEFAULT_CONFIG.featureRefinementPasses, 0);
  assert.equal(NEW_WORLD_CONFIG.featureDistrictStrength, 60);
  assert.equal(NEW_WORLD_CONFIG.featureCoarseningBudget, 10);
  assert.doesNotThrow(() => validateConfig(NEW_WORLD_CONFIG));
  for (const preset of QUALITY_PRESETS) {
    const config = applyQualityPreset(NEW_WORLD_CONFIG, preset);
    assert.equal(config.featureRefinementPasses, preset.id === 'quick' ? 0 : 1);
    assert.equal(config.featureRefinementSpacing, 10000);
    assert.equal(config.featureRefinementBudget, 20);
    assert.equal(config.featureDistrictStrength, preset.id === 'quick' ? 0 : 60);
    assert.equal(config.featureCoarseningBudget, preset.id === 'quick' ? 0 : 10);
    assert.equal(matchingQualityPreset(config)?.id, preset.id);
    assert.equal(
      matchingQualityPreset({ ...config, featureDistrictThreshold: 6 }),
      undefined,
      'district controls are part of quality preset identity',
    );
    assert.equal(
      matchingQualityPreset({ ...config, featureCoarseningTolerance: 26 }),
      undefined,
      'coarsening controls are part of quality preset identity',
    );
    assert.doesNotThrow(() => validateConfig(config));
  }
});

test('feature settings validate real limits and reject fractional pass counts', () => {
  const limits = {
    featureRefinementPasses: { valid: [0, 1, 2], invalid: [-1, 0.5, 3, NaN, Infinity] },
    featureRefinementSpacing: { valid: [100, 10000, 1000000], invalid: [0, 99, 1000001, NaN] },
    featureRefinementBudget: { valid: [0, 20, 50], invalid: [-1, 50.1, NaN, Infinity] },
    featureDistrictStrength: { valid: [0, 60, 100], invalid: [-1, 101, NaN, Infinity] },
    featureDistrictRadius: {
      valid: [50000, 300000, 1500000],
      invalid: [49999, 1500001, NaN, Infinity],
    },
    featureDistrictThreshold: { valid: [1, 5, 30], invalid: [0, 31, NaN, Infinity] },
    featureCoarseningBudget: { valid: [0, 10, 40], invalid: [-1, 41, NaN, Infinity] },
    featureCoarseningSpacing: {
      valid: [10000, 250000, 1000000],
      invalid: [9999, 1000001, NaN, Infinity],
    },
    featureCoarseningTolerance: { valid: [0, 25, 200], invalid: [-1, 201, NaN, Infinity] },
  };
  for (const [key, { valid, invalid }] of Object.entries(limits)) {
    for (const value of valid) {
      assert.doesNotThrow(() => validateConfig({ ...DEFAULT_CONFIG, [key]: value }));
    }
    for (const value of invalid) {
      assert.throws(
        () => readWorldProject({ version: VERSION, config: { ...DEFAULT_CONFIG, [key]: value } }),
        /outside the supported range/,
        `${key}: ${value}`,
      );
    }
  }
});

test('signature compatibility defaults absent feature settings and preserves recipe identity', () => {
  const signature = legacySignature();
  assert.equal(
    normalizedRefinementConfigSignature(signature),
    refinementConfigSignature(DEFAULT_CONFIG),
  );
  assert.notEqual(
    normalizedRefinementConfigSignature(signature),
    refinementConfigSignature(NEW_WORLD_CONFIG),
  );
  assert.notEqual(
    normalizedRefinementConfigSignature(signature),
    refinementConfigSignature({ ...DEFAULT_CONFIG, erosion: DEFAULT_CONFIG.erosion + 0.01 }),
  );
  for (const bad of ['null', '{}', 'broken', '[["seed","a"],["seed","b"]]', '[["erosion",null]]']) {
    assert.equal(normalizedRefinementConfigSignature(bad), null);
  }
  const withUnknown = JSON.parse(signature) as [string, string | number][];
  withUnknown.push(['unknownPhysicalSetting', 1]);
  assert.notEqual(
    normalizedRefinementConfigSignature(JSON.stringify(withUnknown)),
    refinementConfigSignature(DEFAULT_CONFIG),
    'unknown fields must not be silently discarded',
  );
});

test('v2.25 recipes preserve their feature passes without enabling district or quiet-land changes', () => {
  const config = {
    ...legacyConfig(),
    featureRefinementPasses: 2,
    featureRefinementSpacing: 20000,
    featureRefinementBudget: 35,
  };
  const imported = readWorldProject({ version: '2.25.0', config });
  assert.equal(imported.config.featureRefinementPasses, 2);
  assert.equal(imported.config.featureRefinementSpacing, 20000);
  assert.equal(imported.config.featureRefinementBudget, 35);
  assert.equal(imported.config.featureDistrictStrength, 0);
  assert.equal(imported.config.featureCoarseningBudget, 0);
  const oldSignature = JSON.stringify(
    Object.entries(config).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  assert.equal(
    normalizedRefinementConfigSignature(oldSignature),
    refinementConfigSignature(imported.config),
  );
  assert.notEqual(
    normalizedRefinementConfigSignature(oldSignature),
    refinementConfigSignature({ ...imported.config, featureDistrictStrength: 60 }),
  );
  assert.notEqual(
    normalizedRefinementConfigSignature(oldSignature),
    refinementConfigSignature({ ...imported.config, featureCoarseningBudget: 10 }),
  );
});

test('all regional detail controls are exposed in the automatic feature group', () => {
  const group = SETTING_GROUPS.find((entry) => entry.name === 'Automatic feature detail')!;
  for (const key of [
    'featureDistrictStrength',
    'featureDistrictRadius',
    'featureDistrictThreshold',
    'featureCoarseningBudget',
    'featureCoarseningSpacing',
    'featureCoarseningTolerance',
  ]) {
    const setting = group.settings.find((entry) => entry.key === key);
    assert.ok(setting, `${key} is available to users`);
    assert.ok(setting.description.length > 40, `${key} explains its effect`);
  }
  assert.equal(group.settings.find((entry) => entry.key === 'featureDistrictRadius')?.unit, 'km');
  assert.equal(
    group.settings.find((entry) => entry.key === 'featureCoarseningSpacing')?.unit,
    'km',
  );
  assert.equal(
    group.settings.find((entry) => entry.key === 'featureCoarseningTolerance')?.unit,
    'm',
  );
});

test('old surface and regional plans replay with defaulted fields while stale recipes still fail', () => {
  const grid = buildGrid(1, DEFAULT_CONFIG.seed, DEFAULT_CONFIG.irregularity);
  const signature = legacySignature();
  const geometryHash = refinementGeometryHash(grid);
  const surface: ResolvedRefinementPlan = {
    format: 'atlas-refinement-plan/v1',
    geometryHash,
    configSignature: signature,
    cellCount: grid.count,
    radiusMetres: DEFAULT_CONFIG.radius,
    baseSpacingMetres: 10000000,
    gradation: 0.35,
    targetSpacingMetres: Array(grid.count).fill(10000000),
    sourceRadiiMetres: Array(grid.count).fill(0),
    volcanicCaps: [],
  };
  const regional: ResolvedRegionalRefinement = {
    format: 'atlas-regional-refinement/v1',
    sourceGeometryHash: geometryHash,
    sourceCellCount: grid.count,
    configSignature: signature,
    planetRadiusMetres: DEFAULT_CONFIG.radius,
    baseSpacingMetres: 10000000,
    gradation: 0.35,
    request: {
      kind: 'region',
      center: [1, 0, 0],
      radiusMetres: 1000,
      targetSpacingMetres: 10000000,
    },
    caps: [{ center: [1, 0, 0], radiusMetres: 1000 }],
  };
  const snapshot = { grid, config: DEFAULT_CONFIG } as World;
  const original = structuredClone({ surface, regional });
  assert.doesNotThrow(() => replaySurfaceRefinement(grid, DEFAULT_CONFIG, surface));
  assert.equal(
    replayRegionalRefinements(snapshot, [regional]),
    snapshot,
    'coarse target is a no-op',
  );
  for (const config of [NEW_WORLD_CONFIG, { ...DEFAULT_CONFIG, seed: 'different' }]) {
    assert.throws(() => replaySurfaceRefinement(grid, config, surface), /does not match/);
    assert.throws(
      () => replayRegionalRefinements({ ...snapshot, config }, [regional]),
      /does not match/,
    );
  }
  assert.deepEqual({ surface, regional }, original, 'normalization must not mutate saved plans');
});

test('feature plans remain distinct from initial and regional plans in recipe files', () => {
  const feature: ResolvedFeatureRefinementPlan = {
    format: 'atlas-feature-refinement/v1',
    sourceGeometryHash: '42:fixture',
    configSignature: refinementConfigSignature(NEW_WORLD_CONFIG),
    sourceCellCount: 42,
    planetRadiusMetres: NEW_WORLD_CONFIG.radius,
    baseSpacingMetres: 100000,
    gradation: 0.35,
    maxAddedCells: 8,
    caps: [
      {
        center: [1, 0, 0],
        radiusMetres: 10000,
        targetSpacingMetres: 10000,
        features: ['lake-shores'],
      },
    ],
    stats: {
      candidateCells: 1,
      selectedCells: 1,
      estimatedAddedCells: 8,
      budgetSkippedCells: 0,
      coveredCells: 0,
      byDetector: { 'lake-shores': { candidates: 1, selected: 1 } },
      stoppedByBudget: false,
    },
  };
  const world = {
    version: VERSION,
    config: NEW_WORLD_CONFIG,
    resources: { recipe: 'test' },
    refinementPlans: [],
    featureRefinementPlans: [feature],
    featureCoarseningPlans: [
      {
        version: 1,
        pass: 0,
        sourceCellCount: 45,
        sourceGeometrySignature: '45:fixture',
        configSignature: refinementConfigSignature(NEW_WORLD_CONFIG),
        removedCells: [3, 12, 41],
      } satisfies ResolvedFeatureCoarseningPlan,
    ],
    regionalRefinements: [],
  } as unknown as World;
  const exported = JSON.parse(JSON.stringify(worldProject(world)));
  assert.deepEqual(exported.featureRefinementPlans, [feature]);
  const imported = readWorldProject(exported);
  assert.deepEqual(imported.refinementPlans, []);
  assert.deepEqual(imported.featureRefinementPlans, [feature]);
  assert.deepEqual(imported.featureCoarseningPlans, world.featureCoarseningPlans);
  assert.deepEqual(imported.regionalRefinements, []);
  assert.throws(
    () => readWorldProject({ ...exported, featureRefinementPlans: {} }),
    /feature refinement plans must be an array/,
  );
  assert.throws(
    () => readWorldProject({ ...exported, featureRefinementPlans: [{}] }),
    /feature refinement/i,
  );
  assert.throws(
    () => readWorldProject({ ...exported, featureCoarseningPlans: {} }),
    /feature coarsening plans must be an array/,
  );
  assert.throws(
    () => readWorldProject({ ...exported, featureCoarseningPlans: [{}] }),
    /quiet-land coarsening/i,
  );
  assert.throws(
    () => readWorldProject({ ...exported, featureCoarseningPlans: [] }),
    /coarsening plan count/,
  );
  assert.throws(
    () =>
      readWorldProject({
        ...exported,
        config: { ...NEW_WORLD_CONFIG, featureCoarseningBudget: 0 },
      }),
    /coarsening plan count/,
  );
  assert.doesNotThrow(() => readWorldProject({ ...exported, featureCoarseningPlans: undefined }));
});
