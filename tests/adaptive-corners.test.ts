import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGrid } from '../src/core/grid/build';
import { createRegionSpacing, refineGrid } from '../src/core/grid/refine';
import { DEFAULT_CONFIG, type Drainage, type LandWater, type Terrain } from '../src/core/model';
import {
  computeCornerSupport,
  distributeCellInventory,
  reconstructCornerField,
} from '../src/core/operators/corner-fields';
import { routeWater } from '../src/core/generation/drainage';
import { erodeRiverLandscape } from '../src/core/generation/erosion';
import { selectRivers } from '../src/core/generation/rivers';
import { updateLakeCoverage } from '../src/core/generation/lake-surfaces';
import { cornerHeight } from '../src/render/WorldMeshes';
import type { World } from '../src/core/model';

const radius = 1000;
const grid = refineGrid(
  buildGrid(2, 'adaptive-corner-support', 0.65),
  radius,
  'adaptive-corner-support',
  createRegionSpacing(500, radius, [
    { center: [1, 0, 0], radiusMetres: 200, targetSpacingMetres: 60 },
  ]),
);

test('adaptive corner reconstruction preserves constants and bounds sharp terrain', () => {
  const constant = reconstructCornerField(grid, new Float32Array(grid.count).fill(317.25));
  assert.ok(constant.every((height) => height === 317.25));
  const terrain = Float32Array.from({ length: grid.count }, (_, cell) =>
    grid.positions[cell * 3] > 0.95 ? 3000 : -1000,
  );
  const reconstructed = reconstructCornerField(grid, terrain);

  for (let corner = 0; corner < reconstructed.length; corner++) {
    const incident = Array.from(
      grid.triangles.subarray(corner * 3, corner * 3 + 3),
      (cell) => terrain[cell],
    );
    assert.ok(Number.isFinite(reconstructed[corner]));
    assert.ok(reconstructed[corner] >= Math.min(...incident));
    assert.ok(reconstructed[corner] <= Math.max(...incident));
  }

  // The scalar x-coordinate is affine in any corner tangent plane up to its
  // constant radial projection. This distinguishes geometry from an equal mean.
  const smooth = Float64Array.from({ length: grid.count }, (_, cell) => grid.positions[cell * 3]);
  const actual = reconstructCornerField(grid, smooth);
  let meanError = 0;
  let reconstructionError = 0;

  for (let corner = 0; corner < actual.length; corner++) {
    const firstCell = grid.triangles[corner * 3];
    let radial = 0;

    for (let axis = 0; axis < 3; axis++) {
      radial += grid.positions[firstCell * 3 + axis] * grid.corners[corner * 3 + axis];
    }

    const expected = radial * grid.corners[corner * 3];
    const values = Array.from(
      grid.triangles.subarray(corner * 3, corner * 3 + 3),
      (cell) => smooth[cell],
    );

    if (expected < Math.min(...values) || expected > Math.max(...values)) {
      continue;
    }

    reconstructionError += Math.abs(actual[corner] - expected);
    meanError += Math.abs(values.reduce((sum, value) => sum + value, 0) / 3 - expected);
  }

  assert.ok(reconstructionError < meanError * 0.001);
});

test('geometric corner sectors partition each adaptive cell and preserve extensive inventories', () => {
  const support = computeCornerSupport(grid);
  assert.equal(computeCornerSupport(grid), support, 'immutable mesh geometry is reused');
  let unequalPartitions = 0;

  for (let cell = 0; cell < grid.count; cell++) {
    let area = 0;
    let fraction = 0;
    const equalFraction = 1 / (grid.offsets[cell + 1] - grid.offsets[cell]);

    for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
      assert.ok(support.cellCornerArea[offset] > 0);
      area += support.cellCornerArea[offset];
      fraction += support.cellCornerFraction[offset];
      unequalPartitions += +(Math.abs(support.cellCornerFraction[offset] - equalFraction) > 0.01);
      const corner = grid.cellCorners[offset];
      const slot = grid.triangles.subarray(corner * 3, corner * 3 + 3).indexOf(cell);
      assert.equal(support.cornerCellArea[corner * 3 + slot], support.cellCornerArea[offset]);
    }

    assert.ok(Math.abs(area - grid.areas[cell]) < grid.areas[cell] * 1e-14);
    assert.ok(Math.abs(fraction - 1) < 1e-14);
  }

  assert.ok(
    unequalPartitions > grid.count,
    'irregular sectors must have distinct physical support',
  );
  assert.ok(
    Math.abs(support.cornerArea.reduce((sum, area) => sum + area, 0) - 4 * Math.PI) < 1e-10,
  );

  for (const scale of [1, 0.001, 1e9, -25]) {
    const inventory = Float64Array.from(
      grid.areas,
      (area, cell) => area * scale * (1 + (cell % 13)),
    );
    const allocated = distributeCellInventory(grid, inventory);
    const before = inventory.reduce((sum, value) => sum + value, 0);
    const after = allocated.reduce((sum, value) => sum + value, 0);
    assert.ok(Math.abs(before - after) < Math.abs(before) * 1e-13);
  }
});

test('routing, river supply, catchments and rendered corner heights use the shared geometry', () => {
  const height = Float32Array.from(
    { length: grid.count },
    (_, cell) => 1200 * grid.positions[cell * 3 + 1],
  );
  const terrain = { height, ocean: new Uint8Array(grid.count).fill(1) } as Terrain;
  const runoff = Float64Array.from(grid.areas, (area, cell) => area * (1 + (cell % 7)));
  const water = {
    runoff,
    channelRunoff: runoff,
    meltRunoff: new Float32Array(grid.count),
    baseflowRunoff: new Float32Array(grid.count),
    pet: new Float32Array(grid.count).fill(500),
    seasonalRunoff: Array.from({ length: 4 }, () => new Float32Array(runoff)),
    seasonalLiquid: Array.from({ length: 4 }, () => new Float32Array(grid.count).fill(150)),
    seasonalPet: Array.from({ length: 4 }, () => new Float32Array(grid.count).fill(125)),
  } as LandWater;
  const config = { ...DEFAULT_CONFIG, radius };
  const drainage = routeWater(grid, terrain, water, config);
  const expectedRunoff = distributeCellInventory(grid, runoff);
  assert.deepEqual(drainage.height, reconstructCornerField(grid, height));
  assert.deepEqual(drainage.discharge, expectedRunoff);
  assert.ok(Math.abs(drainage.runoffTotal - runoff.reduce((sum, flow) => sum + flow, 0)) < 1e-12);
  assert.ok(Math.abs(drainage.oceanDischarge - drainage.runoffTotal) < 1e-12);
  const rivers = selectRivers(
    grid,
    { ...terrain, ocean: new Uint8Array(grid.count) },
    water,
    drainage,
    config,
  );
  assert.deepEqual(rivers.supportFlow, expectedRunoff);
  const expectedCatchment = distributeCellInventory(
    grid,
    Float64Array.from(grid.areas, (area) => area * radius ** 2),
  );

  for (let corner = 0; corner < drainage.height.length; corner++) {
    assert.ok(Math.abs(rivers.catchmentArea[corner] - expectedCatchment[corner]) < 1e-9);
    assert.equal(cornerHeight({ drainage } as World, corner), drainage.height[corner]);
  }
});

test('seasonal lake coverage integrates to its geometric corner support area', () => {
  const support = computeCornerSupport(grid);
  const area = Float64Array.from(support.cornerArea, (value) => value * radius ** 2);
  const fractions = [0.1, 0.3, 0.5, 0.8];
  const totalArea = area.reduce((sum, value) => sum + value, 0);
  const drainage = {
    height: new Float32Array(area.length),
    lakeId: new Int32Array(area.length),
    lakeFraction: new Float32Array(area.length),
    lakeCoverage: new Float32Array(grid.count),
    lakes: [
      { id: 0, spill: 0, seasonal: { area: fractions.map((fraction) => totalArea * fraction) } },
    ],
  } as Drainage;
  updateLakeCoverage(grid, drainage, area);

  for (let season = 0; season < 4; season++) {
    const integrated = drainage.seasonalLakeCoverage![season].reduce(
      (sum, fraction, cell) => sum + fraction * grid.areas[cell] * radius ** 2,
      0,
    );
    assert.ok(Math.abs(integrated - totalArea * fractions[season]) < totalArea * 1e-7);
  }
});

test('adaptive river incision conserves eroded volume through deposition and export', () => {
  const height = Float32Array.from({ length: grid.count }, (_, cell) => {
    const latitude = grid.positions[cell * 3 + 1];

    return latitude < -0.6 ? -200 : 200 + (latitude + 0.6) * 1500;
  });
  const terrain = {
    height,
    bedrock: new Float32Array(height),
    sediment: new Float32Array(grid.count),
    ocean: Uint8Array.from(height, (value) => +(value < 0)),
    fluvialIncision: new Float32Array(grid.count),
    deltaSediment: new Float32Array(grid.count),
  } as Terrain;
  const runoff = Float64Array.from(grid.areas, (area, cell) =>
    terrain.ocean[cell] ? 0 : area * 5000,
  );
  const water = {
    runoff,
    pet: new Float32Array(grid.count).fill(500),
    seasonalRunoff: Array.from({ length: 4 }, () => new Float32Array(runoff)),
    seasonalLiquid: Array.from({ length: 4 }, () => new Float32Array(grid.count).fill(200)),
    seasonalPet: Array.from({ length: 4 }, () => new Float32Array(grid.count).fill(125)),
  } as LandWater;
  const config = { ...DEFAULT_CONFIG, radius, fluvialDuration: 0.001 };
  const drainage = routeWater(grid, terrain, water, config);
  const before = new Float32Array(height);
  const exported = erodeRiverLandscape(grid, terrain, drainage, config);
  let netVolume = 0;
  let removedVolume = 0;

  for (let cell = 0; cell < grid.count; cell++) {
    const area = grid.areas[cell] * radius ** 2;
    netVolume += (height[cell] - before[cell]) * area;
    removedVolume += terrain.fluvialIncision[cell] * area;
    assert.ok(terrain.ocean[cell] || height[cell] >= 0);
  }

  assert.ok(removedVolume > 0 && exported > 0);
  assert.ok(Math.abs(netVolume + exported) < removedVolume * 1e-4);
});
