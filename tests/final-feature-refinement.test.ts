import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWorld, generateWorldAsync } from '../src/core/pipeline';
import { DEFAULT_CONFIG, SEASON, type Drainage, type Grid, type World } from '../src/core/model';
import { readWorldProject, worldProject } from '../src/core/project';
import { refineExistingWorld, replayRegionalRefinements } from '../src/core/regional-refinement';
import { planFeatureRefinement } from '../src/core/grid/feature-refinement';
import { refineGrid } from '../src/core/grid/refine';
import { remapTerrain } from '../src/core/operators/remap';
import { computeCornerSupport } from '../src/core/operators/corner-fields';
import { routeWater } from '../src/core/generation/drainage';
import { selectRivers } from '../src/core/generation/rivers';
import { solveClimate } from '../src/core/generation/climate';
import { createFlatLakeTerrain, flatLakeConfig, flatLakeWater } from './helpers/flat-lake';

const config = {
  ...DEFAULT_CONFIG,
  seed: 'final-feature-history',
  surfaceLevel: 3,
  processLevel: 3,
  radius: 3000000,
  tectonicDuration: 10,
  fluvialDuration: 0.2,
  landscapeBatches: 2,
  featureRefinementPasses: 2,
  featureRefinementSpacing: 100000,
  featureRefinementBudget: 20,
};

let fixture: { base: World; refined: World; progress: [number, number][] } | undefined;
function worlds() {
  if (!fixture) {
    const progress: [number, number][] = [];
    fixture = {
      base: generateWorld({ ...config, featureRefinementPasses: 0 }),
      refined: generateWorld(config, (_, completed, total) => progress.push([completed, total])),
      progress,
    };
  }
  return fixture;
}

function assertRunoffLedger(drainage: Drainage) {
  const residual = drainage.runoffTotal - drainage.oceanDischarge - drainage.lakeExchange;
  assert.ok(Math.abs(residual) < Math.max(1, drainage.runoffTotal) * 1e-8);
}

function inventory(world: World, field: Float32Array) {
  return field.reduce((sum, value, cell) => sum + value * world.grid.areas[cell], 0);
}

function assertSamePhysicalWorld(actual: World, expected: World) {
  assert.deepEqual(actual.grid.positions, expected.grid.positions);
  assert.deepEqual(actual.grid.triangles, expected.grid.triangles);
  assert.deepEqual(actual.terrain, expected.terrain);
  assert.deepEqual(actual.water, expected.water);
  assert.deepEqual(actual.drainage, expected.drainage);
  assert.deepEqual(actual.rivers, expected.rivers);
  assert.deepEqual(actual.ecology, expected.ecology);
  assert.deepEqual(actual.resources, expected.resources);
  assert.deepEqual(actual.evolution, expected.evolution);
  assert.deepEqual(actual.featureRefinementPlans, expected.featureRefinementPlans);
  assert.deepEqual(actual.featureRefinementStats, expected.featureRefinementStats);
}

test('final feature passes share a strict cell budget and add no geological or landscape time', () => {
  const { base, refined, progress } = worlds();
  const budget = Math.floor((base.grid.count * config.featureRefinementBudget) / 100);
  assert.equal(config.refinementStrength, 0, 'final feature detail also works on uniform worlds');
  assert.ok(refined.grid.count > base.grid.count);
  assert.ok(refined.grid.count <= base.grid.count + budget);
  assert.equal(refined.featureRefinementPlans!.length, 2);
  assert.equal(refined.featureRefinementStats!.length, 2);
  let priorCount = base.grid.count;
  for (const [index, stats] of refined.featureRefinementStats!.entries()) {
    assert.equal(stats.beforeCells, priorCount);
    const remaining = budget - (priorCount - base.grid.count);
    assert.equal(stats.budget, Math.ceil(remaining / (2 - index)));
    assert.ok(stats.afterCells - stats.beforeCells <= stats.budget);
    assert.ok(stats.candidateCells >= stats.selectedCells);
    priorCount = stats.afterCells;
  }
  assert.equal(priorCount, refined.grid.count);
  assert.deepEqual(refined.process, base.process);
  assert.deepEqual(refined.geology, base.geology);
  assert.deepEqual(refined.climate, base.climate);
  assert.deepEqual(refined.climateReferenceHeight, base.climateReferenceHeight);
  assert.deepEqual(refined.evolution, base.evolution);
  assert.equal(refined.sedimentExport, base.sedimentExport);
  assert.deepEqual(refined.resources.deposits, base.resources.deposits);
  assert.deepEqual(
    refined.grid.positions.subarray(0, base.grid.positions.length),
    base.grid.positions,
  );
  assert.deepEqual(refined.terrain.height.subarray(0, base.grid.count), base.terrain.height);
  for (const key of ['sediment', 'fluvialIncision', 'deltaSediment'] as const) {
    const before = inventory(base, base.terrain[key]);
    const after = inventory(refined, refined.terrain[key]);
    assert.ok(Math.abs(after - before) < Math.max(1, before) * 1e-7, `${key} inventory`);
  }
  assert.ok(refined.terrain.height.every(Number.isFinite));
  assert.ok(refined.terrain.sediment.every((depth) => Number.isFinite(depth) && depth >= 0));
  assert.equal(refined.water.runoff.length, refined.grid.count);
  assert.equal(refined.rivers.channel.length, refined.grid.corners.length / 3);
  assert.equal(refined.resources.fertility.length, refined.grid.count);
  assertRunoffLedger(refined.drainage);

  const stages = refined.timings.map(({ name }) => name);
  assert.ok(stages.indexOf('Final climate') < stages.indexOf('Final water & drainage'));
  assert.ok(stages.indexOf('Final water & drainage') < stages.indexOf('Headwaters & channels'));
  let previous = stages.indexOf('Headwaters & channels');
  for (let pass = 1; pass <= 2; pass++) {
    for (const stage of ['plan', 'mesh', 'transfers', 'water & drainage', 'channels']) {
      const next = stages.indexOf(`Final feature ${stage} · ${pass} / 2`);
      assert.ok(next > previous, `final feature ${stage} follows its prerequisite`);
      previous = next;
    }
  }
  assert.ok(previous < stages.indexOf('River courses & deltas'));
  assert.ok(stages.indexOf('River courses & deltas') < stages.indexOf('Biomes & ecology'));
  assert.deepEqual(
    stages.filter((stage) => !stage.startsWith('Final feature ')),
    base.timings.map(({ name }) => name),
    'physical stages run exactly once in the same order',
  );
  assert.deepEqual(progress.at(-1), [stages.length, stages.length]);
});

test('resolved final feature plans replay exactly before a subsequent regional refinement', () => {
  const { refined } = worlds();
  const imported = readWorldProject(JSON.parse(JSON.stringify(worldProject(refined))));
  assert.deepEqual(imported.featureRefinementPlans, refined.featureRefinementPlans);
  const regenerated = generateWorld(imported.config, undefined, {
    refinementPlans: imported.refinementPlans,
    featureRefinementPlans: imported.featureRefinementPlans,
  });
  assertSamePhysicalWorld(regenerated, refined);
  assert.throws(
    () => generateWorld(imported.config, undefined, { featureRefinementPlans: [] }),
    /plan count/,
  );

  let anchor = 0;
  for (let cell = 1; cell < refined.grid.count; cell++) {
    if (refined.terrain.height[cell] > refined.terrain.height[anchor]) {
      anchor = cell;
    }
  }
  const regional = refineExistingWorld(refined, {
    kind: 'region',
    center: [
      refined.grid.positions[anchor * 3],
      refined.grid.positions[anchor * 3 + 1],
      refined.grid.positions[anchor * 3 + 2],
    ],
    radiusMetres: 180000,
    targetSpacingMetres: 75000,
  });
  assert.ok(regional.grid.count > refined.grid.count);
  assert.deepEqual(regional.featureRefinementPlans, refined.featureRefinementPlans);
  const replay = readWorldProject(JSON.parse(JSON.stringify(worldProject(regional))));
  const replayBase = generateWorld(replay.config, undefined, {
    refinementPlans: replay.refinementPlans,
    featureRefinementPlans: replay.featureRefinementPlans,
  });
  const result = replayRegionalRefinements(replayBase, replay.regionalRefinements);
  assertSamePhysicalWorld(result, regional);
  assert.deepEqual(result.regionalRefinements, regional.regionalRefinements);
});

test('asynchronous climate execution produces the same final feature mesh and hydrology', async () => {
  const { refined } = worlds();
  let climateCalls = 0;
  const asynchronous = await generateWorldAsync(config, undefined, {
    climateConcurrency: 4,
    solveClimate: async (request) => {
      climateCalls++;
      return solveClimate(
        request.grid,
        request.height,
        request.ocean,
        request.config,
        request.referenceOcean,
        request.recycledEvapotranspiration,
      );
    },
  });
  assert.equal(climateCalls, 2, 'final detail uses the settled climate instead of solving again');
  assert.equal(asynchronous.execution.climateWorkers, 4);
  assertSamePhysicalWorld(asynchronous, refined);
});

test('a fresh-world single pass can refine features with the default target and cell budget', () => {
  const { base } = worlds();
  const fresh = generateWorld({
    ...config,
    featureRefinementPasses: 1,
    featureRefinementSpacing: DEFAULT_CONFIG.featureRefinementSpacing,
    featureRefinementBudget: DEFAULT_CONFIG.featureRefinementBudget,
  });
  assert.ok(fresh.grid.count > base.grid.count);
  assert.ok(
    fresh.grid.count - base.grid.count <=
      Math.floor((base.grid.count * DEFAULT_CONFIG.featureRefinementBudget) / 100),
  );
  assert.equal(fresh.featureRefinementPlans!.length, 1);
  assert.ok(fresh.featureRefinementStats![0].selectedCells > 0);
  assertRunoffLedger(fresh.drainage);
});

test('zero budget records replayable no-op feature passes without changing the physical world', () => {
  const { base } = worlds();
  const unchanged = generateWorld({ ...config, featureRefinementBudget: 0 });
  assert.equal(unchanged.featureRefinementPlans!.length, 2);
  assert.equal(unchanged.featureRefinementStats!.length, 2);
  for (const stats of unchanged.featureRefinementStats!) {
    assert.equal(stats.beforeCells, base.grid.count);
    assert.equal(stats.afterCells, base.grid.count);
    assert.equal(stats.budget, 0);
    assert.equal(stats.selectedCells, 0);
  }
  assert.deepEqual(unchanged.grid, base.grid);
  assert.deepEqual(unchanged.terrain, base.terrain);
  assert.deepEqual(unchanged.climate, base.climate);
  assert.deepEqual(unchanged.water, base.water);
  assert.deepEqual(unchanged.drainage, base.drainage);
  assert.deepEqual(unchanged.resources, base.resources);
  const imported = readWorldProject(JSON.parse(JSON.stringify(worldProject(unchanged))));
  const replay = generateWorld(imported.config, undefined, {
    featureRefinementPlans: imported.featureRefinementPlans,
  });
  assertSamePhysicalWorld(replay, unchanged);
});

function assertLakeInventory(grid: Grid, drainage: Drainage) {
  const { cornerArea } = computeCornerSupport(grid);
  for (const lake of drainage.lakes) {
    const state = lake.seasonal!;
    for (let season = 0; season < 4; season++) {
      let inventory = 0;
      for (let corner = 0; corner < drainage.lakeId.length; corner++) {
        if (drainage.lakeId[corner] !== lake.id) {
          continue;
        }
        inventory +=
          cornerArea[corner] *
          flatLakeConfig.radius ** 2 *
          Math.max(0, state.level[season] - drainage.height[corner]);
      }
      const net =
        state.inflow[season] +
        state.directRain[season] -
        state.evaporation[season] -
        state.displacedRunoff[season] -
        state.outflow[season];
      const scale = Math.max(1, lake.capacity, Math.abs(state.inflow[season] * SEASON));
      assert.ok(Math.abs(net * SEASON - state.storageChange[season]) < scale * 1e-10);
      assert.ok(Math.abs(inventory - state.storage[season]) < scale * 1e-9);
    }
  }
  assertRunoffLedger(drainage);
}

test('automatic feature insertion retains a connected inland sea, its island and water inventory', () => {
  const source = createFlatLakeTerrain();
  const before = structuredClone(source);
  const lakeConfig = {
    ...flatLakeConfig,
    featureRefinementPasses: 2,
    featureRefinementSpacing: 75000,
    featureRefinementBudget: 50,
  };
  let { grid, terrain } = source;
  for (let pass = 0; pass < 2; pass++) {
    const water = flatLakeWater(grid, terrain);
    const drainage = routeWater(grid, terrain, water, lakeConfig);
    const rivers = selectRivers(grid, terrain, water, drainage, lakeConfig);
    const budget = Math.floor(source.grid.count / 4);
    const plan = planFeatureRefinement(
      { grid, terrain, drainage, rivers, config: lakeConfig },
      budget,
    );
    assert.ok(plan.stats.selectedCells > 0);
    const refined = refineGrid(grid, lakeConfig.radius, lakeConfig.seed, plan.spacingAt, {
      maxAddedCells: budget,
    });
    assert.ok(refined.count > grid.count);
    assert.ok(refined.count - grid.count <= budget);
    terrain = remapTerrain(grid, refined, terrain, lakeConfig);
    grid = refined;
    const rerouted = routeWater(grid, terrain, flatLakeWater(grid, terrain), lakeConfig);
    const interior: number[] = [];
    for (let cell = 0; cell < grid.count; cell++) {
      const angle = Math.acos(grid.positions[cell * 3]);
      if (angle > 0.2 && angle < 0.31) {
        interior.push(cell);
        assert.ok(rerouted.lakeCoverage[cell] > 0.999, `lake floor ${cell} remains wet`);
        for (const seasonal of rerouted.seasonalLakeCoverage!) {
          assert.ok(seasonal[cell] > 0.999);
        }
      }
    }
    assert.ok(interior.length > 0);
    const reached = new Set([interior[0]]);
    const queue = [interior[0]];
    for (let head = 0; head < queue.length; head++) {
      const cell = queue[head];
      for (let edge = grid.offsets[cell]; edge < grid.offsets[cell + 1]; edge++) {
        const neighbor = grid.neighbors[edge];
        if (reached.has(neighbor) || rerouted.lakeCoverage[neighbor] < 0.999) {
          continue;
        }
        reached.add(neighbor);
        queue.push(neighbor);
      }
    }
    assert.ok(
      interior.every((cell) => reached.has(cell)),
      'the wet interior stays connected',
    );
    let islands = 0;
    for (let cell = 0; cell < source.grid.count; cell++) {
      if (source.terrain.height[cell] !== 650) {
        continue;
      }
      islands++;
      assert.equal(terrain.height[cell], 650);
      assert.ok(rerouted.lakeCoverage[cell] < 1, 'a genuine island retains exposed land');
      // A coarse island cell already includes some shoreline water. Its elevated
      // centre must remain above the adjacent reservoir, not become 100% water.
      for (let edge = grid.offsets[cell]; edge < grid.offsets[cell + 1]; edge++) {
        const lake = rerouted.lakes[rerouted.lakeId[grid.cellCorners[edge]]];
        if (lake) {
          assert.ok(Math.max(...lake.seasonal!.level) < terrain.height[cell]);
        }
      }
    }
    assert.ok(islands > 0);
    assertLakeInventory(grid, rerouted);
  }
  assert.ok(
    Array.from(
      { length: grid.count - source.grid.count },
      (_, index) => index + source.grid.count,
    ).some((cell) => Math.acos(grid.positions[cell * 3]) < 0.73),
    'the automatic pass adds detail near the inland sea',
  );
  assert.deepEqual(source, before, 'the original terrain is preserved for rollback');
});
