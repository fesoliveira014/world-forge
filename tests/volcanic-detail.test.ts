import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/core/model';
import { readVector } from '../src/core/math';
import { buildGrid } from '../src/core/grid/build';
import { createRegionSpacing, refineGrid } from '../src/core/grid/refine';
import { buildTransfer } from '../src/core/operators/spatial';
import { buildGeology } from '../src/core/generation/geology';
import { evolveCrust } from '../src/core/generation/crust-evolution';
import { createTerrain } from '../src/core/generation/terrain';
import { buildVolcanicDetail } from '../src/core/generation/volcanic-detail';
import { createScalarSampler } from '../src/core/operators/scalar-sampling';

function hotspotFixture(activity = 1) {
  const config = {
    ...DEFAULT_CONFIG,
    seed: 'VOLCANIC-BUDGET',
    processLevel: 2,
    surfaceLevel: 2,
    radius: 1000000,
    plates: 4,
    plateSpeed: 0,
    tectonicDuration: 20,
    volcanicActivity: activity,
    hotspotCount: 1,
    reliefScale: 1,
    erosion: 0,
  };
  const process = buildGrid(2, config.seed, config.irregularity);
  const geology = buildGeology(process, config);
  const position = readVector(process.positions, 30);
  geology.hotspots = [{ position, start: 0, end: 100, radius: 150000, rate: 300 }];
  evolveCrust(process, geology, config);

  return { process, geology, config, position };
}

test('fine volcanic edifices redistribute one geological volume on uniform and refined meshes', () => {
  const { process, geology, config, position } = hotspotFixture();
  const sources = geology.crust!.volcanicSources!;
  assert.equal(sources.length, 1, 'successive steps merge into one retained source');
  assert.ok(sources[0].volume > 0);
  assert.ok(sources[0].age > 0);
  const snapshot = structuredClone(geology);
  const spacing = createRegionSpacing(1000000, config.radius, [
    { center: position, radiusMetres: 240000, targetSpacingMetres: 45000 },
  ]);
  const refined = refineGrid(process, config.radius, config.seed, spacing);
  assert.ok(refined.count > process.count);
  let referenceVolume = 0;

  for (const surface of [process, refined, buildGrid(3, config.seed, config.irregularity)]) {
    const detail = buildVolcanicDetail(surface, process, geology, config);
    referenceVolume ||= detail.assignedVolume;
    assert.equal(detail.assignedVolume, referenceVolume);
    assert.ok(detail.fineVolume > 0 && detail.fineVolume <= detail.assignedVolume * 0.350001);
    assert.ok(Math.abs(detail.depositedVolume / detail.assignedVolume - 1) < 1e-7);
    assert.ok(detail.height.every((height) => Number.isFinite(height) && height >= 0));
  }

  assert.deepEqual(geology, snapshot, 'surface construction does not advance or mutate geology');
});

test('volcanic detail replaces the broad relief term and creates actual terrain relief', () => {
  const { process, geology, config, position } = hotspotFixture();
  const refined = refineGrid(
    process,
    config.radius,
    config.seed,
    createRegionSpacing(1000000, config.radius, [
      { center: position, radiusMetres: 240000, targetSpacingMetres: 45000 },
    ]),
  );
  const transfer = buildTransfer(process, refined);
  // Keep this budget check above the datum so the separate enclosed-basin
  // transformation cannot alter either construction field after sampling.
  geology.crust!.base.fill(8000);
  geology.crust!.material.fill(0);
  geology.uplift.fill(0);
  const broad = createTerrain(refined, process, transfer, geology, config, { continuous: true });
  const fine = createTerrain(refined, process, transfer, geology, config, {
    continuous: true,
    volcanicDetail: true,
  });
  const withoutVolcanics = structuredClone(geology);
  withoutVolcanics.crust!.volcanic.fill(0);
  const baseline = createTerrain(refined, process, transfer, withoutVolcanics, config, {
    continuous: true,
  });
  const detail = buildVolcanicDetail(refined, process, geology, config);
  let actualVolume = 0;
  let maximumChange = 0;

  for (let cell = 0; cell < refined.count; cell++) {
    maximumChange = Math.max(maximumChange, Math.abs(fine.height[cell] - broad.height[cell]));
    actualVolume +=
      (fine.height[cell] - baseline.height[cell]) * refined.areas[cell] * config.radius ** 2;
    assert.equal(fine.height[cell], fine.bedrock[cell]);
  }

  assert.ok(maximumChange > 500, 'edifices change generated terrain rather than metadata alone');
  assert.ok(Math.abs(actualVolume / detail.assignedVolume - 1) < 1e-6);
  assert.equal(fine.seaThreshold, broad.seaThreshold);
});

test('disabled volcanism allocates no source records or fine construction', () => {
  const { process, geology, config } = hotspotFixture(0);
  assert.deepEqual(geology.crust!.volcanicSources, []);
  assert.ok(geology.crust!.volcanic.every((height) => height === 0));
  const detail = buildVolcanicDetail(process, process, geology, config);
  assert.equal(detail.assignedVolume, 0);
  assert.equal(detail.depositedVolume, 0);
  assert.equal(detail.fineVolume, 0);
  assert.ok(detail.height.every((height) => height === 0));
});

test('a coarse surface cannot lose a volcanic province between its sample centers', () => {
  const { process, geology, config } = hotspotFixture();
  const coarse = buildGrid(0, config.seed, config.irregularity);
  const field = geology.crust!.volcanic;
  geology.crust!.volcanicSources = [];
  let missedCell = -1;

  for (let processCell = 0; processCell < process.count; processCell++) {
    field.fill(0);
    field[processCell] = 1000;
    const sample = createScalarSampler(process, field);

    if (
      Array.from({ length: coarse.count }, (_, cell) =>
        sample(...readVector(coarse.positions, cell)),
      ).every((value) => value === 0)
    ) {
      missedCell = processCell;
      break;
    }
  }

  assert.ok(missedCell >= 0, 'the fixture includes an unresolved province');
  const detail = buildVolcanicDetail(coarse, process, geology, config);
  assert.ok(Math.abs(detail.depositedVolume / detail.assignedVolume - 1) < 1e-7);
  assert.equal(detail.height.filter((value) => value > 0).length, 1);
});
