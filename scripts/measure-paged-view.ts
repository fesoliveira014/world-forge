/** Reproducible codec/query benchmark. fake-indexeddb retains the archive in RAM;
 * these storage latencies and process RSS are NOT browser/disk measurements. */
import 'fake-indexeddb/auto';
import { readFile, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { generateWorldAsync } from '../src/core/pipeline';
import { readWorldProject } from '../src/core/project';
import { prepareWorldView } from '../src/core/view/prepare';
import { WorldViewReader } from '../src/core/view/reader';
import { saveWorldSnapshot, SnapshotReader, deleteSnapshot } from '../src/core/storage';
import { closeSnapshotDatabase } from '../src/core/storage/database';
import { createNodeClimatePool } from './climate-pool';

const recipePath = process.argv[2] ?? 'examples/AETHER-EVOLVED.json';
const reportPath = process.argv[3];
const recipe = readWorldProject(JSON.parse(await readFile(recipePath, 'utf8')));
const times: Record<string, number> = {};
async function timed<T>(name: string, run: () => T | Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await run();
  times[name] = performance.now() - start;
  console.error(`${name}: ${(times[name] / 1000).toFixed(3)} s`);
  return result;
}
function typedBytes(value: unknown, seen = new Set<ArrayBufferLike>()): number {
  if (ArrayBuffer.isView(value)) {
    if (seen.has(value.buffer)) {
      return 0;
    }
    seen.add(value.buffer);
    return value.buffer.byteLength;
  }
  if (value && typeof value === 'object') {
    return Object.values(value).reduce<number>((total, item) => total + typedBytes(item, seen), 0);
  }
  return 0;
}
const threads = Math.min(4, availableParallelism());
const pool = createNodeClimatePool(threads);
const generated = await (async () => {
  try {
    const world = await timed('generate', () =>
      generateWorldAsync(recipe.config, undefined, {
        refinementPlans: recipe.refinementPlans,
        climateConcurrency: threads,
        solveClimate: (request) => pool.solve(request),
      }),
    );
    const prepared = await timed('prepareView', () => prepareWorldView(world));
    const sidecarTypedBytes = typedBytes(prepared);
    const snapshot = await timed('saveSnapshot', () => saveWorldSnapshot(world, prepared));
    return { snapshot, sidecarTypedBytes, worldTypedBytes: world.bytes };
  } finally {
    await pool.close();
  }
})();
if (globalThis.gc) {
  globalThis.gc();
}
const snapshot = await timed('openSnapshot', () => SnapshotReader.open(generated.snapshot.id));
try {
  const reader = await timed('openView', () => WorldViewReader.open(snapshot));
  const directions = new Float32Array(128 * 128 * 3);
  for (let row = 0; row < 128; row++) {
    for (let col = 0; col < 128; col++) {
      const lon = -Math.PI / 4 + (((col + 0.5) / 128) * Math.PI) / 2;
      const lat = -Math.PI / 4 + (((row + 0.5) / 128) * Math.PI) / 2;
      directions.set(
        [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)],
        (row * 128 + col) * 3,
      );
    }
  }
  const samples = await timed('coldTile16384', () => reader.sample(directions, 'biomes', -1));
  await timed('warmTile16384', () => reader.sample(directions, 'world', 2));
  await timed('coldInspection', () => reader.inspect([1, 0, 0], 2));
  const overlays = await timed('tileOverlays', () =>
    reader.overlays({
      bounds: { west: -Math.PI / 4, east: Math.PI / 4, south: -Math.PI / 4, north: Math.PI / 4 },
      season: 2,
      rivers: true,
      coasts: true,
      boundaries: true,
      resources: true,
      maxSegments: 4096,
      maxResources: 100,
    }),
  );
  const report = {
    measurement: 'atlas-paged-view/v1',
    storage: 'fake-indexeddb in-memory implementation; not browser disk I/O',
    queries: {
      coldLayer: 'biomes',
      warmLayer: 'world',
      naturalAttributes: 'primal barycentric interpolation',
    },
    recipe: recipePath,
    version: reader.handle.version,
    climateWorkers: threads,
    surfaceCells: reader.handle.summary.surfaceCells,
    worldTypedBytes: generated.worldTypedBytes,
    sidecarTypedBytes: generated.sidecarTypedBytes,
    snapshotBytes: generated.snapshot.bytes,
    timingsMs: times,
    samplePacketBytes: typedBytes(samples),
    overlayPacketBytes: typedBytes(overlays),
    overlayTruncated: overlays.truncated,
    pages: snapshot.stats,
    viewCaches: reader.cacheStats,
    limits: {
      rawPageCacheBytes: 32 * 1024 * 1024,
      metadataCacheBytes: 4 * 1024 * 1024,
      renderBlocks: 16,
      bytesPerRenderBlock: 2048 * 59 * 4,
      spatialLeaves: 128,
      spatialNodes: 4096,
      surfaceFaceBlocks: 16,
      bytesPerSurfaceFaceBlock: 8192 * 6 * 4,
      surfaceStartBlocks: 16,
      surfacePositionBlocks: 32,
      bytesPerSurfacePositionBlock: 2048 * 3 * 8,
    },
  };
  console.log(JSON.stringify(report, null, 2));
  if (reportPath) {
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
} finally {
  snapshot.close();
  await deleteSnapshot(generated.snapshot.id);
  await closeSnapshotDatabase();
}
