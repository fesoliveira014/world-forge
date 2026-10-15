import assert from 'node:assert/strict';
import test from 'node:test';
import type { FixedRiverBatch } from '../src/core/view/river-render-types';
import {
  buildZoomRiverConstraints,
  createZoomRiverConstraints,
} from '../src/core/view/zoom-river-constraints';

const radius = 6371000;
const direction = (longitude: number, latitude = 0) => [
  Math.cos(latitude) * Math.cos(longitude),
  Math.sin(latitude),
  Math.cos(latitude) * Math.sin(longitude),
];

function packet(paths: number[][][], kinds = paths.map(() => 0)): FixedRiverBatch {
  const points = paths.flat();
  const offsets = [0];
  for (const path of paths) {
    offsets.push(offsets[offsets.length - 1] + path.length);
  }
  return {
    batch: 0,
    totalBatches: 1,
    totalBytes: 0,
    totalPaths: paths.length,
    totalPoints: points.length,
    offsets: Uint32Array.from(offsets),
    incoming: new Float32Array(paths.length * 3),
    positions: Float32Array.from(points.flat()),
    heights: new Float32Array(points.length).fill(1200),
    halfWidths: new Float32Array(points.length).fill(0.001),
    phase: new Float32Array(points.length),
    activity: new Float32Array(points.length),
    sources: new Uint8Array(points.length),
    kinds: Uint8Array.from(kinds),
    bankWidths: new Float32Array(),
    bankColors: new Float32Array(),
  };
}

test('river constraints protect the complete corridor and end caps with a smooth outer feather', () => {
  const batch = packet([[direction(-0.04), direction(0.04)]]);
  const original = structuredClone(batch);
  const index = createZoomRiverConstraints([batch], radius);
  assert.equal(index.segmentCount, 1);
  assert.equal(index.attenuation(direction(0)), 0);
  assert.equal(index.attenuation(direction(0, 0.0009)), 0);
  assert.equal(index.attenuation(direction(0.0409)), 0);
  assert.ok(Math.abs(index.attenuation(direction(0, 0.0015)) - 0.5) < 0.001);
  assert.equal(index.attenuation(direction(0, 0.0021)), 1);
  assert.equal(index.attenuation(direction(0.0421)), 1);
  assert.equal(index.attenuation(direction(0, 0.0015), 0.001 * radius), 0);
  assert.equal(index.attenuation(direction(0, 0.0009).map((value) => value * 10)), 0);
  assert.deepEqual(batch, original, 'building and sampling never alter retained water data');
});

test('protection follows effective slider widths and curvature ceilings while oxbows stay unscaled', () => {
  const river = packet([[direction(-0.04), direction(0.04)]]);
  river.halfWidths.fill(0.0002);
  const index = createZoomRiverConstraints([river], radius);
  assert.equal(index.attenuation(direction(0, 0.00045), 0, 1), 1);
  assert.equal(index.attenuation(direction(0, 0.00045), 0, 2.5), 0);

  const capped = { ...river, curvatureLimits: new Float32Array(2).fill(0.0003) };
  const cappedIndex = createZoomRiverConstraints([capped], radius);
  assert.equal(cappedIndex.attenuation(direction(0, 0.00025), 0, 2.5), 0);
  assert.equal(cappedIndex.attenuation(direction(0, 0.00065), 0, 2.5), 1);

  for (const kind of [1, 2, 3]) {
    const oxbow = { ...river, kinds: Uint8Array.of(kind) };
    const pond = createZoomRiverConstraints([oxbow], radius);
    assert.equal(
      pond.attenuation(direction(0, 0.0003), 0, 0.5),
      pond.attenuation(direction(0, 0.0003), 0, 2.5),
    );
  }
});

test('a parent face margin protects an intersecting narrow river even when its center is outside the strip', () => {
  const batch = packet([[direction(-0.02), direction(0.02)]]);
  batch.halfWidths.fill(0.00001);
  const index = createZoomRiverConstraints([batch], radius);
  const faceCenter = direction(0, 0.005);
  assert.equal(index.attenuation(faceCenter), 1);
  assert.equal(index.attenuation(faceCenter, 0.006 * radius, 2.5), 0);
  assert.equal(index.attenuation(direction(0, 0.02), 0.006 * radius, 2.5), 1);
});

test('three-dimensional arc bounds cover long arcs, the dateline and both poles', () => {
  const cases = [
    { path: [direction(-1.4), direction(1.4)], midpoint: direction(0), away: direction(Math.PI) },
    {
      path: [direction(Math.PI - 0.02), direction(-Math.PI + 0.02)],
      midpoint: direction(Math.PI),
      away: direction(0),
    },
    { path: [direction(0, 1.5), direction(Math.PI, 1.5)], midpoint: [0, 1, 0], away: [0, -1, 0] },
    { path: [direction(0, -1.5), direction(Math.PI, -1.5)], midpoint: [0, -1, 0], away: [0, 1, 0] },
    {
      path: [direction(0.7, 0.3), direction(0.7, 0.3)],
      midpoint: direction(0.7, 0.3),
      away: direction(-0.7, -0.3),
    },
  ];
  for (const sample of cases) {
    const index = createZoomRiverConstraints([packet([sample.path])], radius);
    assert.equal(index.attenuation(sample.midpoint), 0);
    assert.equal(index.attenuation(sample.away), 1);
  }
});

test('path offsets and compact batch continuations create no missing or phantom connecting segments', () => {
  const path = [direction(-0.04), direction(0), direction(0.04)];
  const complete = createZoomRiverConstraints([packet([path])], radius);
  const first = packet([path.slice(0, 2)]);
  const next = packet([path.slice(1)]);
  next.batch = 1;
  next.incoming.set(path[0]);
  first.outgoing = Float32Array.from(path[2]);
  const split = createZoomRiverConstraints([first, next], radius);
  for (let longitude = -0.05; longitude <= 0.05; longitude += 0.003) {
    for (const latitude of [0, 0.0005, 0.0015, 0.004]) {
      assert.equal(
        split.attenuation(direction(longitude, latitude)),
        complete.attenuation(direction(longitude, latitude)),
      );
    }
  }
  const separated = packet(
    [
      [direction(-0.1), direction(-0.08)],
      [direction(0.08), direction(0.1)],
      [direction(-0.01), direction(0.01)],
    ],
    [0, 0, 4],
  );
  const index = createZoomRiverConstraints([separated], radius);
  assert.equal(index.segmentCount, 2);
  assert.equal(
    index.attenuation(direction(0)),
    1,
    'bank-only paths do not create water protection',
  );
  const empty = createZoomRiverConstraints([], radius);
  assert.equal(empty.bytes, 0);
  assert.equal(empty.attenuation(direction(0)), 1);
});

function distributedNetwork(count: number) {
  const paths: number[][][] = [];
  for (let index = 0; index < count; index++) {
    const latitude = Math.asin(1 - (2 * (index + 0.5)) / count);
    const longitude = index * Math.PI * (3 - Math.sqrt(5));
    paths.push([
      direction(longitude - 0.00001, latitude),
      direction(longitude + 0.00001, latitude),
    ]);
  }
  const batch = packet(paths);
  batch.halfWidths.fill(0.00001);
  return batch;
}

test('bounded index storage and local queries avoid scanning the complete retained network', () => {
  const batch = distributedNetwork(10000);
  const index = createZoomRiverConstraints([batch], radius);
  assert.ok(index.bytes <= index.segmentCount * 18, 'metadata stays below 18 bytes per segment');
  for (const sample of [0, 123, 4567, 9999]) {
    const point = batch.positions.subarray(sample * 6, sample * 6 + 3);
    assert.equal(index.attenuation(point), 0);
    assert.ok(index.lastVisitedSegments < 128, 'only nearby leaf segments are visited');
  }
});

test('cooperative construction matches synchronous answers and honors cancellation between slices', async () => {
  const batch = distributedNetwork(20000);
  const expected = createZoomRiverConstraints([batch], radius);
  let yields = 0;
  const actual = await buildZoomRiverConstraints([batch], radius, {
    async yieldControl() {
      yields++;
    },
  });
  assert.ok(yields > 0);
  assert.equal(actual.bytes, expected.bytes);
  for (const point of [direction(0), direction(0.8, 0.3), [0, 1, 0]]) {
    assert.equal(actual.attenuation(point, 50, 2.5), expected.attenuation(point, 50, 2.5));
  }
  const controller = new AbortController();
  await assert.rejects(
    buildZoomRiverConstraints([batch], radius, {
      signal: controller.signal,
      async yieldControl() {
        controller.abort();
      },
    }),
    { name: 'AbortError' },
  );
});
