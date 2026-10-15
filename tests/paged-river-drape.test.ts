import assert from 'node:assert/strict';
import test from 'node:test';
import { generateWorld } from '../src/core/pipeline';
import { DEFAULT_CONFIG } from '../src/core/model';
import { MissingSnapshotFieldError } from '../src/core/storage';
import { prepareWorldView } from '../src/core/view/prepare';
import { PagedSpatialIndex, type PageValues } from '../src/core/view/spatial-index';
import { PagedHeightSampler } from '../src/core/view/height-sampler';
import { WorldViewReader } from '../src/core/view/reader';

const world = generateWorld({
  ...DEFAULT_CONFIG,
  seed: 'river-render-priority',
  surfaceLevel: 3,
  processLevel: 3,
  tectonicDuration: 5,
  fluvialDuration: 0.2,
  landscapeBatches: 1,
  riverSourceArea: 1000,
  riverSourceFlow: 0.1,
});
function pages(root: unknown): PageValues {
  const value = (path: string) =>
    path.split('.').reduce<unknown>((node, key) => {
      if (node === undefined || node === null || !(key in Object(node))) {
        throw new MissingSnapshotFieldError(key);
      }
      return (node as Record<string, unknown>)[key];
    }, root);
  return {
    async readValue(path) {
      return structuredClone(value(path));
    },
    async readValues(path, indices) {
      const source = value(path) as ArrayLike<number>;
      return Float64Array.from(indices, (i) => source[i]);
    },
    async readRange(path, start, count) {
      const source = value(path) as ArrayLike<number>;
      return Float64Array.from({ length: count }, (_, i) => source[start + i]);
    },
  };
}

test('optional river ranks put late major courses first and deduplicate delta references', () => {
  const fixture = structuredClone(world);
  const courses = fixture.rivers.courses;
  assert.ok(courses.corner.length >= 3);
  // Put every course in the same narrow geographic bin so storage order cannot
  // hide a major river appended late in the sparse course table.
  for (let point = 0; point < courses.points.length / 3; point++) {
    const lon = 0.02 + (point % 3) * 0.001;
    const lat = 0.02;
    courses.points.set(
      [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)],
      point * 3,
    );
  }
  fixture.drainage.discharge.fill(1);
  fixture.drainage.seasonalPeak?.fill(1);
  fixture.rivers.seasonalDischarge.forEach((field) => field.fill(1));
  const late = courses.corner.length - 1;
  const corner = courses.corner[late];
  fixture.rivers.seasonalDischarge[2][corner] = 123456;
  const branch = courses.points.slice(0, 6);
  fixture.rivers.deltas = [
    {
      corner,
      lake: -1,
      sedimentVolume: 0,
      branches: [
        { points: branch, fraction: 0.4 },
        { points: branch.slice(), fraction: 0.6 },
      ],
    },
  ];
  fixture.terrain.oxbows = [];
  const originalFlow = fixture.drainage.discharge.slice();
  const prepared = prepareWorldView(fixture);
  const rank = prepared.sidecars.view.overlay.riverRank;
  let represented = 0;
  for (let bin = 0; bin < rank.offsets.length - 1; bin++) {
    const start = rank.offsets[bin];
    const end = rank.offsets[bin + 1];
    const seen = new Set<string>();
    for (let row = start; row < end; row++) {
      const key = `${rank.refs[row * 2]}:${rank.refs[row * 2 + 1]}`;
      assert.ok(!seen.has(key), 'one reference per kind/id per bin');
      seen.add(key);
      if (row > start) {
        assert.ok(rank.scores[row] <= rank.scores[row - 1]);
      }
    }
    if (seen.has(`0:${late}`)) {
      represented++;
      assert.equal(rank.refs[start * 2], 0);
      assert.equal(rank.refs[start * 2 + 1], late);
      assert.equal(rank.scores[start], 123456);
      assert.ok(seen.has('3:0'), 'delta points share the course bin');
    }
  }
  assert.ok(represented > 0);
  assert.equal(prepared.sidecars.view.format, 'atlas-view/v2');
  assert.deepEqual(
    fixture.drainage.discharge,
    originalFlow,
    'display priority cannot change routed water',
  );
});

test('old view-v2 snapshots drape river endpoints on the same continuous surface as renderer queries', async () => {
  const fixture = structuredClone(world);
  // Lower routing heights demonstrate why corner heights cannot place ribbons
  // on the render mesh. The physical terrain and all persisted v2 stencils remain.
  fixture.drainage.height.fill(-20000);
  const prepared = prepareWorldView(fixture);
  const { offsets, refs } = prepared.sidecars.view.overlay;
  const oldSnapshot = {
    world: fixture,
    sidecars: { view: { ...prepared.sidecars.view, overlay: { offsets, refs } } },
  };
  const source = pages(oldSnapshot);
  const reader = await WorldViewReader.open(source);
  const sampler = new PagedHeightSampler(source, new PagedSpatialIndex(source), fixture.grid.count);
  const probes = Float32Array.from(fixture.grid.positions.subarray(0, 60));
  const duplicates = new Float32Array(probes.length * 2);
  duplicates.set(probes);
  duplicates.set(probes, probes.length);
  const expected = (await reader.sample(duplicates, 'world', -1)).heights;
  const heights = await sampler.sample(duplicates);
  assert.deepEqual(heights, expected, 'drape and renderer use identical Float32 height arithmetic');
  assert.deepEqual(heights.subarray(0, 20), heights.subarray(20));
  structuredClone(heights, { transfer: [heights.buffer] });
  assert.deepEqual(
    await sampler.sample(duplicates),
    expected,
    'transferring a packet preserves cached pages',
  );
  const packet = await reader.overlays({
    bounds: { west: -Math.PI, east: Math.PI, south: -Math.PI / 2, north: Math.PI / 2 },
    rivers: true,
    season: -1,
    maxSegments: 1200,
  });
  assert.ok(packet.rivers.heights.length > 0);
  const ground = await sampler.sample(packet.rivers.positions);
  assert.ok(
    ground.some((height) => height > 0),
    'test includes visible land courses',
  );
  for (let point = 0; point < ground.length; point++) {
    assert.ok(
      packet.rivers.heights[point] >= ground[point],
      'river endpoint never lies beneath the actual sampled terrain',
    );
  }
  await assert.rejects(() => sampler.sample(new Float32Array(60003)), /20,000/);
  assert.ok(
    sampler.cacheStats.faceBlocks <= 16 &&
      sampler.cacheStats.positionBlocks <= 32 &&
      sampler.cacheStats.renderBlocks <= 16,
  );
});
