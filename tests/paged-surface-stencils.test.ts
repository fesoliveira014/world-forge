import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGrid } from '../src/core/grid/build';
import type { Vec3 } from '../src/core/math';
import {
  createScalarStencilSampler,
  sampleScalarStencil,
} from '../src/core/operators/scalar-sampling';
import {
  buildSpatialIndex,
  PagedSpatialIndex,
  type PageValues,
} from '../src/core/view/spatial-index';
import { packSurfaceStencils, PagedSurfaceStencils } from '../src/core/view/surface-stencils';

const normalize = (p: Vec3) => p.map((v) => v / Math.hypot(...p)) as Vec3;

test('paged primal stencils reproduce linear fields and continuous values across ownership boundaries', async () => {
  const grid = buildGrid(3, 'paged-triangle-continuity', 0.85);
  const index = buildSpatialIndex(grid.positions);
  const stencils = packSurfaceStencils(grid, index.cells);
  const root = { sidecars: { view: { index, stencils } } };
  let largestRead = 0;
  const value = (path: string): unknown =>
    path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], root);
  const pages: PageValues = {
    async readValue(path) {
      assert.ok(
        /^sidecars\.view\.stencils\.(faces|starts)\.\d+$/.test(path),
        'restore just one independent topology block',
      );
      return structuredClone(value(path));
    },
    async readRange(path, start, count) {
      largestRead = Math.max(largestRead, count);
      const source = value(path) as ArrayLike<number>;
      return Float64Array.from({ length: count }, (_, i) => source[start + i]);
    },
    async readValues(path, indices) {
      const source = value(path) as ArrayLike<number>;
      return Float64Array.from(indices, (i) => source[i]);
    },
  };
  const spatial = new PagedSpatialIndex(pages);
  const paged = new PagedSurfaceStencils(pages, grid.count);
  const reference = createScalarStencilSampler(grid);
  const field = Float64Array.from(
    { length: grid.count },
    (_, cell) =>
      900 +
      1200 * grid.positions[cell * 3] -
      700 * grid.positions[cell * 3 + 1] +
      2300 * grid.positions[cell * 3 + 2],
  );
  const point = (cell: number) =>
    Array.from(grid.positions.subarray(cell * 3, cell * 3 + 3)) as Vec3;
  const sample = async (direction: Vec3) => {
    const nearest = await spatial.locate(direction);
    const stencil = await paged.locate(direction, nearest.row);
    const actual = stencil.weights.reduce(
      (sum, weight, i) => sum + weight * field[index.cells[stencil.rows[i]]],
      0,
    );
    const expected = sampleScalarStencil(reference(...direction, nearest.cell), field);
    assert.ok(
      Math.abs(actual - expected) < 1e-8,
      `paged/full stencil discrepancy: ${actual - expected}`,
    );
    return { actual, stencil };
  };
  for (let face = 0; face < grid.triangles.length / 3; face += 7) {
    const cells = Array.from(grid.triangles.subarray(face * 3, face * 3 + 3));
    const weights = [0.17, 0.38, 0.45];
    const direction = normalize(
      [0, 1, 2].map((axis) =>
        cells.reduce((sum, cell, i) => sum + point(cell)[axis] * weights[i], 0),
      ) as Vec3,
    );
    const result = await sample(direction);
    const linear = cells.reduce((sum, cell, i) => sum + field[cell] * weights[i], 0);
    assert.ok(
      Math.abs(result.actual - linear) < 1e-8,
      'the planar linear field is reproduced after radial projection',
    );
  }
  for (let edge = 0; edge < grid.edgeLength.length; edge += 17) {
    const a = grid.edgeCells[edge * 2];
    const b = grid.edgeCells[edge * 2 + 1];
    const midpoint = normalize(point(a).map((v, axis) => v + point(b)[axis]) as Vec3);
    const firstFace = grid.edgeCorners[edge * 2];
    const secondFace = grid.edgeCorners[edge * 2 + 1];
    const opposite = (face: number) =>
      Array.from(grid.triangles.subarray(face * 3, face * 3 + 3)).find(
        (cell) => cell !== a && cell !== b,
      )!;
    const toward = (cell: number) =>
      normalize(midpoint.map((v, axis) => v * (1 - 1e-9) + point(cell)[axis] * 1e-9) as Vec3);
    const left = await sample(toward(opposite(firstFace)));
    const right = await sample(toward(opposite(secondFace)));
    const onEdge = await sample(midpoint);
    assert.ok(
      Math.abs(left.actual - right.actual) < 1e-5,
      'neighboring faces agree at their shared edge',
    );
    assert.ok(Math.abs(onEdge.actual - (field[a] + field[b]) / 2) < 1e-8);
  }
  assert.ok(largestRead <= 2048 * 3, 'positions are gathered in bounded spatial blocks');
  assert.ok(
    paged.cacheStats.faceBlocks <= 16 &&
      paged.cacheStats.startBlocks <= 16 &&
      paged.cacheStats.positionBlocks <= 32,
  );
});
