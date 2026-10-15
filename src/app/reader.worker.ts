/// <reference lib="webworker" />
import { SnapshotReader } from '../core/storage';
import { WorldViewReader } from '../core/view/reader';
import type { ReaderResponse } from './WorldDataClient';

interface ReaderRequest {
  id: number;
  snapshotId: string;
  method: string;
  args: unknown[];
}
let snapshotId: string | null = null;
let opening: Promise<{ snapshot: SnapshotReader; view: WorldViewReader }> | null = null;
let queue = Promise.resolve();

function open(id: string) {
  if (snapshotId && snapshotId !== id) {
    throw Error('A reader cannot change snapshot revision.');
  }
  snapshotId = id;
  opening ??= SnapshotReader.open(id).then(async (snapshot) => ({
    snapshot,
    view: await WorldViewReader.open(snapshot),
  }));
  return opening;
}

function transferableBuffers(value: unknown, found = new Set<ArrayBuffer>()): ArrayBuffer[] {
  if (value instanceof ArrayBuffer) {
    found.add(value);
  } else if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) {
    found.add(value.buffer);
  } else if (value && typeof value === 'object' && !(value instanceof Blob)) {
    for (const child of Object.values(value)) {
      transferableBuffers(child, found);
    }
  }
  return [...found];
}

async function run(request: ReaderRequest) {
  const { id, snapshotId, method, args } = request;
  try {
    const { snapshot, view } = await open(snapshotId);
    let value: unknown;
    if (method === 'exportRecipe') {
      // Reconstruct just the recipe inside this worker. The page receives a Blob,
      // never the full resolved-plan graph or any physical-world arrays.
      const [
        version,
        config,
        resourceRecipe,
        refinementPlans,
        regionalRefinements,
        featureRefinementPlans,
        featureCoarseningPlans,
      ] = await Promise.all([
        snapshot.readValue('world.version'),
        snapshot.readValue('world.config'),
        snapshot.readValue('world.resources.recipe'),
        snapshot.readValue('world.refinementPlans'),
        snapshot.readOptionalValue('world.regionalRefinements'),
        snapshot.readOptionalValue('world.featureRefinementPlans'),
        snapshot.readOptionalValue('world.featureCoarseningPlans'),
      ]);
      value = new Blob(
        [
          JSON.stringify(
            {
              version,
              config,
              resourceRecipe,
              refinementPlans,
              regionalRefinements,
              featureRefinementPlans,
              featureCoarseningPlans,
            },
            null,
            2,
          ),
        ],
        { type: 'application/json' },
      );
    } else if (method === 'gridManifest') {
      value = await view.gridManifest();
    } else if (method === 'gridBatch') {
      value = await view.gridBatch(...(args as Parameters<WorldViewReader['gridBatch']>));
    } else if (method === 'physicalManifest') {
      value = await view.physicalManifest(
        ...(args as Parameters<WorldViewReader['physicalManifest']>),
      );
    } else if (method === 'physicalBatch') {
      value = await view.physicalBatch(...(args as Parameters<WorldViewReader['physicalBatch']>));
    } else if (method === 'riverRender') {
      value = await view.riverRender(...(args as Parameters<WorldViewReader['riverRender']>));
    } else if (method === 'sample') {
      value = await view.sample(...(args as Parameters<WorldViewReader['sample']>));
    } else if (method === 'inspect') {
      value = await view.inspect(...(args as Parameters<WorldViewReader['inspect']>));
    } else if (method === 'overlays') {
      value = await view.overlays(...(args as Parameters<WorldViewReader['overlays']>));
    } else if (method === 'inspectDeposit') {
      value = await view.inspectDeposit(...(args as Parameters<WorldViewReader['inspectDeposit']>));
    } else if (method === 'listDeposits') {
      value = await view.listDeposits(...(args as Parameters<WorldViewReader['listDeposits']>));
    } else if (method === 'diagnostics') {
      value = await view.diagnostics();
    } else if (method === 'pagingStats') {
      value = snapshot.stats;
    } else {
      throw Error('Unknown saved-world request.');
    }
    // The result can include cached sidecar data. Copy only this bounded packet
    // before transferring so cache ownership can never be detached by a reply.
    const outgoing = structuredClone(value);
    self.postMessage(
      { id, snapshotId, value: outgoing } satisfies ReaderResponse,
      transferableBuffers(outgoing),
    );
  } catch (error) {
    self.postMessage({
      id,
      snapshotId,
      error: error instanceof Error ? error.message : String(error),
    } satisfies ReaderResponse);
  }
}

self.onmessage = (event: MessageEvent<ReaderRequest>) => {
  // One active query gives the raw-page cache a predictable working-set bound.
  queue = queue.then(() => run(event.data));
};
