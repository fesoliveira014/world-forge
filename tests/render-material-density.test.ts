import test from 'node:test';
import assert from 'node:assert/strict';
import { OrthographicCamera, PerspectiveCamera } from 'three';
import { tileMaterialSize, MAX_MATERIAL_INTERVALS } from '../src/render/TileDensity';
import { MAX_TILE_BYTES, selectTiles, TileStore, type TileResource } from '../src/render/TileLod';
import { ROOT_TILES } from '../src/render/TileGeometry';

test('a wide high-DPI overview resolves coast material independently of the 16-segment shape grid', () => {
  const camera = new OrthographicCamera(-Math.PI, Math.PI, Math.PI / 2, -Math.PI / 2);
  const tile = { z: 3, x: 4, y: 4 };
  for (const ratio of [1, 2]) {
    const density = tileMaterialSize(tile, camera, 1550, 775, ratio);
    assert.ok(((1550 / 8) * ratio) / (density.materialWidth - 1) < 1.6);
    assert.ok(((775 / 8) * ratio) / (density.materialHeight - 1) < 1.6);
    assert.ok((density.materialWidth - 1) * (density.materialHeight - 1) <= MAX_MATERIAL_INTERVALS);
  }
});

test('globe material density is stable through rotation and allocates tall polar tiles vertically', () => {
  const camera = new PerspectiveCamera(38, 1.55);
  camera.position.set(0, 0, 3.2);
  const polar = { z: 3, x: 2, y: 7 };
  const before = tileMaterialSize(polar, camera, 1550, 1000, 2);
  camera.position.set(3.2, 0, 0);
  assert.deepEqual(tileMaterialSize(polar, camera, 1550, 1000, 2), before);
  assert.ok(before.materialHeight >= before.materialWidth);
  for (let z = 1; z <= 18; z++) {
    for (const y of [0, 2 ** (z - 1), 2 ** z - 1]) {
      const size = tileMaterialSize({ z, x: 0, y }, camera, 3840, 2160, 2);
      assert.ok(size.materialWidth <= 257 && size.materialHeight <= 257);
      assert.ok((size.materialWidth - 1) * (size.materialHeight - 1) <= MAX_MATERIAL_INTERVALS);
    }
  }
});

test('the display budget accommodates a full cut, all ancestors and a replacement quartet', () => {
  // A full forest with64 leaves has20 internal tiles. The rectangle can rotate.
  const maxTexture = 257 * 129 * 6 * 4 * 2;
  const conservativeShapeAndBorders = 192 * 1024;
  assert.ok((64 + 20 + 4) * (maxTexture + conservativeShapeAndBorders) < MAX_TILE_BYTES);
});

test('a transitioning parent completes before another material transition can subdivide it', () => {
  let transitioning = true;
  const resource = {
    bytes: 1,
    get transitioning() {
      return transitioning;
    },
    dispose() {},
  };
  const store = {
    get: () => resource,
    request: () => false,
    protect() {},
  } as unknown as TileStore<TileResource>;
  assert.deepEqual(
    selectTiles(store, () => 10),
    ROOT_TILES,
  );
  transitioning = false;
  assert.ok(selectTiles(store, () => 10).length > ROOT_TILES.length);
});
