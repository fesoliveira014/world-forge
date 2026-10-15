import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGrid } from '../src/core/grid/build';
import { planSurfaceRefinement } from '../src/core/grid/refinement-plan';
import { routeWater } from '../src/core/generation/drainage';
import { computeCornerSupport } from '../src/core/operators/corner-fields';
import { DEFAULT_CONFIG, type Terrain, type LandWater, type Geology } from '../src/core/model';

test('dry basin tributaries select fine detail using the final drainage receivers', () => {
  const config = {
    ...DEFAULT_CONFIG,
    radius: 3000000,
    riverSourceArea: 30000,
    refinementStrength: 1,
    refinementMinSpacing: 15000,
  };
  const grid = buildGrid(5, 'flat-catchment-review', 0.65);
  const height = Float32Array.from({ length: grid.count }, (_, cell) => {
    const x = grid.positions[cell * 3];
    return x < -0.6 ? -100 : x > 0.8 ? 10 : x > 0.4 ? 100 : 50;
  });
  const terrain = { height, ocean: Uint8Array.from(height, (value) => +(value < 0)) } as Terrain;
  const water = {
    runoff: Float64Array.from(height, (value) => (value >= 0 ? 10 : 0)),
    pet: new Float32Array(grid.count).fill(5000),
    seasonalLiquid: Array.from({ length: 4 }, () => new Float32Array(grid.count)),
    seasonalPet: Array.from({ length: 4 }, () => new Float32Array(grid.count).fill(1250)),
    seasonalRunoff: Array.from({ length: 4 }, () =>
      Float32Array.from(height, (value) => (value >= 0 ? 10 : 0)),
    ),
  } as LandWater;
  const drainage = routeWater(grid, terrain, water, config);
  // This dry shore receives an upstream tributary after its original priority-
  // flood position. Its true catchment crosses the configured 30,000 km² threshold.
  const selectedCorner = 14550;
  const support = computeCornerSupport(grid);
  let catchmentArea = 0;

  for (let source = 0; source < drainage.height.length; source++) {
    let corner = source;
    while (corner >= 0 && corner !== selectedCorner) {
      corner = drainage.receiver[corner];
    }
    if (corner !== selectedCorner) {
      continue;
    }
    for (let incident = 0; incident < 3; incident++) {
      const index = source * 3 + incident;
      if (!terrain.ocean[grid.triangles[index]]) {
        catchmentArea += support.cornerCellArea[index] * config.radius ** 2;
      }
    }
  }

  assert.ok(catchmentArea > config.riverSourceArea * 1e6);
  assert.ok(drainage.discharge[selectedCorner] >= config.riverSourceFlow);
  const geology = { hotspots: [] } as unknown as Geology;
  const transfer = Uint32Array.from({ length: grid.count }, (_, cell) => cell);
  const plan = planSurfaceRefinement(grid, terrain, drainage, geology, transfer, config);

  for (const cell of grid.triangles.subarray(selectedCorner * 3, selectedCorner * 3 + 3)) {
    assert.ok(
      plan.targetSpacing[cell] <= config.refinementMinSpacing * (1 + 1e-12),
      'a supported dry-floor channel requests full river detail',
    );
  }

  const reordered = planSurfaceRefinement(
    grid,
    terrain,
    { ...drainage, order: new Uint32Array(drainage.order).reverse() },
    geology,
    transfer,
    config,
  );
  assert.deepEqual(
    plan.targetSpacing,
    reordered.targetSpacing,
    'flood discovery order is not flow order',
  );
});
