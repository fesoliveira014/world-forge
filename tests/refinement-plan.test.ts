import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  type CrustHistory,
  type Drainage,
  type Geology,
  type Terrain,
} from '../src/core/model';
import { buildGrid } from '../src/core/grid/build';
import { refineGrid } from '../src/core/grid/refine';
import {
  planSurfaceRefinement,
  replaySurfaceRefinement,
  validateResolvedRefinementPlan,
} from '../src/core/grid/refinement-plan';

function plannedMesh() {
  const config = {
    ...DEFAULT_CONFIG,
    seed: 'saved-spacing-field',
    refinementStrength: 0.75,
    refinementMinSpacing: 600000,
  };
  const grid = buildGrid(3, config.seed, config.irregularity);
  const terrain = {
    height: new Float32Array(grid.count),
    ocean: new Uint8Array(grid.count),
  } as Terrain;
  const corners = grid.corners.length / 3;
  const drainage = {
    height: new Float32Array(corners),
    discharge: new Float64Array(corners),
    receiver: new Int32Array(corners).fill(-1),
    order: Uint32Array.from({ length: corners }, (_, corner) => corner),
    lakes: [{ outlet: 0 }],
  } as unknown as Drainage;
  const position = Array.from(grid.corners.subarray(3, 6)) as [number, number, number];
  const geology = {
    hotspots: [{ position, radius: 500, start: 0, end: 300, rate: 1 }],
    crust: {
      volcanic: new Float32Array(grid.count),
      volcanicSources: [
        {
          position: [-position[0], -position[1], -position[2]],
          radius: 1000,
          plate: 0,
          volume: 1e9,
          age: 100,
        },
      ],
    } as CrustHistory,
  } as Geology;
  const transfer = Uint32Array.from({ length: grid.count }, (_, cell) => cell);
  const plan = planSurfaceRefinement(grid, terrain, drainage, geology, transfer, config);
  return { grid, config, plan };
}

test('saved spacing decisions reproduce the complete inserted mesh after a JSON round trip', () => {
  const { grid, config, plan } = plannedMesh();
  const saved = JSON.parse(JSON.stringify(plan.resolved));
  const replay = replaySurfaceRefinement(grid, config, saved);
  assert.equal(saved.volcanicCaps.length, 2);
  for (const cap of plan.resolved.volcanicCaps) {
    assert.ok(replay.spacingAt(...cap.position) <= cap.targetSpacingMetres * (1 + 1e-12));
  }
  assert.deepEqual(plan.targetSpacing, replay.targetSpacing);
  for (let corner = 0; corner < grid.corners.length; corner += 3) {
    const direction = Array.from(grid.corners.subarray(corner, corner + 3)) as [
      number,
      number,
      number,
    ];
    assert.equal(plan.spacingAt(...direction), replay.spacingAt(...direction));
  }
  const first = refineGrid(grid, config.radius, config.seed, plan.spacingAt);
  const second = refineGrid(grid, config.radius, config.seed, replay.spacingAt);
  assert.ok(first.count > grid.count);
  assert.deepEqual(first.positions, second.positions);
  assert.deepEqual(first.triangles, second.triangles);
});

test('saved refinement rejects changes in mesh geometry, topology, or recipe', () => {
  const { grid, config, plan } = plannedMesh();
  assert.throws(
    () => replaySurfaceRefinement(grid, { ...config, erosion: 0 }, plan.resolved),
    /does not match/,
  );
  const moved = { ...grid, positions: grid.positions.slice() };
  moved.positions[0] += 1e-10;
  assert.throws(() => replaySurfaceRefinement(moved, config, plan.resolved), /does not match/);
  const changed = { ...grid, triangles: grid.triangles.slice() };
  [changed.triangles[0], changed.triangles[1]] = [changed.triangles[1], changed.triangles[0]];
  assert.throws(() => replaySurfaceRefinement(changed, config, plan.resolved), /does not match/);
});

test('malformed saved plans fail before allocating a regenerated mesh', () => {
  const { plan } = plannedMesh();
  for (const invalid of [null, {}, { ...plan.resolved, cellCount: 1.5 }]) {
    assert.throws(() => validateResolvedRefinementPlan(invalid), /invalid physical spacing/);
  }
  for (const invalid of [0, -1, NaN, Infinity, '100000']) {
    const saved = structuredClone(plan.resolved);
    saved.targetSpacingMetres[0] = invalid as number;
    assert.throws(() => validateResolvedRefinementPlan(saved), /invalid physical spacing/);
  }
  const missing = { ...plan.resolved, sourceRadiiMetres: [] };
  assert.throws(() => validateResolvedRefinementPlan(missing), /invalid physical spacing/);
  const invalidCap = structuredClone(plan.resolved);
  invalidCap.volcanicCaps[0].position = [0, 0, 0];
  assert.throws(() => validateResolvedRefinementPlan(invalidCap), /invalid physical spacing/);
});
