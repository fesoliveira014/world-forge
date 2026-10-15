import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, VERSION } from '../src/core/model';
import { validateConfig } from '../src/core/config';
import { readWorldProject } from '../src/core/project';
import { buildGrid } from '../src/core/grid/build';
import { gridSpacing } from '../src/core/grid/spacing';

test('2.13.0 recipes receive disabled adaptive defaults and retain existing settings', () => {
  const legacyConfig = { ...DEFAULT_CONFIG };
  const { refinementMinSpacing: _spacing, refinementStrength: _strength, ...legacy } = legacyConfig;
  const imported = readWorldProject({ version: '2.13.0', config: legacy }).config;
  assert.equal(imported.refinementStrength, 0);
  assert.equal(imported.refinementMinSpacing, 100000);
  assert.equal(imported.surfaceLevel, legacy.surfaceLevel);
  assert.equal(imported.processLevel, legacy.processLevel);
  assert.equal(imported.seed, legacy.seed);
});

test('current adaptive recipes preserve explicit minimum spacing and strength', () => {
  const config = { ...DEFAULT_CONFIG, refinementMinSpacing: 100, refinementStrength: 1 };
  const recipe = JSON.parse(JSON.stringify({ version: VERSION, config }));
  assert.deepEqual(readWorldProject(recipe).config, config);
  assert.doesNotThrow(() =>
    validateConfig({ ...config, refinementMinSpacing: 1000000, refinementStrength: 0 }),
  );
});

test('adaptive recipe validation rejects invalid bounds, types, and non-finite numbers', () => {
  for (const refinementMinSpacing of [-100, 0, 99, 1000001, NaN, Infinity, '100000', null]) {
    assert.throws(
      () =>
        readWorldProject({ version: VERSION, config: { ...DEFAULT_CONFIG, refinementMinSpacing } }),
      /Minimum target spacing/,
    );
  }
  for (const refinementStrength of [-0.01, 1.01, NaN, Infinity, '0.5', null]) {
    assert.throws(
      () =>
        readWorldProject({ version: VERSION, config: { ...DEFAULT_CONFIG, refinementStrength } }),
      /Adaptive detail/,
    );
  }
  assert.throws(
    () => validateConfig({ ...DEFAULT_CONFIG, surfaceLevel: 3, processLevel: 4 }),
    /Simulation detail cannot exceed base surface detail/,
  );
});

test('spacing diagnostics use actual nearest center distances in physical metres', () => {
  const grid = buildGrid(3, 'SPACING-DIAGNOSTIC', 0.65);
  const stats = gridSpacing(grid, DEFAULT_CONFIG.radius);
  assert.ok(stats.min > 0);
  assert.ok(stats.min <= stats.p10 && stats.p10 <= stats.median);
  assert.ok(stats.median <= stats.p90 && stats.p90 <= stats.max);
  assert.ok(stats.mean >= stats.min && stats.mean <= stats.max);
  assert.equal(stats.min, Math.min(...grid.edgeDistance) * DEFAULT_CONFIG.radius);
  const doubled = gridSpacing(grid, DEFAULT_CONFIG.radius * 2);
  assert.equal(doubled.median, stats.median * 2);
  assert.equal(doubled.mean, stats.mean * 2);
});
