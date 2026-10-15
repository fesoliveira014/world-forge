import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { selectTiles, TileStore, type TileResource } from '../src/render/TileLod';
import {
  leafAt,
  tileBounds,
  tileKey,
  tileIndices,
  tileInterpolationStencil,
  type RenderTile,
} from '../src/render/TileGeometry';

function globeScore(camera: PerspectiveCamera) {
  const width = 1400;
  const height = 900;
  return (tile: RenderTile) => {
    const bounds = tileBounds(tile);
    const lon = (bounds.west + bounds.east) / 2;
    const lat = (bounds.south + bounds.north) / 2;
    const direction = new Vector3(
      Math.cos(lat) * Math.cos(lon),
      Math.sin(lat),
      Math.cos(lat) * Math.sin(lon),
    );
    const radius = Math.min(Math.PI, (bounds.east - bounds.west + bounds.north - bounds.south) / 2);
    if (
      direction.angleTo(camera.position) >
      Math.acos(1 / camera.position.length()) + radius + 0.1
    ) {
      return 0;
    }
    const pixels =
      ((bounds.north - bounds.south) * height * camera.zoom) /
      (2 * Math.tan((camera.fov * Math.PI) / 360) * camera.position.distanceTo(direction));
    direction.project(camera);
    const margin = (pixels / Math.min(width, height)) * 2;
    return Math.abs(direction.x) > 1 + margin || Math.abs(direction.y) > 1 + margin
      ? 0
      : pixels / 192;
  };
}

function availableStore() {
  return {
    get: () => ({ bytes: 1, dispose() {} }),
    request: () => false,
    protect() {},
  } as unknown as TileStore<TileResource>;
}

test('a rotating globe never replaces still-visible resident detail with a coarse ancestor', () => {
  const store = availableStore();
  const camera = new PerspectiveCamera(38, 1400 / 900, 0.00001, 100);
  let previous: RenderTile[] = [];
  for (let step = 0; step <= 180; step++) {
    const longitude = 0.74 + (step * Math.PI) / 90;
    camera.position.set(3 * Math.cos(longitude), 0.85, 3 * Math.sin(longitude));
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const score = globeScore(camera);
    const next = selectTiles(store, score);
    const cut = new Map(next.map((tile) => [tileKey(tile), tile]));
    for (const tile of previous) {
      if (score(tile) > 0) {
        const n = 2 ** tile.z;
        const covering = leafAt(cut, (tile.x + 0.5) / n, (tile.y + 0.5) / n);
        assert.ok(
          covering && covering.z >= tile.z,
          `visible ${tileKey(tile)} fell back to ${covering && tileKey(covering)} on rotation step ${step}`,
        );
      }
    }
    assert.ok(next.length <= 64);
    previous = next;
  }
});

test('parent interpolation covers every stitched edge without crossing its actual triangles', () => {
  for (let mask = 0; mask < 16; mask++) {
    const indices = tileIndices(mask);
    for (let y = 0; y <= 32; y++) {
      for (let x = 0; x <= 32; x++) {
        const { vertices, weights } = tileInterpolationStencil(x / 2, y / 2, indices);
        assert.ok(weights.every((weight) => weight >= 0 && weight <= 1));
        const reconstructedX = vertices.reduce((sum, v, i) => sum + (v % 17) * weights[i], 0);
        const reconstructedY = vertices.reduce(
          (sum, v, i) => sum + Math.floor(v / 17) * weights[i],
          0,
        );
        assert.equal(reconstructedX, x / 2);
        assert.equal(reconstructedY, y / 2);
      }
    }
  }
});
