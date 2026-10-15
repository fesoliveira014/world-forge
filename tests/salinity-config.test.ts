import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONFIG, VERSION } from '../src/core/model';
import { readWorldProject } from '../src/core/project';
import {
  normalizedRefinementConfigSignature,
  refinementConfigSignature,
} from '../src/core/grid/refinement-config';

test('pre-salt recipes acquire explicit defaults without changing saved refinement identity', () => {
  const {
    salinityYears: _years,
    weatheringSalinity: _weathering,
    inheritedMarineSalinity: _marine,
    ...config
  } = DEFAULT_CONFIG;
  for (const version of ['2.17.1', '2.26.0', '2.27.0']) {
    const recipe = { version, config: { ...config, seed: 'AETHER-2408' } };
    const before = structuredClone(recipe);
    const imported = readWorldProject(recipe);
    assert.equal(imported.config.salinityYears, 100);
    assert.equal(imported.config.weatheringSalinity, 0.05);
    assert.equal(imported.config.inheritedMarineSalinity, 0, 'no marine origin is inferred');
    const signature = JSON.stringify(
      Object.entries(recipe.config).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    assert.equal(
      normalizedRefinementConfigSignature(signature),
      refinementConfigSignature(imported.config),
    );
    assert.notEqual(
      normalizedRefinementConfigSignature(signature),
      refinementConfigSignature({ ...imported.config, salinityYears: 200 }),
    );
    assert.deepEqual(recipe, before);
  }
});

test('salt recipe controls preserve zero and reject invalid concentrations and durations', () => {
  for (const settings of [
    { salinityYears: 0, weatheringSalinity: 0, inheritedMarineSalinity: 0 },
    { salinityYears: 10000, weatheringSalinity: 1, inheritedMarineSalinity: 35 },
    { salinityYears: 125.5, weatheringSalinity: 0.13, inheritedMarineSalinity: 12.5 },
  ]) {
    const restored = readWorldProject({
      version: VERSION,
      config: { ...DEFAULT_CONFIG, ...settings },
    });
    for (const [key, value] of Object.entries(settings)) {
      assert.equal(restored.config[key as keyof typeof settings], value);
    }
  }
  const invalid = {
    salinityYears: [-1, 10001, NaN, Infinity],
    weatheringSalinity: [-0.01, 1.01, NaN, Infinity],
    inheritedMarineSalinity: [-1, 35.1, NaN, Infinity],
  };
  for (const [key, values] of Object.entries(invalid)) {
    for (const value of values) {
      assert.throws(
        () => readWorldProject({ version: VERSION, config: { ...DEFAULT_CONFIG, [key]: value } }),
        /outside the supported range/,
        `${key}=${value}`,
      );
    }
  }
});
