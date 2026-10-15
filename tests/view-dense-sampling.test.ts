import assert from 'node:assert/strict';
import test from 'node:test';
import { BufferGeometry, Color } from 'three';
import { DEFAULT_CONFIG } from '../src/core/model';
import { createScalarStencilSampler } from '../src/core/operators/scalar-sampling';
import { generateWorld } from '../src/core/pipeline';
import { prepareWorldView } from '../src/core/view/prepare';
import { WorldViewReader } from '../src/core/view/reader';
import type { PageValues } from '../src/core/view/spatial-index';
import { updateNaturalSurface } from '../src/render/NaturalSurface';
import { sampleCellColor } from '../src/render/palette';

test('dense multi-block Natural queries preserve original fields across record chunks and seasons', async () => {
  const world = generateWorld({
    ...DEFAULT_CONFIG,
    seed: 'dense-multiblock-parity',
    surfaceLevel: 5,
    processLevel: 3,
    tectonicDuration: 8,
    fluvialDuration: 0,
    landscapeBatches: 1,
  });
  assert.equal(world.grid.count, 10242);
  const prepared = prepareWorldView(world);
  assert.equal(prepared.sidecars.view.records.blocks.length, 6);
  assert.equal(prepared.sidecars.view.stencils.faces.length, 3);
  const root = { world, sidecars: prepared.sidecars };
  const value = (path: string): unknown =>
    path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], root);
  const recordBlocks = new Set<string>();
  const pages: PageValues = {
    async readValue(path) {
      if (path.startsWith('sidecars.view.records.')) {
        assert.match(path, /^sidecars\.view\.records\.blocks\.\d+$/);
        recordBlocks.add(path);
      }
      return structuredClone(value(path));
    },
    async readRange(path, start, count) {
      const source = value(path) as ArrayLike<number>;
      return Float64Array.from({ length: count }, (_, offset) => source[start + offset]);
    },
    async readValues(path, indices) {
      const source = value(path) as ArrayLike<number>;
      return Float64Array.from(indices, (index) => source[index]);
    },
  };

  // Every physical vertex guarantees more than two 4,096-row derivation chunks.
  // Real triangles across spatial page boundaries catch a row/field mismatch that
  // repeated synthetic records alone would not expose.
  const points = Array.from(world.grid.positions);
  const rows = new Uint32Array(world.grid.count);
  prepared.sidecars.view.index.cells.forEach((cell, row) => (rows[cell] = row));
  let crossBlockFaces = 0;
  for (let face = 0; face < world.grid.triangles.length / 3; face++) {
    const cells = world.grid.triangles.subarray(face * 3, face * 3 + 3);
    if (new Set(Array.from(cells, (cell) => Math.floor(rows[cell] / 2048))).size < 2) {
      continue;
    }
    crossBlockFaces++;
    const weights = [0.17, 0.38, 0.45];
    const point = [0, 1, 2].map((axis) =>
      cells.reduce(
        (sum, cell, vertex) => sum + world.grid.positions[cell * 3 + axis] * weights[vertex],
        0,
      ),
    );
    const length = Math.hypot(...point);
    points.push(...point.map((component) => component / length));
  }
  assert.ok(crossBlockFaces > 100);
  const repeatedStart = points.length / 3;
  // Repeat an interior run to verify shared-row deduplication does not reorder queries.
  const repeatedCount = 64;
  points.push(...points.slice(world.grid.count * 3, (world.grid.count + repeatedCount) * 3));
  const directions = Float32Array.from(points);
  assert.ok(directions.length / 3 < 20000);

  const reader = await WorldViewReader.open(pages);
  const originalGeometry = new BufferGeometry();
  const locate = createScalarStencilSampler(world.grid);
  const heights = Float32Array.from(
    world.terrain.height,
    (height, cell) => height + world.drainage.lakeDepth[cell],
  );
  const vertexColors = new Float32Array(world.grid.count * 3);
  const color = new Color();
  let firstClimate: Float32Array | undefined;
  for (const season of [-1, 0, 1, 2, 3]) {
    const actual = await reader.sample(directions, 'world', season);
    assert.deepEqual(
      actual.cellIds.subarray(0, world.grid.count),
      Uint32Array.from({ length: world.grid.count }, (_, cell) => cell),
    );
    updateNaturalSurface(originalGeometry, world, season);
    for (let cell = 0; cell < world.grid.count; cell++) {
      sampleCellColor(world, cell, 'world', season, color);
      vertexColors.set([color.r, color.g, color.b], cell * 3);
    }
    const attributes: {
      name: string;
      size: number;
      values: ArrayLike<number>;
      actual: Float32Array;
    }[] = (
      [
        'surfaceTerrain',
        'surfaceClimate',
        'surfaceHabitat',
        'surfaceDelta',
        'surfaceWater',
      ] as const
    ).map((name) => ({
      name,
      size: originalGeometry.getAttribute(name).itemSize,
      values: originalGeometry.getAttribute(name).array,
      actual: actual[name],
    }));
    attributes.push(
      { name: 'heights', size: 1, values: heights, actual: actual.heights },
      { name: 'colors', size: 3, values: vertexColors, actual: actual.colors },
    );
    for (let query = 0; query < directions.length / 3; query++) {
      const x = directions[query * 3];
      const y = directions[query * 3 + 1];
      const z = directions[query * 3 + 2];
      const length = Math.hypot(x, y, z);
      const stencil = locate(x / length, y / length, z / length);
      for (const attribute of attributes) {
        for (let component = 0; component < attribute.size; component++) {
          let expected = 0;
          let scale = 1;
          for (let vertex = 0; vertex < 3; vertex++) {
            const raw = attribute.values[stencil.cells[vertex] * attribute.size + component];
            expected += raw * stencil.weights[vertex];
            scale = Math.max(scale, Math.abs(raw));
          }
          assert.ok(
            Math.abs(
              attribute.actual[query * attribute.size + component] - Math.fround(expected),
            ) <=
              scale * 1.2e-7,
            `${attribute.name}, season ${season}, query ${query}, component ${component}`,
          );
        }
      }
    }
    for (const attribute of attributes) {
      assert.deepEqual(
        attribute.actual.subarray(repeatedStart * attribute.size),
        attribute.actual.subarray(
          world.grid.count * attribute.size,
          (world.grid.count + repeatedCount) * attribute.size,
        ),
        `repeated queries retain ${attribute.name}`,
      );
    }
    if (season === 0) {
      firstClimate = actual.surfaceClimate;
    }
    if (season === 2) {
      assert.notDeepEqual(
        actual.surfaceClimate,
        firstClimate,
        'cached source records retain season changes',
      );
    }
  }
  assert.equal(recordBlocks.size, 6);
  originalGeometry.dispose();
});
