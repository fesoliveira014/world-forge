import 'fake-indexeddb/auto';
import { IDBObjectStore as FakeObjectStore } from 'fake-indexeddb';
import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { DEFAULT_CONFIG, type World } from '../src/core/model';
import { generateWorld } from '../src/core/pipeline';
import { encodeGraph, restoreGraph } from '../src/core/storage/codec';
import {
  SNAPSHOT_PAGE_BYTES,
  SnapshotReader,
  saveWorldSnapshot,
  openSnapshot,
  listSnapshots,
  renameSnapshot,
  deleteSnapshot,
  restoreWorldSnapshot,
  probeSnapshotStorage,
} from '../src/core/storage';
import {
  closeSnapshotDatabase,
  cleanupIncompleteSnapshots,
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

function fixture(extra: Record<string, unknown> = {}): World {
  const positions = new Float64Array([1, 0, 0, 0, 1, 0]);
  const grid = { count: 2, positions };
  return {
    version: 'snapshot-fixture',
    config: { seed: 'snapshot-fixture' },
    grid,
    process: grid,
    terrain: {
      height: new Float32Array([123.25, -99]),
      coastDistance: new Float64Array([0, Infinity]),
    },
    ...extra,
  } as unknown as World;
}

test('graph codec preserves object, view and buffer aliases without giant numeric metadata', async () => {
  const raw = new ArrayBuffer(73);
  new Uint8Array(raw).set(Array.from({ length: raw.byteLength }, (_, index) => index));
  const sliced = new Float64Array(raw, 8, 3);
  const many = Array.from({ length: 2049 }, (_, index) => index / 7);
  many[42] = Infinity;
  many[43] = -0;
  const source = {
    raw,
    sliced,
    sameView: sliced,
    bytes: new Uint8Array(raw, 7, 13),
    data: new DataView(raw, 5, 21),
    many,
    manyAgain: many,
    nested: { missing: undefined, nan: NaN, negativeZero: -0 },
    records: Array.from({ length: 600 }, (_, index) => ({ index })),
    cycle: null as unknown,
  };
  source.cycle = source;
  const encoded = encodeGraph(source, 64);
  assert.equal(encoded.manifest.buffers.length, 2);
  assert.ok(JSON.stringify(encoded.manifest).length < 1024);
  assert.ok(encoded.nodes.some((node) => node.kind === 'numbers'));
  assert.ok(encoded.nodes.some((node) => node.kind === 'list'));
  const result = (await restoreGraph({
    manifest: encoded.manifest,
    node: async (id) => encoded.nodes[id],
    page: async (buffer, page) => encoded.page(buffer, page),
  })) as typeof source;
  assert.deepEqual(result, source);
  assert.equal(result.sliced, result.sameView);
  assert.equal(result.sliced.buffer, result.raw);
  assert.equal(result.bytes.buffer, result.raw);
  assert.equal(result.data.buffer, result.raw);
  assert.equal(result.sliced.byteOffset, 8);
  assert.equal(result.manyAgain, result.many);
  assert.equal(result.cycle, result);
  assert.ok(Object.is(result.many[43], -0));
});

test('a complete physical world restores exactly, including shared grids and erosion state', async () => {
  const world = generateWorld({
    ...DEFAULT_CONFIG,
    seed: 'snapshot-physical-roundtrip',
    surfaceLevel: 3,
    processLevel: 3,
    tectonicDuration: 5,
    fluvialDuration: 0.1,
    landscapeBatches: 1,
  });
  const descriptor = await saveWorldSnapshot(world, {
    id: 'physical',
    name: 'A saved world',
    summary: { count: world.grid.count },
    sidecars: { view: { index: new Uint32Array([3, 7]), summary: { seed: world.config.seed } } },
  });
  assert.equal(descriptor.id, 'physical');
  assert.equal(descriptor.surfaceCells, world.grid.count);
  const restored = await restoreWorldSnapshot(descriptor.id);
  assert.deepEqual(restored, world);
  assert.equal(restored.grid, restored.process);
  assert.notEqual(restored.terrain.height.buffer, world.terrain.height.buffer);
  const reader = await SnapshotReader.open(descriptor.id);
  assert.deepEqual(await reader.readValue('sidecars.view.summary'), { seed: world.config.seed });
  assert.equal(reader.stats.pageReads, 0, 'metadata inspection does not restore numerical state');
  assert.deepEqual(
    await reader.readValues('sidecars.view.index', [1, 0]),
    new Float64Array([7, 3]),
  );
  reader.close();
});

test('paged reads coalesce concurrent requests, honor view offsets, and survive transferred outputs', async () => {
  const buffer = new ArrayBuffer(73);
  const view = new Uint32Array(buffer, 4, 17);
  view.set(Array.from({ length: view.length }, (_, index) => 1234 + index));
  const numbers = Array.from({ length: 3000 }, (_, index) => index * 0.25);
  await saveWorldSnapshot(fixture({ view, numbers }), { id: 'paged' });
  const reader = await SnapshotReader.open('paged');
  const [first, second] = await Promise.all([
    reader.readValues('world.view', [0, 16, 0]),
    reader.readRange('world.view', 14, 3),
  ]);
  assert.deepEqual(first, new Float64Array([1234, 1250, 1234]));
  assert.deepEqual(second, new Float64Array([1248, 1249, 1250]));
  assert.equal(reader.stats.pageReads, 1);
  structuredClone(first, { transfer: [first.buffer] });
  assert.equal(first.byteLength, 0);
  assert.deepEqual(await reader.readValues('world.view', [0]), new Float64Array([1234]));
  assert.equal(reader.stats.pageReads, 1, 'transferring result leaves cached pages intact');
  assert.deepEqual(
    await reader.readValues('world.numbers', [2999, 2]),
    new Float64Array([749.75, 0.5]),
  );
  await assert.rejects(reader.readValues('world.view', [-1]), RangeError);
  await assert.rejects(reader.readValues('world.view', [17]), RangeError);
  await assert.rejects(reader.readRange('world.view', 0, -1), RangeError);
  reader.close();
  assert.equal(reader.stats.cachedPageBytes, 0);
  await assert.rejects(reader.readValues('world.view', [0]), { name: 'AbortError' });
});

test('large pages evict by bytes, and sparse reads do not load the complete field', async () => {
  const perPage = SNAPSHOT_PAGE_BYTES / Float64Array.BYTES_PER_ELEMENT;
  const values = new Float64Array(perPage * 3);
  values[0] = 10;
  values[perPage] = 20;
  values[2 * perPage] = 30;
  await saveWorldSnapshot(fixture({ values }), { id: 'cache' });
  const reader = await SnapshotReader.open('cache', { cacheBytes: SNAPSHOT_PAGE_BYTES });
  assert.equal((await reader.readValues('world.values', [perPage]))[0], 20);
  assert.equal(reader.stats.pageReads, 1);
  assert.equal(reader.stats.cachedPageBytes, SNAPSHOT_PAGE_BYTES);
  assert.equal((await reader.readValues('world.values', [0]))[0], 10);
  assert.equal(reader.stats.cachedPages, 1);
  assert.equal((await reader.readValues('world.values', [perPage]))[0], 20);
  assert.equal(reader.stats.pageReads, 3);
  assert.ok(reader.stats.cachedPageBytes <= SNAPSHOT_PAGE_BYTES);
  reader.close();
});

test('cancelled and quota-failed saves leave the previous ready snapshot intact', async () => {
  await saveWorldSnapshot(fixture(), { id: 'ready' });
  const controller = new AbortController();
  await assert.rejects(
    saveWorldSnapshot(fixture(), {
      id: 'cancelled',
      signal: controller.signal,
      progress(completed, total) {
        if (completed === total - 1) {
          controller.abort();
        }
      },
    }),
    { name: 'AbortError' },
  );
  assert.deepEqual(
    (await listSnapshots()).map((snapshot) => snapshot.id),
    ['ready'],
  );
  await assert.rejects(openSnapshot('cancelled'), /unavailable/);

  const original = FakeObjectStore.prototype.add;
  FakeObjectStore.prototype.add = function (...args) {
    if (this.name === 'pages') {
      throw new DOMException('Disk is full', 'QuotaExceededError');
    }
    return original.apply(this, args);
  };
  try {
    await assert.rejects(saveWorldSnapshot(fixture(), { id: 'quota' }), {
      name: 'QuotaExceededError',
    });
  } finally {
    FakeObjectStore.prototype.add = original;
  }
  assert.deepEqual(
    (await listSnapshots()).map((snapshot) => snapshot.id),
    ['ready'],
  );
  assert.deepEqual(await restoreWorldSnapshot('ready'), fixture());
  const database = await snapshotDatabase();
  const remainingStages = await new Promise<number>((resolve) => {
    const request = database.transaction('staging').objectStore('staging').count();
    request.onsuccess = () => resolve(request.result);
  });
  assert.equal(remainingStages, 0);
});

test('snapshots cannot overwrite revisions, and rename/delete affect only the selected snapshot', async () => {
  assert.deepEqual(await probeSnapshotStorage(), {});
  await saveWorldSnapshot(fixture(), { id: 'one' });
  await saveWorldSnapshot(fixture(), { id: 'two' });
  await assert.rejects(saveWorldSnapshot(fixture(), { id: 'one' }), /already exists/);
  assert.equal((await renameSnapshot('one', '  Named world  ')).name, 'Named world');
  assert.equal((await openSnapshot('one')).name, 'Named world');
  await deleteSnapshot('one');
  assert.deepEqual(
    (await listSnapshots()).map((snapshot) => snapshot.id),
    ['two'],
  );
  assert.deepEqual(await restoreWorldSnapshot('two'), fixture());
});

test('library listing and opening metadata never load physical manifest tables', async () => {
  const descriptor = await saveWorldSnapshot(fixture(), { id: 'catalog-only' });
  const originalGet = FakeObjectStore.prototype.get;
  const originalGetAll = FakeObjectStore.prototype.getAll;
  FakeObjectStore.prototype.get = function (...args) {
    assert.notEqual(this.name, 'snapshots', 'opening a handle must read only catalog metadata');
    return originalGet.apply(this, args);
  };
  FakeObjectStore.prototype.getAll = function (...args) {
    assert.notEqual(this.name, 'snapshots', 'listing worlds must not clone every manifest');
    return originalGetAll.apply(this, args);
  };
  try {
    assert.deepEqual(await openSnapshot(descriptor.id), descriptor);
    assert.deepEqual(await listSnapshots(), [descriptor]);
  } finally {
    FakeObjectStore.prototype.get = originalGet;
    FakeObjectStore.prototype.getAll = originalGetAll;
  }
});

test('database upgrade preserves existing ready snapshot catalog entries', async () => {
  const descriptor = {
    id: 'previous-schema',
    name: 'Previous world',
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 1,
    worldVersion: '2.15.0',
    seed: 'old-world',
    surfaceCells: 2,
    processCells: 2,
    bytes: 48,
  };
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(SNAPSHOT_DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('snapshots', { keyPath: 'id' });
      db.createObjectStore('staging', { keyPath: 'id' });
      db.createObjectStore('nodes', { keyPath: ['snapshotId', 'id'] });
      db.createObjectStore('pages', { keyPath: ['snapshotId', 'buffer', 'page'] });
      db.createObjectStore('probe');
      request.transaction!.objectStore('snapshots').put({
        id: descriptor.id,
        descriptor,
        manifest: encodeGraph({ world: fixture() }).manifest,
      });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.close();
  assert.deepEqual(await openSnapshot(descriptor.id), descriptor);
  assert.deepEqual(await listSnapshots(), [descriptor]);
});

test('missing pages fail explicitly instead of returning a partly restored world', async () => {
  await saveWorldSnapshot(fixture(), { id: 'damaged' });
  const database = await snapshotDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction('pages', 'readwrite');
    tx.objectStore('pages').delete(['damaged', 0, 0]);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
  await assert.rejects(restoreWorldSnapshot('damaged'), /missing a data page/);
  const reader = await SnapshotReader.open('damaged');
  assert.equal(await reader.readOptionalValue('world.regionalRefinements'), undefined);
  await assert.rejects(reader.readOptionalValue('world.grid.positions'), /missing a data page/);
  reader.close();
});

test('cancellation during final commit aborts the ready manifest transaction', async () => {
  const controller = new AbortController();
  const original = FakeObjectStore.prototype.add;
  FakeObjectStore.prototype.add = function (...args) {
    const request = original.apply(this, args);
    if (this.name === 'snapshots') {
      controller.abort();
    }
    return request;
  };
  try {
    await assert.rejects(
      saveWorldSnapshot(fixture(), { id: 'commit-aborted', signal: controller.signal }),
      { name: 'AbortError' },
    );
  } finally {
    FakeObjectStore.prototype.add = original;
  }
  assert.deepEqual(await listSnapshots(), []);
});

test('abandoned staging is reclaimed only when its writer lock is available', async (context) => {
  const database = await snapshotDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(['staging', 'nodes', 'pages'], 'readwrite');
    for (const id of ['active-writer', 'terminated-writer']) {
      tx.objectStore('staging').put({ id, nodes: 1, pages: 1, createdAt: Date.now() });
      tx.objectStore('nodes').put({ snapshotId: id, id: 0, node: { kind: 'array', values: [] } });
      tx.objectStore('pages').put({ snapshotId: id, buffer: 0, page: 0, data: new ArrayBuffer(8) });
    }
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
  const previous = Object.getOwnPropertyDescriptor(navigator, 'locks');
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (
        name: string,
        options: { ifAvailable: boolean },
        callback: (lock: object | null) => Promise<void>,
      ) => {
        assert.equal(options.ifAvailable, true);
        return callback(name.endsWith('active-writer') ? null : {});
      },
    },
  });
  context.after(() => {
    if (previous) {
      Object.defineProperty(navigator, 'locks', previous);
    } else {
      Reflect.deleteProperty(navigator, 'locks');
    }
  });
  await cleanupIncompleteSnapshots();
  for (const store of ['staging', 'nodes', 'pages']) {
    const records = await new Promise<{ id?: string; snapshotId?: string }[]>((resolve) => {
      const request = database.transaction(store).objectStore(store).getAll();
      request.onsuccess = () => resolve(request.result);
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].snapshotId ?? records[0].id, 'active-writer');
  }
});
