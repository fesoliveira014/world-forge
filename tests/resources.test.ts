import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Color,
  LineSegments,
  OrthographicCamera,
  PerspectiveCamera,
  Texture,
  Vector3,
} from 'three';
import { generateWorld, collectWorldBuffers } from '../src/core/pipeline';
import { DEFAULT_CONFIG, type Deposit } from '../src/core/model';
import { RESOURCE_PRESETS } from '../src/core/resource-presets';
import { generateDeposits } from '../src/core/generation/resources';
import { buildFertility, evaluateFertilityCell } from '../src/core/generation/fertility';
import { createTerrain } from '../src/core/generation/terrain';
import { buildGeology } from '../src/core/generation/geology';
import { ResourceMarkers } from '../src/render/ResourceMarkers';
import { sampleCellColor } from '../src/render/palette';
import { BANK_LAYERS } from '../src/render/RiverbankTexture';
import { readWorldProject, worldProject } from '../src/core/project';
import {
  CartographicSymbols,
  selectMapSymbols,
  createInkMask,
} from '../src/render/CartographicSymbols';
import { WaterSurface } from '../src/render/WaterSurface';
import { isLakeCell } from '../src/render/SurfaceHabitats';
import { mapPoint, spherePoint } from '../src/render/projection';

const config = { ...DEFAULT_CONFIG, seed: 'AETHER-0004', processLevel: 3, surfaceLevel: 3 };
const world = generateWorld(config);

test('ink symbols keep stable land locations, wrap at the map edges, and respond to seasons', () => {
  const mask = createInkMask([45, 40, 32, 255, 170, 170, 170, 255, 240, 235, 208, 255]);
  assert.equal(mask[0], 255);
  assert.equal(mask[4], 0);
  assert.equal(mask[5], 0);
  assert.equal(mask[8], 0);
  assert.ok(mask[9] > 240);
  const terrain = world.terrain.height.slice();
  const symbols = selectMapSymbols(world);
  assert.ok(symbols.length > 0 && symbols.length <= 12000);
  assert.deepEqual(selectMapSymbols(world), symbols);
  for (const symbol of symbols) {
    assert.equal(world.terrain.ocean[symbol.cell], 0);
    assert.equal(isLakeCell(world, symbol.cell), false);
  }
  const seasonalWorld = {
    ...world,
    water: {
      ...world.water,
      seasonalTemperature: world.water.seasonalTemperature.map((field, season) =>
        Float32Array.from(field, () => (season === 0 ? 20 : -15)),
      ),
    },
  };
  const atlas = new Texture();
  const globe = new CartographicSymbols(seasonalWorld, 26, 0, 'globe', atlas);
  const map = new CartographicSymbols(seasonalWorld, 26, 0, 'map', atlas);
  const autumn = new CartographicSymbols(seasonalWorld, 26, 2, 'map', atlas);
  assert.equal(map.geometry.instanceCount, 3 * globe.geometry.instanceCount);
  assert.deepEqual(
    map.geometry.getAttribute('anchor').array,
    autumn.geometry.getAttribute('anchor').array,
  );
  assert.notDeepEqual(
    map.geometry.getAttribute('paperTint').array,
    autumn.geometry.getAttribute('paperTint').array,
  );
  assert.deepEqual(world.terrain.height, terrain);
  for (const mesh of [globe, map, autumn]) {
    assert.ok(mesh.geometry.getAttribute('anchor').array.every(Number.isFinite));
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
  atlas.dispose();
});

test('raised-map waterways use the same planar height interpolation as the terrain', () => {
  const height = new Float32Array(world.grid.count).fill(2000);
  const sample = {
    ...world,
    terrain: { ...world.terrain, height },
    drainage: { ...world.drainage, lakeDepth: new Float32Array(world.grid.count) },
  };
  const cells = Array.from(world.grid.triangles.slice(0, 3));
  const points = cells.map((cell) => new Vector3().fromArray(world.grid.positions, cell * 3));
  const coordinates = points.map((point) => mapPoint(point.x, point.y, point.z));
  const anchor = coordinates[0][0];
  for (const coordinate of coordinates) {
    coordinate[0] += Math.round((anchor - coordinate[0]) / (2 * Math.PI)) * 2 * Math.PI;
  }
  height[cells[0]] = 1000;
  height[cells[1]] = 2500;
  height[cells[2]] = 4000;
  const point = spherePoint(
    coordinates.reduce((sum, value) => sum + value[0], 0) / 3,
    coordinates.reduce((sum, value) => sum + value[1], 0) / 3,
    new Vector3(),
  );
  new WaterSurface(sample, 26, false, true, true).place(point, 0.000075);
  assert.ok(Math.abs(point.length() - (1 + (2500 * 26) / world.config.radius + 0.000075)) < 1e-7);
});

test('primary deposits survive surface refinement, palette extension and quantity changes', () => {
  const refined = generateWorld({ ...config, surfaceLevel: 4 });
  assert.ok(world.resources.deposits.length > 0);
  assert.deepEqual(refined.resources.deposits, world.resources.deposits);
  const doubled = generateWorld({ ...config, depositAmount: 2 });
  assert.deepEqual(
    doubled.resources.deposits.map(({ amount, ...deposit }) => deposit),
    world.resources.deposits.map(({ amount, ...deposit }) => deposit),
  );
  for (let index = 0; index < doubled.resources.deposits.length; index++) {
    assert.ok(
      Math.abs(
        doubled.resources.deposits[index].amount - 2 * world.resources.deposits[index].amount,
      ) <= 1,
    );
  }
  const identity = Uint32Array.from({ length: world.process.count }, (_, cell) => cell);
  const referenceOceanMask = createTerrain(
    world.process,
    world.process,
    identity,
    world.geology,
    config,
  ).ocean;
  const environment = {
    process: world.process,
    geology: world.geology,
    referenceOceanMask,
    seed: config.seed,
    radius: config.radius,
  };
  const metals = generateDeposits(
    environment,
    config,
    RESOURCE_PRESETS.filter((preset) => preset.type !== 'corundum'),
  );
  assert.deepEqual(
    metals,
    world.resources.deposits.filter((deposit) => deposit.resourceType !== 'corundum'),
  );
  assert.deepEqual(generateDeposits(environment, { ...config, depositFrequency: 0 }), []);
  assert.equal(
    new Set(world.resources.deposits.map((deposit) => deposit.id)).size,
    world.resources.deposits.length,
  );
  for (const deposit of world.resources.deposits) {
    assert.ok(Number.isFinite(deposit.amount) && deposit.amount > 0);
    assert.ok(deposit.extentKm > 0 && Math.abs(Math.hypot(...deposit.anchor) - 1) < 1e-12);
  }
  const initialConfig = { ...config, tectonicDuration: 0 };
  const initialGeology = buildGeology(world.process, initialConfig);
  const initialOcean = createTerrain(
    world.process,
    world.process,
    identity,
    initialGeology,
    initialConfig,
  ).ocean;
  const initialEnvironment = {
    ...environment,
    geology: initialGeology,
    referenceOceanMask: initialOcean,
  };
  assert.equal(initialGeology.crust, undefined);
  const initial = generateDeposits(initialEnvironment, config);
  assert.ok(initial.length > 0);
  assert.deepEqual(generateDeposits(initialEnvironment, config), initial);
});

test('fertility preserves local dryland corridors and distinguishes water, ice and fresh volcanic cover', () => {
  const sample = structuredClone(world);
  sample.terrain.ocean.fill(0);
  sample.terrain.height.fill(100);
  sample.terrain.sediment.fill(0);
  sample.drainage.lakeDepth.fill(0);
  sample.drainage.lakeCoverage.fill(0);
  sample.drainage.height.fill(100);
  sample.water.rain.fill(50);
  sample.water.pet.fill(1000);
  sample.water.saturatedSeasons.fill(0);
  for (const season of sample.water.seasonalTemperature) {
    season.fill(20);
  }
  sample.ecology.biome.fill(6);
  sample.ecology.riparianFraction.fill(0);
  sample.ecology.floodplainFraction.fill(0);
  sample.ecology.wetlandFraction.fill(0);
  sample.geology.crust!.volcanic.fill(0);
  sample.rivers.channel.fill(0);
  const cell = sample.grid.edgeCells[0];
  const corner = sample.grid.edgeCorners[0];
  const receiver = sample.grid.edgeCorners[1];
  sample.rivers.channel[corner] = 1;
  sample.rivers.supportFlow[corner] = 100;
  sample.drainage.receiver[corner] = receiver;
  sample.ecology.floodplains.corner = new Uint32Array([corner]);
  sample.ecology.floodplains.width = new Float32Array([1000, 1000]);
  sample.terrain.sediment[cell] = 50;
  const dry = evaluateFertilityCell(sample, cell);
  sample.ecology.riparianFraction[cell] = 0.1;
  const corridor = evaluateFertilityCell(sample, cell);
  assert.ok(corridor.corridorScore > 65);
  assert.ok(corridor.score > dry.score && corridor.score < 15);
  assert.ok(
    Math.abs(
      corridor.score -
        ((1 - corridor.corridorFraction) * corridor.regionalScore +
          corridor.corridorFraction * corridor.meanCorridorScore),
    ) < 1e-10,
  );

  const before = collectWorldBuffers({
    terrain: sample.terrain,
    water: sample.water,
    ecology: sample.ecology,
  }).map((buffer) => new Uint8Array(buffer).slice());
  const fertility = buildFertility(sample);
  collectWorldBuffers({
    terrain: sample.terrain,
    water: sample.water,
    ecology: sample.ecology,
  }).forEach((buffer, index) => assert.deepEqual(new Uint8Array(buffer), before[index]));
  assert.ok(fertility.every((score) => Number.isFinite(score) && score >= 0 && score <= 100));
  sample.resources.fertility = fertility;
  const color = sampleCellColor(sample, cell, 'fertility', -1, new Color()).getHex();
  sample.terrain.deltaSediment[cell] = 100;
  sample.ecology.vegetation[cell] = 1;
  assert.equal(sampleCellColor(sample, cell, 'fertility', 2, new Color()).getHex(), color);
  assert.ok(!BANK_LAYERS.includes('fertility'));

  sample.drainage.lakeCoverage[cell] = 0.8;
  const shore = evaluateFertilityCell(sample, cell);
  assert.ok(
    shore.score > 0 && shore.score <= 20,
    'exposed shore keeps an area-weighted land potential',
  );
  assert.ok(Math.abs(shore.landFraction - 0.2) < 1e-6);
  sample.drainage.lakeCoverage[cell] = 1;
  assert.equal(evaluateFertilityCell(sample, cell).score, 0);
  sample.drainage.lakeCoverage[cell] = 0;
  sample.ecology.biome[cell] = 1;
  assert.equal(evaluateFertilityCell(sample, cell).score, 0);
  sample.ecology.biome[cell] = 6;
  sample.ecology.riparianFraction[cell] = 0;
  sample.terrain.sediment[cell] = 0;
  sample.water.rain[cell] = 1000;
  const processCell = sample.transfer[cell];
  sample.geology.crust!.volcanic[processCell] = 3000;
  sample.geology.crust!.volcanicAge[processCell] = 0;
  const fresh = evaluateFertilityCell(sample, cell);
  sample.geology.crust!.volcanicAge[processCell] = 10;
  const established = evaluateFertilityCell(sample, cell);
  assert.ok(established.score > fresh.score && fresh.score < 35);
  assert.equal(fresh.volcanic, 0);
});

test('deposit picking respects the globe horizon and both sides of the map seam', () => {
  const front: Deposit = {
    id: 'front',
    resourceType: 'copper',
    anchor: [1, 0, 0],
    amount: 10000,
    extentKm: 10,
    formationCause: 'magmatic-hydrothermal',
  };
  const back: Deposit = { ...front, id: 'back', anchor: [-1, 0, 0] };
  const sample = { ...world, resources: { ...world.resources, deposits: [back, front] } };
  const globe = new ResourceMarkers(sample, 'all', 'globe', 10, 'front');
  const camera = new PerspectiveCamera(38, 2, 0.01, 100);
  camera.position.set(3, 0, 0);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  assert.equal(globe.pick(camera, 400, 200, 800, 400), 'front');
  const hidden = new ResourceMarkers(
    { ...sample, resources: { ...sample.resources, deposits: [back] } },
    'all',
    'globe',
    10,
    null,
  );
  assert.equal(hidden.pick(camera, 400, 200, 800, 400), null);

  const longitude = Math.PI - 0.001;
  const seam = {
    ...front,
    id: 'seam',
    anchor: [Math.cos(longitude), 0, Math.sin(longitude)] as [number, number, number],
  };
  sample.resources = { ...sample.resources, deposits: [seam] };
  const map = new ResourceMarkers(sample, 'all', 'map', 10, 'seam');
  const mapCamera = new OrthographicCamera(-Math.PI, Math.PI, Math.PI / 2, -Math.PI / 2, 0.01, 100);
  mapCamera.position.set(0, 0, 6);
  mapCamera.lookAt(0, 0, 0);
  mapCamera.updateProjectionMatrix();
  assert.equal(map.pick(mapCamera, 799, 200, 800, 400), 'seam');
  assert.equal(map.pick(mapCamera, 1, 200, 800, 400), 'seam');
  assert.equal(map.pick(mapCamera, -10, 200, 800, 400), null);
  for (const group of [globe, hidden, map]) {
    group.traverse((object) => {
      if ('geometry' in object) {
        const geometry = (object as LineSegments).geometry;
        assert.ok([...geometry.getAttribute('position').array].every(Number.isFinite));
        if (object instanceof LineSegments && group === map) {
          const positions = geometry.getAttribute('position');
          for (let vertex = 0; vertex < positions.count; vertex += 2) {
            assert.ok(Math.abs(positions.getX(vertex) - positions.getX(vertex + 1)) <= Math.PI);
          }
        }
        geometry.dispose();
        const material = (object as LineSegments).material;
        for (const item of Array.isArray(material) ? material : [material]) {
          item.dispose();
        }
      }
    });
  }
});

test('2.9.0 projects receive resource defaults and recipe metadata survives export', () => {
  const { depositFrequency, depositAmount, ...legacyConfig } = config;
  const legacy = readWorldProject({ version: '2.9.0', config: legacyConfig });
  assert.equal(legacy.config.depositFrequency, depositFrequency);
  assert.equal(legacy.config.depositAmount, depositAmount);
  assert.equal(legacy.resourceRecipeChanged, false);
  const exported = worldProject(world);
  assert.equal(exported.resourceRecipe, world.resources.recipe);
  assert.deepEqual(readWorldProject(JSON.parse(JSON.stringify(exported))).config, world.config);
  assert.equal(
    readWorldProject({ ...exported, resourceRecipe: 'older-rules' }).resourceRecipeChanged,
    true,
  );
});
