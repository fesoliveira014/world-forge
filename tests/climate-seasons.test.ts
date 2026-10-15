import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DEFAULT_CONFIG, type Climate } from '../src/core/model';
import { buildGrid } from '../src/core/grid/build';
import {
  combineClimateSeasons,
  prepareClimate,
  solveClimate,
  solveClimateSeason,
} from '../src/core/generation/climate';

function fixture() {
  const config = {
    ...DEFAULT_CONFIG,
    seed: 'SEASON-EXTRACTION',
    processLevel: 2,
    surfaceLevel: 2,
    moistureLifetime: 14,
    moistureMixing: 450000,
  };
  const grid = buildGrid(2, config.seed, config.irregularity);
  const height = Float32Array.from(
    { length: grid.count },
    (_, cell) => 1800 * Math.sin(grid.positions[cell * 3] * 7) - 400,
  );
  const ocean = Uint8Array.from(height, (value) => +(value < 0));
  const referenceOcean = Uint8Array.from(height, (value) => +(value < 250));
  const recycled = Float32Array.from({ length: grid.count }, (_, cell) => 120 + (cell % 11) * 35);

  return { grid, height, ocean, config, referenceOcean, recycled };
}

function climateDigest(climate: Climate): string {
  const hash = createHash('sha256');

  for (const field of [
    climate.temperature,
    climate.rain,
    climate.pet,
    climate.wind,
    climate.current,
    climate.sst,
    climate.moisture,
    climate.evaporation,
  ]) {
    for (const season of field) {
      hash.update(new Uint8Array(season.buffer, season.byteOffset, season.byteLength));
    }
  }

  hash.update(
    new Uint8Array(new Float64Array([climate.atmosphereResidual, climate.oceanDivergence]).buffer),
  );

  return hash.digest('hex');
}

test('season extraction preserves every pre-refactor climate buffer and diagnostic bit', () => {
  const { grid, height, ocean, config, referenceOcean, recycled } = fixture();
  // Captured from the original serial loop before extracting the seasonal solve.
  const initialDigest = 'b2eff96dd1e0ef042ca85df090735dbd7da68db26507c407eab5ba723789e1df';
  const recycledDigest = '12214dfafe0ad787a07806a5894a8b6e94c71a0fd2387003064f67b79c592548';
  assert.equal(
    climateDigest(solveClimate(grid, height, ocean, config, referenceOcean)),
    initialDigest,
  );
  assert.equal(
    climateDigest(solveClimate(grid, height, ocean, config, referenceOcean, recycled)),
    recycledDigest,
  );
});

test('cloned season jobs are independent and combine deterministically in completion order', () => {
  const { grid, height, ocean, config, referenceOcean, recycled } = fixture();
  const prepared = prepareClimate(grid, height, ocean, config, referenceOcean, recycled);
  const before = structuredClone(prepared);
  const completionOrder = [2, 0, 3, 1];
  const seasons = completionOrder.map((season) =>
    solveClimateSeason(structuredClone(prepared), season),
  );
  const parallelResult = combineClimateSeasons(seasons);
  const serialResult = solveClimate(grid, height, ocean, config, referenceOcean, recycled);
  assert.deepEqual(parallelResult, serialResult);
  assert.deepEqual(
    seasons.map((season) => season.seasonIndex),
    completionOrder,
  );
  assert.deepEqual(solveClimateSeason(prepared, 2), seasons[0]);
  assert.deepEqual(solveClimateSeason(prepared, 0), seasons[1]);
  assert.deepEqual(prepared, before, 'season workers cannot mutate shared preparation inputs');
});

test('season dispatch and assembly reject incomplete or duplicate jobs', () => {
  const { grid, height, ocean, config } = fixture();
  const prepared = prepareClimate(grid, height, ocean, config);

  for (const season of [-1, 4, 0.5, Number.NaN]) {
    assert.throws(() => solveClimateSeason(prepared, season), /season index/);
  }

  const first = solveClimateSeason(prepared, 0);
  assert.throws(() => combineClimateSeasons([first]), /exactly one result/);
  assert.throws(() => combineClimateSeasons([first, first, first, first]), /exactly one result/);
});
