import assert from 'node:assert/strict';
import test from 'node:test';
import { Mesh, Vector3, type BufferGeometry } from 'three';
import type { FixedRiverBatch } from '../src/core/view/river-render-types';
import type { WorldHandle } from '../src/core/view/types';
import {
  FixedRiverAsset,
  FixedRivers,
  buildFixedRiverGeometry,
  paintFixedRiverBanks,
  type FixedRiverAppearance,
} from '../src/render/FixedRivers';

const handle = { config: { radius: 6371000 } } as WorldHandle;
const appearance: FixedRiverAppearance = {
  projection: 'globe',
  relief: 12,
  mapStyle: 'natural',
  layer: 'world',
  riverWidth: 1,
};
const direction = (longitude: number, latitude: number) => [
  Math.cos(latitude) * Math.cos(longitude),
  Math.sin(latitude),
  Math.cos(latitude) * Math.sin(longitude),
];
const rawBytes = (packet: FixedRiverBatch) =>
  Object.values(packet).reduce(
    (sum, value) => sum + (ArrayBuffer.isView(value) ? value.byteLength : 0),
    0,
  );

function fixture(kinds = [4, 0, 2, 4, 3, 1]): FixedRiverBatch {
  const offsets = [0];
  const points: number[] = [];
  for (let path = 0; path < kinds.length; path++) {
    for (let point = 0; point < 3 + (path % 3); point++) {
      points.push(
        ...direction(
          -0.35 + point * 0.013 + path * 0.027,
          0.11 + path * 0.023 + Math.sin(point) * 0.008,
        ),
      );
    }
    offsets.push(points.length / 3);
  }
  const count = points.length / 3;
  const packet: FixedRiverBatch = {
    batch: 0,
    totalBatches: 2,
    totalBytes: 0,
    totalPaths: kinds.length,
    totalPoints: count,
    offsets: Uint32Array.from(offsets),
    incoming: new Float32Array(kinds.length * 3),
    outgoing: new Float32Array(kinds.length * 3),
    kinds: Uint8Array.from(kinds),
    positions: Float32Array.from(points),
    heights: Float32Array.from({ length: count }, (_, point) => 90 + point * 12),
    halfWidths: Float32Array.from({ length: count }, (_, point) => 0.0004 + point * 0.000002),
    curvatureLimits: new Float32Array(count).fill(0.001),
    phase: Float32Array.from({ length: count }, (_, point) => -0.05 + point * 0.00013),
    activity: Float32Array.from({ length: count }, (_, point) => 0.2 + (point / count) * 0.7),
    sources: Uint8Array.from({ length: count }, (_, point) => point % 7),
    bankWidths: Float32Array.from({ length: count * 2 }, (_, component) =>
      component % 2 ? 0.001 : 0.002,
    ),
    bankColors: Float32Array.from({ length: count * 8 }, (_, component) =>
      component % 4 === 3 ? 0.86 : (component % 3) * 0.24 + 0.1,
    ),
  };
  for (let path = 0; path < kinds.length; path++) {
    new Vector3()
      .fromArray(packet.positions, offsets[path] * 3)
      .add(new Vector3(0.003, 0.002, -0.001))
      .normalize()
      .toArray(packet.incoming, path * 3);
    new Vector3()
      .fromArray(packet.positions, (offsets[path + 1] - 1) * 3)
      .add(new Vector3(-0.001, 0.002, 0.003))
      .normalize()
      .toArray(packet.outgoing!, path * 3);
  }
  packet.totalBytes = rawBytes(packet);
  return packet;
}

function sameGeometry(actual: BufferGeometry, expected: BufferGeometry) {
  assert.deepEqual(actual.index?.array, expected.index?.array);
  assert.deepEqual(Object.keys(actual.attributes), Object.keys(expected.attributes));
  for (const name of Object.keys(actual.attributes)) {
    assert.deepEqual(actual.getAttribute(name).array, expected.getAttribute(name).array, name);
  }
}

test('shared river assets release mixed bank payloads without changing any water field or geometry', () => {
  const raw = fixture();
  const expected = structuredClone(raw);
  const asset = new FixedRiverAsset();
  const retained = asset.addBatch(raw, { deferBankUpload: true })!;
  assert.ok(retained);
  const expectedPaths = Array.from(raw.kinds.keys()).filter((path) => raw.kinds[path] !== 4);
  const expectedPoints = expectedPaths.flatMap((path) =>
    Array.from(
      { length: raw.offsets[path + 1] - raw.offsets[path] },
      (_, point) => raw.offsets[path] + point,
    ),
  );
  for (const [field, size] of [
    ['positions', 3],
    ['heights', 1],
    ['halfWidths', 1],
    ['curvatureLimits', 1],
    ['phase', 1],
    ['activity', 1],
    ['sources', 1],
  ] as const) {
    const values = retained[field]!;
    assert.deepEqual(
      Array.from(values),
      expectedPoints.flatMap((point) =>
        Array.from(raw[field]!.subarray(point * size, (point + 1) * size)),
      ),
      field,
    );
    assert.equal(
      values.buffer.byteLength,
      values.byteLength,
      `${field} cannot retain excluded bank points through a backing buffer`,
    );
  }
  for (const field of ['incoming', 'outgoing'] as const) {
    assert.deepEqual(
      Array.from(retained[field]!),
      expectedPaths.flatMap((path) => Array.from(raw[field]!.subarray(path * 3, path * 3 + 3))),
      `${field} continuation halo`,
    );
  }
  assert.equal(retained.bankWidths.byteLength, 0);
  assert.equal(retained.bankColors.byteLength, 0);
  assert.deepEqual(
    Array.from(retained.kinds),
    expectedPaths.map((path) => raw.kinds[path]),
  );
  assert.equal(asset.sourceBytes, rawBytes(raw));
  assert.equal(asset.packetBytes, rawBytes(retained));
  assert.ok(asset.packetBytes < asset.sourceBytes * 0.5);
  assert.deepEqual(
    raw,
    expected,
    'consumption does not mutate an upstream packet or its cached worker copy',
  );
  for (const projection of ['globe', 'map'] as const) {
    for (const mapStyle of ['natural', 'relief', 'illustrated'] as const) {
      const options = {
        ...appearance,
        projection,
        mapStyle,
        riverWidth: 2.5,
        layer: 'sources' as const,
      };
      const before = buildFixedRiverGeometry(raw, handle.config.radius, options);
      const after = buildFixedRiverGeometry(retained, handle.config.radius, options);
      sameGeometry(after, before);
      before.dispose();
      after.dispose();
    }
  }
  asset.dispose();
});

test('one bank atlas keeps exact painting order and survives river group recreation', () => {
  const first = fixture([4, 0]);
  const second = fixture([4]);
  second.batch = 1;
  second.bankColors.fill(0.7);
  const expected = new Uint8Array(4096 * 2048 * 4);
  paintFixedRiverBanks(expected, 4096, 2048, first);
  paintFixedRiverBanks(expected, 4096, 2048, second);
  const asset = new FixedRiverAsset();
  asset.addBatch(first, { deferBankUpload: true });
  assert.equal(asset.addBatch(second, { deferBankUpload: true }), null);
  assert.equal(asset.receivedBatches, 2);
  assert.equal(asset.packets.length, 1, 'bank-only packets have no retained record');
  assert.deepEqual(
    asset.bankTexture.image.data,
    expected,
    'original atlas paint order and every pigment byte survive',
  );
  const sourceBytes = asset.sourceBytes;
  asset.addBatch(first);
  asset.addBatch(second);
  assert.equal(asset.receivedBatches, 2);
  assert.equal(
    asset.sourceBytes,
    sourceBytes,
    'duplicate arrivals do not retain or repaint raw inputs',
  );
  asset.flushBanks();
  const atlas = asset.bankTexture;
  const version = atlas.version;
  let atlasDisposals = 0;
  atlas.addEventListener('dispose', () => atlasDisposals++);
  const globe = new FixedRivers(handle, appearance, asset);
  asset.packets.forEach((packet) => globe.addBatch(packet));
  assert.equal(globe.children.length, 1);
  assert.equal(globe.bankTexture, atlas);
  globe.dispose();
  assert.equal(atlasDisposals, 0, 'scene teardown does not dispose the shared asset');
  const map = new FixedRivers(handle, { ...appearance, projection: 'map' }, asset);
  asset.packets.forEach((packet) => map.addBatch(packet));
  assert.equal(map.bankTexture, atlas);
  assert.equal(atlas.version, version, 'projection recreation does not repaint the atlas');
  assert.deepEqual(
    atlas.image.data,
    expected,
    'CPU atlas remains available for a new WebGL context',
  );
  const reference = buildFixedRiverGeometry(first, handle.config.radius, {
    ...appearance,
    projection: 'map',
  });
  sameGeometry((map.children[0] as Mesh).geometry, reference);
  reference.dispose();
  map.dispose();
  asset.dispose();
  asset.dispose();
  assert.equal(atlasDisposals, 1, 'explicit asset teardown disposes the atlas once');
  assert.equal(asset.bytes, 0);
  assert.equal(asset.packets.length, 0);
  assert.equal((atlas.image.data as Uint8Array).byteLength, 0);
  assert.equal(asset.addBatch(first), null, 'late arrivals cannot resurrect a disposed asset');
});

test('whole water batches share their original water buffers and release only bank payloads', () => {
  const raw = fixture([0, 1]);
  const asset = new FixedRiverAsset();
  const retained = asset.addBatch(raw)!;
  for (const field of [
    'positions',
    'heights',
    'halfWidths',
    'curvatureLimits',
    'phase',
    'activity',
    'sources',
    'incoming',
    'outgoing',
    'offsets',
    'kinds',
  ] as const) {
    assert.equal(
      retained[field],
      raw[field],
      `${field} is already compact and needs no duplicate allocation`,
    );
  }
  assert.equal(
    asset.sourceBytes - asset.packetBytes,
    raw.bankWidths.byteLength + raw.bankColors.byteLength,
  );
  assert.equal(
    asset.flushBanks(),
    false,
    'standalone consumption already publishes changed bank pixels',
  );
  asset.dispose();
});
