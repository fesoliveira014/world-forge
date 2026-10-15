import test from 'node:test';
import assert from 'node:assert/strict';
import { YEAR, type Drainage, type Lake } from '../src/core/model';
import {
  SALT_SATURATION,
  salinityClass,
  salinityFreshwaterSuitability,
  solveLakeSalt,
  solveSalinity,
} from '../src/core/generation/salinity';
import { routeWater } from '../src/core/generation/drainage';
import { createFlatLakeTerrain, flatLakeConfig, flatLakeWater } from './helpers/flat-lake';

function near(actual: number, expected: number, relative = 1e-11) {
  assert.ok(
    Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * relative,
    `${actual} should equal ${expected}`,
  );
}

function ledger(result: ReturnType<typeof solveLakeSalt>) {
  near(
    result.initialSalt + result.inputSalt,
    result.dissolvedSalt + result.bedSalt + result.exportedSalt,
  );
  assert.ok(result.concentration >= 0 && result.concentration <= SALT_SATURATION);
}

test('closed lake concentrates dissolved input without exporting evaporated salt', () => {
  const result = solveLakeSalt(
    { storage: 100, outflow: 0 },
    {
      years: 2,
      initialSaltMass: 20,
      inputSaltRate: 10 / YEAR,
    },
  );
  near(result.dissolvedSalt, 40);
  near(result.concentration, 0.4);
  assert.equal(result.exportedSalt, 0);
  assert.equal(result.bedSalt, 0);
  ledger(result);
});

test('well mixed flushing has the analytic exponential solution and exports inherited salt', () => {
  const result = solveLakeSalt(
    { storage: 100, outflow: 100 / YEAR },
    {
      years: 1,
      initialSaltMass: 1000,
      inputSaltRate: 20 / YEAR,
    },
  );
  near(result.dissolvedSalt, 20 + 980 * Math.exp(-1));
  near(result.exportedSalt, 1020 - result.dissolvedSalt);
  near(result.outflowSalt, (result.concentration * 100) / YEAR);
  ledger(result);
});

test('drying stores precipitated salt and zero-time refilling redissolves the same mass', () => {
  const dry = solveLakeSalt(
    { storage: 0, outflow: 0 },
    {
      years: 10,
      initialSaltMass: 1000,
      inputSaltRate: 10 / YEAR,
    },
  );
  near(dry.bedSalt, 1100);
  assert.equal(dry.dissolvedSalt, 0);
  assert.equal(dry.concentration, 0);
  const refilled = solveLakeSalt(
    { storage: 100, outflow: 0 },
    {
      years: 0,
      initialSaltMass: dry.bedSalt,
      inputSaltRate: 10 / YEAR,
    },
  );
  near(refilled.dissolvedSalt, 1100);
  near(refilled.concentration, 11);
  assert.equal(refilled.bedSalt, 0);
  ledger(dry);
  ledger(refilled);
});

test('saturation precipitates excess salt and flushing first consumes that bed inventory', () => {
  const accumulating = solveLakeSalt(
    { storage: 1, outflow: 0 },
    {
      years: 100,
      initialSaltMass: 0,
      inputSaltRate: 10 / YEAR,
    },
  );
  near(accumulating.dissolvedSalt, SALT_SATURATION);
  near(accumulating.bedSalt, 1000 - SALT_SATURATION);
  const flushed = solveLakeSalt(
    { storage: 1, outflow: 1 / YEAR },
    {
      years: 4,
      initialSaltMass: 1000,
      inputSaltRate: 0,
    },
  );
  const bedDissolutionYears = (1000 - SALT_SATURATION) / SALT_SATURATION;
  near(flushed.dissolvedSalt, SALT_SATURATION * Math.exp(-(4 - bedDissolutionYears)));
  assert.equal(flushed.bedSalt, 0);
  ledger(accumulating);
  ledger(flushed);
});

test('inflow exceeding saturated export crosses the solubility boundary exactly', () => {
  const result = solveLakeSalt(
    { storage: 1, outflow: 1 / YEAR },
    {
      years: 3,
      initialSaltMass: 0,
      inputSaltRate: 520 / YEAR,
    },
  );
  const saturationYears = Math.log(2);
  near(result.dissolvedSalt, 260);
  near(result.bedSalt, 260 * (3 - saturationYears));
  ledger(result);
});

test('long explicit ages stay finite with constant work; changing storage preserves salt', () => {
  const old = solveLakeSalt(
    { storage: 100, outflow: 1 },
    {
      years: 1e9,
      initialSaltMass: 10000,
      inputSaltRate: 0.05,
    },
  );
  near(old.concentration, 0.05);
  ledger(old);
  const reduced = solveLakeSalt(
    { storage: 0.001, outflow: 0 },
    {
      years: 0,
      initialSaltMass: old.dissolvedSalt + old.bedSalt,
      inputSaltRate: 0,
    },
  );
  near(reduced.dissolvedSalt + reduced.bedSalt, old.dissolvedSalt + old.bedSalt);
  assert.ok(reduced.bedSalt > 0);
});

test('water suitability and labels follow modeled concentration', () => {
  assert.equal(salinityClass(0.1), 'freshwater');
  assert.equal(salinityClass(1), 'brackish');
  assert.equal(salinityClass(35), 'saline');
  assert.equal(salinityClass(100), 'hypersaline');
  assert.equal(salinityFreshwaterSuitability(0.05), 1);
  assert.ok(salinityFreshwaterSuitability(5) < 0.25);
  assert.ok(salinityFreshwaterSuitability(35) < 0.001);
});

function fakeLake(id: number, outlet: number, outflow: number): Lake {
  return {
    id,
    outlet,
    outflow,
    storage: 100,
    area: 100,
    capacity: 100,
    spill: 1,
    level: 1,
    inflow: outflow,
    evaporation: 0,
    directRain: 0,
    displacedRunoff: 0,
    kind: outflow > 0 ? 'spilling' : 'closed',
  };
}

function cascade() {
  const { grid, terrain } = createFlatLakeTerrain();
  terrain.ocean.fill(0);
  const water = flatLakeWater(grid, terrain);
  water.runoff.fill(0);
  const count = grid.corners.length / 3;
  const drainage: Drainage = {
    height: new Float32Array(count),
    filled: new Float32Array(count),
    receiver: new Int32Array(count).fill(-1),
    order: Uint32Array.from({ length: count }, (_, i) => i),
    discharge: new Float64Array(count),
    basin: new Uint32Array(count),
    lakeId: new Int32Array(count).fill(-1),
    lakeDepth: new Float32Array(grid.count),
    lakeFraction: new Float32Array(count),
    lakeCoverage: new Float32Array(grid.count),
    lakes: [fakeLake(0, 1, 100 / YEAR), fakeLake(1, 2, 0)],
    runoffTotal: 0,
    oceanDischarge: 0,
    lakeExchange: 0,
  };
  drainage.lakeId[0] = 0;
  drainage.lakeId[1] = 1;
  drainage.lakeFraction[0] = 1;
  drainage.lakeFraction[1] = 1;
  drainage.discharge[1] = 100 / YEAR;
  // The order is deliberately irrelevant; a receiver DAG drives salt routing.
  drainage.order.reverse();
  return { grid, terrain, water, drainage };
}

test('lake cascade routes historical exported mass separately from final channel concentration', () => {
  const { grid, terrain, water, drainage } = cascade();
  solveSalinity(grid, terrain, water, drainage, {
    ...flatLakeConfig,
    salinityYears: 1,
    inheritedMarineSalinity: 10,
    weatheringSalinity: 0,
  });
  const first = drainage.lakes[0].salinity!;
  const second = drainage.lakes[1].salinity!;
  near(first.dissolvedSalt, 1000 * Math.exp(-1));
  near(second.dissolvedSalt, 1000 + 1000 * (1 - Math.exp(-1)));
  near(drainage.riverSalinity![1], first.concentration, 1e-6);
  near(drainage.salinityBudget!.retainedSalt, 2000);
  near(drainage.salinityBudget!.residual, 0, 1e-8);
  assert.equal(drainage.salinityBudget!.exportedSalt, 0);
  assert.equal(terrain.saltAgeYears, 1);
});

test('an actual lake routing solve conserves salt, preserves fresh tributaries, and does not re-age', () => {
  const { grid, terrain } = createFlatLakeTerrain();
  const water = flatLakeWater(grid, terrain);
  const drainage = routeWater(grid, terrain, water, flatLakeConfig);
  solveSalinity(grid, terrain, water, drainage, {
    ...flatLakeConfig,
    salinityYears: 20,
    inheritedMarineSalinity: 35,
  });
  const budget = drainage.salinityBudget!;
  assert.ok(drainage.lakes.some((lake) => lake.salinity!.dissolvedSalt > 0));
  near(
    budget.initialSalt + budget.weatheringSalt,
    budget.retainedSalt + budget.exportedSalt,
    1e-10,
  );
  assert.ok(drainage.riverSalinity!.every(Number.isFinite));
  assert.ok(drainage.soilSalinity!.every(Number.isFinite));
  assert.ok(
    drainage.soilSalinityFraction!.every(
      (value, cell) => value >= 0 && value <= Math.max(0, 1 - drainage.lakeCoverage[cell]) + 1e-7,
    ),
  );
  const initialMass = terrain.saltMass!.reduce((sum, value) => sum + value, 0);
  const age = terrain.saltAgeYears;
  solveSalinity(grid, terrain, water, drainage, { ...flatLakeConfig, salinityYears: 1000 });
  near(
    terrain.saltMass!.reduce((sum, value) => sum + value, 0),
    initialMass,
    1e-10,
  );
  assert.equal(terrain.saltAgeYears, age);
  assert.equal(drainage.salinityBudget!.elapsedYears, 0);
  assert.equal(drainage.salinityBudget!.weatheringSalt, 0);
  assert.equal(drainage.salinityBudget!.exportedSalt, 0);
});

test('disappearing lakes and new ocean classification retain geographic salt at zero elapsed time', () => {
  const { grid, terrain, water, drainage } = cascade();
  terrain.saltMass = new Float64Array(grid.count);
  terrain.saltMass[0] = 120;
  terrain.saltMass[1] = 230;
  terrain.saltAgeYears = 90;
  terrain.ocean[0] = 1;
  drainage.lakes = [];
  drainage.lakeId.fill(-1);
  drainage.lakeFraction.fill(0);
  solveSalinity(grid, terrain, water, drainage, flatLakeConfig, { advanceYears: 0 });
  assert.equal(terrain.saltMass[0], 120);
  assert.equal(terrain.saltMass[1], 230);
  assert.equal(terrain.saltAgeYears, 90);
  assert.equal(drainage.soilSalinityFraction![0], 0);
  assert.equal(drainage.soilSalinityFraction![1], 1);
  near(drainage.salinityBudget!.retainedSalt, 350);
  near(drainage.salinityBudget!.residual, 0);
});

test('adjacent reservoirs sharing coarse cells do not exchange salt during repeated zero-time solves', () => {
  const { grid, terrain, water, drainage } = cascade();
  solveSalinity(grid, terrain, water, drainage, {
    ...flatLakeConfig,
    salinityYears: 1,
    inheritedMarineSalinity: 10,
    weatheringSalinity: 0,
  });
  const before = drainage.lakes.map((lake) => lake.salinity!.concentration);
  const parcels = terrain.saltParcels!;
  const positions = new Float64Array(parcels.positions);
  const masses = new Float64Array(parcels.masses);
  for (let pass = 0; pass < 10; pass++) {
    solveSalinity(grid, terrain, water, drainage, flatLakeConfig, { advanceYears: 0 });
    for (const lake of drainage.lakes) {
      near(lake.salinity!.concentration, before[lake.id]);
    }
    assert.equal(terrain.saltParcels, parcels);
  }
  assert.deepEqual(parcels.positions, positions);
  assert.deepEqual(parcels.masses, masses);
});

test('reservoir split and merge partition original geographic parcels without duplicating mass', () => {
  const { grid, terrain, water, drainage } = cascade();
  terrain.saltParcels = {
    positions: new Float64Array(grid.corners.subarray(0, 6)),
    masses: Float64Array.of(100, 300),
  };
  terrain.saltAgeYears = 80;
  const parcels = terrain.saltParcels;
  drainage.lakes = [fakeLake(0, -1, 0)];
  drainage.lakeId[1] = 0;
  solveSalinity(grid, terrain, water, drainage, flatLakeConfig, { advanceYears: 0 });
  near(drainage.lakes[0].salinity!.dissolvedSalt, 400);
  drainage.lakes = [fakeLake(0, -1, 0), fakeLake(1, -1, 0)];
  drainage.lakeId[1] = 1;
  solveSalinity(grid, terrain, water, drainage, flatLakeConfig, { advanceYears: 0 });
  near(drainage.lakes[0].salinity!.dissolvedSalt, 100);
  near(drainage.lakes[1].salinity!.dissolvedSalt, 300);
  drainage.lakes = [fakeLake(0, -1, 0)];
  drainage.lakeId[1] = 0;
  solveSalinity(grid, terrain, water, drainage, flatLakeConfig, { advanceYears: 0 });
  near(drainage.lakes[0].salinity!.dissolvedSalt, 400);
  assert.equal(terrain.saltParcels, parcels);
  assert.equal(terrain.saltAgeYears, 80);
  near(drainage.salinityBudget!.retainedSalt, 400);
});
