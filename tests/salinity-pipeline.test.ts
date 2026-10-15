import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/core/model';
import { generateWorld } from '../src/core/pipeline';
import {
  normalizedRefinementConfigSignature,
  refinementConfigSignature,
} from '../src/core/grid/refinement-config';

test('generation models one salt interval after all final mesh passes and before habitats', () => {
  const config = {
    ...DEFAULT_CONFIG,
    seed: 'AETHER-2408',
    surfaceLevel: 3,
    processLevel: 3,
    tectonicDuration: 0,
    erosion: 0,
    refinementStrength: 0,
    featureRefinementBudget: 0,
    featureCoarseningBudget: 0,
    salinityYears: 350,
  };
  const baseline = generateWorld({ ...config, featureRefinementPasses: 0 });
  const progress: [number, number][] = [];
  const additionalPasses = generateWorld(
    { ...config, featureRefinementPasses: 2 },
    (_, completed, total) => progress.push([completed, total]),
  );
  for (const world of [baseline, additionalPasses]) {
    const stages = world.timings.map(({ name }) => name);
    const salts = stages.indexOf('Lake salts & soil salinity');
    assert.equal(stages.filter((name) => name === 'Lake salts & soil salinity').length, 1);
    assert.ok(salts > stages.lastIndexOf('Final feature water & drainage · 2 / 2'));
    assert.ok(salts < stages.indexOf('Biomes & ecology'));
    assert.equal(world.terrain.saltAgeYears, 350);
    assert.equal(world.terrain.saltMass?.length, world.grid.count);
  }
  assert.deepEqual(additionalPasses.grid.positions, baseline.grid.positions);
  assert.deepEqual(additionalPasses.terrain.saltMass, baseline.terrain.saltMass);
  assert.deepEqual(additionalPasses.drainage.salinityBudget, baseline.drainage.salinityBudget);
  assert.deepEqual(progress.at(-1), [
    additionalPasses.timings.length,
    additionalPasses.timings.length,
  ]);
});

test('saved refinement signatures accept absent salinity defaults while retaining explicit values', () => {
  const oldEntries = Object.entries(DEFAULT_CONFIG).filter(
    ([key]) => !['salinityYears', 'weatheringSalinity', 'inheritedMarineSalinity'].includes(key),
  );
  assert.equal(
    normalizedRefinementConfigSignature(JSON.stringify(oldEntries)),
    refinementConfigSignature(DEFAULT_CONFIG),
  );
  assert.notEqual(
    normalizedRefinementConfigSignature(JSON.stringify([...oldEntries, ['salinityYears', 200]])),
    refinementConfigSignature(DEFAULT_CONFIG),
  );
});
