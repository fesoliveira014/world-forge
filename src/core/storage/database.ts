import type { World } from '../model';
import { encodeGraph, SNAPSHOT_SCHEMA_VERSION, type GraphManifest, type GraphNode } from './codec';

export const SNAPSHOT_DATABASE_NAME = 'atlas-world-snapshots';
const DATABASE_VERSION = 3;
const NODE_BATCH_SIZE = 128;
const LOCK_PREFIX = 'atlas-world-snapshot:';
const DRAFT_OWNER_LOCK_PREFIX = 'atlas-world-draft-owner:';

export interface SnapshotDescriptor {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  worldVersion: string;
  seed: string;
  surfaceCells: number;
  processCells: number;
  bytes: number;
  summary?: unknown;
  /** Absent on older snapshots, which are saved worlds. */
  saved?: boolean;
  draftOwnerId?: string;
}

export interface SnapshotRecord {
  descriptor: SnapshotDescriptor;
  manifest: GraphManifest;
  id: string;
}

interface StagingRecord {
  id: string;
  createdAt: number;
  nodes: number;
  pages: number;
  draftOwnerId?: string;
}

export interface SaveSnapshotOptions {
  id?: string;
  name?: string;
  summary?: unknown;
  sidecars?: Record<string, unknown>;
  progress?: (completed: number, total: number) => void;
  signal?: AbortSignal;
}

export interface StageSnapshotOptions extends SaveSnapshotOptions {
  ownerId: string;
}

export interface SnapshotDraftSession {
  id: string;
  /** Call after stopping this session's compute workers and readers. */
  close(): Promise<void>;
}

let connection: Promise<IDBDatabase> | undefined;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Snapshot storage request failed.'));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Snapshot transaction aborted.'));
    transaction.onerror = () => {
      // Abort is the final outcome and provides the transaction's error.
    };
  });
}

async function transaction<T>(
  database: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  action: (tx: IDBTransaction) => Promise<T> | T,
  signal?: AbortSignal,
): Promise<T> {
  const tx = database.transaction(stores, mode);
  const abort = () => {
    try {
      tx.abort();
    } catch {
      // A commit which already finished is a complete, valid snapshot.
    }
  };
  signal?.addEventListener('abort', abort, { once: true });
  const completed = transactionComplete(tx);
  // Attach rejection before action awaits so request failures cannot be unhandled.
  const outcome = completed.then(
    () => ({ error: undefined }),
    (error: unknown) => ({ error }),
  );
  try {
    abortIfNeeded(signal);
    const result = await action(tx);
    const { error } = await outcome;
    if (error) {
      throw error;
    }
    return result;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // The transaction may already have aborted or committed.
    }
    await outcome;
    abortIfNeeded(signal);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

export async function snapshotDatabase(): Promise<IDBDatabase> {
  if (!connection) {
    if (typeof indexedDB === 'undefined') {
      throw new Error('This browser does not support local world storage.');
    }
    connection = new Promise((resolve, reject) => {
      let blocked = false;
      const request = indexedDB.open(SNAPSHOT_DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('snapshots')) {
          database.createObjectStore('snapshots', { keyPath: 'id' });
          database.createObjectStore('staging', { keyPath: 'id' });
          database.createObjectStore('nodes', { keyPath: ['snapshotId', 'id'] });
          database.createObjectStore('pages', { keyPath: ['snapshotId', 'buffer', 'page'] });
          database.createObjectStore('probe');
        }
        if (!database.objectStoreNames.contains('descriptors')) {
          const descriptors = database.createObjectStore('descriptors', { keyPath: 'id' });
          // Copy only the small catalog entry during the one-time schema upgrade.
          const cursor = request.transaction!.objectStore('snapshots').openCursor();
          cursor.onsuccess = () => {
            const record = cursor.result;
            if (record) {
              descriptors.put((record.value as SnapshotRecord).descriptor);
              record.continue();
            }
          };
        }
        if (!database.objectStoreNames.contains('drafts')) {
          database.createObjectStore('drafts', { keyPath: 'id' });
        }
      };
      request.onerror = () => {
        connection = undefined;
        reject(request.error ?? new Error('Could not open local world storage.'));
      };
      request.onblocked = () => {
        blocked = true;
        connection = undefined;
        reject(new Error('Another Atlas tab is blocking the local world storage upgrade.'));
      };
      request.onsuccess = () => {
        const database = request.result;
        if (blocked) {
          database.close();
          return;
        }
        database.onversionchange = () => {
          database.close();
          connection = undefined;
        };
        resolve(database);
        // Locks distinguish terminated writers from active writers in other tabs/workers.
        void cleanupStagedSnapshots(database)
          .then(() => cleanupDraftSnapshots(database))
          .catch(() => undefined);
      };
    });
  }
  return connection;
}

/** Close a reader's connection before clearing site data or replacing test databases. */
export async function closeSnapshotDatabase(): Promise<void> {
  const previous = connection;
  connection = undefined;
  (await previous)?.close();
}

function snapshotKeys(id: string): IDBKeyRange {
  return IDBKeyRange.bound([id], [id, []]);
}

async function removeSnapshotRecords(
  database: IDBDatabase,
  id: string,
  stagingOnly = false,
): Promise<void> {
  await transaction(
    database,
    ['snapshots', 'descriptors', 'drafts', 'staging', 'nodes', 'pages'],
    'readwrite',
    async (tx) => {
      if (stagingOnly && (await requestResult(tx.objectStore('snapshots').getKey(id)))) {
        return;
      }
      tx.objectStore('pages').delete(snapshotKeys(id));
      tx.objectStore('nodes').delete(snapshotKeys(id));
      tx.objectStore('staging').delete(id);
      if (!stagingOnly) {
        tx.objectStore('snapshots').delete(id);
        tx.objectStore('descriptors').delete(id);
        tx.objectStore('drafts').delete(id);
      }
    },
  );
}

async function cleanupStagedSnapshots(database: IDBDatabase): Promise<void> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) {
    // Without cross-worker locks we cannot prove that another writer is gone.
    return;
  }
  const stages = await transaction(
    database,
    ['staging'],
    'readonly',
    (tx) => requestResult(tx.objectStore('staging').getAll()) as Promise<StagingRecord[]>,
  );
  for (const stage of stages) {
    await locks.request(`${LOCK_PREFIX}${stage.id}`, { ifAvailable: true }, async (lock) => {
      if (lock) {
        await removeSnapshotRecords(database, stage.id, true);
      }
    });
  }
}

/** Reclaim writes whose worker has gone away; skip cleanup without cross-worker locks. */
export async function cleanupIncompleteSnapshots(): Promise<void> {
  const database = await snapshotDatabase();
  await cleanupStagedSnapshots(database);
  await cleanupDraftSnapshots(database);
}

/** A tab owns its draft pages until replacement or close. Other tabs may reclaim
 * an abandoned owner only after its browser-managed lock has been released. */
export async function createSnapshotDraftSession(): Promise<SnapshotDraftSession> {
  const id = crypto.randomUUID();
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  let release = () => {};
  let held: Promise<unknown> = Promise.resolve();
  if (locks) {
    let acquired!: () => void;
    let failed!: (reason: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      acquired = resolve;
      failed = reject;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    held = locks
      .request(`${DRAFT_OWNER_LOCK_PREFIX}${id}`, async () => {
        acquired();
        await released;
      })
      .catch(failed);
    await ready;
  }
  let closing: Promise<void> | undefined;
  return {
    id,
    close() {
      closing ??= (async () => {
        try {
          await removeOwnerDrafts(await snapshotDatabase(), id);
        } finally {
          release();
          await held;
        }
      })();
      return closing;
    },
  };
}

async function ownerDraftIds(database: IDBDatabase, ownerId: string): Promise<string[]> {
  return transaction(database, ['drafts', 'staging'], 'readonly', async (tx) => {
    const drafts = (await requestResult(tx.objectStore('drafts').getAll())) as SnapshotDescriptor[];
    const stages = (await requestResult(tx.objectStore('staging').getAll())) as StagingRecord[];
    return [
      ...new Set(
        [...drafts, ...stages]
          .filter((record) => record.draftOwnerId === ownerId)
          .map((record) => record.id),
      ),
    ];
  });
}

async function removeOwnerDrafts(database: IDBDatabase, ownerId: string): Promise<void> {
  for (const id of await ownerDraftIds(database, ownerId)) {
    await discardWorldDraft(id, ownerId);
  }
}

async function cleanupDraftSnapshots(database: IDBDatabase): Promise<void> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) {
    // Keep unknown owners when the browser cannot distinguish a closed tab from a live one.
    return;
  }
  const drafts = await transaction(
    database,
    ['drafts'],
    'readonly',
    (tx) => requestResult(tx.objectStore('drafts').getAll()) as Promise<SnapshotDescriptor[]>,
  );
  const owners = new Set(drafts.map((draft) => draft.draftOwnerId));
  for (const ownerId of owners) {
    if (!ownerId) {
      continue;
    }
    await locks.request(
      `${DRAFT_OWNER_LOCK_PREFIX}${ownerId}`,
      { ifAvailable: true },
      async (lock) => {
        if (lock) {
          await removeOwnerDrafts(database, ownerId);
        }
      },
    );
  }
}

/** Atomically checks ownership and saved status, so a late cancellation can never
 * delete a world which the user has just saved. Stop its compute worker first. */
export async function discardWorldDraft(id: string, ownerId: string): Promise<void> {
  const database = await snapshotDatabase();
  const remove = () =>
    transaction(
      database,
      ['snapshots', 'descriptors', 'drafts', 'staging', 'nodes', 'pages'],
      'readwrite',
      async (tx) => {
        if (await requestResult(tx.objectStore('descriptors').getKey(id))) {
          return;
        }
        const draft = (await requestResult(tx.objectStore('drafts').get(id))) as
          SnapshotDescriptor | undefined;
        const stage = (await requestResult(tx.objectStore('staging').get(id))) as
          StagingRecord | undefined;
        if (
          draft
            ? draft.saved !== false || draft.draftOwnerId !== ownerId
            : stage?.draftOwnerId !== ownerId
        ) {
          return;
        }
        tx.objectStore('snapshots').delete(id);
        tx.objectStore('drafts').delete(id);
        tx.objectStore('staging').delete(id);
        tx.objectStore('nodes').delete(snapshotKeys(id));
        tx.objectStore('pages').delete(snapshotKeys(id));
      },
    );
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  await (locks ? locks.request(`${LOCK_PREFIX}${id}`, remove) : remove());
}

/** Saving an already paged draft publishes only metadata, without copying or
 * restoring its physical graph. Promotion and draft deletion serialize in IDB. */
export async function promoteSnapshot(
  id: string,
  name: string,
  options: { signal?: AbortSignal } = {},
): Promise<SnapshotDescriptor> {
  abortIfNeeded(options.signal);
  const database = await snapshotDatabase();
  return transaction(
    database,
    ['snapshots', 'descriptors', 'drafts'],
    'readwrite',
    async (tx) => {
      const existing = (await requestResult(tx.objectStore('descriptors').get(id))) as
        SnapshotDescriptor | undefined;
      if (existing) {
        return existing;
      }
      const draft = (await requestResult(tx.objectStore('drafts').get(id))) as
        SnapshotDescriptor | undefined;
      const record = (await requestResult(tx.objectStore('snapshots').get(id))) as
        SnapshotRecord | undefined;
      if (!draft || !record || draft.saved !== false) {
        throw new Error('This temporary world is no longer available to save.');
      }
      const descriptor = {
        ...draft,
        saved: true,
        name: name.trim() || draft.seed,
        updatedAt: Date.now(),
      };
      delete descriptor.draftOwnerId;
      tx.objectStore('snapshots').put({ ...record, descriptor });
      tx.objectStore('descriptors').add(descriptor);
      tx.objectStore('drafts').delete(id);
      return descriptor;
    },
    options.signal,
  );
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Saving the world was cancelled.', 'AbortError');
  }
}

export async function probeSnapshotStorage(): Promise<{ usage?: number; quota?: number }> {
  const database = await snapshotDatabase();
  await transaction(database, ['probe'], 'readwrite', (tx) => {
    const store = tx.objectStore('probe');
    store.put(1, 'write-check');
    store.delete('write-check');
  });
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      return { usage: estimate.usage, quota: estimate.quota };
    } catch {
      // A failed optional estimate does not negate the successful real write probe.
    }
  }
  return {};
}

/** A snapshot is immutable. Its manifest becomes visible in one final transaction. */
export async function saveWorldSnapshot(
  world: World,
  options: SaveSnapshotOptions = {},
): Promise<SnapshotDescriptor> {
  return writeWorldSnapshot(world, options);
}

/** Temporary immutable pages support bounded viewing, but never enter the saved library. */
export async function stageWorldSnapshot(
  world: World,
  options: StageSnapshotOptions,
): Promise<SnapshotDescriptor> {
  if (!options.ownerId) {
    throw new Error('A temporary world needs a draft session owner.');
  }
  return writeWorldSnapshot(world, options, options.ownerId);
}

async function writeWorldSnapshot(
  world: World,
  options: SaveSnapshotOptions,
  draftOwnerId?: string,
): Promise<SnapshotDescriptor> {
  const id = options.id ?? crypto.randomUUID();
  const save = async () => {
    abortIfNeeded(options.signal);
    const database = await snapshotDatabase();
    const encoded = encodeGraph({ world, sidecars: options.sidecars ?? {} });
    const totalPages = encoded.manifest.buffers.reduce((count, buffer) => count + buffer.pages, 0);
    const total = totalPages + encoded.nodes.length + 1;
    const now = Date.now();
    const descriptor: SnapshotDescriptor = {
      id,
      name: options.name?.trim() || world.config.seed,
      createdAt: now,
      updatedAt: now,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      worldVersion: world.version,
      seed: world.config.seed,
      surfaceCells: world.grid.count,
      processCells: world.process.count,
      bytes: encoded.manifest.buffers.reduce((count, buffer) => count + buffer.byteLength, 0),
      summary: options.summary,
      saved: !draftOwnerId,
      ...(draftOwnerId ? { draftOwnerId } : {}),
    };
    // Reserve before writing, without replacing either a completed or another staged revision.
    await transaction(database, ['snapshots', 'staging'], 'readwrite', async (tx) => {
      const existing = await requestResult(tx.objectStore('snapshots').getKey(id));
      const staging = await requestResult(tx.objectStore('staging').getKey(id));
      if (existing !== undefined || staging !== undefined) {
        throw new Error('A world snapshot with this ID already exists.');
      }
      tx.objectStore('staging').add({
        id,
        createdAt: now,
        nodes: 0,
        pages: 0,
        ...(draftOwnerId ? { draftOwnerId } : {}),
      } satisfies StagingRecord);
    });

    let completedNodes = 0;
    let completedPages = 0;
    try {
      for (let start = 0; start < encoded.nodes.length; start += NODE_BATCH_SIZE) {
        abortIfNeeded(options.signal);
        const end = Math.min(encoded.nodes.length, start + NODE_BATCH_SIZE);
        await transaction(database, ['staging', 'nodes'], 'readwrite', async (tx) => {
          const marker = (await requestResult(tx.objectStore('staging').get(id))) as
            StagingRecord | undefined;
          if (!marker) {
            throw new Error('The staged world was removed before saving completed.');
          }
          for (let node = start; node < end; node++) {
            tx.objectStore('nodes').add({ snapshotId: id, id: node, node: encoded.nodes[node] });
          }
          tx.objectStore('staging').put({ ...marker, nodes: end });
        });
        completedNodes = end;
        options.progress?.(completedNodes + completedPages, total);
      }
      for (let buffer = 0; buffer < encoded.manifest.buffers.length; buffer++) {
        for (let page = 0; page < encoded.manifest.buffers[buffer].pages; page++) {
          abortIfNeeded(options.signal);
          const data = encoded.page(buffer, page);
          await transaction(database, ['staging', 'pages'], 'readwrite', async (tx) => {
            const marker = (await requestResult(tx.objectStore('staging').get(id))) as
              StagingRecord | undefined;
            if (!marker) {
              throw new Error('The staged world was removed before saving completed.');
            }
            tx.objectStore('pages').add({ snapshotId: id, buffer, page, data });
            tx.objectStore('staging').put({ ...marker, pages: marker.pages + 1 });
          });
          completedPages++;
          options.progress?.(completedNodes + completedPages, total);
        }
      }
      abortIfNeeded(options.signal);
      await transaction(
        database,
        ['snapshots', 'descriptors', 'drafts', 'staging'],
        'readwrite',
        async (tx) => {
          const marker = (await requestResult(tx.objectStore('staging').get(id))) as
            StagingRecord | undefined;
          if (!marker || marker.nodes !== encoded.nodes.length || marker.pages !== totalPages) {
            throw new Error('Cannot commit an incomplete world snapshot.');
          }
          abortIfNeeded(options.signal);
          tx.objectStore('snapshots').add({
            id,
            descriptor,
            manifest: encoded.manifest,
          } satisfies SnapshotRecord);
          tx.objectStore(draftOwnerId ? 'drafts' : 'descriptors').add(descriptor);
          tx.objectStore('staging').delete(id);
        },
        options.signal,
      );
    } catch (error) {
      await removeSnapshotRecords(database, id, true).catch(() => undefined);
      throw error;
    }
    // Reporting code must not turn a successful durable commit into an apparent save failure.
    try {
      options.progress?.(total, total);
    } catch {
      // Snapshot remains committed even when the consumer has gone away.
    }
    return descriptor;
  };
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks ? locks.request(`${LOCK_PREFIX}${id}`, save) : save();
}

export async function readSnapshotRecord(id: string): Promise<SnapshotRecord> {
  const database = await snapshotDatabase();
  const record = await transaction(
    database,
    ['snapshots'],
    'readonly',
    (tx) =>
      requestResult(tx.objectStore('snapshots').get(id)) as Promise<SnapshotRecord | undefined>,
  );
  if (!record) {
    throw new Error('This saved world is unavailable or its save did not complete.');
  }
  return record;
}

export async function openSnapshot(id: string): Promise<SnapshotDescriptor> {
  const database = await snapshotDatabase();
  const descriptor = await transaction(
    database,
    ['descriptors', 'drafts'],
    'readonly',
    async (tx) =>
      ((await requestResult(tx.objectStore('descriptors').get(id))) ??
        (await requestResult(tx.objectStore('drafts').get(id)))) as SnapshotDescriptor | undefined,
  );
  if (!descriptor) {
    throw new Error('This saved world is unavailable or its save did not complete.');
  }
  return descriptor;
}

export async function listSnapshots(): Promise<SnapshotDescriptor[]> {
  const database = await snapshotDatabase();
  const descriptors = await transaction(
    database,
    ['descriptors'],
    'readonly',
    (tx) => requestResult(tx.objectStore('descriptors').getAll()) as Promise<SnapshotDescriptor[]>,
  );
  return descriptors.sort((left, right) => right.createdAt - left.createdAt);
}

export async function renameSnapshot(id: string, name: string): Promise<SnapshotDescriptor> {
  const database = await snapshotDatabase();
  return transaction(database, ['snapshots', 'descriptors'], 'readwrite', async (tx) => {
    const record = (await requestResult(tx.objectStore('snapshots').get(id))) as
      SnapshotRecord | undefined;
    if (!record || record.descriptor.saved === false) {
      throw new Error('This saved world is unavailable.');
    }
    const descriptor = {
      ...record.descriptor,
      name: name.trim() || record.descriptor.seed,
      updatedAt: Date.now(),
    };
    tx.objectStore('snapshots').put({ ...record, descriptor });
    tx.objectStore('descriptors').put(descriptor);
    return descriptor;
  });
}

export async function deleteSnapshot(id: string): Promise<void> {
  const database = await snapshotDatabase();
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks) {
    await locks.request(`${LOCK_PREFIX}${id}`, () => removeSnapshotRecords(database, id));
  } else {
    await removeSnapshotRecords(database, id);
  }
}

export async function readSnapshotNode(snapshotId: string, id: number): Promise<GraphNode> {
  const database = await snapshotDatabase();
  const record = await transaction(
    database,
    ['nodes'],
    'readonly',
    (tx) =>
      requestResult(tx.objectStore('nodes').get([snapshotId, id])) as Promise<
        { node: GraphNode } | undefined
      >,
  );
  if (!record) {
    throw new Error('The saved world is missing a graph record.');
  }
  return record.node;
}

export async function readSnapshotPage(
  snapshotId: string,
  buffer: number,
  page: number,
): Promise<ArrayBuffer> {
  const database = await snapshotDatabase();
  const record = await transaction(
    database,
    ['pages'],
    'readonly',
    (tx) =>
      requestResult(tx.objectStore('pages').get([snapshotId, buffer, page])) as Promise<
        { data: ArrayBuffer } | undefined
      >,
  );
  if (!record) {
    throw new Error('The saved world is missing a data page.');
  }
  return record.data;
}
