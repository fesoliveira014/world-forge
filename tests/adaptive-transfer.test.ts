import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGrid } from '../src/core/grid/build';
import { createRegionSpacing, refineGrid } from '../src/core/grid/refine';
import type { Grid } from '../src/core/model';
import { prolongRainfall } from '../src/core/operators/prolongation';
import {
  buildTransfer,
  calculateHeightGradient,
  restrictSurface,
} from '../src/core/operators/spatial';
import {
  buildOverlapTransfer,
  restrictDensity,
  transferDensity,
  transferInventory,
} from '../src/core/operators/transfer';

function integral(values: ArrayLike<number>, areas: Float64Array): number {
  let sum = 0;
  for (let cell = 0; cell < areas.length; cell++) {
    sum += values[cell] * areas[cell];
  }
  return sum;
}

test('weighted tangent least squares reconstructs a linear stencil on irregular meshes', () => {
  const grid = buildGrid(2, 'weighted-stencil', 0.95);
  const radius = 7;
  for (let cell = 0; cell < grid.count; cell += 13) {
    const x = grid.positions[3 * cell];
    const y = grid.positions[3 * cell + 1];
    const z = grid.positions[3 * cell + 2];
    const radial = 2 * x - 3 * y + z;
    const expected = [2 - radial * x, -3 - radial * y, 1 - radial * z];
    const field = Float64Array.from({ length: grid.count }, (_, neighbor) =>
      expected.reduce(
        (value, component, axis) =>
          value +
          component * (grid.positions[3 * neighbor + axis] - grid.positions[3 * cell + axis]),
        8,
      ),
    );
    const gradient = calculateHeightGradient(grid, field, radius);
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(Math.abs(gradient[3 * cell + axis] - expected[axis] / radius) < 3e-8);
    }
  }
  const constant = calculateHeightGradient(grid, new Float64Array(grid.count).fill(5), 1);
  assert.ok(constant.every((value) => value === 0));
});

test('rank-deficient gradient stencils resolve one direction without infinities', () => {
  const angle = 0.2;
  const grid = {
    count: 3,
    positions: new Float64Array([
      0,
      0,
      1,
      Math.sin(angle),
      0,
      Math.cos(angle),
      -Math.sin(angle),
      0,
      Math.cos(angle),
    ]),
    offsets: new Uint32Array([0, 2, 3, 4]),
    neighbors: new Uint32Array([1, 2, 0, 0]),
  } as Grid;
  const field = new Float64Array([0, 3 * Math.sin(angle), -3 * Math.sin(angle)]);
  const gradient = calculateHeightGradient(grid, field, 1);
  assert.ok(gradient.every(Number.isFinite));
  assert.ok(Math.abs(gradient[0] - 3) < 1e-7);
  assert.ok(gradient[1] === 0);
  assert.ok(gradient[2] === 0);
});

test('smooth spherical gradients converge under irregular mesh refinement', () => {
  const errors = [1, 2, 3].map((level) => {
    const grid = buildGrid(level, 'gradient-convergence', 0.95);
    const values = Float64Array.from(
      { length: grid.count },
      (_, cell) =>
        2 * grid.positions[3 * cell] +
        3 * grid.positions[3 * cell + 1] -
        4 * grid.positions[3 * cell + 2],
    );
    const gradient = calculateHeightGradient(grid, values, 1);
    let squaredError = 0;
    for (let cell = 0; cell < grid.count; cell++) {
      for (let axis = 0; axis < 3; axis++) {
        const expected = [2, 3, -4][axis] - values[cell] * grid.positions[3 * cell + axis];
        squaredError += grid.areas[cell] * (gradient[3 * cell + axis] - expected) ** 2;
      }
    }
    return Math.sqrt(squaredError / (4 * Math.PI));
  });
  assert.ok(errors[1] < 0.8 * errors[0]);
  assert.ok(errors[2] < 0.7 * errors[1]);
});

test('geometric overlap rows and columns cover unrelated irregular Voronoi meshes', () => {
  for (const [sourceLevel, targetLevel] of [
    [1, 3],
    [3, 1],
    [2, 2],
  ]) {
    const source = buildGrid(sourceLevel, 'overlap-source', 0.95);
    const target = buildGrid(targetLevel, 'overlap-target', 0.9);
    const mapping = buildOverlapTransfer(source, target);
    const columnArea = new Float64Array(source.count);
    let splitCells = 0;
    for (let cell = 0; cell < target.count; cell++) {
      let rowArea = 0;
      if (mapping.offsets[cell + 1] - mapping.offsets[cell] > 1) {
        splitCells++;
      }
      for (let overlap = mapping.offsets[cell]; overlap < mapping.offsets[cell + 1]; overlap++) {
        assert.ok(mapping.areas[overlap] > 0);
        rowArea += mapping.areas[overlap];
        columnArea[mapping.sources[overlap]] += mapping.areas[overlap];
        const length = Math.hypot(...mapping.centroids.subarray(3 * overlap, 3 * overlap + 3));
        assert.ok(length <= 1 + 1e-8);
      }
      assert.ok(Math.abs(rowArea / target.areas[cell] - 1) < 1e-11);
    }
    for (let cell = 0; cell < source.count; cell++) {
      assert.ok(Math.abs(columnArea[cell] / source.areas[cell] - 1) < 1e-11);
    }
    assert.ok(
      splitCells > target.count / 10,
      'boundary cells have multiple geometric contributors',
    );
    assert.ok(
      mapping.sources.length < 8 * (source.count + target.count),
      'overlap storage stays sparse',
    );
  }
});

test('coincident meshes transfer identically without spurious boundary slivers', () => {
  const source = buildGrid(2, 'coincident-overlap', 0.95);
  const copy = buildGrid(2, 'coincident-overlap', 0.95);
  const values = Float64Array.from({ length: source.count }, (_, cell) => cell / source.count);
  for (const target of [source, copy]) {
    const mapping = buildOverlapTransfer(source, target);
    assert.equal(mapping.sources.length, source.count);
    const transferred = transferDensity(mapping, values);
    for (let cell = 0; cell < source.count; cell++) {
      assert.equal(mapping.sources[cell], cell);
      assert.ok(Math.abs(transferred[cell] - values[cell]) < 1e-12);
      assert.ok(Math.hypot(...mapping.centroids.subarray(3 * cell, 3 * cell + 3)) <= 1);
    }
  }
});

test('overlap density and inventory transfers preserve constants and integrated quantities', () => {
  const source = buildGrid(2, 'density-source', 0.8);
  const target = buildGrid(3, 'density-target', 0.95);
  const mapping = buildOverlapTransfer(source, target);
  const constant = transferDensity(mapping, new Float64Array(source.count).fill(17));
  const reverseConstant = restrictDensity(mapping, new Float64Array(target.count).fill(17));
  assert.ok(constant.every((value) => Math.abs(value - 17) < 1e-10));
  assert.ok(reverseConstant.every((value) => Math.abs(value - 17) < 1e-10));
  const field = Float64Array.from({ length: source.count }, (_, cell) => 2 + Math.sin(cell * 0.23));
  const transferred = transferDensity(mapping, field);
  assert.ok(Math.abs(integral(field, source.areas) - integral(transferred, target.areas)) < 1e-11);
  const inventories = Float64Array.from(field, (value, cell) => value * source.areas[cell]);
  const transferredInventories = transferInventory(mapping, inventories);
  assert.ok(
    Math.abs(inventories.reduce((a, b) => a + b) - transferredInventories.reduce((a, b) => a + b)) <
      1e-11,
  );
  const restored = restrictDensity(mapping, transferred);
  assert.ok(Math.abs(integral(restored, source.areas) - integral(field, source.areas)) < 1e-11);
});

test('geometric overlaps conserve transfers through a locally refined transition', () => {
  const process = buildGrid(2, 'adaptive-transfer-process', 0.8);
  const seed = buildGrid(2, 'adaptive-transfer-surface', 0.8);
  const spacing = createRegionSpacing(500, 1000, [
    { center: [1, 0, 0], radiusMetres: 200, targetSpacingMetres: 60 },
  ]);
  const surface = refineGrid(seed, 1000, 'adaptive-transfer-surface', spacing);
  assert.ok(surface.count > seed.count);
  const mapping = buildOverlapTransfer(process, surface);
  const rows = transferDensity(mapping, new Float64Array(process.count).fill(1));
  const columns = restrictDensity(mapping, new Float64Array(surface.count).fill(1));
  assert.ok(rows.every((value) => Math.abs(value - 1) < 1e-10));
  assert.ok(columns.every((value) => Math.abs(value - 1) < 1e-10));
  const field = Float32Array.from(
    { length: process.count },
    (_, cell) => 20 + 10 * process.positions[3 * cell],
  );
  const [result] = prolongRainfall(
    surface,
    process,
    buildTransfer(process, surface),
    [field],
    mapping,
  );
  assert.ok(result.every((value) => Number.isFinite(value) && value >= 0));
  assert.ok(Math.abs(integral(result, surface.areas) / integral(field, process.areas) - 1) < 1e-7);
});

test('overlap rainfall reconstruction is bounded, conservative, and resolves a smooth analytic field', () => {
  const process = buildGrid(2, 'rain-process', 0.95);
  const surface = buildGrid(4, 'rain-surface', 0.95);
  const mapping = buildOverlapTransfer(process, surface);
  const parent = buildTransfer(process, surface);
  const sourceMean = new Float64Array(process.count);
  const targetMean = new Float64Array(surface.count);
  for (let cell = 0; cell < surface.count; cell++) {
    for (let overlap = mapping.offsets[cell]; overlap < mapping.offsets[cell + 1]; overlap++) {
      const value =
        10 +
        3 * mapping.centroids[3 * overlap] +
        2 * mapping.centroids[3 * overlap + 1] -
        mapping.centroids[3 * overlap + 2];
      sourceMean[mapping.sources[overlap]] += mapping.areas[overlap] * value;
      targetMean[cell] += mapping.areas[overlap] * value;
    }
    targetMean[cell] /= surface.areas[cell];
  }
  for (let cell = 0; cell < process.count; cell++) {
    sourceMean[cell] /= process.areas[cell];
  }
  const field = Float32Array.from(sourceMean);
  const [reconstructed, constant] = prolongRainfall(
    surface,
    process,
    parent,
    [field, new Float32Array(process.count).fill(20)],
    mapping,
  );
  const piecewise = transferDensity(mapping, field);
  const lower = Math.min(...field);
  const upper = Math.max(...field);
  let linearError = 0;
  let constantError = 0;
  for (let cell = 0; cell < surface.count; cell++) {
    assert.equal(constant[cell], 20);
    assert.ok(reconstructed[cell] >= lower - 1e-6 && reconstructed[cell] <= upper + 1e-6);
    linearError += surface.areas[cell] * (reconstructed[cell] - targetMean[cell]) ** 2;
    constantError += surface.areas[cell] * (piecewise[cell] - targetMean[cell]) ** 2;
  }
  assert.ok(
    linearError < 0.1 * constantError,
    'linear overlap reconstruction resolves subcell variation',
  );
  assert.ok(
    Math.abs(integral(reconstructed, surface.areas) / integral(field, process.areas) - 1) < 1e-7,
  );

  const dryFront = Float32Array.from(field, (_, cell) =>
    process.positions[3 * cell] > 0 ? 100 : 0,
  );
  const [front] = prolongRainfall(surface, process, parent, [dryFront], mapping);
  assert.ok(front.every((value) => value >= 0 && value <= 100));
  assert.ok(
    Math.abs(integral(front, surface.areas) / integral(dryFront, process.areas) - 1) < 1e-7,
  );
});

test('surface restriction uses overlap contributions independently of categorical owners', () => {
  const process = buildGrid(1, 'restriction-process', 0.8);
  const surface = buildGrid(2, 'restriction-surface', 0.8);
  const mapping = buildOverlapTransfer(process, surface);
  const height = Float32Array.from({ length: surface.count }, (_, cell) => 100 + cell);
  const restricted = restrictSurface(
    surface,
    process,
    new Uint32Array(surface.count),
    height,
    new Uint8Array(surface.count),
    mapping,
  );
  const expected = restrictDensity(mapping, height);
  for (let cell = 0; cell < process.count; cell++) {
    assert.ok(Math.abs(restricted.height[cell] - expected[cell]) < 2e-5);
    assert.ok(Math.abs(restricted.childArea[cell] / process.areas[cell] - 1) < 1e-11);
    assert.equal(restricted.landFraction[cell], 1);
  }
});
