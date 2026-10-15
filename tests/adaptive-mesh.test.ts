import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildGrid, buildSeedMesh, finalizeGrid, nearestCell } from '../src/core/grid/build';
import {
  faceCircumcenter,
  faceCircumradius,
  mutableMeshFromGrid,
  nextHalfEdge,
  undirectedEdgeKey,
} from '../src/core/grid/mesh';
import { createRegionSpacing, refineGrid, refineMesh } from '../src/core/grid/refine';
import { cross, dot, readVector, subtractVectors } from '../src/core/math';
import type { Grid } from '../src/core/model';

function geometryDigest(grid: Grid) {
  const hash = createHash('sha256');

  for (const [key, value] of Object.entries(grid)) {
    if (ArrayBuffer.isView(value)) {
      hash.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    } else {
      hash.update(key + ':' + value);
    }
  }

  return hash.digest('hex');
}

const radius = 1000;
const spacing = createRegionSpacing(500, radius, [
  { center: [1, 0, 0], radiusMetres: 200, targetSpacingMetres: 60 },
]);

// Captured from the original builder before extracting the mutable primal mesh.
test('disabled refinement preserves every geometry buffer and flip count byte-for-byte', () => {
  const expected = [
    'f6d34384749a6307e2c536a066404173fc428243b1fac061b081032b67d4317e',
    '56362c5bf881dded3f01a3d64bcfed62a80cfadf0b4f2c2c0daacda9f6aa4f05',
    'f62a2af6333680e9029da4c1cdaa4ebc39cc5408656d4a29c1663dcfc4df79d2',
    'ff50f442303838d7912472c5043becb6c1b0e3fa7e1ab29a93e0be667a639868',
  ];

  for (let level = 0; level < expected.length; level++) {
    assert.equal(
      geometryDigest(buildGrid(level, 'adaptive-disabled-baseline', 0.65)),
      expected[level],
    );
  }
});

test('edge identity survives site count growth without endpoint collisions', () => {
  const keys = new Set<number>();

  for (let larger = 1; larger < 100; larger++) {
    for (let smaller = 0; smaller < larger; smaller++) {
      const key = undirectedEdgeKey(smaller, larger);
      assert.equal(key, undirectedEdgeKey(larger, smaller));
      assert.ok(!keys.has(key));
      keys.add(key);
    }
  }

  assert.equal(undirectedEdgeKey(123, 456), 103863);
});

test('local refinement is deterministic, keeps immutable seed sites, and leaves shared geometry intact', () => {
  const base = buildGrid(2, 'adaptive-mesh', 0.65);
  const baselineDigest = geometryDigest(base);
  const first = refineGrid(base, radius, 'adaptive-mesh', spacing);
  const second = refineGrid(base, radius, 'adaptive-mesh', spacing);
  assert.ok(first.count > base.count * 1.5);
  assert.ok(first.count < base.count * 4);
  assert.equal(geometryDigest(first), geometryDigest(second));
  assert.equal(geometryDigest(base), baselineDigest);
  assert.deepEqual(first.positions.slice(0, base.positions.length), base.positions);
  assert.notEqual(first.positions.buffer, base.positions.buffer);
  assert.notEqual(first.triangles.buffer, base.triangles.buffer);
  assert.equal(first.refinement!.baseCount, base.count);
  assert.equal(first.refinement!.insertedCount, first.count - base.count);

  for (let cell = 0; cell < first.count; cell++) {
    const position = readVector(first.positions, cell);
    const source = first.refinement!.sourceCell[cell];
    const nearest = nearestCell(base, ...position);
    assert.ok(
      dot(position, readVector(base.positions, source)) >=
        dot(position, readVector(base.positions, nearest)) - 1e-14,
    );

    if (cell < base.count) {
      assert.equal(source, cell);
    }
  }
});

test('refined mesh is a closed oriented sphere with positive dual areas and empty circumcircles', () => {
  const mesh = buildSeedMesh(2, 'adaptive-invariants', 0.8);
  const originalCount = mesh.count;
  refineMesh(mesh, radius, 'adaptive-invariants', spacing);
  const grid = finalizeGrid(mesh);
  const faceCount = grid.triangles.length / 3;
  const edgeCount = grid.edgeCells.length / 2;
  assert.equal(grid.count - edgeCount + faceCount, 2);
  assert.equal(faceCount, 2 * grid.count - 4);
  assert.ok(Math.abs(grid.areas.reduce((sum, area) => sum + area, 0) - 4 * Math.PI) < 1e-10);

  for (let cell = 0; cell < grid.count; cell++) {
    assert.ok(grid.areas[cell] > 0);
    assert.ok(Math.abs(Math.hypot(...readVector(grid.positions, cell)) - 1) < 1e-14);
    assert.ok(grid.offsets[cell + 1] - grid.offsets[cell] >= 3);
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
    const boundaryScore = dot(first, center);
    assert.ok(
      faceCircumradius(mesh, face) * radius * Math.sqrt(3) <= spacing(...center) * (1 + 1e-9),
    );

    // Global empty-circle checking catches invalid local flips and disconnected cavities.
    for (let cell = 0; cell < grid.count; cell++) {
      assert.ok(dot(readVector(grid.positions, cell), center) <= boundaryScore + 2e-11);
    }
  }

  // At insertion the containing circumcircle is empty; check separation against every
  // earlier site independently of the adjacency and legalization implementation.
  for (let cell = originalCount; cell < grid.count; cell++) {
    const position = readVector(grid.positions, cell);
    const minimumAngle = spacing(...position) / (radius * Math.sqrt(3));

    for (let earlier = 0; earlier < cell; earlier++) {
      assert.ok(
        dot(position, readVector(grid.positions, earlier)) <= Math.cos(minimumAngle) + 2e-11,
      );
    }
  }
});

test('spherical manual regions remain continuous at the longitude seam and poles', () => {
  const seamSpacing = createRegionSpacing(500, radius, [
    { center: [-1, 0, 0], radiusMetres: 150, targetSpacingMetres: 70 },
    { center: [0, 1, 0], radiusMetres: 150, targetSpacingMetres: 90 },
  ]);
  const small = 1e-7;
  assert.equal(
    seamSpacing(-Math.cos(small), 0, Math.sin(small)),
    seamSpacing(-Math.cos(small), 0, -Math.sin(small)),
  );
  assert.equal(
    seamSpacing(small, Math.sqrt(1 - small * small), 0),
    seamSpacing(0, Math.sqrt(1 - small * small), small),
  );
  assert.equal(seamSpacing(-1, 0, 0), 70);
  assert.equal(seamSpacing(0, 1, 0), 90);
  const grid = refineGrid(
    buildGrid(1, 'seam-refinement', 0.4),
    radius,
    'seam-refinement',
    seamSpacing,
  );
  const mesh = mutableMeshFromGrid(grid);

  for (let face = 0; face < mesh.triangleCount; face++) {
    const center = faceCircumcenter(mesh, face);
    assert.ok(
      faceCircumradius(mesh, face) * radius * Math.sqrt(3) <= seamSpacing(...center) * (1 + 1e-9),
    );
  }
});

test('invalid spacing reports failure instead of silently truncating refinement', () => {
  const mesh = buildSeedMesh(0, 'invalid-refinement', 0);
  assert.throws(() => refineMesh(mesh, radius, 'invalid-refinement', () => 0), /positive/);
  assert.throws(
    () =>
      createRegionSpacing(500, radius, [
        { center: [0, 0, 0], radiusMetres: 1, targetSpacingMetres: 1 },
      ]),
    /valid direction/,
  );
});

test('100 metre targets retain finite positive dual distances and well separated sites', () => {
  const planetRadius = 6371000;
  const field = createRegionSpacing(2000000, planetRadius, [
    { center: [1, 0, 0], radiusMetres: 1000, targetSpacingMetres: 100 },
  ]);
  const grid = refineGrid(
    buildGrid(3, 'refinement-stress', 0.9),
    planetRadius,
    'refinement-stress',
    field,
  );
  assert.ok(grid.count > 2000);
  assert.ok(grid.areas.every((area) => Number.isFinite(area) && area * planetRadius ** 2 > 1000));
  assert.ok(grid.edgeLength.every((length) => Number.isFinite(length) && length > 0));
  assert.ok(
    grid.edgeDistance.every(
      (distance) => Number.isFinite(distance) && distance * planetRadius > 50,
    ),
  );
  assert.ok(Math.abs(grid.areas.reduce((sum, area) => sum + area, 0) - 4 * Math.PI) < 1e-9);
});
