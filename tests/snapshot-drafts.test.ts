import 'fake-indexeddb/auto';
import { IDBObjectStore as FakeObjectStore } from 'fake-indexeddb';
import assert from 'node:assert/strict';
import test, { after, beforeEach, type TestContext } from 'node:test';
import type { World } from '../src/core/model';
import { encodeGraph } from '../src/core/storage/codec';
import {
  createSnapshotDraftSession,
  discardWorldDraft,
  listSnapshots,
  openSnapshot,
  promoteSnapshot,
  restoreWorldSnapshot,
  saveWorldSnapshot,
  SnapshotReader,
  stageWorldSnapshot,
} from '../src/core/storage';
import {
  cleanupIncompleteSnapshots,
  closeSnapshotDatabase,
  snapshotDatabase,
  SNAPSHOT_DATABASE_NAME,
} from '../src/core/storage/database';

async function resetDatabase() {
  await closeSnapshotDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(SNAPSHOT_DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

beforeEach(resetDatabase);
after(resetDatabase);

function fixture(): World {
  const grid = { count: 2, positions: new Float64Array([1, 0, 0, 0, 1, 0]) };
  return {
    version: 'draft-fixture',
    config: { seed: 'draft-fixture' },
    grid,
    process: grid,
    terrain: { height: new Float32Array([14.25, -2]) },
  } as unknown as World;
}

/** Serial exclusive lock queues, including the browser's nonblocking owner probe. */
function mockLocks(context: TestContext) {
  const tails = new Map<string, Promise<void>>();
  const locks = {
    async request<T>(
      name: string,
      options: { ifAvailable?: boolean } | ((lock: object | null) => Promise<T>),
      callback?: (lock: object | null) => Promise<T>,
    ): Promise<T> {
      const work = typeof options === 'function' ? options : callback!;
      const previous = tails.get(name);
      if (typeof options !== 'function' && options.ifAvailable && previous) {
        return work(null);
      }
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(name, held);
      await previous;
      try {
        return await work({ name });
      } finally {
        if (tails.get(name) === held) {
          tails.delete(name);
        }
        release();
      }
    },
  };
  const previous = Object.getOwnPropertyDescriptor(navigator, 'locks');
  Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
  context.after(() => {
    if (previous) {
      Object.defineProperty(navigator, 'locks', previous);
    } else {
      Reflect.deleteProperty(navigator, 'locks');
    }
  });
  return locks;
}

test('temporary pages are readable and restorable but only explicit promotion writes the saved catalog', async () => {
  const world = fixture();
  const originalAdd = FakeObjectStore.prototype.add;
  FakeObjectStore.prototype.add = function (...args) {
    assert.notEqual(this.name, 'descriptors', 'generation must never publish a library entry');
    return originalAdd.apply(this, args);
  };
  try {
    const descriptor = await stageWorldSnapshot(world, { id: 'draft', ownerId: 'tab' });
    assert.equal(descriptor.saved, false);
    assert.equal(descriptor.draftOwnerId, 'tab');
  } finally {
    FakeObjectStore.prototype.add = originalAdd;
  }
  assert.deepEqual(await listSnapshots(), []);
  assert.equal((await openSnapshot('draft')).saved, false);
  const reader = await SnapshotReader.open('draft', { cacheBytes: 1024 });
  assert.deepEqual(await reader.readValues('world.terrain.height', [1]), new Float64Array([-2]));
  assert.ok(reader.stats.cachedPageBytes <= 1024);
  assert.deepEqual(await restoreWorldSnapshot('draft'), world);

  const originalGet = FakeObjectStore.prototype.get;
  const originalPut = FakeObjectStore.prototype.put;
  FakeObjectStore.prototype.get = function (...args) {
    assert.ok(!['nodes', 'pages'].includes(this.name), 'promotion cannot restore physical data');
    return originalGet.apply(this, args);
  };
  FakeObjectStore.prototype.put = function (...args) {
    assert.ok(!['nodes', 'pages'].includes(this.name), 'promotion cannot rewrite physical data');
    return originalPut.apply(this, args);
  };
  let saved;
  try {
    saved = await promoteSnapshot('draft', '  My world  ');
    assert.equal(saved.saved, true);
    assert.equal(saved.name, 'My world');
    assert.equal(saved.draftOwnerId, undefined);
    assert.deepEqual(await promoteSnapshot('draft', 'Duplicate click'), saved);
  } finally {
    FakeObjectStore.prototype.get = originalGet;
    FakeObjectStore.prototype.put = originalPut;
  }
  assert.deepEqual(await listSnapshots(), [saved]);
  assert.deepEqual(await reader.readValues('world.terrain.height', [0]), new Float64Array([14.25]));
  reader.close();
  assert.deepEqual(await restoreWorldSnapshot('draft'), world);
});

test('cancelled or failed promotion leaves its readable draft and older saves intact', async () => {
  await saveWorldSnapshot(fixture(), { id: 'saved' });
  await stageWorldSnapshot(fixture(), { id: 'draft', ownerId: 'tab' });
  const controller = new AbortController();
  const originalAdd = FakeObjectStore.prototype.add;
  FakeObjectStore.prototype.add = function (...args) {
    const request = originalAdd.apply(this, args);
    if (this.name === 'descriptors') {
      controller.abort();
    }
    return request;
  };
  try {
    await assert.rejects(promoteSnapshot('draft', 'Cancelled', { signal: controller.signal }), {
      name: 'AbortError',
    });
  } finally {
    FakeObjectStore.prototype.add = originalAdd;
  }
  assert.equal((await openSnapshot('draft')).saved, false);
  assert.deepEqual(await restoreWorldSnapshot('draft'), fixture());
  FakeObjectStore.prototype.add = function (...args) {
    if (this.name === 'descriptors') {
      throw new DOMException('Disk is full', 'QuotaExceededError');
    }
    return originalAdd.apply(this, args);
  };
  try {
    await assert.rejects(promoteSnapshot('draft', 'Failed'), { name: 'QuotaExceededError' });
  } finally {
    FakeObjectStore.prototype.add = originalAdd;
  }
  assert.equal((await openSnapshot('draft')).saved, false);
  assert.deepEqual(
    (await listSnapshots()).map((entry) => entry.id),
    ['saved'],
  );
  await promoteSnapshot('draft', 'Retried');
  assert.equal((await listSnapshots()).length, 2);
});

test('queued cleanup rechecks promotion atomically and can never delete a saved world', async (context) => {
  const locks = mockLocks(context);
  const session = await createSnapshotDraftSession();
  await stageWorldSnapshot(fixture(), { id: 'draft', ownerId: session.id });
  let release!: () => void;
  let acquired!: () => void;
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const held = locks.request('atlas-world-snapshot:draft', async () => {
    acquired();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await ready;
  const cleanup = discardWorldDraft('draft', session.id);
  await promoteSnapshot('draft', 'Saved during cleanup');
  release();
  await held;
  await cleanup;
  await session.close();
  assert.equal((await openSnapshot('draft')).saved, true);
  assert.deepEqual(await restoreWorldSnapshot('draft'), fixture());

  await stageWorldSnapshot(fixture(), { id: 'discard-first', ownerId: 'other' });
  await discardWorldDraft('discard-first', 'other');
  await assert.rejects(promoteSnapshot('discard-first', 'Too late'), /no longer available/);
  assert.deepEqual(
    (await listSnapshots()).map((entry) => entry.id),
    ['draft'],
  );
});

test('cleanup skips live owners in other tabs and removes only abandoned or explicitly closed drafts', async (context) => {
  mockLocks(context);
  const first = await createSnapshotDraftSession();
  const second = await createSnapshotDraftSession();
  await stageWorldSnapshot(fixture(), { id: 'first', ownerId: first.id });
  await stageWorldSnapshot(fixture(), { id: 'second', ownerId: second.id });
  await stageWorldSnapshot(fixture(), { id: 'abandoned', ownerId: 'closed-tab' });
  await cleanupIncompleteSnapshots();
  await assert.rejects(openSnapshot('abandoned'), /unavailable/);
  assert.equal((await openSnapshot('first')).saved, false);
  assert.equal((await openSnapshot('second')).saved, false);
  await discardWorldDraft('second', first.id);
  assert.equal((await openSnapshot('second')).saved, false, 'ownership must be checked');
  await first.close();
  await first.close();
  await assert.rejects(openSnapshot('first'), /unavailable/);
  assert.deepEqual(await restoreWorldSnapshot('second'), fixture());
  await second.close();
  const database = await snapshotDatabase();
  for (const store of ['snapshots', 'descriptors', 'drafts', 'staging', 'nodes', 'pages']) {
    const count = await new Promise<number>((resolve) => {
      const request = database.transaction(store).objectStore(store).count();
      request.onsuccess = () => resolve(request.result);
    });
    assert.equal(count, 0, `closing releases ${store}`);
  }
});

test('without Web Locks unknown draft owners are kept, while explicit cleanup still works', async () => {
  const session = await createSnapshotDraftSession();
  await stageWorldSnapshot(fixture(), { id: 'draft', ownerId: session.id });
  await cleanupIncompleteSnapshots();
  assert.equal((await openSnapshot('draft')).saved, false);
  await session.close();
  await assert.rejects(openSnapshot('draft'), /unavailable/);
});

test('cancelled draft publication cleans partial pages without changing saved or active worlds', async () => {
  await saveWorldSnapshot(fixture(), { id: 'saved' });
  await stageWorldSnapshot(fixture(), { id: 'active', ownerId: 'tab' });
  const controller = new AbortController();
  await assert.rejects(
    stageWorldSnapshot(fixture(), {
      id: 'candidate',
      ownerId: 'tab',
      signal: controller.signal,
      progress(completed, total) {
        if (completed === total - 1) {
          controller.abort();
        }
      },
    }),
    { name: 'AbortError' },
  );
  await discardWorldDraft('candidate', 'tab');
  assert.deepEqual(await restoreWorldSnapshot('active'), fixture());
  assert.deepEqual(
    (await listSnapshots()).map((entry) => entry.id),
    ['saved'],
  );
  await assert.rejects(openSnapshot('candidate'), /unavailable/);
});

test('2.16 database upgrades keep saved worlds and exact physical data without saved flags', async () => {
  const encoded = encodeGraph({ world: fixture(), sidecars: {} });
  const descriptor = {
    id: 'old-saved',
    name: 'Existing 2.16 world',
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 1,
    worldVersion: '2.16.0',
    seed: 'draft-fixture',
    surfaceCells: 2,
    processCells: 2,
    bytes: encoded.manifest.buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0),
  };
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(SNAPSHOT_DATABASE_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('snapshots', { keyPath: 'id' });
      db.createObjectStore('descriptors', { keyPath: 'id' });
      db.createObjectStore('staging', { keyPath: 'id' });
      db.createObjectStore('nodes', { keyPath: ['snapshotId', 'id'] });
      db.createObjectStore('pages', { keyPath: ['snapshotId', 'buffer', 'page'] });
      db.createObjectStore('probe');
      const tx = request.transaction!;
      tx.objectStore('snapshots').put({
        id: descriptor.id,
        descriptor,
        manifest: encoded.manifest,
      });
      tx.objectStore('descriptors').put(descriptor);
      encoded.nodes.forEach((node, id) =>
        tx.objectStore('nodes').put({ snapshotId: descriptor.id, id, node }),
      );
      encoded.manifest.buffers.forEach((buffer, index) => {
        for (let page = 0; page < buffer.pages; page++) {
          tx.objectStore('pages').put({
            snapshotId: descriptor.id,
            buffer: index,
            page,
            data: encoded.page(index, page),
          });
        }
      });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.close();
  assert.deepEqual(await listSnapshots(), [descriptor]);
  assert.deepEqual(await openSnapshot(descriptor.id), descriptor);
  await discardWorldDraft(descriptor.id, 'some-tab');
  await cleanupIncompleteSnapshots();
  assert.deepEqual(await restoreWorldSnapshot(descriptor.id), fixture());
  assert.deepEqual(await promoteSnapshot(descriptor.id, 'Ignored duplicate'), descriptor);
});

test('explicit owner close reclaims interrupted publication batches alongside ready drafts', async () => {
  const session = await createSnapshotDraftSession();
  await stageWorldSnapshot(fixture(), { id: 'ready-draft', ownerId: session.id });
  const database = await snapshotDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(['staging', 'nodes', 'pages'], 'readwrite');
    tx.objectStore('staging').put({
      id: 'interrupted',
      draftOwnerId: session.id,
      createdAt: Date.now(),
      nodes: 1,
      pages: 1,
    });
    tx.objectStore('nodes').put({
      snapshotId: 'interrupted',
      id: 0,
      node: { kind: 'array', values: [] },
    });
    tx.objectStore('pages').put({
      snapshotId: 'interrupted',
      buffer: 0,
      page: 0,
      data: new ArrayBuffer(8),
    });
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
  await session.close();
  for (const store of ['staging', 'drafts', 'snapshots', 'nodes', 'pages']) {
    const count = await new Promise<number>((resolve) => {
      const request = database.transaction(store).objectStore(store).count();
      request.onsuccess = () => resolve(request.result);
    });
    assert.equal(count, 0);
  }
});
