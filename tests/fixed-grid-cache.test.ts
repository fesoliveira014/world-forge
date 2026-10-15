import assert from 'node:assert/strict';
import test from 'node:test';
import type { FixedGridManifest, FixedGridPacket } from '../src/core/view/fixed-grid-types';
import type { WorldViewSource } from '../src/core/view/types';
import { FixedGridCache } from '../src/render/FixedGridCache';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function packet(batch: number): FixedGridPacket {
  const vertices = new Float32Array([1, 0, 0, 100, 0, 1, 0, 200]);
  const indices = new Uint16Array([0, 1]);
  const landCoverage = new Uint8Array([255, 255]);
  return {
    batch,
    firstEdge: batch,
    vertexCount: 2,
    edgeCount: 1,
    vertices,
    landCoverage,
    indices,
    bytes: vertices.byteLength + landCoverage.byteLength + indices.byteLength,
  };
}
const manifest: FixedGridManifest = {
  format: 'atlas-fixed-grid/v1',
  batches: 2,
  edges: 2,
  vertices: 4,
  estimatedBytes: 76,
};
function fixture() {
  const manifestReply = deferred<FixedGridManifest>();
  const replies: ReturnType<typeof deferred<FixedGridPacket>>[] = [];
  const calls: number[] = [];
  let manifests = 0;
  let cancellations = 0;
  let releases = 0;
  const source = {
    gridManifest() {
      manifests++;
      return manifestReply.promise;
    },
    gridBatch(batch: number) {
      calls.push(batch);
      const reply = deferred<FixedGridPacket>();
      replies.push(reply);
      return reply.promise;
    },
    cancelGridRender() {
      cancellations++;
    },
    releaseGridRender() {
      releases++;
      return releases > 1;
    },
  } as unknown as WorldViewSource;
  const cache = new FixedGridCache(source, 'snapshot-a');
  return {
    source,
    cache,
    calls,
    replies,
    manifestReply,
    get manifests() {
      return manifests;
    },
    get cancellations() {
      return cancellations;
    },
    get releases() {
      return releases;
    },
  };
}
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('grid loading did not reach the expected state');
}

test('grid loading is lazy, pauses between bounded packets, and retains data across toggles', async () => {
  const f = fixture();
  try {
    assert.equal(f.manifests, 0);
    f.cache.setEnabled(true);
    assert.equal(f.manifests, 1);
    f.cache.setEnabled(false);
    f.manifestReply.resolve(manifest);
    await until(() => f.cache.manifest !== null);
    assert.deepEqual(f.calls, [], 'turning off during manifest loading starts no packet reads');
    f.cache.setEnabled(true);
    await until(() => f.calls.length === 1);
    f.cache.setEnabled(false);
    const first = packet(0);
    f.replies[0].resolve(first);
    await until(() => f.cache.packets.length === 1);
    assert.equal(f.cache.packets[0], first, 'compact arrays are shared, not copied');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(f.calls, [0], 'at most one packet remains in flight when hidden');
    f.cache.setEnabled(true);
    await until(() => f.calls.length === 2);
    f.replies[1].resolve(packet(1));
    await until(() => f.cache.done);
    assert.equal(f.cache.bytes, 76);
    assert.equal(f.cache.released, false, 'an occupied reader is retried on a later update');
    f.cache.setEnabled(true);
    assert.equal(f.cache.released, true);
    for (let update = 0; update < 20; update++) {
      f.cache.setEnabled(false);
      f.cache.setEnabled(true);
    }
    assert.equal(f.manifests, 1);
    assert.deepEqual(f.calls, [0, 1]);
    assert.equal(
      f.cache.requests,
      3,
      'camera/appearance updates and toggles never reread loaded edges',
    );
    f.cache.dispose();
    f.cache.dispose();
    assert.equal(f.cancellations, 1);
    assert.equal(f.cache.bytes, 0);
    assert.deepEqual(Array.from(first.vertices), [1, 0, 0, 100, 0, 1, 0, 200]);
  } finally {
    f.cache.dispose();
  }
});

test('source replacement discards late manifest and packet replies without installing stale edges', async () => {
  const beforeManifest = fixture();
  beforeManifest.cache.setEnabled(true);
  beforeManifest.cache.dispose();
  beforeManifest.manifestReply.resolve(manifest);
  await Promise.resolve();
  assert.equal(beforeManifest.cache.manifest, null);
  assert.deepEqual(beforeManifest.calls, []);
  const beforePacket = fixture();
  beforePacket.cache.setEnabled(true);
  beforePacket.manifestReply.resolve(manifest);
  await until(() => beforePacket.calls.length === 1);
  beforePacket.cache.dispose();
  beforePacket.replies[0].resolve(packet(0));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(beforePacket.cache.manifest, null);
  assert.deepEqual(beforePacket.cache.packets, []);
  assert.equal(beforePacket.cancellations, 1);
  assert.equal(beforePacket.cache.error, '');
});

test('failed packet reads keep completed geometry and retry only after explicit off/on', async () => {
  const f = fixture();
  try {
    f.cache.setEnabled(true);
    f.manifestReply.resolve(manifest);
    await until(() => f.calls.length === 1);
    const first = packet(0);
    f.replies[0].resolve(first);
    await until(() => f.calls.length === 2);
    f.replies[1].reject(new Error('IndexedDB read failed'));
    await until(() => !!f.cache.error);
    assert.equal(f.cancellations, 1, 'retry will create a fresh lane after a worker failure');
    for (let update = 0; update < 20; update++) {
      f.cache.setEnabled(true);
    }
    assert.deepEqual(f.calls, [0, 1]);
    assert.equal(f.cache.packets[0], first);
    f.cache.setEnabled(false);
    f.cache.setEnabled(true);
    await until(() => f.calls.length === 3);
    assert.deepEqual(f.calls, [0, 1, 1]);
    f.replies[2].resolve(packet(1));
    await until(() => f.cache.done);
    assert.equal(f.cache.error, '');
    assert.equal(f.cache.packets[0], first);
    assert.equal(f.manifests, 1);
  } finally {
    f.cache.dispose();
  }
});
