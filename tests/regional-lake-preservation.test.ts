import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegionSpacing, refineGrid } from '../src/core/grid/refine';
import { routeWater } from '../src/core/generation/drainage';
import { computeCornerSupport } from '../src/core/operators/corner-fields';
import { remapTerrain } from '../src/core/operators/remap';
import { SEASON, type Drainage, type Grid, type Terrain } from '../src/core/model';
import { createFlatLakeTerrain, flatLakeConfig, flatLakeWater } from './helpers/flat-lake';

function interiorCells(grid: Grid) {
  return Array.from({ length: grid.count }, (_, cell) => cell).filter((cell) => {
    const angle = Math.acos(grid.positions[cell * 3]);
    return angle > 0.2 && angle < 0.31;
  });
}

function assertConnectedFloor(grid: Grid, terrain: Terrain, drainage: Drainage) {
  const cells = interiorCells(grid);
  assert.ok(cells.length > 0);
  for (const cell of cells) {
    assert.ok(drainage.lakeCoverage[cell] > 0.999, `interior cell ${cell} remains water`);
    for (const coverage of drainage.seasonalLakeCoverage!) {
      assert.ok(coverage[cell] > 0.999, `no seasonal dry hole at cell ${cell}`);
    }
  }
  const visited = new Set([cells[0]]);
  const queue = [cells[0]];
  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head];
    for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
      const neighbor = grid.neighbors[offset];
      if (!visited.has(neighbor) && drainage.lakeCoverage[neighbor] > 0.999) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  assert.ok(
    cells.every((cell) => visited.has(cell)),
    'the physical wet floor stays connected',
  );
  const lakeIds = new Set<number>();
  for (const cell of cells) {
    for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
      lakeIds.add(drainage.lakeId[grid.cellCorners[offset]]);
    }
  }
  assert.equal(lakeIds.size, 1, 'one routed reservoir spans the interior');
  assert.ok(!lakeIds.has(-1));
  assert.ok(terrain.height.every(Number.isFinite));
}

function assertPhysicalLedger(grid: Grid, drainage: Drainage) {
  const radiusSquared = flatLakeConfig.radius ** 2;
  const { cornerArea } = computeCornerSupport(grid);
  const volume = drainage.lakes.map(() => [0, 0, 0, 0]);
  for (let corner = 0; corner < drainage.lakeId.length; corner++) {
    const lake = drainage.lakes[drainage.lakeId[corner]];
    if (!lake) {
      continue;
    }
    for (let season = 0; season < 4; season++) {
      volume[lake.id][season] +=
        cornerArea[corner] *
        radiusSquared *
        Math.max(0, lake.seasonal!.level[season] - drainage.height[corner]);
    }
  }
  for (const lake of drainage.lakes) {
    const state = lake.seasonal!;
    for (let season = 0; season < 4; season++) {
      const net =
        state.inflow[season] +
        state.directRain[season] -
        state.evaporation[season] -
        state.displacedRunoff[season] -
        state.outflow[season];
      const scale = Math.max(1, lake.capacity, Math.abs(state.inflow[season] * SEASON));
      assert.ok(Math.abs(net * SEASON - state.storageChange[season]) < scale * 1e-10);
      assert.ok(state.storage[season] >= 0 && state.storage[season] <= lake.capacity);
      assert.ok(
        Math.abs(volume[lake.id][season] - state.storage[season]) < scale * 1e-9,
        'recorded water inventory agrees with the actual new basin and level',
      );
    }
    if (lake.outflow > 0) {
      assert.ok(lake.outlet >= 0 && lake.outlet < drainage.receiver.length);
      assert.ok(
        drainage.receiver.some(
          (downstream, corner) =>
            downstream === lake.outlet &&
            drainage.lakeId[corner] === lake.id &&
            Math.abs(drainage.discharge[corner] - lake.outflow) < Math.max(1, lake.outflow) * 1e-10,
        ),
        'spill uses a real rebuilt escape edge with the recorded outflow',
      );
    }
  }
  for (let season = 0; season < 4; season++) {
    const rasterArea = drainage.seasonalLakeCoverage![season].reduce(
      (sum, fraction, cell) => sum + fraction * grid.areas[cell] * radiusSquared,
      0,
    );
    const area = drainage.lakes.reduce((sum, lake) => sum + lake.seasonal!.area[season], 0);
    assert.ok(Math.abs(rasterArea - area) < Math.max(1, area) * 1e-7);
  }
  const residual = drainage.runoffTotal - drainage.oceanDischarge - drainage.lakeExchange;
  assert.ok(Math.abs(residual) < Math.max(1, drainage.runoffTotal) * 1e-10);
}

test('regional remap preserves a routed level lake floor and island through repeated insertion', () => {
  const source = createFlatLakeTerrain();
  const original = structuredClone(source);
  const initial = routeWater(
    source.grid,
    source.terrain,
    flatLakeWater(source.grid, source.terrain),
    flatLakeConfig,
  );
  assertConnectedFloor(source.grid, source.terrain, initial);
  assertPhysicalLedger(source.grid, initial);
  let { grid, terrain } = source;
  for (const spacing of [0.025, 0.02]) {
    const refined = refineGrid(
      grid,
      flatLakeConfig.radius,
      flatLakeConfig.seed,
      createRegionSpacing(0.5 * flatLakeConfig.radius, flatLakeConfig.radius, [
        {
          center: [1, 0, 0],
          radiusMetres: 0.65 * flatLakeConfig.radius,
          targetSpacingMetres: spacing * flatLakeConfig.radius,
        },
      ]),
    );
    assert.ok(refined.count > grid.count);
    terrain = remapTerrain(grid, refined, terrain, flatLakeConfig);
    grid = refined;
    const drainage = routeWater(grid, terrain, flatLakeWater(grid, terrain), flatLakeConfig);
    assertConnectedFloor(grid, terrain, drainage);
    assertPhysicalLedger(grid, drainage);
    let islands = 0;
    for (let cell = 0; cell < source.grid.count; cell++) {
      if (source.terrain.height[cell] !== 650) {
        continue;
      }
      islands++;
      assert.equal(terrain.height[cell], 650, 'the real raised island is retained');
      assert.equal(drainage.lakeCoverage[cell], 0, 'water does not hide the real island');
      for (const field of drainage.seasonalLakeCoverage!) {
        assert.equal(field[cell], 0);
      }
    }
    assert.ok(islands > 0);
  }
  assert.deepEqual(source, original, 'refining leaves the original lake available for rollback');
});
