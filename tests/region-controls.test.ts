import test from 'node:test';
import assert from 'node:assert/strict';
import { regionSettingsError } from '../src/app/region-settings';

test('regional controls validate a spherical footprint and finite physical spacing', () => {
  const region = { radiusMetres: 250000, targetSpacingMetres: 100, footprint: 'region' as const };
  assert.equal(regionSettingsError(region, 6371000), '');
  assert.match(regionSettingsError(region, 1000), /circumference/);

  for (const radiusMetres of [0, -1, NaN, Infinity]) {
    assert.match(regionSettingsError({ ...region, radiusMetres }, 6371000), /positive region/);
  }

  for (const targetSpacingMetres of [0, -1, NaN, Infinity]) {
    assert.match(
      regionSettingsError({ ...region, targetSpacingMetres }, 6371000),
      /positive target/,
    );
  }
});

test('watershed footprint ignores the unused circle radius but respects mesh precision', () => {
  assert.equal(
    regionSettingsError(
      { footprint: 'watershed', radiusMetres: 0, targetSpacingMetres: 100 },
      6371000,
    ),
    '',
  );
  assert.match(
    regionSettingsError(
      { footprint: 'region', radiusMetres: 250000, targetSpacingMetres: 0.001 },
      6371000,
    ),
    /precision/,
  );
});
