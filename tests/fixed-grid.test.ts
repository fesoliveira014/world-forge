import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGrid } from '../src/core/grid/build';
import { createRegionSpacing, refineGrid } from '../src/core/grid/refine';
import type { Grid } from '../src/core/model';
import { FixedGridReader } from '../src/core/view/fixed-grid';
import { FIXED_GRID_EDGES_PER_BATCH } from '../src/core/view/fixed-grid-types';
import type { PageValues } from '../src/core/view/spatial-index';

function fixture(grid: Grid) {
  const drainage = {
    height: Float32Array.from({ length: grid.corners.length / 3 }, (_, id) => (id % 137) - 20),
    lakeId: new Int32Array(grid.corners.length / 3).fill(-1),
    lakeFraction: new Float32Array(grid.corners.length / 3),
    lakes: [{ level: 142.25 }],
  };
  const root = { world: { grid, drainage } };
  const value = (path: string): unknown =>
    path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], root);
  const reads: { path: string; count: number }[] = [];
  const pages: PageValues = {
    async readValue(path) {
      assert.match(
        path,
        /^world\.drainage\.lakes\.\d+\.level$/,
        'no complete array or World restoration',
      );
      reads.push({ path, count: 1 });
      return value(path);
    },
    async readRange(path, start, count) {
      reads.push({ path, count });
      assert.equal(path, 'world.grid.edgeCorners');
      assert.ok(count <= FIXED_GRID_EDGES_PER_BATCH * 2);
      const source = value(path) as ArrayLike<number>;
      return Float64Array.from({ length: count }, (_, i) => source[start + i]);
    },
    async readValues(path, ids) {
      reads.push({ path, count: ids.length });
      assert.ok(ids.length <= FIXED_GRID_EDGES_PER_BATCH * 6);
      const source = value(path) as ArrayLike<number>;
      return Float64Array.from(ids, (id) => source[id]);
    },
  };
  return { reader: new FixedGridReader(pages, { surfaceCells: grid.count }), drainage, reads };
}

const key = (values: ArrayLike<number>, offset: number) =>
  [0, 1, 2].map((axis) => Math.fround(values[offset + axis])).join(',');

async function checkCompleteGrid(grid: Grid) {
  const { reader, drainage, reads } = fixture(grid);
  const manifest = await reader.manifest();
  assert.equal(manifest.edges, grid.edgeCorners.length / 2);
  assert.equal(manifest.vertices, grid.corners.length / 3);
  assert.equal(reads.length, 0, 'manifest needs only small saved summary metadata');
  const corners = new Map(
    Array.from({ length: manifest.vertices }, (_, id) => [key(grid.corners, id * 3), id]),
  );
  const visited = new Set<string>();
  let bytes = 0;
  for (let batch = 0; batch < manifest.batches; batch++) {
    const packet = await reader.batch(batch);
    const ids = Array.from({ length: packet.vertexCount }, (_, vertex) =>
      corners.get(key(packet.vertices, vertex * 4))!,
    );
    assert.ok(
      ids.every((id) => id !== undefined),
      'every endpoint is an original physical dual corner',
    );
    assert.equal(new Set(ids).size, ids.length, 'shared packet corners are stored once');
    assert.ok(packet.indices instanceof Uint16Array);
    assert.ok(ids.length <= FIXED_GRID_EDGES_PER_BATCH * 2);
    assert.equal(
      packet.bytes,
      packet.vertices.byteLength + packet.landCoverage.byteLength + packet.indices.byteLength,
    );
    bytes += packet.bytes;
    for (let vertex = 0; vertex < ids.length; vertex++) {
      assert.equal(packet.vertices[vertex * 4 + 3], drainage.height[ids[vertex]]);
      assert.equal(packet.landCoverage[vertex], drainage.height[ids[vertex]] > 0 ? 255 : 0);
      const errorMetres =
        12_000_000 *
        Math.hypot(
          ...[0, 1, 2].map(
            (axis) => packet.vertices[vertex * 4 + axis] - grid.corners[ids[vertex] * 3 + axis],
          ),
        );
      assert.ok(
        errorMetres < 1,
        `Float32 endpoint error stays sub-metre on a 12,000km planet: ${errorMetres}`,
      );
    }
    for (let index = 0; index < packet.edgeCount * 2; index += 2) {
      const edge = packet.firstEdge + index / 2;
      const a = ids[packet.indices[index]];
      const b = ids[packet.indices[index + 1]];
      assert.equal(a, grid.edgeCorners[edge * 2]);
      assert.equal(b, grid.edgeCorners[edge * 2 + 1]);
      const edgeKey = [a, b].sort((a, b) => a - b).join(',');
      assert.ok(!visited.has(edgeKey), 'each undirected physical edge occurs exactly once');
      visited.add(edgeKey);
    }
  }
  assert.equal(visited.size, manifest.edges);
  assert.ok(bytes >= manifest.estimatedBytes, 'estimate excludes measured boundary duplicates');
  const first = await reader.batch(0);
  const again = await reader.batch(0);
  assert.deepEqual(first, again);
  assert.notEqual(first.vertices.buffer, again.vertices.buffer);
  assert.notEqual(first.indices.buffer, again.indices.buffer);
  first.vertices.fill(0);
  assert.deepEqual(await reader.batch(0), again, 'consumer changes cannot corrupt later reads');
  return manifest;
}

test('persistent grid packets cover all saved dual edges once across bounded reusable batches', async () => {
  const manifest = await checkCompleteGrid(buildGrid(5, 'complete-grid', 0.65));
  assert.ok(manifest.batches > 2, 'exercise complete and partial batch boundaries');
});

test('locally refined physical grids retain exact rebuilt topology without a camera or global map', async () => {
  const source = buildGrid(3, 'refined-grid', 0.65);
  const grid = refineGrid(
    source,
    1000,
    'refined-grid',
    createRegionSpacing(500, 1000, [
      { center: [0, 1, 0], radiusMetres: 250, targetSpacingMetres: 24 },
    ]),
  );
  assert.ok(grid.count > source.count);
  await checkCompleteGrid(grid);
});

test('wet lake edges align with saved physical water surfaces while dry islands keep their elevation', async () => {
  const grid = buildGrid(2, 'grid-lakes', 0.65);
  const { reader, drainage, reads } = fixture(grid);
  drainage.lakeId.fill(0);
  drainage.lakeFraction.fill(0.5);
  drainage.height[1] = 250;
  drainage.lakeFraction[2] = 0;
  const packet = await reader.batch(0);
  const ids = new Map(
    Array.from({ length: grid.corners.length / 3 }, (_, id) => [key(grid.corners, id * 3), id]),
  );
  for (let vertex = 0; vertex < packet.vertexCount; vertex++) {
    const id = ids.get(key(packet.vertices, vertex * 4))!;
    assert.equal(
      packet.vertices[vertex * 4 + 3],
      id === 2 ? drainage.height[id] : Math.max(drainage.height[id], 142.25),
    );
    assert.equal(
      packet.landCoverage[vertex],
      drainage.height[id] <= 0 ? 0 : id === 2 ? 255 : 128,
      'lake water height does not turn a wet shore into dry land',
    );
  }
  assert.equal(
    reads.filter((read) => read.path.endsWith('.level')).length,
    1,
    'read each lake level only once per bounded packet',
  );
});

test('invalid grid requests fail before reading and corrupt endpoints fail explicitly', async () => {
  const grid = buildGrid(1, 'invalid-grid', 0.65);
  const { reader, reads } = fixture(grid);
  for (const batch of [-1, 0.5, NaN, Infinity, 1]) {
    await assert.rejects(reader.batch(batch), /batch/);
  }
  assert.equal(reads.length, 0);
  grid.edgeCorners[0] = grid.corners.length;
  await assert.rejects(reader.batch(0), /corner/);
});
