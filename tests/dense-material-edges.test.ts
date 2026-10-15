import test from 'node:test';
import assert from 'node:assert/strict';
import type { CellSampleBatch, WorldHandle, WorldViewSource } from '../src/core/view/types';
import {
  loadDenseSurface,
  updateDenseEdges,
  decodeMaterialFields,
  type DenseSurface,
} from '../src/render/DenseSurface';
import type { RenderTile } from '../src/render/TileGeometry';
const handle = {
  config: { radius: 6371000 },
  summary: { minimumHeight: -12000, maximumHeight: 9000 },
} as WorldHandle;
const source = {
  sample: async (directions: Float32Array): Promise<CellSampleBatch> => {
    const count = directions.length / 3;
    const result = {
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
    for (let i = 0; i < count; i++) {
      const value = 0.5 + 0.5 * Math.sin(directions[i * 3 + 1] * 35);
      result.surfaceTerrain[i * 4] = value * 2000;
      result.surfaceWater[i * 2] = value;
      result.surfaceClimate[i * 4] = -5 + 20 * value;
      result.surfaceHabitat[i * 3 + 2] = value * 1000;
    }
    return result;
  },
} as unknown as WorldViewSource;
const arrays = (surface: DenseSurface) => surface.textures.map((texture) => texture.image.data!);

test('stitched material edges preserve sixteen-bit carry boundaries and restore original samples', async () => {
  const west = { z: 3, x: 3, y: 4 };
  const east = { z: 3, x: 4, y: 4 };
  const coarse = await loadDenseSurface(west, handle, source, -1, 17, 17);
  const fine = await loadDenseSurface(east, handle, source, -1, 17, 33);
  const original = arrays(fine).map((data) => data.slice());
  for (const [map, channel] of [
    [0, 0],
    [1, 1],
    [3, 0],
  ]) {
    for (let y = 0; y < 17; y++) {
      const encoded = y % 2 ? 256 : 255;
      coarse.borders[map][1][y * 4 + channel] = encoded >> 8;
      coarse.borders[map][1][y * 4 + channel + 1] = encoded & 255;
    }
  }
  const bytes = fine.bytes;
  updateDenseEdges(fine, east, [{ tile: west, surface: coarse }]);
  for (const [map, channel] of [
    [0, 0],
    [1, 1],
    [3, 0],
  ]) {
    const data = arrays(fine)[map];
    const index = fine.width * 4 + channel;
    assert.equal(
      data[index] * 256 + data[index + 1],
      256,
      'midpoint must not become code384 through independent byte rounding',
    );
  }
  assert.equal(fine.bytes, bytes);
  assert.equal(fine.textures.length, 6);
  updateDenseEdges(fine, east, []);
  arrays(fine).forEach((data, i) => assert.deepEqual(data, original[i]));
  coarse.dispose();
  fine.dispose();
});

test('a high-density coarse tile matches both lower-density fine neighbors along an entire edge', async () => {
  const tile = { z: 3, x: 3, y: 4 };
  const neighbors: { tile: RenderTile; surface: DenseSurface }[] = [];
  for (const y of [8, 9]) {
    const neighbor = { z: 4, x: 8, y };
    neighbors.push({
      tile: neighbor,
      surface: await loadDenseSurface(neighbor, handle, source, -1, 17, 17),
    });
  }
  const own = await loadDenseSurface(tile, handle, source, -1, 17, 65);
  updateDenseEdges(own, tile, neighbors);
  for (let y = 1; y < 64; y++) {
    const neighbor = neighbors[y < 32 ? 0 : 1].surface;
    const coordinate = (y % 32) / 2;
    const lower = Math.floor(coordinate);
    const fraction = coordinate - lower;
    const border = neighbor.borders[4][0];
    const expected =
      Math.round(
        border[lower * 4 + 2] * (1 - fraction) + border[Math.min(16, lower + 1) * 4 + 2] * fraction,
      ) / 255;
    const decoded = decodeMaterialFields(
      arrays(own),
      y * own.width + own.width - 1,
      own.elevationRange,
    );
    assert.equal(decoded.water[0], expected, `edge row${y}`);
  }
  own.dispose();
  neighbors.forEach((neighbor) => neighbor.surface.dispose());
});

test('packed field storage accounts for CPU, GPU and immutable borders at the maximum rectangle', async () => {
  const surface = await loadDenseSurface({ z: 3, x: 2, y: 5 }, handle, source, -1, 257, 129);
  const cpu = arrays(surface).reduce((sum, data) => sum + data.byteLength, 0);
  const borders = surface.borders.flat().reduce((sum, data) => sum + data.byteLength, 0);
  assert.equal(surface.bytes, cpu * 2 + borders);
  assert.ok(surface.bytes < 1.6 * 1024 * 1024);
  surface.dispose();
});
