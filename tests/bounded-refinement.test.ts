import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildGrid, buildSeedMesh, finalizeGrid } from '../src/core/grid/build';
import {
  faceCircumcenter,
  faceCircumradius,
  nextHalfEdge,
  type SphericalMesh,
} from '../src/core/grid/mesh';
import { createRegionSpacing, refineGrid, refineMesh } from '../src/core/grid/refine';
import { cross, dot, readVector, subtractVectors } from '../src/core/math';

const radius = 1000;
const spacing = createRegionSpacing(500, radius, [
  { center: [1, 0, 0], radiusMetres: 200, targetSpacingMetres: 60 },
]);

function digest(value: object) {
  const hash = createHash('sha256');
  const update = (object: object) => {
    for (const [key, field] of Object.entries(object)) {
      hash.update(key + ':');

      if (ArrayBuffer.isView(field)) {
        hash.update(new Uint8Array(field.buffer, field.byteOffset, field.byteLength));
      } else if (typeof field === 'object' && field !== null) {
        update(field);
      } else {
        hash.update(String(field));
      }
    }
  };
  update(value);
  return hash.digest('hex');
}

function assertClosedDelaunaySphere(mesh: SphericalMesh) {
  const grid = finalizeGrid(mesh);
  const faceCount = grid.triangles.length / 3;
  assert.equal(grid.count - grid.edgeCells.length / 2 + faceCount, 2);
  assert.equal(faceCount, 2 * grid.count - 4);
  assert.ok(Math.abs(grid.areas.reduce((sum, area) => sum + area, 0) - 4 * Math.PI) < 1e-10);

  for (let cell = 0; cell < grid.count; cell++) {
    assert.ok(grid.areas[cell] > 0);
    assert.ok(Math.abs(Math.hypot(...readVector(grid.positions, cell)) - 1) < 1e-14);
  }

  for (let edge = 0; edge < faceCount * 3; edge++) {
    const twin = mesh.halfEdges[edge];
    assert.ok(twin >= 0 && twin < faceCount * 3);
    assert.equal(mesh.halfEdges[twin], edge);
    assert.equal(mesh.triangles[edge], mesh.triangles[nextHalfEdge(twin)]);
    assert.equal(mesh.triangles[nextHalfEdge(edge)], mesh.triangles[twin]);
  }

  for (let face = 0; face < faceCount; face++) {
    const first = readVector(grid.positions, grid.triangles[face * 3]);
    const second = readVector(grid.positions, grid.triangles[face * 3 + 1]);
    const third = readVector(grid.positions, grid.triangles[face * 3 + 2]);
    assert.ok(dot(cross(subtractVectors(second, first), subtractVectors(third, first)), first) > 0);
    const center = faceCircumcenter(mesh, face);
    const boundary = dot(first, center);

    // Check all sites, independently of local half-edge adjacency and flip decisions.
    for (let cell = 0; cell < grid.count; cell++) {
      assert.ok(dot(readVector(grid.positions, cell), center) <= boundary + 2e-11);
    }
  }
}

test('bounded insertions stop exactly at the budget after leaving a fully legalized sphere', () => {
  for (const maxAddedCells of [1, 2, 7, 31]) {
    const mesh = buildSeedMesh(1, 'bounded-refinement-sphere', 0.8);
    const count = mesh.count;
    const originalPositions = mesh.positions.slice();
    refineMesh(mesh, radius, 'bounded-refinement-sphere', spacing, { maxAddedCells });
    assert.equal(mesh.count, count + maxAddedCells);
    assert.deepEqual(mesh.positions.slice(0, originalPositions.length), originalPositions);
    assertClosedDelaunaySphere(mesh);

    // A valid capped mesh deliberately does not promise the unmet covering-radius target.
    let unmet = false;

    for (let face = 0; face < mesh.triangleCount; face++) {
      const center = faceCircumcenter(mesh, face);
      unmet ||= faceCircumradius(mesh, face) * radius * Math.sqrt(3) > spacing(...center) * 1.001;
    }

    assert.ok(unmet);
  }
});

test('a zero insertion budget preserves the exact original grid and mesh without sampling', () => {
  const grid = buildGrid(1, 'bounded-zero', 0.6);
  const mesh = buildSeedMesh(1, 'bounded-zero', 0.6);
  const gridBefore = digest(grid);
  const meshBefore = digest(mesh);
  const sample = () => {
    assert.fail('A zero insertion budget must not sample its spacing field.');
  };
  assert.equal(refineGrid(grid, radius, 'bounded-zero', sample, { maxAddedCells: 0 }), grid);
  refineMesh(mesh, radius, 'bounded-zero', sample, { maxAddedCells: 0 });
  assert.equal(digest(grid), gridBefore);
  assert.equal(digest(mesh), meshBefore);
});

test('invalid insertion budgets fail before any mesh mutation or spacing evaluation', () => {
  const grid = buildGrid(1, 'bounded-invalid', 0.5);
  const mesh = buildSeedMesh(1, 'bounded-invalid', 0.5);
  const gridBefore = digest(grid);
  const meshBefore = digest(mesh);
  const sample = () => {
    assert.fail('Budget validation must precede spacing evaluation.');
  };

  for (const maxAddedCells of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const options = { maxAddedCells };
    assert.throws(
      () => refineGrid(grid, radius, 'bounded-invalid', sample, options),
      /safe integer/,
    );
    assert.throws(
      () => refineMesh(mesh, radius, 'bounded-invalid', sample, options),
      /safe integer/,
    );
    assert.equal(digest(grid), gridBefore);
    assert.equal(digest(mesh), meshBefore);
  }
});

test('bounded grid refinement is repeatable and preserves immutable sources across later passes', () => {
  const base = buildGrid(2, 'bounded-repeatable', 0.65);
  const before = digest(base);
  const options = { maxAddedCells: 17 };
  const first = refineGrid(base, radius, 'bounded-repeatable', spacing, options);
  const repeat = refineGrid(base, radius, 'bounded-repeatable', spacing, options);
  assert.equal(first.count, base.count + options.maxAddedCells);
  assert.equal(digest(first), digest(repeat));
  assert.equal(digest(base), before);
  assert.deepEqual(first.positions.slice(0, base.positions.length), base.positions);
  assert.notEqual(first.positions.buffer, base.positions.buffer);
  assert.notEqual(first.triangles.buffer, base.triangles.buffer);

  const second = refineGrid(first, radius, 'bounded-repeatable-next', spacing, {
    maxAddedCells: 13,
  });
  assert.equal(second.count, first.count + 13);
  assert.deepEqual(second.positions.slice(0, first.positions.length), first.positions);
  assert.equal(second.refinement!.baseCount, base.count);
  assert.equal(second.refinement!.insertedCount, 30);
  assert.equal(second.refinement!.passes, 2);
  assert.deepEqual(
    second.refinement!.sourceCell.slice(0, first.count),
    first.refinement!.sourceCell,
  );
  assert.ok(second.refinement!.sourceCell.every((cell) => cell < base.count));
});

test('omitted or nonbinding budgets retain the pre-budget implementation output byte-for-byte', () => {
  const base = buildGrid(2, 'bounded-refinement-baseline', 0.65);
  const unbounded = refineGrid(base, radius, 'bounded-refinement-baseline', spacing);
  // Captured from the original refineGrid before adding optional insertion budgets.
  const expected = '1682db914ebd541c6546251c9c9a88cc149643bdd6e10dc1ed06f796ab0d60dc';
  assert.equal(unbounded.count, 392);
  assert.equal(digest(unbounded), expected);

  for (const options of [{}, { maxAddedCells: undefined }, { maxAddedCells: 1000 }]) {
    const refined = refineGrid(base, radius, 'bounded-refinement-baseline', spacing, options);
    assert.equal(digest(refined), expected);
  }
});
