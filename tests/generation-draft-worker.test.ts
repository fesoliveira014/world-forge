import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONFIG } from '../src/core/model';
import { worldProject } from '../src/core/project';
import {
  createSnapshotDraftSession,
  listSnapshots,
  openSnapshot,
  promoteSnapshot,
  restoreWorldSnapshot,
} from '../src/core/storage';
import { closeSnapshotDatabase, SNAPSHOT_DATABASE_NAME } from '../src/core/storage/database';
import type { GenerationInput, GenerationResponse } from '../src/app/generation-messages';

test('generation, import and refinement workers publish unsaved handles until explicit Save', async (context) => {
  const session = await createSnapshotDraftSession();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'self');
  let finish: ((message: GenerationResponse) => void) | undefined;
  const scope = {
    onmessage: null as ((event: { data: GenerationInput }) => void) | null,
    postMessage(message: GenerationResponse) {
      if (message.type === 'complete' || message.type === 'error') {
        finish!(structuredClone(message));
      }
    },
  };
  Object.defineProperty(globalThis, 'self', { configurable: true, value: scope });
  context.after(async () => {
    if (previous) {
      Object.defineProperty(globalThis, 'self', previous);
    } else {
      Reflect.deleteProperty(globalThis, 'self');
    }
    await session.close();
    await closeSnapshotDatabase();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(SNAPSHOT_DATABASE_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });
  await import('../src/app/generator.worker');
  const run = (request: GenerationInput) =>
    new Promise<GenerationResponse>((resolve) => {
      finish = resolve;
      scope.onmessage!({ data: structuredClone(request) });
    });
  const generated = await run({
    type: 'generate',
    id: 1,
    outputSnapshotId: 'generated',
    draftOwnerId: session.id,
    climateConcurrency: 1,
    config: {
      ...DEFAULT_CONFIG,
      seed: 'manual-worker-save',
      surfaceLevel: 3,
      processLevel: 3,
      tectonicDuration: 5,
      fluvialDuration: 0.1,
      landscapeBatches: 1,
    },
  });
  assert.equal(generated.type, 'complete');
  assert.ok(generated.type === 'complete');
  assert.equal(generated.handle.saved, false);
  assert.equal(generated.handle.snapshotId, 'generated');
  assert.deepEqual(await listSnapshots(), []);
  const world = await restoreWorldSnapshot('generated');
  assert.equal(world.grid.count, generated.handle.summary.surfaceCells);
  await promoteSnapshot('generated', 'Keep this world');

  const refined = await run({
    type: 'refine',
    id: 2,
    snapshotId: 'generated',
    outputSnapshotId: 'refined',
    draftOwnerId: session.id,
    request: {
      kind: 'region',
      center: [1, 0, 0],
      radiusMetres: 750000,
      targetSpacingMetres: 350000,
    },
  });
  assert.ok(refined.type === 'complete');
  assert.equal(refined.handle.saved, false);
  assert.ok(refined.handle.summary.surfaceCells > generated.handle.summary.surfaceCells);
  assert.deepEqual(
    (await listSnapshots()).map((entry) => entry.id),
    ['generated'],
  );
  assert.deepEqual(await restoreWorldSnapshot('generated'), world);

  const imported = await run({
    type: 'import',
    id: 3,
    outputSnapshotId: 'imported',
    draftOwnerId: session.id,
    climateConcurrency: 1,
    file: new Blob([JSON.stringify(worldProject(world))]),
  });
  assert.ok(imported.type === 'complete');
  assert.equal(imported.handle.saved, false);
  assert.equal((await openSnapshot('imported')).draftOwnerId, session.id);
  assert.deepEqual(
    (await listSnapshots()).map((entry) => entry.id),
    ['generated'],
  );

  const failed = await run({
    type: 'refine',
    id: 4,
    snapshotId: 'refined',
    outputSnapshotId: 'failed',
    draftOwnerId: session.id,
    request: { kind: 'region', center: [1, 0, 0], radiusMetres: -1, targetSpacingMetres: 350000 },
  });
  assert.equal(failed.type, 'error');
  assert.equal((await openSnapshot('refined')).saved, false);
  await assert.rejects(openSnapshot('failed'), /unavailable/);
  await session.close();
  assert.deepEqual(
    (await listSnapshots()).map((entry) => entry.id),
    ['generated'],
  );
  await assert.rejects(openSnapshot('refined'), /unavailable/);
  await assert.rejects(openSnapshot('imported'), /unavailable/);
});
