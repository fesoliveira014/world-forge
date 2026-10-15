import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildGrid } from '../src/core/grid/build';
import { coarsenGrid, prepareQuietLandCoarsening } from '../src/core/grid/coarsen';
import { faceCircumcenter, mutableMeshFromGrid, nextHalfEdge } from '../src/core/grid/mesh';
import { refineGrid } from '../src/core/grid/refine';
import { cross, dot, normalizeVector, readVector, subtractVectors } from '../src/core/math';
import type { Drainage, Ecology, Grid, Rivers, Terrain } from '../src/core/model';
import { remapTerrain } from '../src/core/operators/remap';
import { createScalarSampler } from '../src/core/operators/scalar-sampling';

const options = {
  radius: 1000,
  maxRemovedCells: 100,
  heightToleranceMetres: 2,
  maxSpacingMetres: 500,
};

test('tiny-budget planning on a 40k grid preserves the pre-compaction selection and mesh', () => {
  const grid = buildGrid(6, 'AETHER-2408', 0.65);
  const result = coarsenGrid(grid, new Float32Array(grid.count).fill(100), {
    radius: 6_371_000,
    maxRemovedCells: 1,
    heightToleranceMetres: 25,
    maxSpacingMetres: 250_000,
  });
  const digest = createHash('sha256');
  for (const field of [
    result.grid.positions,
    result.grid.triangles,
    result.grid.cellCorners,
    result.grid.neighbors,
    result.grid.areas,
    result.sourceCells,
  ]) {
    digest.update(new Uint8Array(field.buffer, field.byteOffset, field.byteLength));
  }
  // Captured before replacing retained candidate geometry with compact ranks.
  assert.equal(
    digest.digest('hex'),
    '8c41def95ffbd09c0ad0351462f5a8732d2bfc151da7cb68029e7b7f4d6ed19b',
  );
  assert.equal(result.grid.count, 40_961);
});

function validateSphere(grid: Grid) {
  const mesh = mutableMeshFromGrid(grid);
  assert.equal(grid.triangles.length / 3, 2 * grid.count - 4);
  assert.equal(grid.count - grid.edgeCells.length / 2 + grid.triangles.length / 3, 2);
  assert.ok(Math.abs(grid.areas.reduce((sum, area) => sum + area, 0) - 4 * Math.PI) < 1e-10);
  assert.ok(grid.areas.every((area) => area > 0));
  for (let edge = 0; edge < mesh.halfEdges.length; edge++) {
    const twin = mesh.halfEdges[edge];
    assert.equal(mesh.halfEdges[twin], edge);
    assert.equal(mesh.triangles[edge], mesh.triangles[nextHalfEdge(twin)]);
  }
  for (let face = 0; face < mesh.triangleCount; face++) {
    const first = readVector(grid.positions, grid.triangles[face * 3]);
    const second = readVector(grid.positions, grid.triangles[face * 3 + 1]);
    const third = readVector(grid.positions, grid.triangles[face * 3 + 2]);
    assert.ok(dot(cross(subtractVectors(second, first), subtractVectors(third, first)), first) > 0);
    const center = faceCircumcenter(mesh, face);
    const boundary = dot(first, center);
    for (let cell = 0; cell < grid.count; cell++) {
      assert.ok(dot(readVector(grid.positions, cell), center) <= boundary + 2e-11);
    }
  }
}

function fixtures(grid: Grid) {
  const n = grid.count;
  const corners = grid.triangles.length / 3;
  const terrain: Terrain = {
    height: new Float32Array(n).fill(200),
    bedrock: new Float32Array(n).fill(198),
    sediment: new Float32Array(n).fill(2),
    surfaceChange: new Float32Array(n),
    ocean: new Uint8Array(n),
    coastDistance: new Float32Array(n).fill(1e6),
    seaThreshold: 0,
    fluvialIncision: new Float32Array(n),
    deltaSediment: new Float32Array(n),
    oxbows: [],
  };
  const drainage: Drainage = {
    height: new Float32Array(corners),
    filled: new Float32Array(corners),
    receiver: new Int32Array(corners).fill(-1),
    order: new Uint32Array(corners),
    discharge: new Float64Array(corners),
    basin: new Uint32Array(corners),
    lakeId: new Int32Array(corners).fill(-1),
    lakeDepth: new Float32Array(n),
    lakeFraction: new Float32Array(corners),
    lakeCoverage: new Float32Array(n),
    seasonalLakeCoverage: Array.from({ length: 4 }, () => new Float32Array(n)),
    lakes: [],
    runoffTotal: 0,
    oceanDischarge: 0,
    lakeExchange: 0,
  };
  const rivers: Rivers = {
    channel: new Uint8Array(corners),
    headwater: new Uint8Array(corners),
    catchmentArea: new Float64Array(corners),
    supportFlow: new Float64Array(corners),
    system: new Uint32Array(corners),
    streamOrder: new Uint8Array(corners),
    seasonalDischarge: [],
    sourceFractions: [],
    source: new Uint8Array(corners),
    regime: new Uint8Array(corners),
    courses: {
      corner: new Uint32Array(0),
      offsets: new Uint32Array([0]),
      points: new Float32Array(0),
      sinuosity: new Float32Array(0),
    },
    deltas: [],
  };
  const ecology: Ecology = {
    biome: new Uint8Array(n).fill(5),
    vegetation: new Float32Array(n),
    riparian: new Float32Array(n),
    riparianFraction: new Float32Array(n),
    riverbankVegetation: new Float32Array(corners),
    floodplains: {
      corner: new Uint32Array(0),
      width: new Float32Array(0),
      vegetation: new Float32Array(0),
      habitat: new Uint8Array(0),
      seasonalFlood: [],
    },
    riverHabitat: new Uint8Array(n),
    floodplainFraction: new Float32Array(n),
    ice: new Float32Array(n),
    wetland: new Uint8Array(n),
    wetlandFraction: new Float32Array(n),
  };
  return { grid, terrain, drainage, rivers, ecology, radius: options.radius };
}

test('bounded coarsening removes base sites and preserves a closed Delaunay sphere and exact geographic anchors', () => {
  const original = buildGrid(3, 'coarsening', 0.8);
  const before = structuredClone(original);
  const height = new Float32Array(original.count).fill(200);
  const result = coarsenGrid(original, height, options);
  assert.equal(result.removedSourceCells.length, 100);
  assert.equal(result.grid.count, original.count - 100);
  assert.deepEqual(original, before);
  for (let cell = 0; cell < result.grid.count; cell++) {
    assert.deepEqual(
      readVector(result.grid.positions, cell),
      readVector(original.positions, result.sourceCells[cell]),
    );
  }
  assert.equal(result.grid.refinement!.baseCount, result.grid.count);
  assert.equal(result.grid.refinement!.insertedCount, 0);
  validateSphere(result.grid);
  assert.deepEqual(coarsenGrid(original, height, options), result);
  const replay = coarsenGrid(original, height, {
    ...options,
    resolvedRemovedCells: result.removedSourceCells,
  });
  assert.deepEqual(replay.grid, result.grid);
  assert.deepEqual(replay.sourceCells, result.sourceCells);
});

test('coarsening bounds spacing and surface error and refuses removal of unresolved peaks', () => {
  const grid = buildGrid(3, 'coarsening-error', 0.6);
  const height = Float32Array.from(
    { length: grid.count },
    (_, cell) =>
      200 + 30 * Math.sin(grid.positions[cell * 3] * 4) + 5 * grid.positions[cell * 3 + 1],
  );
  const result = coarsenGrid(grid, height, options);
  assert.ok(result.grid.count < grid.count);
  const before = createScalarSampler(grid, height);
  const after = createScalarSampler(
    result.grid,
    Float32Array.from(result.sourceCells, (cell) => height[cell]),
  );
  for (let cell = 0; cell < grid.count; cell++) {
    const point = readVector(grid.positions, cell);
    assert.ok(Math.abs(before(...point) - after(...point)) <= options.heightToleranceMetres + 1e-5);
  }
  for (let face = 0; face < grid.triangles.length; face += 3) {
    const a = readVector(grid.positions, grid.triangles[face]);
    const b = readVector(grid.positions, grid.triangles[face + 1]);
    const c = readVector(grid.positions, grid.triangles[face + 2]);
    const point = normalizeVector([a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]]);
    assert.ok(Math.abs(before(...point) - after(...point)) <= options.heightToleranceMetres + 1e-5);
  }
  const peak = new Float32Array(grid.count).fill(200);
  peak[50] = 700;
  const eligibleCells = new Uint8Array(grid.count);
  eligibleCells[50] = 1;
  const rejected = coarsenGrid(grid, peak, { ...options, eligibleCells });
  assert.equal(rejected.grid, grid);
  assert.equal(rejected.stats.rejectedHeight, 1);
  const tooFine = coarsenGrid(grid, height, { ...options, maxSpacingMetres: 1 });
  assert.equal(tooFine.grid, grid);
  assert.equal(tooFine.stats.rejectedSpacing, grid.count);
});

test('coarsening protects hydrology, biome boundaries, district interiors and terrain features with a buffer', () => {
  const grid = buildGrid(3, 'coarsening-protection', 0.5);
  const context = fixtures(grid);
  context.terrain.ocean[30] = 1;
  context.drainage.seasonalLakeCoverage![0][45] = 0.01;
  context.rivers.channel[80] = 1;
  // A lake-fraction corner ID is not a cell ID; protect its actual incident land.
  const shallowCorner = grid.count + 7;
  context.drainage.lakeFraction[shallowCorner] = 0.001;
  context.ecology.biome[100] = 4;
  context.ecology.wetlandFraction[120] = 0.1;
  context.terrain.deltaSediment[140] = 1;
  context.terrain.height[160] = 600;
  const districts = new Float32Array(grid.count);
  districts[180] = 1;
  const selection = prepareQuietLandCoarsening(context, districts);
  for (const feature of [
    30,
    45,
    grid.triangles[80 * 3],
    grid.triangles[shallowCorner * 3],
    100,
    120,
    140,
    160,
    180,
  ]) {
    assert.equal(selection.protectedCells[feature], 1);
    for (let offset = grid.offsets[feature]; offset < grid.offsets[feature + 1]; offset++) {
      assert.equal(selection.protectedCells[grid.neighbors[offset]], 1);
    }
  }
  const result = coarsenGrid(grid, context.terrain.height, { ...options, ...selection });
  assert.ok(result.grid.count < grid.count, 'unfeatured broad land still simplifies');
  for (const removed of result.removedSourceCells) {
    assert.equal(selection.protectedCells[removed], 0);
  }
  for (let cell = 0; cell < grid.count; cell++) {
    if (selection.protectedCells[cell]) {
      assert.ok(result.sourceCells.includes(cell));
    }
  }
  const oldToNew = new Map(Array.from(result.sourceCells, (source, cell) => [source, cell]));
  for (const feature of [
    30,
    45,
    grid.triangles[80 * 3],
    grid.triangles[shallowCorner * 3],
    100,
    120,
    140,
    160,
    180,
  ]) {
    const target = oldToNew.get(feature)!;
    const beforeNeighbors = Array.from(
      grid.neighbors.subarray(grid.offsets[feature], grid.offsets[feature + 1]),
    ).sort((a, b) => a - b);
    const afterNeighbors = Array.from(
      result.grid.neighbors.subarray(result.grid.offsets[target], result.grid.offsets[target + 1]),
      (cell) => result.sourceCells[cell],
    ).sort((a, b) => a - b);
    assert.deepEqual(
      afterNeighbors,
      beforeNeighbors,
      `feature ${feature} retains every original neighbor`,
    );
    const star = (mesh: Grid, cell: number, source?: Uint32Array) =>
      Array.from(mesh.cellCorners.subarray(mesh.offsets[cell], mesh.offsets[cell + 1]), (corner) =>
        Array.from(
          mesh.triangles.subarray(corner * 3, corner * 3 + 3),
          (vertex) => source?.[vertex] ?? vertex,
        )
          .sort((a, b) => a - b)
          .join(','),
      ).sort();
    assert.deepEqual(
      star(result.grid, target, result.sourceCells),
      star(grid, feature),
      `feature ${feature} retains its full triangle star`,
    );
  }
});

test('a compacted surface supports subsequent refinement without stale source indices', () => {
  const grid = buildGrid(3, 'coarsening-then-detail', 0.65);
  const result = coarsenGrid(grid, new Float32Array(grid.count).fill(200), options);
  const refined = refineGrid(result.grid, options.radius, 'coarsening-then-detail', () => 80, {
    maxAddedCells: 30,
  });
  assert.equal(refined.count, result.grid.count + 30);
  assert.equal(refined.refinement!.baseCount, result.grid.count);
  assert.equal(refined.refinement!.insertedCount, 30);
  assert.ok(refined.refinement!.sourceCell.every((source) => source < result.grid.count));
  assert.deepEqual(refined.positions.slice(0, result.grid.positions.length), result.grid.positions);
  validateSphere(refined);
});

test('terrain remapping after coarsening conserves material and preserves retained elevations', () => {
  const grid = buildGrid(3, 'coarsening-material', 0.6);
  const { terrain } = fixtures(grid);
  for (let cell = 0; cell < grid.count; cell++) {
    terrain.sediment[cell] = 2 + grid.positions[cell * 3];
  }
  const result = coarsenGrid(grid, terrain.height, options);
  const mapped = remapTerrain(grid, result.grid, terrain, { radius: options.radius });
  const before = grid.areas.reduce((sum, area, cell) => sum + area * terrain.sediment[cell], 0);
  const after = result.grid.areas.reduce(
    (sum, area, cell) => sum + area * mapped.sediment[cell],
    0,
  );
  assert.ok(Math.abs(before - after) < before * 2e-8);
  assert.ok(mapped.height.every((height) => height === 200));
  assert.ok(mapped.sediment.every((depth) => depth >= 0));
});

test('zero and invalid budgets do not mutate the source; saved selections must remain valid', () => {
  const grid = buildGrid(2, 'coarsening-invalid', 0.5);
  const height = new Float32Array(grid.count).fill(100);
  assert.equal(coarsenGrid(grid, height, { ...options, maxRemovedCells: 0 }).grid, grid);
  for (const budget of [-1, 0.5, NaN, Infinity]) {
    assert.throws(
      () => coarsenGrid(grid, height, { ...options, maxRemovedCells: budget }),
      /safe integer/,
    );
  }
  for (const resolvedRemovedCells of [[-1], [grid.count], [0, 0]]) {
    assert.throws(() => coarsenGrid(grid, height, { ...options, resolvedRemovedCells }));
  }
  const protectedCells = new Uint8Array(grid.count);
  protectedCells[0] = 1;
  assert.throws(
    () => coarsenGrid(grid, height, { ...options, protectedCells, resolvedRemovedCells: [0] }),
    /protected feature/,
  );
  assert.throws(
    () =>
      coarsenGrid(grid, height, {
        ...options,
        maxSpacingMetres: 1000,
        resolvedRemovedCells: [0, grid.neighbors[grid.offsets[0]]],
      }),
    /intersecting cavities/,
  );
});
