import assert from 'node:assert/strict';
import test from 'node:test';
import { WorldDataClient } from '../src/app/WorldDataClient';

class TestWorker {
  static latest: TestWorker;
  static instances: TestWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  messages: { id: number; snapshotId: string; method: string; args: unknown[] }[] = [];
  constructor() {
    TestWorker.latest = this;
    TestWorker.instances.push(this);
  }
  postMessage(message: TestWorker['messages'][number]) {
    this.messages.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(value: unknown, snapshotId = 'snapshot-one') {
    this.onmessage?.({ data: { id: this.messages.at(-1)!.id, snapshotId, value } });
  }
}

test('paged client rejects stale revisions and ignores replies after disposal', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = TestWorker as unknown as typeof Worker;
  try {
    const client = new WorldDataClient('snapshot-one');
    const worker = TestWorker.latest;
    const result = client.diagnostics();
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    worker.reply({ wrong: true }, 'snapshot-two');
    await Promise.resolve();
    assert.equal(settled, false);
    worker.reply({ surfaceCells: 100 });
    assert.deepEqual(await result, { surfaceCells: 100 });
    const pending = client.inspect([1, 0, 0], -1);
    const rejected = assert.rejects(pending, /closed/);
    const lateReply = worker.onmessage!;
    client.dispose();
    await rejected;
    lateReply({ data: { id: 2, snapshotId: 'snapshot-one', value: {} } });
    assert.equal(worker.terminated, true);
    await assert.rejects(client.diagnostics(), /closed/);
  } finally {
    globalThis.Worker = previous;
  }
});

const overlayRequest = {
  bounds: { west: -Math.PI, east: Math.PI, south: -Math.PI / 2, north: Math.PI / 2 },
  season: -1,
  rivers: true,
};

test('persistent grid loading has an independent lane with guarded release and cancellation', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = TestWorker as unknown as typeof Worker;
  try {
    const client = new WorldDataClient('snapshot-one');
    const primary = TestWorker.latest;
    assert.equal(client.releaseGridRender(), false);
    const manifest = client.gridManifest();
    const grid = TestWorker.latest;
    assert.notEqual(grid, primary);
    assert.equal(grid.messages[0].method, 'gridManifest');
    assert.equal(
      client.releaseGridRender(),
      false,
      'a pending manifest is never aborted by release',
    );
    const terrain = client.physicalManifest('world', -1);
    primary.reply({ batches: 3 });
    assert.deepEqual(
      await terrain,
      { batches: 3 },
      'terrain completes without waiting for the grid',
    );
    grid.reply({ batches: 2, edges: 12000 });
    assert.deepEqual(await manifest, { batches: 2, edges: 12000 });
    const batch = client.gridBatch(1);
    assert.deepEqual(grid.messages.at(-1)!.args, [1]);
    assert.equal(client.releaseGridRender(), false);
    grid.reply({ batch: 1 });
    assert.deepEqual(await batch, { batch: 1 });
    assert.equal(client.releaseGridRender(), true);
    assert.equal(grid.terminated, true);
    assert.equal(primary.terminated, false);
    assert.equal(client.releaseGridRender(), false);
    const cancelled = assert.rejects(client.gridBatch(0), { name: 'AbortError' });
    const obsolete = TestWorker.latest;
    const late = obsolete.onmessage!;
    const oldId = obsolete.messages[0].id;
    client.cancelGridRender();
    await cancelled;
    assert.ok(obsolete.terminated);
    const current = client.gridBatch(0);
    const replacement = TestWorker.latest;
    let settled = false;
    void current.then(() => {
      settled = true;
    });
    late({ data: { id: oldId, snapshotId: 'snapshot-one', value: { stale: true } } });
    await Promise.resolve();
    assert.equal(settled, false);
    replacement.reply({ batch: 0, current: true });
    assert.deepEqual(await current, { batch: 0, current: true });
    client.dispose();
    assert.ok(primary.terminated && replacement.terminated);
    await assert.rejects(client.gridManifest(), /closed/);
  } finally {
    globalThis.Worker = previous;
  }
});

test('grid reader errors stay local, statistics include its bounded cache, and disposal cancels pending packets', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = TestWorker as unknown as typeof Worker;
  try {
    const client = new WorldDataClient('snapshot-one');
    const primary = TestWorker.latest;
    const gridRequest = client.gridManifest();
    const grid = TestWorker.latest;
    grid.reply({ batches: 1 });
    await gridRequest;
    const stats = {
      cachedPageBytes: 100,
      cachedMetadataBytes: 10,
      cachedPages: 1,
      pageReads: 2,
      activePageReads: 0,
    };
    const total = client.pagingStats();
    primary.reply(stats);
    grid.reply(stats);
    assert.deepEqual(await total, {
      readerCount: 2,
      cachedPageBytes: 200,
      cachedMetadataBytes: 20,
      cachedPages: 2,
      pageReads: 4,
      activePageReads: 0,
    });
    const failed = assert.rejects(client.gridBatch(0), /grid crashed/);
    grid.onerror!({ message: 'grid crashed' });
    await failed;
    const terrain = client.physicalManifest('world', -1);
    primary.reply({ batches: 1 });
    assert.deepEqual(await terrain, { batches: 1 });
    assert.equal(primary.terminated, false);
    client.cancelGridRender();
    const pending = assert.rejects(client.gridBatch(0), /closed/);
    const replacement = TestWorker.latest;
    client.dispose();
    await pending;
    assert.ok(replacement.terminated && primary.terminated);
  } finally {
    globalThis.Worker = previous;
  }
});

test('complete river preparation cannot block terrain, inspection or independent overlays', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = TestWorker as unknown as typeof Worker;
  try {
    const client = new WorldDataClient('snapshot-one');
    const primary = TestWorker.latest;
    const river = client.riverRender({ season: -1, threshold: 20, batch: 0 });
    const riverWorker = TestWorker.latest;
    const overlay = client.overlays(overlayRequest);
    const overlayWorker = TestWorker.latest;
    assert.equal(new Set([primary, riverWorker, overlayWorker]).size, 3);
    const manifest = client.physicalManifest('world', -1);
    assert.equal(primary.messages.at(-1)!.method, 'physicalManifest');
    primary.reply({ batches: 12 });
    assert.deepEqual(await manifest, { batches: 12 });
    const batch = client.physicalBatch('world', -1, 3);
    assert.deepEqual(primary.messages.at(-1)!.args, ['world', -1, 3]);
    primary.reply({ batch: 3, bytes: 100 });
    assert.deepEqual(await batch, { batch: 3, bytes: 100 });
    overlayWorker.reply({ gridStatus: 'visible' });
    assert.deepEqual(await overlay, { gridStatus: 'visible' });
    const inspection = client.inspect([1, 0, 0], -1);
    primary.reply({ cell: 7 });
    assert.deepEqual(await inspection, { cell: 7 });
    const rejected = assert.rejects(river, /closed/);
    client.dispose();
    await rejected;
    assert.ok([primary, riverWorker, overlayWorker].every((worker) => worker.terminated));
    await assert.rejects(client.riverRender({ season: 0, threshold: 20, batch: 1 }), /closed/);
  } finally {
    globalThis.Worker = previous;
  }
});

test('river worker failure remains local and its page cache is counted separately', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = TestWorker as unknown as typeof Worker;
  try {
    const client = new WorldDataClient('snapshot-one');
    const primary = TestWorker.latest;
    const river = client.riverRender({ season: 2, threshold: 20, batch: 0 });
    const riverWorker = TestWorker.latest;
    riverWorker.reply({ totalBatches: 1 });
    await river;
    const stats = {
      cachedPageBytes: 100,
      cachedMetadataBytes: 10,
      cachedPages: 1,
      pageReads: 2,
      activePageReads: 0,
    };
    const total = client.pagingStats();
    primary.reply(stats);
    riverWorker.reply(stats);
    assert.deepEqual(await total, {
      readerCount: 2,
      cachedPageBytes: 200,
      cachedMetadataBytes: 20,
      cachedPages: 2,
      pageReads: 4,
      activePageReads: 0,
    });
    const failed = assert.rejects(
      client.riverRender({ season: 2, threshold: 20, batch: 0 }),
      /river crashed/,
    );
    riverWorker.onerror!({ message: 'river crashed' });
    await failed;
    const manifest = client.physicalManifest('world', -1);
    primary.reply({ batches: 1 });
    assert.deepEqual(await manifest, { batches: 1 });
    assert.equal(primary.terminated, false);
    client.dispose();
  } finally {
    globalThis.Worker = previous;
  }
});

test('changing river season or threshold immediately cancels obsolete network preparation', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = TestWorker as unknown as typeof Worker;
  try {
    const client = new WorldDataClient('snapshot-one');
    const primary = TestWorker.latest;
    const first = assert.rejects(client.riverRender({ season: -1, threshold: 20, batch: 0 }), {
      name: 'AbortError',
    });
    const obsolete = TestWorker.latest;
    const lateReply = obsolete.onmessage!;
    const middle = assert.rejects(client.riverRender({ season: 1, threshold: 20, batch: 0 }), {
      name: 'AbortError',
    });
    const intermediate = TestWorker.latest;
    const latest = client.riverRender({ season: 1, threshold: 100, batch: 0 });
    const current = TestWorker.latest;
    await Promise.all([first, middle]);
    assert.equal(obsolete.terminated, true);
    assert.equal(intermediate.terminated, true);
    assert.equal(primary.terminated, false);
    lateReply({
      data: { id: obsolete.messages[0].id, snapshotId: 'snapshot-one', value: { obsolete: true } },
    });
    current.reply({ totalBatches: 2 });
    assert.deepEqual(await latest, { totalBatches: 2 });
    const count = TestWorker.instances.length;
    const nextBatch = client.riverRender({ season: 1, threshold: 100, batch: 1 });
    assert.equal(
      TestWorker.instances.length,
      count,
      'same variant reuses its prepared river worker',
    );
    current.reply({ batch: 1 });
    assert.deepEqual(await nextBatch, { batch: 1 });
    client.dispose();
    assert.equal(current.terminated, true);
  } finally {
    globalThis.Worker = previous;
  }
});

test('completed river assets can release preparation storage without disrupting other readers', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = TestWorker as unknown as typeof Worker;
  try {
    const client = new WorldDataClient('snapshot-one');
    const primary = TestWorker.latest;
    const variant = { season: -1, threshold: 20 };
    const first = client.riverRender({ ...variant, batch: 0 });
    const river = TestWorker.latest;
    assert.equal(client.releaseRiverRender(variant), false, 'an unfinished transfer remains live');
    river.reply({ totalBatches: 2, batch: 0 });
    await first;
    const second = client.riverRender({ ...variant, batch: 1 });
    assert.equal(TestWorker.latest, river, 'all packets reuse the prepared worker');
    river.reply({ totalBatches: 2, batch: 1 });
    await second;
    const overlay = client.overlays(overlayRequest);
    const overlayWorker = TestWorker.latest;
    assert.equal(client.releaseRiverRender({ season: 1, threshold: 20 }), false);
    assert.equal(client.releaseRiverRender(variant), true);
    assert.equal(river.terminated, true);
    assert.equal(primary.terminated, false);
    assert.equal(overlayWorker.terminated, false);
    overlayWorker.reply({ gridStatus: 'visible' });
    await overlay;
    const stats = {
      cachedPageBytes: 0,
      cachedMetadataBytes: 0,
      cachedPages: 0,
      pageReads: 0,
      activePageReads: 0,
    };
    const workerCount = TestWorker.instances.length;
    const paging = client.pagingStats();
    primary.reply(stats);
    overlayWorker.reply(stats);
    assert.equal((await paging).readerCount, 2);
    assert.equal(
      TestWorker.instances.length,
      workerCount,
      'diagnostics do not recreate the river worker',
    );
    assert.equal(client.releaseRiverRender(variant), false, 'repeated release is harmless');
    const nextVariant = { season: 1, threshold: 20 };
    const next = client.riverRender({ ...nextVariant, batch: 0 });
    const replacement = TestWorker.latest;
    assert.notEqual(replacement, river);
    assert.equal(
      client.releaseRiverRender(variant),
      false,
      'old completion cannot release the new season',
    );
    replacement.reply({ totalBatches: 1, batch: 0 });
    await next;
    assert.equal(
      client.releaseRiverRender(variant),
      false,
      'guard also applies after the new reply',
    );
    assert.equal(replacement.terminated, false);
    assert.equal(client.releaseRiverRender(nextVariant), true);
    const reopened = client.riverRender({ ...nextVariant, batch: 0 });
    const reopenedWorker = TestWorker.latest;
    assert.notEqual(reopenedWorker, replacement);
    reopenedWorker.reply({ totalBatches: 1, batch: 0 });
    await reopened;
    client.dispose();
    assert.equal(client.releaseRiverRender(nextVariant), false);
  } finally {
    globalThis.Worker = previous;
  }
});

test('a blocked overlay query cannot block terrain samples or inspections', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = TestWorker as unknown as typeof Worker;
  try {
    const before = TestWorker.instances.length;
    const client = new WorldDataClient('snapshot-one');
    const primary = TestWorker.latest;
    assert.equal(TestWorker.instances.length, before + 1);
    const overlay = client.overlays(overlayRequest);
    const secondary = TestWorker.latest;
    assert.notEqual(secondary, primary);
    assert.equal(TestWorker.instances.length, before + 2);
    const sample = client.sample(new Float32Array([1, 0, 0]), 'world', -1);
    assert.equal(primary.messages.at(-1)!.method, 'sample');
    assert.equal(secondary.messages.at(-1)!.method, 'overlays');
    assert.notEqual(primary.messages.at(-1)!.id, secondary.messages.at(-1)!.id);
    primary.reply({ heights: [120] });
    assert.deepEqual(await sample, { heights: [120] });
    const inspection = client.inspect([1, 0, 0], -1);
    primary.reply({ cell: 5 });
    assert.deepEqual(await inspection, { cell: 5 });
    const rejected = assert.rejects(overlay, /closed/);
    const lateReply = secondary.onmessage!;
    client.dispose();
    await rejected;
    lateReply({ data: { id: 1, snapshotId: 'snapshot-one', value: {} } });
    assert.equal(primary.terminated, true);
    assert.equal(secondary.terminated, true);
    await assert.rejects(client.overlays(overlayRequest), /closed/);
  } finally {
    globalThis.Worker = previous;
  }
});

test('an overlay worker crash rejects its requests while terrain remains usable', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = TestWorker as unknown as typeof Worker;
  try {
    const client = new WorldDataClient('snapshot-one');
    const primary = TestWorker.latest;
    const first = assert.rejects(client.overlays(overlayRequest), /overlay crashed/);
    const secondary = TestWorker.latest;
    const second = assert.rejects(client.overlays(overlayRequest), /overlay crashed/);
    const sample = client.sample(new Float32Array([0, 1, 0]), 'world', -1);
    secondary.onerror!({ message: 'overlay crashed' });
    await Promise.all([first, second]);
    assert.equal(secondary.terminated, true);
    assert.equal(primary.terminated, false);
    primary.reply({ heights: [240] });
    assert.deepEqual(await sample, { heights: [240] });
    await assert.rejects(client.overlays(overlayRequest), /overlay crashed/);
    client.dispose();
    assert.equal(primary.terminated, true);
  } finally {
    globalThis.Worker = previous;
  }
});

test('primary failure or disposal terminates both reader lanes and rejects queued work', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = TestWorker as unknown as typeof Worker;
  try {
    for (const mode of ['dispose', 'error']) {
      const client = new WorldDataClient('snapshot-one');
      const primary = TestWorker.latest;
      const first = assert.rejects(client.inspect([1, 0, 0], -1), /closed|crashed/);
      const queued = assert.rejects(client.inspect([0, 1, 0], -1), /closed|crashed/);
      const overlay = assert.rejects(client.overlays(overlayRequest), /closed|crashed/);
      const secondary = TestWorker.latest;
      if (mode === 'dispose') {
        client.dispose();
      } else {
        primary.onerror!({ message: 'reader crashed' });
      }
      await Promise.all([first, queued, overlay]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(primary.messages.length, 1);
      assert.equal(primary.terminated, true);
      assert.equal(secondary.terminated, true);
    }
  } finally {
    globalThis.Worker = previous;
  }
});

test('paging statistics aggregate both readers without eagerly creating the overlay lane', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = TestWorker as unknown as typeof Worker;
  try {
    const client = new WorldDataClient('snapshot-one');
    const primary = TestWorker.latest;
    const count = TestWorker.instances.length;
    const primaryStats = {
      cachedPageBytes: 32 * 1024 * 1024,
      cachedMetadataBytes: 4 * 1024 * 1024,
      cachedPages: 32,
      pageReads: 40,
      activePageReads: 1,
    };
    const one = client.pagingStats();
    primary.reply(primaryStats);
    assert.deepEqual(await one, { ...primaryStats, readerCount: 1 });
    assert.equal(TestWorker.instances.length, count);
    const overlay = client.overlays(overlayRequest);
    const secondary = TestWorker.latest;
    secondary.reply({ rivers: [] });
    await overlay;
    const both = client.pagingStats();
    primary.reply(primaryStats);
    secondary.reply(primaryStats);
    assert.deepEqual(await both, {
      cachedPageBytes: 64 * 1024 * 1024,
      cachedMetadataBytes: 8 * 1024 * 1024,
      cachedPages: 64,
      pageReads: 80,
      activePageReads: 2,
      readerCount: 2,
    });
    client.dispose();
  } finally {
    globalThis.Worker = previous;
  }
});

test('worker errors reject every in-flight request without affecting another revision', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = TestWorker as unknown as typeof Worker;
  try {
    const old = new WorldDataClient('snapshot-one');
    const oldWorker = TestWorker.latest;
    const first = assert.rejects(old.diagnostics(), /reader crashed/);
    const second = assert.rejects(old.inspect([1, 0, 0], -1), /reader crashed/);
    const current = new WorldDataClient('snapshot-two');
    const currentWorker = TestWorker.latest;
    const result = current.diagnostics();
    oldWorker.onerror!({ message: 'reader crashed' });
    await Promise.all([first, second]);
    assert.equal(oldWorker.terminated, true);
    assert.equal(currentWorker.terminated, false);
    currentWorker.reply({ surfaceCells: 200 }, 'snapshot-two');
    assert.deepEqual(await result, { surfaceCells: 200 });
    current.dispose();
  } finally {
    globalThis.Worker = previous;
  }
});

test('cell inspection has one active and one latest queued request shared by duplicate callers', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = TestWorker as unknown as typeof Worker;
  try {
    const client = new WorldDataClient('snapshot-one');
    const worker = TestWorker.latest;
    const first = client.inspect([1, 0, 0], -1);
    assert.equal(client.inspect([1, 0, 0], -1), first);
    const superseded = client.inspect([0, 1, 0], -1);
    const rejected = assert.rejects(superseded, { name: 'AbortError' });
    const latest = client.inspect([0, 0, 1], 2);
    assert.equal(client.inspect([0, 0, 1], 2), latest);
    assert.equal(worker.messages.length, 1);
    await rejected;
    worker.reply({ cell: 1 });
    assert.deepEqual(await first, { cell: 1 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(worker.messages.length, 2);
    assert.deepEqual(worker.messages[1].args, [[0, 0, 1], 2]);
    worker.reply({ cell: 3 });
    assert.deepEqual(await latest, { cell: 3 });
    client.dispose();
  } finally {
    globalThis.Worker = previous;
  }
});

test('disposing or failing the reader rejects active and queued inspections without dispatching queued work', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = TestWorker as unknown as typeof Worker;
  try {
    for (const mode of ['dispose', 'error']) {
      const client = new WorldDataClient('snapshot-one');
      const worker = TestWorker.latest;
      const first = assert.rejects(client.inspect([1, 0, 0], -1), /closed|crashed/);
      const queued = assert.rejects(client.inspect([0, 1, 0], -1), /closed|crashed/);
      if (mode === 'dispose') {
        client.dispose();
      } else {
        worker.onerror!({ message: 'reader crashed' });
      }
      await Promise.all([first, queued]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(worker.messages.length, 1);
      assert.equal(worker.terminated, true);
    }
  } finally {
    globalThis.Worker = previous;
  }
});
