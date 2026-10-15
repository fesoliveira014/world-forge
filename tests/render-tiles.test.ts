import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROOT_TILES,
  tileChildren,
  tileDirections,
  tileIndices,
  tileKey,
  tileNeighbors,
  type RenderTile,
} from '../src/render/TileGeometry';
import { selectTiles, TileStore, type TileResource } from '../src/render/TileLod';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('dyadic tile edges match bit-for-bit across LODs, the dateline, and poles', () => {
  const parent = { z: 3, x: 3, y: 4 };
  const coarse = tileDirections(parent);
  const child = tileDirections(tileChildren(parent)[0]);
  for (let i = 0; i <= 8; i++) {
    for (let axis = 0; axis < 3; axis++) {
      assert.equal(coarse[i * 3 + axis], child[i * 2 * 3 + axis]);
      assert.equal(coarse[i * 17 * 3 + axis], child[i * 2 * 17 * 3 + axis]);
    }
  }
  const west = tileDirections({ z: 4, x: 0, y: 7 });
  const east = tileDirections({ z: 4, x: 15, y: 7 });
  for (let y = 0; y <= 16; y++) {
    assert.deepEqual(
      west.slice(y * 17 * 3, y * 17 * 3 + 3),
      east.slice((y * 17 + 16) * 3, (y * 17 + 16) * 3 + 3),
    );
  }
  const north = tileDirections({ z: 4, x: 5, y: 15 });
  for (let x = 0; x <= 16; x++) {
    assert.deepEqual([...north.slice((16 * 17 + x) * 3, (16 * 17 + x) * 3 + 3)], [0, 1, 0]);
  }
});

test('every mixed-LOD stitch covers its tile without reversed or overlapping triangles', () => {
  for (let mask = 0; mask < 16; mask++) {
    const indices = tileIndices(mask);
    let area = 0;
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [...indices.slice(i, i + 3)];
      const ax = a % 17;
      const ay = Math.floor(a / 17);
      const bx = b % 17;
      const by = Math.floor(b / 17);
      const cx = c % 17;
      const cy = Math.floor(c / 17);
      const signed = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      assert.ok(signed <= 0, `mask ${mask} reversed a triangle`);
      area -= signed / 2;
      for (const vertex of [a, b, c]) {
        const x = vertex % 17;
        const y = Math.floor(vertex / 17);
        if ((mask & 1 && x === 0) || (mask & 2 && x === 16)) {
          assert.equal(y % 2, 0);
        }
        if ((mask & 4 && y === 0) || (mask & 8 && y === 16)) {
          assert.equal(x % 2, 0);
        }
      }
    }
    assert.equal(area, 256, `mask ${mask} leaves a hole`);
  }
});

test('parents remain until all four child packets arrive, with at most four requests', async () => {
  const pending = new Map<string, (resource: TileResource) => void>();
  const store = new TileStore<TileResource>(
    (tile) => new Promise((resolve) => pending.set(tileKey(tile), resolve)),
    () => {},
  );
  assert.equal(selectTiles(store, () => 2).length, 0);
  assert.equal(store.loading, 4);
  for (const root of ROOT_TILES) {
    pending.get(tileKey(root))!({ bytes: 100, dispose() {} });
  }
  await flush();
  let leaves = selectTiles(store, () => 2);
  assert.equal(leaves.length, 4);
  const children = tileChildren(ROOT_TILES[0]);
  for (const child of children.slice(0, 3)) {
    pending.get(tileKey(child))!({ bytes: 100, dispose() {} });
  }
  await flush();
  leaves = selectTiles(store, () => 2);
  assert.ok(leaves.some((tile) => tileKey(tile) === tileKey(ROOT_TILES[0])));
  pending.get(tileKey(children[3]))!({ bytes: 100, dispose() {} });
  await flush();
  leaves = selectTiles(store, () => 2);
  assert.equal(leaves.length, 7);
  assert.ok(!leaves.some((tile) => tileKey(tile) === tileKey(ROOT_TILES[0])));
  assert.ok(store.loading <= 4);
  store.dispose();
});

test('focal zoom keeps residency and active leaves bounded and neighbors stitched', async () => {
  let disposed = 0;
  const store = new TileStore<TileResource>(
    async () => ({
      bytes: 1000,
      dispose() {
        disposed++;
      },
    }),
    () => {},
    128,
    128000,
  );
  const score = (tile: RenderTile) =>
    tile.x === 0 && tile.y === 0 ? 100 / tile.z : tile.z < 2 ? 2 : 0.5;
  let leaves: RenderTile[] = [];
  for (let pass = 0; pass < 100; pass++) {
    leaves = selectTiles(store, score, 64, 10);
    await flush();
  }
  assert.ok(Math.max(...leaves.map((tile) => tile.z)) >= 7);
  assert.ok(leaves.length <= 64);
  assert.ok(store.size <= 128);
  assert.ok(store.bytes <= 128000);
  const map = new Map(leaves.map((tile) => [tileKey(tile), tile]));
  for (const tile of leaves) {
    for (const neighbor of tileNeighbors(tile, map)) {
      if (neighbor) {
        assert.ok(Math.abs(tile.z - neighbor.z) <= 1);
      }
    }
  }
  const size = store.size;
  store.dispose();
  assert.ok(disposed >= size);
  assert.equal(store.bytes, 0);
});

test('late packets are disposed after snapshot invalidation and cannot resurrect a cache', async () => {
  let resolve!: (resource: TileResource) => void;
  let disposed = 0;
  let changed = 0;
  const store = new TileStore<TileResource>(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
    () => {
      changed++;
    },
  );
  store.request(ROOT_TILES[0]);
  store.dispose();
  resolve({
    bytes: 100,
    dispose() {
      disposed++;
    },
  });
  await flush();
  assert.equal(disposed, 1);
  assert.equal(store.size, 0);
  assert.equal(changed, 0);
});

test('uneven tile readiness at the leaf budget cannot oscillate between splits and merges', () => {
  // This readiness/priority layout made the former repair pass repeat a 46-leaf state forever.
  const hash = (z: number, x: number, y: number) => {
    let value = (3 * 123456789 + z * 1836311903 + x * 2971215073 + y * 297121507) >>> 0;
    value ^= value >>> 13;
    value = Math.imul(value, 60493);
    value ^= value >>> 17;
    return (value >>> 0) / 4294967296;
  };
  let lookups = 0;
  const store = {
    get(tile: RenderTile) {
      // A bounded assertion turns a regression into a failure instead of hanging the test runner.
      assert.ok(++lookups < 100000, 'tile selection failed to make bounded progress');
      return tile.z === 1 || hash(tile.z, tile.x, tile.y) > 0.07
        ? { bytes: 1, dispose() {} }
        : undefined;
    },
    request() {
      return false;
    },
    protect() {},
  } as unknown as TileStore<TileResource>;
  const score = (tile: RenderTile) =>
    tile.z < 7 ? (hash(tile.z + 11, tile.x, tile.y) * 9) / 2 ** (tile.z - 3) : 0;
  const leaves = selectTiles(store, score, 64, 9);
  assert.ok(leaves.length <= 64);
  const map = new Map(leaves.map((tile) => [tileKey(tile), tile]));
  for (const tile of leaves) {
    for (const neighbor of tileNeighbors(tile, map)) {
      if (neighbor) {
        assert.ok(Math.abs(tile.z - neighbor.z) <= 1);
      }
    }
  }
});
