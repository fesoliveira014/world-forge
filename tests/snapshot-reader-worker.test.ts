import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { generateWorld } from '../src/core/pipeline';
import { DEFAULT_CONFIG, type World } from '../src/core/model';
import { worldProject, readWorldProject } from '../src/core/project';
import { refineExistingWorld } from '../src/core/regional-refinement';
import { prepareWorldView } from '../src/core/view/prepare';
import type {
  CellInspection,
  CellSampleBatch,
  DepositInspection,
  DepositPage,
  OverlayPacket,
  WorldSummary,
} from '../src/core/view/types';
import { saveWorldSnapshot } from '../src/core/storage';
import { closeSnapshotDatabase, SNAPSHOT_DATABASE_NAME } from '../src/core/storage/database';
import type { ReaderResponse } from '../src/app/WorldDataClient';
import type {
  PhysicalMeshManifest,
  PhysicalMeshPacket,
} from '../src/core/view/physical-mesh-types';
import type { FixedRiverBatch } from '../src/core/view/river-render-types';
import type { FixedGridManifest, FixedGridPacket } from '../src/core/view/fixed-grid-types';

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

let fixtureWorld: World | undefined;
function worldFixture() {
  fixtureWorld ??= generateWorld({
    ...DEFAULT_CONFIG,
    seed: 'snapshot-worker-inspection',
    surfaceLevel: 3,
    processLevel: 3,
    tectonicDuration: 5,
    fluvialDuration: 0.1,
    landscapeBatches: 1,
  });
  return fixtureWorld;
}

let workerSequence = 0;
/** Execute the actual browser worker protocol, including transfer detachment. */
async function readerHarness(snapshotId: string) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'self');
  let requestId = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const scope = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage(message: ReaderResponse, transfer: Transferable[] = []) {
      const response = structuredClone(message, { transfer });
      const callbacks = pending.get(response.id);
      assert.ok(callbacks, 'every worker response belongs to a pending request');
      pending.delete(response.id);
      assert.equal(response.snapshotId, snapshotId);
      if (response.error) {
        callbacks.reject(new Error(response.error));
      } else {
        callbacks.resolve(response.value);
      }
    },
  };
  Object.defineProperty(globalThis, 'self', { configurable: true, value: scope });
  const moduleUrl = new URL('../src/app/reader.worker.ts', import.meta.url);
  moduleUrl.searchParams.set('protocol-test', String(++workerSequence));
  try {
    await import(moduleUrl.href);
  } catch (error) {
    if (previous) {
      Object.defineProperty(globalThis, 'self', previous);
    } else {
      Reflect.deleteProperty(globalThis, 'self');
    }
    throw error;
  }
  return {
    call<T>(method: string, ...args: unknown[]): Promise<T> {
      const id = ++requestId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve: (value) => resolve(value as T), reject });
        scope.onmessage!({ data: structuredClone({ id, snapshotId, method, args }) });
      });
    },
    close() {
      assert.equal(pending.size, 0);
      if (previous) {
        Object.defineProperty(globalThis, 'self', previous);
      } else {
        Reflect.deleteProperty(globalThis, 'self');
      }
    },
  };
}

test('cold reader worker exports base recipes and returns transferable inspection/resource packets', async (context) => {
  const world = worldFixture();
  const prepared = prepareWorldView(world);
  await saveWorldSnapshot(world, { id: 'base', ...prepared });
  const worker = await readerHarness('base');
  context.after(() => worker.close());
  const summary = await worker.call<WorldSummary>('diagnostics');
  assert.deepEqual(summary, prepared.summary);
  const recipe = await worker.call<Blob>('exportRecipe');
  assert.ok(recipe instanceof Blob);
  assert.deepEqual(
    JSON.parse(await recipe.text()),
    JSON.parse(JSON.stringify(worldProject(world))),
  );
  assert.equal(readWorldProject(JSON.parse(await recipe.text())).regionalRefinements, undefined);

  const cell = 17;
  const direction = Array.from(world.grid.positions.subarray(cell * 3, cell * 3 + 3));
  const inspection = await worker.call<CellInspection>('inspect', direction, -1);
  assert.equal(inspection.cell, cell);
  assert.equal(inspection.height, world.terrain.height[cell]);
  assert.equal(inspection.bedrock, world.terrain.bedrock[cell]);
  assert.equal(inspection.sediment, world.terrain.sediment[cell]);
  assert.equal(
    inspection.outline.length,
    (world.grid.offsets[cell + 1] - world.grid.offsets[cell]) * 3,
  );
  const directions = Float32Array.from(direction);
  const first = await worker.call<CellSampleBatch>('sample', directions, 'elevation', 2);
  const second = await worker.call<CellSampleBatch>('sample', directions, 'elevation', 2);
  assert.deepEqual(
    first,
    second,
    'transferring an earlier reply must not detach cached display records',
  );
  assert.deepEqual(first.cellIds, new Uint32Array([cell]));

  assert.ok(world.resources.deposits.length > 0, 'fixture must exercise the saved deposit lookup');
  const deposits = await worker.call<DepositPage>('listDeposits', 'all', 0, 2);
  assert.deepEqual(deposits.items, world.resources.deposits.slice(0, 2));
  assert.equal(deposits.total, world.resources.deposits.length);
  const expected = world.resources.deposits[0];
  const detail = await worker.call<DepositInspection>('inspectDeposit', expected.id);
  assert.deepEqual(detail.deposit, expected);
  assert.equal(await worker.call('inspectDeposit', 'missing-deposit-id'), null);
  const overlays = await worker.call<OverlayPacket>('overlays', {
    bounds: { west: -Math.PI, east: Math.PI, south: -Math.PI / 2, north: Math.PI / 2 },
    season: 1,
    layer: 'wind',
    rivers: true,
    coasts: true,
    boundaries: true,
    gridLines: true,
    vectors: true,
    drift: 5,
    maxVectors: 16,
    maxSegments: 600,
  });
  const lines = [
    overlays.rivers,
    overlays.coasts,
    overlays.boundaries,
    overlays.flow,
    overlays.grid,
    overlays.drift,
  ];
  assert.ok(lines.reduce((total, line) => total + line.positions.length / 6, 0) <= 600);
  assert.equal(overlays.gridStatus, 'zoom-in');
  assert.equal(overlays.grid.positions.length, 0);
  assert.ok(overlays.flow.positions.length > 0 && overlays.drift.positions.length > 0);
  assert.ok(
    lines.every((line) =>
      [...line.positions, ...line.heights, ...line.widths].every(Number.isFinite),
    ),
  );
  await assert.rejects(worker.call('sample', directions, 'world', 99), /Season/);
  assert.equal(
    (await worker.call<WorldSummary>('diagnostics')).surfaceCells,
    world.grid.count,
    'one invalid request must not poison the worker queue',
  );
});

test('regional snapshot recipes retain exact resolved history when exported from a cold worker', async (context) => {
  const base = worldFixture();
  const refined = refineExistingWorld(base, {
    kind: 'region',
    center: [1, 0, 0],
    radiusMetres: 750000,
    targetSpacingMetres: 350000,
  });
  assert.ok(refined.grid.count > base.grid.count);
  assert.equal(refined.regionalRefinements?.length, 1);
  await saveWorldSnapshot(refined, { id: 'regional', ...prepareWorldView(refined) });
  const worker = await readerHarness('regional');
  context.after(() => worker.close());
  const recipe = await worker.call<Blob>('exportRecipe');
  const project = readWorldProject(JSON.parse(await recipe.text()));
  assert.deepEqual(project.regionalRefinements, refined.regionalRefinements);
  assert.deepEqual(project.refinementPlans, refined.refinementPlans);
  assert.equal((await worker.call<WorldSummary>('diagnostics')).surfaceCells, refined.grid.count);
});

test('fixed mesh, complete grid and river replies survive transfer and invalid requests on an existing snapshot', async (context) => {
  const world = worldFixture();
  await saveWorldSnapshot(world, { id: 'fixed-display', ...prepareWorldView(world) });
  const worker = await readerHarness('fixed-display');
  context.after(() => worker.close());
  const manifest = await worker.call<PhysicalMeshManifest>('physicalManifest', 'world', -1);
  assert.equal(manifest.triangles, world.grid.triangles.length / 3);
  assert.equal(manifest.physicalVertices, world.grid.count);
  const mesh = await worker.call<PhysicalMeshPacket>('physicalBatch', 'world', -1, 0);
  const again = await worker.call<PhysicalMeshPacket>('physicalBatch', 'world', -1, 0);
  assert.deepEqual(
    again,
    mesh,
    'reply transfer must not detach reusable topology or display fields',
  );
  assert.ok(mesh.indices.length > 0);
  assert.ok(mesh.directions.length > 0);
  const gridManifest = await worker.call<FixedGridManifest>('gridManifest');
  assert.equal(gridManifest.edges, world.grid.edgeCorners.length / 2);
  assert.equal(gridManifest.vertices, world.grid.corners.length / 3);
  let gridEdges = 0;
  for (let batch = 0; batch < gridManifest.batches; batch++) {
    const grid = await worker.call<FixedGridPacket>('gridBatch', batch);
    const repeated = await worker.call<FixedGridPacket>('gridBatch', batch);
    assert.deepEqual(repeated, grid, 'grid transfers leave the page reader reusable');
    assert.notEqual(repeated.vertices.buffer, grid.vertices.buffer);
    assert.ok(grid.indices instanceof Uint16Array);
    gridEdges += grid.edgeCount;
    const cornerIds = [
      ...new Set(
        world.grid.edgeCorners.subarray(
          grid.firstEdge * 2,
          grid.firstEdge * 2 + grid.edgeCount * 2,
        ),
      ),
    ].sort((a, b) => a - b);
    for (let vertex = 0; vertex < cornerIds.length; vertex++) {
      const corner = cornerIds[vertex];
      const lake = world.drainage.lakeId[corner];
      const expectedHeight =
        lake >= 0 && world.drainage.lakeFraction[corner] > 0
          ? Math.max(world.drainage.height[corner], world.drainage.lakes[lake].level)
          : world.drainage.height[corner];
      assert.equal(grid.vertices[vertex * 4 + 3], Math.fround(expectedHeight));
      for (let axis = 0; axis < 3; axis++) {
        assert.equal(
          grid.vertices[vertex * 4 + axis],
          Math.fround(world.grid.corners[corner * 3 + axis]),
        );
      }
    }
    assert.equal(
      grid.bytes,
      grid.vertices.byteLength + grid.landCoverage.byteLength + grid.indices.byteLength,
    );
  }
  assert.equal(gridEdges, gridManifest.edges);
  const request = { season: -1, threshold: 0, batch: 0 };
  const rivers = await worker.call<FixedRiverBatch>('riverRender', request);
  const riversAgain = await worker.call<FixedRiverBatch>('riverRender', request);
  assert.deepEqual(riversAgain, rivers, 'cached river geometry remains available after transfer');
  assert.ok(rivers.totalPaths > 0);
  assert.ok(rivers.offsets.length > 1);
  assert.ok(rivers.curvatureLimits instanceof Float32Array);
  assert.ok(rivers.outgoing instanceof Float32Array);
  assert.equal(rivers.outgoing.length, rivers.kinds.length * 3);
  assert.equal(rivers.curvatureLimits.length, rivers.heights.length);
  assert.ok(rivers.curvatureLimits.every((limit) => Number.isFinite(limit) && limit > 0));
  assert.ok(
    rivers.curvatureLimits.some((limit) => limit < 1),
    'prepared curve limits cross the actual worker protocol',
  );
  assert.notEqual(
    riversAgain.curvatureLimits!.buffer,
    rivers.curvatureLimits.buffer,
    'transfers clone cached curve limits into independent buffers',
  );
  await assert.rejects(worker.call('physicalBatch', 'world', 99, 0), /Season/);
  await assert.rejects(worker.call('physicalBatch', 'world', -1, manifest.batches), /batch/i);
  await assert.rejects(worker.call('gridBatch', gridManifest.batches), /batch/i);
  await assert.rejects(worker.call('riverRender', { ...request, season: 99 }), /Season/);
  assert.equal((await worker.call<WorldSummary>('diagnostics')).surfaceCells, world.grid.count);
});

test('reader recipe export preserves final quiet-land coarsening plans and diagnostics', async (context) => {
  const world = generateWorld({
    ...worldFixture().config,
    featureRefinementPasses: 1,
    featureRefinementBudget: 0,
    featureCoarseningBudget: 10,
    featureCoarseningSpacing: 1000000,
  });
  assert.equal(world.featureCoarseningPlans?.length, 1);
  const prepared = prepareWorldView(world);
  await saveWorldSnapshot(world, { id: 'quiet-land-recipe', ...prepared });
  const worker = await readerHarness('quiet-land-recipe');
  context.after(() => worker.close());
  const blob = await worker.call<Blob>('exportRecipe');
  const recipe = readWorldProject(JSON.parse(await blob.text()));
  assert.deepEqual(recipe.featureCoarseningPlans, world.featureCoarseningPlans);
  assert.deepEqual(recipe.featureRefinementPlans, world.featureRefinementPlans);
  assert.equal(recipe.config.featureCoarseningBudget, 10);
  const summary = await worker.call<WorldSummary>('diagnostics');
  assert.deepEqual(summary.featureCoarseningStats, world.featureCoarseningStats);
  assert.equal(
    summary.featureCoarseningStats?.[0].afterCells,
    world.grid.count,
    'zero insertion budget leaves the post-coarsening cell count unchanged',
  );
});
