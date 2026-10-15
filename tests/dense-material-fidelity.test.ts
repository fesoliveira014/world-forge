import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Raycaster,
  Vector2,
  Vector3,
} from 'three';
import type { CellSampleBatch, WorldHandle, WorldViewSource } from '../src/core/view/types';
import {
  geographicMaterialUv,
  loadDenseSurface,
  materialDirections,
  MAX_MATERIAL_QUERY,
} from '../src/render/DenseSurface';
import {
  tileBounds,
  tileDirections,
  tileIndices,
  type RenderTile,
} from '../src/render/TileGeometry';

const normalize = (point: number[]) => {
  const length = Math.hypot(...point);
  return point.map((value) => value / length);
};

test('polar material lookup follows the geographic meridian, independent of collapsed fan UVs', () => {
  for (const sign of [-1, 1]) {
    const tile = { z: 3, x: 3, y: sign > 0 ? 7 : 0 };
    const grid = tileDirections(tile);
    const row = sign > 0 ? 15 : 1;
    const column = 7;
    const base = Array.from(grid.subarray((row * 17 + column) * 3, (row * 17 + column) * 3 + 3));
    for (const towardPole of [0.1, 0.5, 0.9, 0.999]) {
      const point = base.map(
        (value, axis) => value * (1 - towardPole) + (axis === 1 ? sign : 0) * towardPole,
      );
      const uv = geographicMaterialUv(tile, point as [number, number, number]);
      assert.ok(
        Math.abs(uv[0] - column / 16) < 2e-7,
        'a true meridian has constant texture longitude all the way to the pole',
      );
      const expectedLatitude = Math.asin(normalize(point)[1]);
      const bounds = tileBounds(tile);
      assert.ok(
        Math.abs(uv[1] - (expectedLatitude - bounds.south) / (bounds.north - bounds.south)) < 2e-7,
      );
      if (towardPole === 0.5) {
        // The previous UV path moves half a geometry column along this same edge.
        const oldUv = (column - towardPole) / 16;
        assert.ok(Math.abs(uv[0] - oldUv) * 128 > 3.99);
      }
    }
  }
});

test('north and south camera rays reach continuous geographic samples around the true pole', () => {
  for (const sign of [-1, 1]) {
    const tiles = Array.from({ length: 8 }, (_, x) => ({ z: 3, x, y: sign > 0 ? 7 : 0 }));
    const meshes = tiles.map((tile) => {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(tileDirections(tile), 3));
      geometry.setIndex(new BufferAttribute(tileIndices(), 1));
      const mesh = new Mesh(geometry, new MeshBasicMaterial({ side: DoubleSide }));
      mesh.userData.tile = tile;
      mesh.updateMatrixWorld();
      return mesh;
    });
    const camera = new PerspectiveCamera(45, 1, 0.01, 20);
    camera.position.set(0, sign * 3, 0);
    camera.up.set(0, 0, 1);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const raycaster = new Raycaster();
    for (const radius of [0, 0.002, 0.02]) {
      for (let step = 0; step < 32; step++) {
        const angle = ((step + 0.37) * Math.PI) / 16;
        raycaster.setFromCamera(
          new Vector2(Math.cos(angle) * radius, Math.sin(angle) * radius),
          camera,
        );
        const hit = raycaster.intersectObjects(meshes, false)[0];
        assert.ok(
          hit,
          `no polar geometry hole for hemisphere ${sign}, radius ${radius}, ray ${step}`,
        );
        const direction = hit.point.clone().normalize();
        const tile = hit.object.userData.tile as RenderTile;
        const uv = geographicMaterialUv(tile, direction.toArray());
        assert.ok(uv.every(Number.isFinite));
        const bounds = tileBounds(tile);
        const latitude = bounds.south + uv[1] * (bounds.north - bounds.south);
        assert.ok(Math.abs(latitude - Math.asin(direction.y)) < 1e-7);
        if (radius > 0) {
          const longitude = bounds.west + uv[0] * (bounds.east - bounds.west);
          const reconstructed = new Vector3(
            Math.cos(latitude) * Math.cos(longitude),
            Math.sin(latitude),
            Math.cos(latitude) * Math.sin(longitude),
          );
          assert.ok(
            reconstructed.distanceTo(direction) < 1e-7,
            'inverse coordinates preserve the actual point seen from a polar camera',
          );
        } else {
          assert.ok(Math.abs(uv[1] - (sign > 0 ? 1 : 0)) < 1e-12);
        }
      }
    }
    for (const mesh of meshes) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }
});

test('polar latitude remains resolved when stored Float32 y has rounded to one', () => {
  for (const sign of [-1, 1]) {
    const tile = { z: 3, x: 4, y: sign > 0 ? 7 : 0 };
    const bounds = tileBounds(tile);
    for (const distance of [1e-4, 1e-6, 1e-8]) {
      const direction = Float32Array.of(Math.sin(distance), sign * Math.cos(distance), 0);
      assert.equal(direction[1], sign, 'fixture reproduces the polar Float32 y rounding');
      const uv = geographicMaterialUv(tile, Array.from(direction));
      const offset = sign > 0 ? 1 - uv[1] : uv[1];
      const expected =
        Math.atan2(Math.abs(direction[0]), Math.abs(direction[1])) / (bounds.north - bounds.south);
      assert.ok(offset > 0, 'near-pole samples must not collapse into the pole row');
      assert.ok(
        Math.abs(offset - expected) < expected * 1e-7,
        'horizontal components preserve latitude at fine polar zoom',
      );
    }
  }
});

test('rectangular dense grids share exact pole and dateline rows, including striped requests', () => {
  for (const [width, height] of [
    [257, 129],
    [129, 257],
  ]) {
    for (const sign of [-1, 1]) {
      for (let x = 0; x < 8; x++) {
        const tile = { z: 3, x, y: sign > 0 ? 7 : 0 };
        const directions = materialDirections(tile, width, height);
        const poleRow = sign > 0 ? height - 1 : 0;
        for (let column = 0; column < width; column++) {
          const start = (poleRow * width + column) * 3;
          assert.deepEqual(directions.subarray(start, start + 3), Float32Array.of(0, sign, 0));
        }
        const firstRow = Math.floor(height / 2);
        const rowCount = height - firstRow;
        assert.deepEqual(
          materialDirections(tile, width, height, firstRow, rowCount),
          directions.subarray(firstRow * width * 3),
        );
      }
    }
    const west = materialDirections({ z: 3, x: 0, y: 3 }, width, height);
    const east = materialDirections({ z: 3, x: 7, y: 3 }, width, height);
    for (let row = 0; row < height; row++) {
      assert.deepEqual(
        west.subarray(row * width * 3, row * width * 3 + 3),
        east.subarray((row * width + width - 1) * 3, (row * width + width - 1) * 3 + 3),
      );
    }
  }
});

function fieldsFor(
  directions: Float32Array,
  oceanAt: (direction: [number, number, number]) => number,
): CellSampleBatch {
  const count = directions.length / 3;
  const fields: CellSampleBatch = {
    cellIds: new Uint32Array(count),
    heights: new Float32Array(count),
    colors: new Float32Array(count * 3),
    bankLand: new Float32Array(count),
    surfaceTerrain: new Float32Array(count * 4),
    surfaceClimate: new Float32Array(count * 4),
    surfaceHabitat: new Float32Array(count * 3),
    surfaceDelta: new Float32Array(count * 4),
    surfaceWater: new Float32Array(count * 2),
    surfaceBank: new Float32Array(count * 4),
  };
  for (let cell = 0; cell < count; cell++) {
    const water = oceanAt(
      Array.from(directions.subarray(cell * 3, cell * 3 + 3)) as [number, number, number],
    );
    fields.surfaceTerrain[cell * 4 + 1] = 1 - water;
    fields.surfaceWater[cell * 2] = water;
  }
  return fields;
}

test('dense materials preserve a small island omitted by the old seventeen-point geometry grid', async () => {
  const tile = { z: 3, x: 4, y: 4 };
  const center = [7.5 / 16, 6.5 / 16];
  const radius = 0.019;
  const oceanUv = (u: number, v: number) =>
    Math.max(0, Math.min(1, (Math.hypot(u - center[0], v - center[1]) - radius) / 0.004 + 0.5));
  const oceanAt = (direction: [number, number, number]) =>
    oceanUv(...geographicMaterialUv(tile, direction));
  const coarse = fieldsFor(tileDirections(tile), oceanAt);
  assert.ok(
    coarse.surfaceWater.filter((_, index) => index % 2 === 0).every((value) => value === 1),
    'the old geometry grid misses every land sample',
  );
  const handle = {
    summary: { minimumHeight: -1000, maximumHeight: 1000 },
  } as unknown as WorldHandle;
  for (const [width, height] of [
    [257, 129],
    [129, 257],
  ]) {
    const requests: number[] = [];
    const source = {
      sample: async (directions: Float32Array) => {
        requests.push(directions.length / 3);
        return fieldsFor(directions, oceanAt);
      },
    } as unknown as WorldViewSource;
    const material = await loadDenseSurface(tile, handle, source, -1, width, height);
    assert.ok(requests.length > 1 && requests.every((count) => count <= MAX_MATERIAL_QUERY));
    assert.equal(
      requests.reduce((sum, count) => sum + count, 0),
      width * height,
    );
    // Emulate normalized RGBA8 linear texture filtering at shared-boundary texels.
    const bytes = material.textures[4].image.data as Uint8Array;
    const sample = (u: number, v: number) => {
      const x = u * (width - 1);
      const y = v * (height - 1);
      const left = Math.floor(x);
      const bottom = Math.floor(y);
      const read = (dx: number, dy: number) =>
        bytes[((bottom + dy) * width + left + dx) * 4 + 2] / 255;
      const a = read(0, 0) * (1 - (x - left)) + read(1, 0) * (x - left);
      const b = read(0, 1) * (1 - (x - left)) + read(1, 1) * (x - left);
      return a * (1 - (y - bottom)) + b * (y - bottom);
    };
    assert.ok(
      sample(center[0], center[1]) < 0.01,
      'the island interior reaches the displayed material',
    );
    let intersection = 0;
    let union = 0;
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 128; x++) {
        const u = center[0] + ((x + 0.5) / 128 - 0.5) * radius * 4;
        const v = center[1] + ((y + 0.5) / 128 - 0.5) * radius * 4;
        const truth = oceanUv(u, v) < 0.5;
        const displayed = sample(u, v) < 0.5;
        if (truth && displayed) {
          intersection++;
        }
        if (truth || displayed) {
          union++;
        }
      }
    }
    assert.ok(
      intersection / union > 0.88,
      `small-island shoreline overlap ${intersection / union}`,
    );
    material.dispose();
  }
});
