import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROOT_TILES,
  leafAt,
  tileKey,
  tileParent,
  type RenderTile,
} from '../src/render/TileGeometry';
import {
  MAX_ACTIVE_TILES,
  MAX_RESIDENT_TILES,
  MAX_TILE_BYTES,
  MAX_TILE_REQUESTS,
  selectTiles,
  TileStore,
  type TileResource,
} from '../src/render/TileLod';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const cutMap = (leaves: RenderTile[]) => new Map(leaves.map((tile) => [tileKey(tile), tile]));

function assertCompleteBalancedCut(leaves: RenderTile[]) {
  assert.ok(leaves.length <= MAX_ACTIVE_TILES);
  const map = cutMap(leaves);
  let area = 0;
  for (const tile of leaves) {
    area += 4 ** -tile.z;
    for (let parent = tileParent(tile); parent.z >= 1; parent = tileParent(parent)) {
      assert.equal(map.has(tileKey(parent)), false, 'a tile overlaps its selected ancestor');
    }
  }
  assert.equal(area, 1, 'the cut must cover all four roots without gaps');
  // Check all pairs at a common integer resolution. Unlike midpoint neighbor queries,
  // this includes both halves of an edge and the wrapped longitude seam.
  const resolution = 2 ** Math.max(...leaves.map((tile) => tile.z));
  for (let i = 0; i < leaves.length; i++) {
    const a = leaves[i];
    const scaleA = resolution / 2 ** a.z;
    const ax = a.x * scaleA;
    const ay = a.y * scaleA;
    for (const b of leaves.slice(i + 1)) {
      const scaleB = resolution / 2 ** b.z;
      const bx = b.x * scaleB;
      const by = b.y * scaleB;
      const vertical =
        ((ax + scaleA) % resolution === bx || (bx + scaleB) % resolution === ax) &&
        Math.max(ay, by) < Math.min(ay + scaleA, by + scaleB);
      const horizontal =
        (ay + scaleA === by || by + scaleB === ay) &&
        Math.max(ax, bx) < Math.min(ax + scaleA, bx + scaleB);
      if (vertical || horizontal) {
        assert.ok(Math.abs(a.z - b.z) <= 1, `${tileKey(a)} and ${tileKey(b)} exceed 2:1`);
      }
    }
  }
}

function assertVisibleDetailPreserved(
  previous: RenderTile[],
  next: RenderTile[],
  score: (tile: RenderTile) => number,
) {
  const map = cutMap(next);
  for (const tile of previous) {
    if (!score(tile)) {
      continue;
    }
    const n = 2 ** tile.z;
    const covering = leafAt(map, (tile.x + 0.5) / n, (tile.y + 0.5) / n);
    assert.ok(
      covering && covering.z >= tile.z,
      `visible ${tileKey(tile)} fell back to ${covering && tileKey(covering)}`,
    );
  }
}

/** A geographic viewport, with periodic longitude and a bounded latitude range. */
function viewportScore(u: number, v: number, width: number, height: number) {
  return (tile: RenderTile) => {
    const n = 2 ** tile.z;
    const west = tile.x / n;
    const east = (tile.x + 1) / n;
    const south = tile.y / n;
    const north = (tile.y + 1) / n;
    if (north < v - height / 2 || south > v + height / 2) {
      return 0;
    }
    const intersects = [-1, 0, 1].some(
      (wrap) => east + wrap >= u - width / 2 && west + wrap <= u + width / 2,
    );
    return intersects ? 2 / (n * Math.min(width, height)) : 0;
  };
}

function availableStore() {
  return {
    get: () => ({ bytes: 1, dispose() {} }),
    request: () => false,
    protect() {},
  } as unknown as TileStore<TileResource>;
}

test('asynchronous rotation across the dateline preserves visible detail under cache pressure', async () => {
  let disposed = 0;
  const store = new TileStore<TileResource>(
    async () => ({
      bytes: MAX_TILE_BYTES / MAX_RESIDENT_TILES,
      dispose() {
        disposed++;
      },
    }),
    () => {},
  );
  let previous: RenderTile[] = [];
  for (let step = -30; step <= 100; step++) {
    const u = (Math.max(0, step) / 100 + 0.86) % 1;
    const score = viewportScore(u, 0.53, 0.15, 0.22);
    for (let pass = 0; pass < 2; pass++) {
      const next = selectTiles(store, score);
      if (next.length >= ROOT_TILES.length) {
        assertCompleteBalancedCut(next);
        assertVisibleDetailPreserved(previous, next, score);
      }
      for (const tile of next) {
        assert.ok(store.get(tile), 'selected tile must stay resident');
      }
      assert.ok(store.size <= MAX_RESIDENT_TILES);
      assert.ok(store.bytes <= MAX_TILE_BYTES);
      assert.ok(store.loading <= MAX_TILE_REQUESTS);
      previous = next;
      await flush();
    }
  }
  assert.ok(disposed > 0, 'the trajectory must actually exercise cache eviction');
  assert.ok(Math.max(...previous.map((tile) => tile.z)) >= 4);
  store.dispose();
  assert.equal(store.bytes, 0);
});

test('large map pans free invisible detail and allow refinement at the new focus', async () => {
  const store = new TileStore<TileResource>(
    async () => ({ bytes: 1000, dispose() {} }),
    () => {},
  );
  let previous: RenderTile[] = [];
  for (const [u, v] of [
    [0.001, 0.001],
    [0.999, 0.999],
    [0.251, 0.749],
    [0.749, 0.251],
  ]) {
    const score = viewportScore(u, v, 1 / 1024, 1 / 1024);
    for (let pass = 0; pass < 120; pass++) {
      const next = selectTiles(store, score);
      if (next.length >= ROOT_TILES.length) {
        assertCompleteBalancedCut(next);
        assertVisibleDetailPreserved(previous, next, score);
      }
      previous = next;
      await flush();
    }
    const covering = leafAt(cutMap(previous), u, v);
    assert.ok(covering && covering.z >= 6, `pan to ${u}, ${v} remained at level ${covering?.z}`);
    assert.ok(store.size <= MAX_RESIDENT_TILES);
    assert.ok(store.bytes <= MAX_TILE_BYTES);
  }
  store.dispose();
});

test('visible detail coarsens only after explicit zoom-out and outside the hysteresis band', () => {
  const store = availableStore();
  const score = (rootScore: number) => (tile: RenderTile) => rootScore / 2 ** (tile.z - 1);
  let leaves = selectTiles(store, score(1.3));
  assert.equal(leaves.length, 16);
  leaves = selectTiles(store, score(0.1));
  assert.equal(leaves.length, 16, 'rotation and pan cannot downgrade visible detail');
  for (const rootScore of [0.66, 0.9, 0.7, 0.66]) {
    leaves = selectTiles(store, score(rootScore), 64, 18, { allowVisibleCoarsening: true });
    assert.equal(leaves.length, 16, 'small zoom fluctuations must not alternate parent and child');
  }
  leaves = selectTiles(store, score(0.64), 64, 18, { allowVisibleCoarsening: true });
  assert.equal(leaves.length, 4);
  leaves = selectTiles(store, score(1.14));
  assert.equal(
    leaves.length,
    4,
    'a recently merged parent should survive below the split threshold',
  );
  leaves = selectTiles(store, score(1.16));
  assert.equal(leaves.length, 16);
  assertCompleteBalancedCut(leaves);
});

test('staggered root readiness never subdivides a partial globe or drops an available root', async () => {
  const pending = new Map<string, (value: TileResource) => void>();
  const store = new TileStore<TileResource>(
    (tile) => new Promise((resolve) => pending.set(tileKey(tile), resolve)),
    () => {},
  );
  assert.deepEqual(
    selectTiles(store, () => 100),
    [],
  );
  for (let i = 0; i < ROOT_TILES.length; i++) {
    pending.get(tileKey(ROOT_TILES[i]))!({ bytes: 100, dispose() {} });
    await flush();
    const leaves = selectTiles(store, () => 100);
    assert.equal(leaves.length, i + 1);
    assert.ok(leaves.every((tile) => tile.z === 1));
    for (const root of ROOT_TILES.slice(0, i + 1)) {
      assert.ok(leaves.some((tile) => tileKey(tile) === tileKey(root)));
    }
  }
  store.dispose();
  for (const resolve of pending.values()) {
    resolve({ bytes: 100, dispose() {} });
  }
  await flush();
});
