import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGrid } from '../src/core/grid/build';
import { DEFAULT_CONFIG, type Lake, type World } from '../src/core/model';
import { classifyEcology } from '../src/core/generation/ecology';
import { evaluateFertilityCell } from '../src/core/generation/fertility';
import { applySalineRiverExposure } from '../src/core/generation/floodplains';
import {
  lakeFreshwaterSuitability,
  lakeWaterDescription,
  soilSalinityLimit,
} from '../src/core/generation/lake-state';

function environment(): World {
  const grid = buildGrid(1, 'local-salinity', 0.3);
  const count = grid.count;
  const corners = grid.corners.length / 3;
  const field = (value = 0) => new Float32Array(count).fill(value);
  const world = {
    grid,
    config: { ...DEFAULT_CONFIG, radius: 10000 },
    transfer: new Uint32Array(count),
    geology: {},
    terrain: {
      ocean: new Uint8Array(count),
      height: field(100),
      sediment: field(50),
      deltaSediment: field(),
    },
    water: {
      rain: field(400),
      temperature: field(20),
      pet: field(800),
      aet: field(320),
      aridity: field(2),
      soil: field(20),
      snow: field(),
      runoff: field(100),
      baseflowRunoff: field(5),
      saturatedSeasons: new Uint8Array(count),
      seasonalRain: Array.from({ length: 4 }, () => field(100)),
      seasonalTemperature: Array.from({ length: 4 }, () => field(20)),
    },
    drainage: {
      receiver: new Int32Array(corners).fill(-1),
      height: new Float32Array(corners).fill(100),
      discharge: new Float64Array(corners),
      lakeId: new Int32Array(corners).fill(-1),
      lakeFraction: new Float32Array(corners),
      lakeCoverage: field(),
      lakeDepth: field(),
      lakes: [],
    },
    rivers: {
      channel: new Uint8Array(corners),
      headwater: new Uint8Array(corners),
      source: new Uint8Array(corners),
      supportFlow: new Float32Array(corners),
      seasonalDischarge: Array.from({ length: 4 }, () => new Float64Array(corners)),
      courses: { corner: new Uint32Array(), sinuosity: new Float32Array() },
      deltas: [],
    },
  } as unknown as World;
  world.ecology = ecology(world);
  return world;
}

function ecology(world: World) {
  return classifyEcology(
    world.grid,
    world.terrain,
    world.water,
    world.drainage,
    world.rivers,
    world.config,
  );
}

function saltGround(world: World, concentration: number, fraction: number) {
  world.drainage.soilSalinity = new Float32Array(world.grid.count).fill(concentration);
  world.drainage.soilSalinityFraction = new Float32Array(world.grid.count).fill(fraction);
}

function channel(world: World): number {
  const corner = world.grid.edgeCorners[0];
  world.drainage.receiver[corner] = world.grid.edgeCorners[1];
  world.drainage.discharge[corner] = 100;
  world.rivers.channel[corner] = 1;
  world.rivers.supportFlow[corner] = 100;
  for (const season of world.rivers.seasonalDischarge) {
    season[corner] = 100;
  }
  world.drainage.riverSalinity = new Float32Array(world.drainage.receiver.length);
  return corner;
}

test('lake chemistry distinguishes fresh closed lakes, salty throughflow and dry salt beds', () => {
  const lake = { area: 100, outflow: 0, evaporation: 1 } as Lake;
  const legacy = lakeFreshwaterSuitability(lake);
  lake.salinity = {
    dissolvedSalt: 10,
    bedSalt: 0,
    concentration: 0.1,
    inflowSalt: 0,
    outflowSalt: 0,
    elapsedYears: 100,
  };
  assert.equal(lakeFreshwaterSuitability(lake), 1);
  assert.ok(legacy < 1, 'unmodeled closed lakes retain their historical uncertainty');
  assert.match(lakeWaterDescription(lake), /^Freshwater/);
  lake.outflow = 100;
  lake.salinity.concentration = 35;
  assert.ok(lakeFreshwaterSuitability(lake) < 0.001, 'throughflow does not guarantee fresh water');
  assert.match(lakeWaterDescription(lake), /^Saline/);
  lake.area = 0;
  lake.salinity.bedSalt = 10;
  assert.equal(lakeFreshwaterSuitability(lake), 0);
  assert.match(lakeWaterDescription(lake), /Dry basin.*salt deposits/);
});

test('soil salinity lowers local vegetation and fertility without changing the climate biome', () => {
  const world = environment();
  const baseline = world.ecology;
  const fertility = evaluateFertilityCell(world, 0);
  const rain = world.water.rain.slice();
  const aridity = world.water.aridity.slice();
  saltGround(world, 35, 0.25);
  world.ecology = ecology(world);
  const saline = evaluateFertilityCell(world, 0);
  assert.deepEqual(world.ecology.biome, baseline.biome);
  assert.deepEqual(world.water.rain, rain);
  assert.deepEqual(world.water.aridity, aridity);
  assert.ok(world.ecology.vegetation[0] < baseline.vegetation[0]);
  assert.ok(world.ecology.vegetation[0] >= baseline.vegetation[0] * 0.75);
  assert.ok(saline.score < fertility.score && saline.score >= fertility.score * 0.75);
  assert.ok(Math.abs(saline.score / fertility.score - saline.salinityLimit) < 1e-10);
  assert.equal(saline.salineFraction, 0.25);
  assert.ok(saline.limitations.includes('Saline soil'));
  assert.equal(
    saline.freshwater,
    fertility.freshwater,
    'soil penalty is separate from water utility',
  );
  assert.equal(soilSalinityLimit(35, 0, 1), 1);
  assert.equal(soilSalinityLimit(0, 1, 1), 1);
  assert.equal(soilSalinityLimit(35, 1, 0), 1);
  assert.equal(soilSalinityLimit(35, 0.5, 0.5), soilSalinityLimit(35, 1, 1));
});

test('incoming fresh rivers remain green beside saline ground; salty releases lose freshwater benefit', () => {
  const world = environment();
  const corner = channel(world);
  saltGround(world, 35, 0.8);
  world.ecology = ecology(world);
  const fresh = world.ecology;
  const cell = world.grid.edgeCells[0];
  const freshFertility = evaluateFertilityCell(world, cell);
  world.drainage.riverSalinity![corner] = 35;
  world.ecology = ecology(world);
  const saltyFertility = evaluateFertilityCell(world, cell);
  assert.ok(fresh.riverbankVegetation[corner] > 0.95);
  assert.ok(world.ecology.riverbankVegetation[corner] < 0.3);
  assert.ok(fresh.vegetation[cell] > world.ecology.vegetation[cell]);
  assert.deepEqual(fresh.biome, world.ecology.biome);
  assert.ok(freshFertility.freshwater > 0.99);
  assert.ok(saltyFertility.freshwater < 0.001);
  assert.ok(freshFertility.score > saltyFertility.score);
  assert.equal(freshFertility.regionalScore, saltyFertility.regionalScore);
});

test('fresh-fed deltas retain their local habitat benefit while saline releases cannot create it', () => {
  const world = environment();
  const corner = channel(world);
  world.rivers.channel.fill(0);
  world.rivers.deltas = [{ corner }] as typeof world.rivers.deltas;
  world.terrain.deltaSediment.fill(10);
  saltGround(world, 35, 0.8);
  const fresh = ecology(world);
  world.drainage.riverSalinity![corner] = 35;
  const saline = ecology(world);
  const cell = world.grid.triangles[corner * 3];
  assert.ok(fresh.wetlandFraction[cell] > saline.wetlandFraction[cell]);
  assert.ok(fresh.vegetation[cell] > saline.vegetation[cell]);
  assert.deepEqual(fresh.biome, saline.biome);
});

test('saline river contact affects its physical bank footprint without salting an entire catchment', () => {
  const world = environment();
  const corner = channel(world);
  const cell = world.grid.edgeCells[0];
  saltGround(world, 0, 0);
  const fresh = evaluateFertilityCell(world, cell);
  world.drainage.riverSalinity![corner] = 35;
  for (const season of world.rivers.seasonalDischarge) {
    season[corner] = 1000;
  }
  const discharge = world.drainage.discharge.slice();
  applySalineRiverExposure(world.grid, world.terrain, world.drainage, world.rivers, world.config);
  world.ecology = ecology(world);
  const salty = evaluateFertilityCell(world, cell);
  assert.equal(world.drainage.soilSalinity![cell], 35);
  assert.ok(salty.salineFraction > 0 && salty.salineFraction < 0.5);
  assert.ok(
    salty.score < fresh.score,
    'soil loses fertility independently of a missing river bonus',
  );
  assert.equal(
    [...world.drainage.soilSalinityFraction!].filter((fraction) => fraction > 0).length,
    2,
    'only the two banks of the saline reach have contact',
  );
  assert.deepEqual(world.drainage.discharge, discharge);
  assert.equal(world.terrain.saltMass, undefined, 'contact proxy does not manufacture stored salt');
  const contact = world.drainage.soilSalinityFraction!.slice();
  const chemistry = world.drainage.soilSalinity!.slice();
  const repeat = ecology(world);
  assert.deepEqual(repeat.vegetation, world.ecology.vegetation);
  assert.deepEqual(world.drainage.soilSalinityFraction, contact);
  assert.deepEqual(world.drainage.soilSalinity, chemistry);
});
