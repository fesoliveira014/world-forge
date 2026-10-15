import test from 'node:test';
import assert from 'node:assert/strict';
import { BufferGeometry, Mesh, Vector3 } from 'three';
import { generateWorld } from '../src/core/pipeline';
import {
  DEFAULT_CONFIG,
  YEAR,
  type Grid,
  type Terrain,
  type LandWater,
  type Drainage,
  type Rivers,
  type World,
  type Climate,
  SEASON,
} from '../src/core/model';
import { resolveLakeSurfaces } from '../src/core/generation/lake-surfaces';
import { balanceLake } from '../src/core/generation/reservoir';
import { prolongRainfall } from '../src/core/operators/prolongation';
import { buildTransfer } from '../src/core/operators/spatial';
import { solveLandWater } from '../src/core/generation/land-water';
import { lakeFreshwaterSuitability } from '../src/core/generation/lake-state';
import { resolveNestedLakes } from '../src/core/generation/nested-lakes';
import {
  computeDiffusionConductance,
  computeStableTimeStep,
  transportInventory,
  prepareTransport,
} from '../src/core/operators/transport';
import { selectRivers, flowRegime } from '../src/core/generation/rivers';
import { erodeRiverLandscape } from '../src/core/generation/erosion';
import { routeWater } from '../src/core/generation/drainage';
import { evolveBend } from '../src/core/generation/river-courses';
import { createRiverStrips } from '../src/render/RiverStrips';
import { RiverRibbon } from '../src/render/RiverRibbon';
import { RiverGeometry } from '../src/render/RiverGeometry';
import { WaterSurface } from '../src/render/WaterSurface';
import { createRiverbankTexture } from '../src/render/RiverbankTexture';
import { createOxbowSurfaces } from '../src/render/OxbowSurfaces';
import { classifyEcology } from '../src/core/generation/ecology';
import { floodplainWidths } from '../src/core/generation/floodplains';
import { shapeContinentalBasins } from '../src/core/generation/continental-basins';
import { updateNaturalSurface } from '../src/render/NaturalSurface';
import { getDeltaCells, isLakeCell } from '../src/render/SurfaceHabitats';
import { buildGrid } from '../src/core/grid/build';
import { buildGeology } from '../src/core/generation/geology';
import { createTerrain } from '../src/core/generation/terrain';
import { createHotspots, volcanicRates, emplaceVolcanics } from '../src/core/generation/volcanism';
import { depositInBasins } from '../src/core/generation/sediment';
import { weatherLandscape } from '../src/core/generation/landscape';
import { erodeOutlets } from '../src/core/generation/outlet-erosion';
import { floodCorners } from '../src/core/generation/drainage-topology';
import {
  evolveCrust,
  referencePoint,
  rotationMatrix,
} from '../src/core/generation/crust-evolution';

test('finite plate motion changes geography, creates young ocean, and retains its initial reference', () => {
  const matrix = new Float64Array(9);
  rotationMatrix(matrix, 0, [0, 1, 0], Math.PI / 2);
  const rotated = referencePoint(matrix, 0, 1, 0, 0);
  assert.ok(Math.abs(rotated[0]) < 1e-12 && Math.abs(rotated[2] + 1) < 1e-12);
  const config = { ...DEFAULT_CONFIG, surfaceLevel: 3, processLevel: 3 };
  const grid = buildGrid(3, config.seed, config.irregularity);
  const geology = buildGeology(grid, config);
  const initial = new Uint16Array(geology.plate);
  evolveCrust(grid, geology, config);
  const crust = geology.crust!;
  assert.deepEqual(crust.initialPlate, initial);
  assert.ok(
    geology.plate.some((p, i) => p !== initial[i]),
    'ownership moves rather than only changing display transforms',
  );
  assert.ok(
    crust.base.filter((h, i) => h > 0 !== crust.initialBase[i] > 0).length > grid.count * 0.02,
  );
  assert.ok(
    crust.material.some(
      (m, i) => !m && geology.age[i] < config.tectonicDuration && crust.base[i] < 0,
    ),
  );
  assert.ok(crust.base.every(Number.isFinite));
  const zero = buildGeology(grid, config);
  evolveCrust(grid, zero, { ...config, tectonicDuration: 0 });
  assert.equal(zero.crust, undefined);
  assert.deepEqual(zero.plate, initial);
});

test('shared-edge transport preserves inventory on unequal-area cells', () => {
  const grid = {
    count: 2,
    areas: new Float64Array([2, 5]),
    edgeCells: new Uint32Array([0, 1]),
    edgeLength: new Float64Array([1]),
  } as Grid;
  const inventory = new Float64Array([6, 5]);
  const delta = new Float64Array(2);
  const flux = new Float64Array([0.5]);
  const dt = computeStableTimeStep(grid, flux, 1, 1);
  transportInventory(prepareTransport(grid, flux, 1), inventory, delta, dt);
  assert.equal(inventory[0], 4.5);
  assert.equal(inventory[1], 6.5);
  assert.equal(inventory[0] + inventory[1], 11);
});

test('prepared transport combines reverse flow and mixing on physical cell areas', () => {
  const grid = {
    count: 2,
    areas: new Float64Array([2, 5]),
    edgeCells: new Uint32Array([0, 1]),
  } as Grid;
  const flux = new Float64Array([-0.5]);
  const mixing = new Float64Array([0.2]);
  const transport = prepareTransport(grid, flux, 2, mixing);
  const inventory = new Float64Array([24, 20]);
  const delta = new Float64Array(2);
  // At radius 2 the depths are 3 and 1. Over a quarter second,
  // advection sends 0.125 left and diffusion sends 0.1 right.
  transportInventory(transport, inventory, delta, 0.25);
  assert.ok(Math.abs(inventory[0] - 24.025) < 1e-12);
  assert.ok(Math.abs(inventory[1] - 19.975) < 1e-12);

  const timeStep = computeStableTimeStep(grid, flux, 2, 100, mixing);
  for (let stepIndex = 0; stepIndex < 20; stepIndex++) {
    transportInventory(transport, inventory, delta, timeStep);
  }
  assert.ok(inventory.every((value) => value >= 0));
  assert.ok(Math.abs(inventory[0] + inventory[1] - 44) < 1e-12);

  // Ocean heat inventories may be negative; the same operator must stay linear.
  const heat = new Float64Array([-24, -20]);
  transportInventory(transport, heat, delta, 0.25);
  assert.ok(Math.abs(heat[0] + 24.025) < 1e-12);
  assert.ok(Math.abs(heat[1] + 19.975) < 1e-12);
});

test('hotspots construct islands from the seabed and retain a seed-stable eruption schedule', () => {
  const config = {
    ...DEFAULT_CONFIG,
    processLevel: 3,
    surfaceLevel: 3,
    plateSpeed: 0,
    volcanicActivity: 0,
  };
  assert.deepEqual(createHotspots(config), createHotspots({ ...config, tectonicDuration: 80 }));
  const grid = buildGrid(3, config.seed, config.irregularity);
  const geology = buildGeology(grid, config);
  evolveCrust(grid, geology, config);
  const crust = geology.crust!;
  crust.base.fill(-8000);
  crust.material.fill(0);
  geology.uplift.fill(0);
  const hotspot = {
    position: [...grid.positions.subarray(0, 3)] as [number, number, number],
    start: 0,
    end: 50,
    radius: 120000,
    rate: 400,
  };
  const owners = new Uint16Array(grid.count);
  const faults = new Float32Array(grid.count);
  const activeConfig = { ...config, volcanicActivity: 1 };
  const active = volcanicRates(grid, owners, faults, [hotspot], 20, activeConfig);
  assert.ok(active[0] > 300, 'a source operates inside a plate without a boundary');
  assert.ok(volcanicRates(grid, owners, faults, [hotspot], 60, activeConfig).every((v) => v === 0));
  const map = Uint32Array.from({ length: grid.count }, (_, i) => i);
  crust.volcanic[0] = emplaceVolcanics(0, active[0], 5);
  const submarine = createTerrain(grid, grid, map, geology, config);
  assert.ok(submarine.height[0] < 0, 'insufficient construction remains a seamount');
  crust.volcanic[0] = emplaceVolcanics(0, active[0], 35);
  const emerged = createTerrain(grid, grid, map, geology, config);
  assert.ok(emerged.height[0] > 0);
  assert.ok(
    emerged.height[0] < crust.volcanic[0] - 4000,
    'island elevation subtracts the ocean depth rather than exposing the whole edifice',
  );
});

test('sediment fills a downstream depression and exports only the unused material', () => {
  const height = new Float32Array([-100, 4, 10, 2, 5, 14]);
  const offsets = [0];
  const neighbors: number[] = [];

  for (let i = 0; i < height.length; i++) {
    if (i > 0) {
      neighbors.push(i - 1);
    }

    if (i + 1 < height.length) {
      neighbors.push(i + 1);
    }

    offsets.push(neighbors.length);
  }

  const grid = {
    count: height.length,
    offsets: new Uint32Array(offsets),
    neighbors: new Uint32Array(neighbors),
    areas: new Float64Array(height.length).fill(1),
  } as Grid;
  const terrain = {
    height,
    bedrock: new Float32Array(height),
    sediment: new Float32Array(height.length),
    ocean: new Uint8Array([1, 0, 0, 0, 0, 0]),
  } as Terrain;
  const supply = new Float64Array([0, 0, 0, 0, 0, 100]);
  const exported = depositInBasins(grid, terrain, supply, { ...DEFAULT_CONFIG, radius: 1 });
  assert.equal(height[3], 10);
  assert.equal(height[4], 10);
  assert.equal(height[2], 10, 'the sill stays in place');
  assert.equal(height[0], -100, 'ocean bathymetry stays in place');
  assert.equal(exported + terrain.sediment.reduce((a, b) => a + b, 0), 100);
});

test('waves retreat an intraplate coast even without rivers or plate boundaries', () => {
  const config = {
    ...DEFAULT_CONFIG,
    surfaceLevel: 4,
    processLevel: 4,
    erosion: 1,
    tectonicDuration: 200,
    windErosion: 0,
    waveErosion: 2,
  };
  const grid = buildGrid(4, config.seed, config.irregularity);
  const geology = buildGeology(grid, config);
  geology.uplift.fill(0);
  geology.plate.fill(0);
  const height = Float32Array.from({ length: grid.count }, (_, i) =>
    grid.positions[i * 3] > 0 ? 1 : -3000,
  );
  const terrain = {
    height,
    bedrock: new Float32Array(height),
    sediment: new Float32Array(grid.count),
    ocean: Uint8Array.from(height, (h) => +(h < 0)),
  } as Terrain;
  const originalOcean = new Uint8Array(terrain.ocean);
  const climate = { rain: [], pet: [], wind: [], temperature: [] } as unknown as Climate;

  for (let s = 0; s < 4; s++) {
    climate.rain.push(new Float32Array(grid.count));
    climate.pet.push(new Float32Array(grid.count).fill(250));
    climate.temperature.push(new Float32Array(grid.count).fill(20));
    climate.wind.push(new Float32Array(grid.count * 3));
  }

  weatherLandscape(
    grid,
    grid,
    Uint32Array.from({ length: grid.count }, (_, i) => i),
    geology,
    terrain,
    climate,
    config,
  );
  assert.ok(
    terrain.ocean.some((o, i) => o && !originalOcean[i]),
    'waves change the real land mask',
  );
  assert.ok(terrain.height.every((h, i) => terrain.ocean[i] || h >= 0));
});

test('outlet incision creates a descending escape channel while resistant basins retain storage', () => {
  // Ocean -> sill -> lake floor -> upland. Triples isolate each corner's terrain sample.
  const grid = {
    count: 4,
    positions: Float64Array.from({ length: 12 }, (_, index) => +(index % 3 === 0)),
    corners: Float64Array.from({ length: 12 }, (_, index) => +(index % 3 === 0)),
    triangles: new Uint32Array([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3]),
    cornerNeighbors: new Uint32Array([0, 1, 0, 0, 2, 1, 1, 3, 2, 2, 3, 3]),
    cornerEdges: new Uint32Array(12),
    edgeLength: new Float64Array([100]),
    areas: new Float64Array(4).fill(1),
  } as Grid;

  const makeTerrain = () =>
    ({
      height: new Float32Array([-100, 10, 2, 20]),
      bedrock: new Float32Array([-100, 10, 2, 20]),
      sediment: new Float32Array(4),
      ocean: new Uint8Array([1, 0, 0, 0]),
    }) as Terrain;

  const strong = makeTerrain();
  const weak = makeTerrain();
  const config = { ...DEFAULT_CONFIG, radius: 1 };
  erodeOutlets(grid, strong, new Float32Array(4).fill(12), config);
  erodeOutlets(grid, weak, new Float32Array(4).fill(2), config);
  const drained = floodCorners(grid, strong);
  const retained = floodCorners(grid, weak);
  assert.equal(drained.filled[2], drained.height[2], 'the depression has a real escape');
  assert.ok(strong.height[2] > strong.height[1] && strong.height[1] > 0);
  assert.ok(retained.filled[2] > retained.height[2] + 5, 'limited erosion leaves a deeper basin');
  assert.equal(strong.height[0], -100);
  assert.equal(strong.height[3], 20);
});

test('physical mixing has comparable reach on coarse and fine meshes', () => {
  const amplitudes: number[] = [];

  for (const count of [16, 64]) {
    const length = 1000;
    const dx = length / count;
    const k = 1000;
    const horizon = 10;
    const grid = {
      count,
      areas: new Float64Array(count).fill(dx),
      edgeCells: Uint32Array.from({ length: count * 2 }, (_, i) =>
        i % 2 ? (Math.floor(i / 2) + 1) % count : i / 2,
      ),
      edgeLength: new Float64Array(count).fill(1),
      edgeDistance: new Float64Array(count).fill(dx),
    } as Grid;
    const inventory = Float64Array.from(
      { length: count },
      (_, i) => dx * (1 + 0.5 * Math.cos((i * Math.PI * 2) / count)),
    );
    const flux = new Float64Array(count);
    const delta = new Float64Array(count);
    const mixing = computeDiffusionConductance(grid, k);
    const dt = computeStableTimeStep(grid, flux, 1, horizon, mixing);
    const transport = prepareTransport(grid, flux, 1, mixing);

    for (let time = 0; time < horizon;) {
      const step = Math.min(dt, horizon - time);
      transportInventory(transport, inventory, delta, step);
      time += step;
    }

    assert.ok(inventory.every((v) => v >= 0));
    assert.ok(Math.abs(inventory.reduce((a, b) => a + b, 0) - length) < 1e-9);
    const amplitude =
      (inventory.reduce((v, q, i) => v + (q / dx) * Math.cos((i * Math.PI * 2) / count), 0) * 2) /
      count;
    amplitudes.push(amplitude);
    assert.ok(
      Math.abs(amplitude - 0.5 * Math.exp((-4 * Math.PI ** 2 * k * horizon) / length ** 2)) < 0.01,
    );
  }

  assert.ok(Math.abs(amplitudes[0] - amplitudes[1]) < 0.01);
});

test('one fixed world preserves geometry, water, and reservoir contracts', () => {
  const config = { ...DEFAULT_CONFIG, seed: 'AETHER-0003', surfaceLevel: 5, processLevel: 4 };
  const w = generateWorld(config);
  const d = w.drainage;
  assert.ok(Math.abs(w.grid.areas.reduce((a, b) => a + b, 0) - 4 * Math.PI) < 1e-6);
  assert.ok(w.climate.atmosphereResidual < 1e-9);
  assert.ok(w.climate.oceanDivergence < 1e-5);
  assert.ok(
    Math.abs(d.runoffTotal - d.oceanDischarge - d.lakeExchange) < 1e-7 * Math.max(1, d.runoffTotal),
  );
  assert.ok(
    Math.abs(d.lakes.reduce((sum, lake) => sum + lake.inflow - lake.outflow, 0) - d.lakeExchange) <
      1e-7 * Math.max(1, d.runoffTotal),
    'individual lake transfers agree with the global reservoir exchange',
  );
  const tributaries = new Uint16Array(d.receiver.length);

  for (let c = 0; c < d.receiver.length; c++) {
    if (w.rivers.channel[c] && d.discharge[c] >= 20) {
      tributaries[d.receiver[c]]++;
    }
  }

  assert.ok(
    tributaries.some((n) => n >= 2),
    'runoff produces visible confluences',
  );
  assert.ok(w.water.residual < 1e-6, 'land buckets conserve water');
  for (let season = 0; season < 4; season++) {
    const mappedArea = d.seasonalLakeCoverage![season].reduce(
      (sum, wet, cell) => sum + wet * w.grid.areas[cell] * w.config.radius ** 2,
      0,
    );
    const storedArea = d.lakes.reduce((sum, lake) => sum + lake.seasonal!.area[season], 0);
    assert.ok(
      Math.abs(mappedArea - storedArea) < 1e-6 * Math.max(1, storedArea),
      'seasonal map coverage equals reservoir area',
    );
  }
  assert.ok(w.water.channelRunoff.every((q, i) => q >= 0 && q <= w.water.runoff[i] + 1e-9));
  assert.ok(w.terrain.height.every((h, i) => w.terrain.ocean[i] || h >= 0));
  assert.ok(
    w.terrain.height.some((h, i) => w.terrain.ocean[i] && h < -1000),
    'ocean floors retain their depth',
  );

  for (const lake of d.lakes) {
    assert.ok(lake.storage >= 0 && lake.storage <= lake.capacity + 1);
    assert.ok(
      Math.abs(
        lake.inflow +
          lake.directRain -
          lake.displacedRunoff -
          lake.evaporation -
          lake.outflow -
          (lake.seasonal?.storageChange.reduce((sum, change) => sum + change, 0) ?? 0) / YEAR,
      ) <
        1e-7 * Math.max(1, lake.inflow),
    );

    if (lake.kind === 'closed') {
      assert.equal(lake.outflow, 0);
    }
  }

  assert.ok(
    w.terrain.fluvialIncision.some((h) => h > 100),
    'the reference landscape contains incised valleys',
  );
  assert.ok(
    w.terrain.oxbows.length > 0 && w.rivers.deltas.length > 0,
    'the reference landscape exercises both cutoff ponds and deltas',
  );

  for (let c = 0; c < d.receiver.length; c++) {
    if (w.rivers.channel[c]) {
      const fraction = w.rivers.sourceFractions.reduce((sum, f) => sum + f[c], 0);
      assert.ok(Math.abs(fraction - 1) < 1e-6, 'source labels partition existing water');
    }
  }

  for (const delta of w.rivers.deltas) {
    assert.ok(delta.branches.length >= 2);
    assert.ok(
      Math.abs(delta.branches.reduce((sum, branch) => sum + branch.fraction, 0) - 1) < 1e-12,
      'distributaries divide the trunk flow without duplicating it',
    );
  }

  const deltaMask = getDeltaCells(w);
  assert.ok(deltaMask.some((v) => v > 0));
  assert.ok(
    deltaMask.filter((v) => v > 0).length <= w.rivers.deltas.length * 2,
    'deltas tint at most two cells per mouth',
  );
  const courses = w.rivers.courses;

  for (let r = 0; r < courses.corner.length; r++) {
    const c = courses.corner[r];
    const to = d.receiver[c];

    for (let k = 0; k < 3; k++) {
      assert.ok(
        Math.abs(courses.points[courses.offsets[r] * 3 + k] - w.grid.corners[c * 3 + k]) < 1e-6,
      );
      assert.ok(
        Math.abs(
          courses.points[(courses.offsets[r + 1] - 1) * 3 + k] - w.grid.corners[to * 3 + k],
        ) < 1e-6,
      );
    }
  }

  for (const projection of ['globe', 'map'] as const) {
    const objects = [
      createRiverStrips(w, 20, 1, 10, -1, projection, 'sources').object,
      createOxbowSurfaces(w, 10, -1, projection),
    ];

    for (const object of objects) {
      object.traverse((child) => {
        if (!(child instanceof Mesh)) {
          return;
        }

        assert.ok(child.geometry.getAttribute('position').count > 0);
        assert.ok(
          Array.from(child.geometry.getAttribute('position').array).every(Number.isFinite),
          'both layouts have finite river-feature geometry',
        );
        child.geometry.dispose();

        for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
          material.dispose();
        }
      });
    }
  }

  assert.throws(() => generateWorld({ ...config, processLevel: 6 }), /Simulation detail/);
});

test('supported headwaters merge, cross a dry valley and spilling lake, and feed only accessible banks', () => {
  // 0 and 7 are supported sources; 1 and 8 have only storm runoff. Sources merge
  // at 2, enter lake corner 3, spill at 4, and cross dry corner 5 to ocean 6.
  const receiver = new Int32Array([2, 2, 3, -1, 5, 6, -1, 2, 6]);
  const edgeCells: number[] = [];
  const neighbors = new Uint32Array(27);
  const edges = new Uint32Array(27);

  for (let c = 0; c < 9; c++) {
    neighbors.fill(c, c * 3, c * 3 + 3);

    if (receiver[c] < 0) {
      continue;
    }

    neighbors[c * 3] = receiver[c];
    edges[c * 3] = edgeCells.length / 2;
    edgeCells.push(c, receiver[c]);
  }

  const grid = {
    count: 9,
    positions: Float64Array.from({ length: 27 }, (_, index) => +(index % 3 === 0)),
    corners: Float64Array.from({ length: 27 }, (_, index) => +(index % 3 === 0)),
    offsets: Uint32Array.from({ length: 10 }, (_, i) => i),
    cellCorners: Uint32Array.from({ length: 9 }, (_, i) => i),
    areas: Float64Array.from(
      { length: 9 },
      (_, i) => ([0, 1, 7, 8].includes(i) ? 1e10 : 1e9) / DEFAULT_CONFIG.radius ** 2,
    ),
    cornerNeighbors: neighbors,
    cornerEdges: edges,
    neighbors: Uint32Array.from({ length: 9 }, (_, i) => Math.max(0, receiver[i])),
    arcEdges: new Uint32Array(9),
    edgeDistance: new Float64Array(edgeCells.length / 2).fill(10000 / DEFAULT_CONFIG.radius),
    triangles: Uint32Array.from({ length: 27 }, (_, i) => Math.floor(i / 3)),
    edgeCells: new Uint32Array(edgeCells),
    edgeLength: new Float64Array(edgeCells.length / 2).fill(10000 / DEFAULT_CONFIG.radius),
  } as Grid;
  const terrain = {
    height: new Float32Array(9).fill(10),
    sediment: new Float32Array(9),
    deltaSediment: new Float32Array(9),
    ocean: new Uint8Array([0, 0, 0, 0, 0, 0, 1, 0, 0]),
  } as Terrain;
  const seasonalTemperature = Array.from(
    { length: 4 },
    () => new Float32Array([25, 25, 25, 25, 25, 25, 25, -5, 25]),
  );
  const water = {
    channelRunoff: new Float64Array([2, 0, 0, 0, 0, 0, 0, 2, 0]),
    runoff: new Float64Array([3, 100, 4, 0, 0, 1, 0, 3, 100]),
    meltRunoff: new Float32Array([0, 0, 0, 0, 0, 0, 0, 2, 0]),
    baseflowRunoff: new Float32Array([2, 0, 0, 0, 0, 0, 0, 0, 0]),
    saturatedSeasons: new Uint8Array(9),
    seasonalRunoff: [0.2, 0.4, 2.6, 0.8].map((f) =>
      Float32Array.from([3, 100, 4, 0, 0, 1, 0, 3, 100], (q) => q * f),
    ),
    temperature: seasonalTemperature[0],
    rain: new Float32Array(9).fill(100),
    aridity: new Float32Array(9).fill(6),
    pet: new Float32Array(9).fill(600),
    aet: new Float32Array(9),
    soil: new Float32Array(9),
    snow: new Float32Array([0, 0, 0, 0, 0, 0, 0, 500, 0]),
    seasonalTemperature,
    seasonalRain: Array.from({ length: 4 }, () => new Float32Array(9).fill(25)),
  } as LandWater;
  const drainage = {
    receiver,
    discharge: new Float64Array([3, 100, 110, 110, 80, 81, 181, 3, 100]),
    height: new Float32Array([10, 10, 10, 0, 1, 10, 0, 10, 10]),
    lakeId: new Int32Array([-1, -1, -1, 0, 0, -1, -1, -1, -1]),
    lakeDepth: new Float32Array([0, 0, 0, 5, 5, 0, 0, 0, 0]),
    lakeFraction: new Float32Array([0, 0, 0, 1, 1, 0, 0, 0, 0]),
    lakeCoverage: new Float32Array([0, 0, 0, 1, 1, 0, 0, 0, 0]),
    lakes: [{ id: 0, outlet: 5, level: 1, outflow: 80, inflow: 110, storage: 1e9 }],
  } as Drainage;
  const rivers = selectRivers(grid, terrain, water, drainage, DEFAULT_CONFIG);
  assert.deepEqual([...rivers.channel], [1, 0, 1, 0, 1, 1, 0, 1, 0]);
  assert.equal(rivers.headwater[0], 1);
  assert.equal(rivers.source[0], 3, 'slow release identifies spring/baseflow support');
  assert.equal(rivers.source[7], 2, 'rapid melt identifies snow-fed supply');
  assert.equal(rivers.source[4], 4, 'a reservoir release has lake provenance');
  assert.ok(rivers.sourceFractions[3][5] > 0.98, 'lake release dominates its dry downstream reach');
  assert.equal(flowRegime([0, 0, 0, 40]), 3);
  assert.equal(flowRegime([10, 10, 10, 10]), 1);
  assert.equal(rivers.headwater[7], 1);
  assert.equal(rivers.headwater[2], 0, 'tributaries merge into one channel');
  assert.equal(rivers.streamOrder[0], 1);
  assert.equal(rivers.streamOrder[2], 2, 'equal-order tributaries form a larger trunk');
  assert.equal(rivers.streamOrder[5], 2, 'tributary order continues through the spilling lake');
  assert.equal(rivers.system[0], rivers.system[5], 'the entire connected river shares an outlet');
  const closed = {
    ...drainage,
    receiver: new Int32Array(drainage.receiver),
    lakes: [{ ...drainage.lakes[0], outflow: 0 }],
  };
  closed.receiver[4] = -1;
  const closedRivers = selectRivers(grid, terrain, water, closed, DEFAULT_CONFIG);
  assert.notEqual(
    closedRivers.system[0],
    closedRivers.system[5],
    'a closed lake ends its river system',
  );
  assert.equal(closedRivers.channel[4], 0, 'a closed lake has no invented spill');
  assert.ok(
    rivers.catchmentArea[5] > rivers.catchmentArea[2],
    'catchment continues through storage',
  );

  for (let c = 0; c < receiver.length; c++) {
    const mean = rivers.seasonalDischarge.reduce((v, q) => v + q[c], 0) / 4;
    assert.ok(
      Math.abs(mean - drainage.discharge[c]) < 1e-4,
      'seasonal mean preserves annual water',
    );
  }

  const seasonality = (c: number) =>
    (Math.max(...rivers.seasonalDischarge.map((q) => q[c])) -
      Math.min(...rivers.seasonalDischarge.map((q) => q[c]))) /
    drainage.discharge[c];

  assert.ok(seasonality(4) < seasonality(2), 'stored water buffers the seasonal release');
  const ecology = classifyEcology(grid, terrain, water, drainage, rivers, DEFAULT_CONFIG);
  assert.equal(ecology.biome[2], 6, 'the regional desert remains a desert');
  assert.ok(
    ecology.vegetation[2] > 0 && ecology.riparian[2] > 0.3,
    'imported water greens dry banks',
  );
  assert.equal(ecology.riverHabitat[2], 2, 'the desert contains a local riparian woodland');
  assert.ok(
    ecology.floodplains.seasonalFlood[2].some((v) => v > 0),
    'wet-season excess can flood banks',
  );
  assert.equal(ecology.vegetation[8], 0, 'an isolated storm path does not green the desert');
  assert.equal(ecology.vegetation[6], 0, 'no vegetation in the ocean');
  assert.equal(ecology.vegetation[7], 0, 'no vegetation on a permanent ice sheet');
  terrain.height[2] = 1000;
  const highBank = classifyEcology(grid, terrain, water, drainage, rivers, DEFAULT_CONFIG);
  assert.ok(
    highBank.riparianFraction[2] < ecology.riparianFraction[2] * 0.5,
    'high terraces narrow the accessible bank instead of irrigating the ridge',
  );
});

test('large lowland rivers support broad alluvial habitat while small streams and confined banks stay narrow', () => {
  const valley = {
    supply: 1000,
    peak: 1000,
    length: 20000,
    riverSlope: 0.0001,
    bankSlope: 0.0002,
    availableWidth: 30000,
    sediment: 20,
    extent: 1,
  };
  const large = floodplainWidths(valley);
  const small = floodplainWidths({ ...valley, supply: 5, peak: 5 });
  const canyon = floodplainWidths({ ...valley, riverSlope: 0.01, bankSlope: 0.04 });
  const betweenFloods = floodplainWidths({ ...valley, peak: 0 });
  const constrained = floodplainWidths({ ...valley, availableWidth: 1200 });
  assert.ok(
    large.bank > 8000 && large.flood > 2000,
    'a large flat valley has kilometre-scale floodplain habitat',
  );
  assert.ok(small.bank < 600, 'a small source does not acquire a giant fertile belt');
  assert.ok(canyon.bank < 200 && canyon.flood < 200, 'steep terrain confines even a large river');
  assert.ok(
    betweenFloods.bank > 8000 && betweenFloods.flood === 0,
    'persistent alluvial habitat is distinct from active inundation',
  );
  assert.equal(constrained.bank, 1200, 'unresolved neighboring terrain is not blindly overrun');
  const wider = floodplainWidths({ ...valley, extent: 1.5 });
  assert.ok(
    wider.bank > large.bank && wider.flood > large.flood,
    'the generation control affects physical habitat extent',
  );
});

test('continental basins sit above sea level while preserving slopes and escape sills', () => {
  // Ocean, coast, escape sill, deep inland basin, higher ridge, ordinary upland pond.
  const height = new Float32Array([-4000, 100, 500, 100, -2000, -1000, 600, 520, 550]);
  const ocean = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0]);
  const neighbors: number[] = [];
  const offsets = [0];

  for (let i = 0; i < height.length; i++) {
    if (i > 0) {
      neighbors.push(i - 1);
    }

    if (i + 1 < height.length) {
      neighbors.push(i + 1);
    }

    offsets.push(neighbors.length);
  }

  const grid = {
    count: height.length,
    offsets: new Uint32Array(offsets),
    neighbors: new Uint32Array(neighbors),
  } as Grid;
  shapeContinentalBasins(grid, height, ocean);
  assert.ok(height.every((h, i) => ocean[i] || h > 0));
  assert.ok(height[4] < height[5] && height[5] < height[3] && height[3] < height[2]);
  assert.equal(height[0], -4000, 'ocean bathymetry is preserved');
  assert.equal(height[1], 100, 'coastal land stays fixed');
  assert.equal(height[2], 500, 'the lowest escape sill stays fixed');
  assert.equal(height[6], 600, 'the higher surrounding ridge stays fixed');
  assert.equal(height[7], 520, 'ordinary above-sea-level ponds are unchanged');
  assert.equal(height[8], 550);
});

test('semi-arid grassland has cover, true deserts stay sparse, and cool summers can support growth', () => {
  const count = 7;
  const grid = { count, offsets: new Uint32Array(count + 1) } as Grid;
  const terrain = {
    ocean: new Uint8Array(count),
    height: new Float32Array(count),
    deltaSediment: new Float32Array(count),
  } as Terrain;
  const rain = new Float32Array([300, 60, 900, 160, 100, 0, 350]);
  const pet = new Float32Array([1000, 1000, 700, 200, 0, 1000, 1000]);
  const seasons = [-18, 14, -6, -10];
  const water = {
    rain,
    pet,
    aet: new Float32Array([255, 40, 600, 120, 0, 0, 290]),
    aridity: Float32Array.from(pet, (v, i) => Math.min(6, v / Math.max(1, rain[i]))),
    temperature: new Float32Array([15, 25, 15, -5, -8, 25, 25]),
    soil: new Float32Array(count),
    saturatedSeasons: new Uint8Array(count),
    snow: new Float32Array([0, 0, 0, 0, 500, 0, 0]),
    seasonalTemperature: seasons.map((t) => new Float32Array([15, 25, 15, t, -8, 25, 25])),
    seasonalRain: seasons.map(() => Float32Array.from(rain, (v) => v / 4)),
  } as LandWater;
  const drainage = {
    receiver: new Int32Array(0),
    lakeDepth: new Float32Array(count),
    lakeCoverage: new Float32Array(count),
  } as Drainage;
  const rivers = {
    channel: new Uint8Array(0),
    headwater: new Uint8Array(0),
    deltas: [],
  } as unknown as Rivers;
  const ecology = classifyEcology(grid, terrain, water, drainage, rivers, DEFAULT_CONFIG);
  assert.equal(ecology.biome[0], 5, 'semi-arid temperate land is grassland');
  assert.equal(ecology.biome[6], 7, 'semi-arid tropical land is savanna');
  assert.ok(ecology.vegetation[0] > 0.4, 'soil-supported grassland is not nearly bare');
  assert.equal(ecology.biome[1], 6, 'arid land remains desert');
  assert.ok(ecology.vegetation[1] < 0.15, 'little available water keeps desert cover sparse');
  assert.equal(ecology.biome[2], 4, 'humid temperate land remains forest');
  assert.ok(ecology.vegetation[2] > ecology.vegetation[0]);
  assert.notEqual(ecology.biome[3], 6, 'modest rain is sufficient when demand is low');
  assert.ok(ecology.vegetation[3] > 0.3, 'a cold annual mean does not erase summer growth');
  assert.equal(ecology.vegetation[4], 0, 'permanent ice stays bare');
  assert.equal(ecology.vegetation[5], 0, 'warmth without water cannot create vegetation');
});

test('shallow standing water is visible on the same surface as its ecological lake cells', () => {
  // A dry desert bank, a 20 cm lake, and ocean. The shallow lake previously appeared
  // as desert because two consumers independently required more than 2 m of water.
  const grid = { count: 3, offsets: new Uint32Array(4) } as Grid;
  const terrain = {
    ocean: new Uint8Array([0, 0, 1]),
    height: new Float32Array([3, 2.3, -500]),
    deltaSediment: new Float32Array(3),
    fluvialIncision: new Float32Array(3),
  } as Terrain;
  const water = {
    temperature: new Float32Array(3).fill(25),
    rain: new Float32Array(3).fill(60),
    pet: new Float32Array(3).fill(1000),
    aet: new Float32Array(3).fill(50),
    aridity: new Float32Array(3).fill(6),
    soil: new Float32Array(3),
    saturatedSeasons: new Uint8Array(3),
    snow: new Float32Array(3),
    seasonalTemperature: Array.from({ length: 4 }, () => new Float32Array(3).fill(25)),
    seasonalRain: Array.from({ length: 4 }, () => new Float32Array(3).fill(15)),
  } as LandWater;
  const drainage = {
    receiver: new Int32Array(0),
    lakeDepth: new Float32Array([0, 0.2, 0]),
    lakeCoverage: new Float32Array([0, 1, 0]),
  } as Drainage;
  const rivers = {
    channel: new Uint8Array(0),
    headwater: new Uint8Array(0),
    deltas: [],
  } as unknown as Rivers;
  const ecology = classifyEcology(grid, terrain, water, drainage, rivers, DEFAULT_CONFIG);
  assert.deepEqual([...ecology.biome], [6, 12, 0]);
  assert.equal(ecology.vegetation[1], 0, 'standing water is not vegetated desert ground');
  const geometry = new BufferGeometry();
  const world = { grid, terrain, water, drainage, rivers, ecology } as World;
  updateNaturalSurface(geometry, world, -1);
  const surface = geometry.getAttribute('surfaceTerrain');
  assert.deepEqual(
    [0, 1, 2].map((i) => surface.getY(i)),
    [1, 0, 0],
  );
  drainage.lakeDepth[1] = 0;
  assert.ok(isLakeCell(world, 1), 'coverage preserves a flat lake even with zero measured depth');
  updateNaturalSurface(geometry, world, 0);
  assert.equal(surface.getY(1), 0, 'flat standing water remains visible after a season change');
  drainage.lakeCoverage[1] = 0.25;
  drainage.lakeDepth[1] = 5;
  world.ecology = classifyEcology(grid, terrain, water, drainage, rivers, DEFAULT_CONFIG);
  assert.equal(world.ecology.biome[1], 6, 'mixed shores retain their regional land biome');
  assert.ok(!isLakeCell(world, 1), 'positive center depth does not erase the exposed shore');
  updateNaturalSurface(geometry, world, 1);
  assert.equal(surface.getY(1), 0.75);
  geometry.dispose();
});

test('a perched pond spills into a closed lower lake without losing its channel', () => {
  // Two downhill catchments, with a saddle between corners 1 and 2.
  const grid = {
    cornerNeighbors: new Uint32Array([0, 1, 0, 0, 2, 1, 1, 3, 2, 2, 3, 3]),
    cornerEdges: new Uint32Array(12),
    edgeLength: new Float64Array([1]),
  } as Grid;
  const height = new Float32Array([0, 4, 3, 1]);
  const area = new Float64Array([1, 1, 1, 1]);
  const input = new Float64Array(4);
  const rain = new Float64Array(4);
  const evap = new Float64Array([10, 1, 1, 1]);
  const // External tributary inflow is not local runoff displaced by the lake.
    discharge = new Float64Array([0, 0, 0, 3]);
  const receiver = new Int32Array(4).fill(-1);
  const lakeId = new Int32Array(4).fill(-1);
  const candidate = balanceLake(0, -1, 5, [0, 1, 2, 3], height, area, input, rain, evap, 3);
  let id = 0;
  const result = resolveNestedLakes({
    grid,
    members: [0, 1, 2, 3],
    height,
    rank: new Uint32Array([0, 3, 2, 1]),
    input,
    discharge,
    rain,
    evap,
    area,
    candidate,
    escapeFrom: 1,
    receiver,
    lakeId,
    allocateId: () => id++,
  });
  assert.ok(result);
  assert.equal(result.lakes.length, 2);
  assert.equal(result.outflow, 0);
  const upper = result.byCorner.get(3)!;
  const lower = result.byCorner.get(0)!;
  assert.equal(upper.level, 4);
  assert.equal(upper.outflow, 1);
  assert.equal(lower.inflow, 1);
  assert.equal(lower.kind, 'closed');
  assert.equal(receiver[2], 1);
  assert.equal(receiver[1], 0);
  assert.equal(receiver[0], -1);
  assert.equal(discharge[1], 1);

  for (const lake of result.lakes) {
    assert.ok(
      Math.abs(
        lake.inflow + lake.directRain - lake.displacedRunoff - lake.evaporation - lake.outflow,
      ) < 1e-9,
    );
  }
});

test('an unresolved flat lake has an area-preserving shore and exposed flats drain into it', () => {
  const grid = {
    count: 5,
    positions: Float64Array.from({ length: 15 }, (_, index) => +(index % 3 === 0)),
    corners: Float64Array.from({ length: 15 }, (_, index) => +(index % 3 === 0)),
    triangles: Uint32Array.from({ length: 15 }, (_, index) => Math.floor(index / 3)),
    areas: new Float64Array(5).fill(1),
    offsets: new Uint32Array([0, 1, 2, 3, 4, 5]),
    cellCorners: new Uint32Array([0, 1, 2, 3, 4]),
    cornerNeighbors: new Uint32Array([0, 0, 0, 1, 2, 1, 1, 3, 2, 2, 4, 3, 3, 4, 4]),
  } as Grid;
  const d = {
    receiver: new Int32Array([-1, -1, -1, -1, 3]),
    height: new Float32Array([0, 10, 10, 10, 20]),
    discharge: new Float64Array([0, 5, 10, 85, 80]),
    lakeId: new Int32Array([-1, 0, 0, 0, -1]),
    lakeFraction: new Float32Array(5),
    lakeCoverage: new Float32Array(5),
    lakes: [{ id: 0, area: 1.5, level: 10, inflow: 100, outflow: 0 }],
  } as Drainage;
  resolveLakeSurfaces(grid, d, new Float64Array(5).fill(1), new Float64Array([0, 5, 10, 5, 80]));
  assert.equal(
    d.lakeFraction.reduce((a, b) => a + b, 0),
    1.5,
  );
  assert.equal(d.lakeFraction[3], 1, 'the substantial inlet reaches visible standing water');
  assert.equal(d.receiver[1], 2, 'exposed flat ground no longer acts as an invisible lake');
  assert.equal(d.discharge[2] + d.discharge[3], 100, 'rerouting preserves lake inflow');
});

test('water joins remain connected and textured banks soften and respond to seasons', () => {
  const grid = buildGrid(1, 'river-join', 0.65);
  const n = grid.corners.length / 3;
  const a = 0;
  const b = grid.cornerNeighbors[a * 3];
  const c = Array.from(grid.cornerNeighbors.subarray(b * 3, b * 3 + 3)).find((i) => i !== a)!;
  const receiver = new Int32Array(n).fill(-1);
  const discharge = new Float64Array(n);
  const channel = new Uint8Array(n);
  receiver[a] = b;
  receiver[b] = c;
  discharge[a] = 1000;
  discharge[b] = 4000;
  discharge[c] = 4000;
  channel[a] = channel[b] = 1;
  const world = {
    grid,
    config: DEFAULT_CONFIG,
    terrain: { height: new Float32Array(grid.count).fill(10), ocean: new Uint8Array(grid.count) },
    water: {
      seasonalTemperature: Array.from({ length: 4 }, () => new Float32Array(grid.count).fill(20)),
    },
    drainage: {
      receiver,
      discharge,
      height: new Float32Array(n).fill(10),
      lakeDepth: new Float32Array(grid.count),
      lakeFraction: new Float32Array(n),
      lakeId: new Int32Array(n).fill(-1),
      lakes: [],
    },
    rivers: {
      channel,
      source: new Uint8Array(n),
      deltas: [],
      seasonalDischarge: Array.from({ length: 4 }, () => Float32Array.from(discharge)),
      courses: {
        corner: Uint32Array.from([a, b]),
        offsets: Uint32Array.from([0, 2, 4]),
        sinuosity: Float32Array.from([1, 1]),
        points: Float32Array.from(
          [a, b, b, c].flatMap((i) => Array.from(grid.corners.subarray(i * 3, i * 3 + 3))),
        ),
      },
    },
    ecology: {
      floodplains: {
        corner: Uint32Array.from([a, b]),
        width: Float32Array.from([1000, 2500, 4000, 1500]),
        vegetation: Float32Array.from([0.8, 0.9, 0.95, 0.85]),
        habitat: Uint8Array.from([1, 2, 2, 1]),
        seasonalFlood: Array.from({ length: 4 }, () => new Float32Array(4)),
      },
    },
  } as unknown as World;
  const network = new RiverGeometry(world);
  const firstCourse = network.getCoursePoints(a);
  const secondCourse = network.getCoursePoints(b);
  assert.ok(firstCourse.length > 6 && secondCourse.length > 6, 'routing corners become curves');
  assert.deepEqual(firstCourse.slice(-3), secondCourse.slice(0, 3), 'the junction remains exact');
  const intoJunction = new Vector3()
    .fromArray(firstCourse, firstCourse.length - 3)
    .sub(new Vector3().fromArray(firstCourse, firstCourse.length - 6))
    .normalize();
  const outOfJunction = new Vector3()
    .fromArray(secondCourse, 3)
    .sub(new Vector3().fromArray(secondCourse, 0))
    .normalize();
  assert.ok(intoJunction.dot(outOfJunction) > 0.98, 'the main channel has a smooth shared tangent');
  const thin = createRiverStrips(world, 20, 0.5, 10, -1, 'map').object.children[0] as Mesh;
  const wide = createRiverStrips(world, 20, 2.5, 10, -1, 'map').object.children[0] as Mesh;
  assert.deepEqual(
    thin.geometry.getAttribute('uv').array.slice(0, thin.geometry.userData.mapCopies.first * 2),
    wide.geometry.getAttribute('uv').array.slice(0, wide.geometry.userData.mapCopies.first * 2),
    'widening rivers preserves every centerline sample and its flow phase',
  );
  thin.geometry.dispose();
  wide.geometry.dispose();
  for (const mesh of [thin, wide]) {
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      material.dispose();
    }
  }

  const texture = createRiverbankTexture(world, 0, 128);
  const data = texture.image.data!;
  assert.ok(
    data.some((v, i) => i % 4 === 3 && v > 0 && v < 200),
    'bank edges have a soft alpha falloff',
  );
  world.water.seasonalTemperature[1].fill(-10);
  const frozen = createRiverbankTexture(world, 1, 128);
  assert.notDeepEqual(data, frozen.image.data, 'winter changes the bank pigment');

  for (let p = 0; p < data.length; p += 4) {
    assert.ok(
      data[p] <= data[p + 3] && data[p + 1] <= data[p + 3] && data[p + 2] <= data[p + 3],
      'premultiplied edge colors cannot leave a dark filtering halo',
    );
  }

  texture.dispose();
  frozen.dispose();

  for (const projection of ['globe', 'map'] as const) {
    const water = createRiverStrips(world, 20, 1, 10, -1, projection).object.children[0] as Mesh;
    assert.equal(water.geometry.userData.ribbons, 1, 'two connected reaches form one ribbon');

    if (projection === 'globe') {
      const index = water.geometry.getIndex()!;
      const parents = new Int32Array(water.geometry.getAttribute('position').count);

      for (let i = 0; i < parents.length; i++) {
        parents[i] = i;
      }

      const root = (i: number): number => {
        while (parents[i] !== i) {
          i = parents[i];
        }

        return i;
      };

      for (let i = 0; i < index.count; i += 3) {
        parents[root(index.getX(i + 1))] = root(index.getX(i));
        parents[root(index.getX(i + 2))] = root(index.getX(i));
      }

      assert.equal(
        new Set(Array.from(index.array, (i) => root(i))).size,
        1,
        'span and bevel indices form one connected mesh',
      );
    }

    water.geometry.dispose();

    for (const material of Array.isArray(water.material) ? water.material : [water.material]) {
      material.dispose();
    }
  }
});

test('wide river bends keep their width and cannot fold quads into bow ties', () => {
  const surface = new WaterSurface({} as World, 0, false, true);
  const points = [
    [0, 0],
    [0.001, 0],
    [0.0012, 0.00025],
    [0.0014, -0.00025],
    [0.0024, 0],
  ].map(([y, z], i) => ({
    position: new Vector3(1, y, z).normalize(),
    width: 0.0007,
    phase: i,
    activity: 1,
    source: 1,
  }));
  const ribbon = new RiverRibbon(surface);
  ribbon.addPath(points);
  const geometry = ribbon.buildGeometry();
  const p = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  const index = geometry.getIndex()!;
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();

  for (let i = 0; i < p.count; i++) {
    if (uv.getY(i) === 0) {
      continue;
    }
    // bevel center
    a.fromBufferAttribute(p, i).normalize();
    assert.ok(
      Math.abs(a.angleTo(points[uv.getX(i)].position) - Math.atan(0.0007)) < 1e-7,
      'bends retain the chosen water width instead of repeatedly pinching it',
    );
  }

  for (let i = 0; i < index.count; i += 3) {
    a.fromBufferAttribute(p, index.getX(i));
    b.fromBufferAttribute(p, index.getX(i + 1));
    c.fromBufferAttribute(p, index.getX(i + 2));
    assert.ok(
      b.sub(a).cross(c.sub(a)).dot(a) < -1e-16,
      'every span and join triangle has nonzero, consistent winding',
    );
  }

  geometry.dispose();
});

test('a deep chain of spilling ponds settles without restarting closed subtrees', () => {
  // Each side pond adds water to the same closed lower catchment. Restarting that
  // catchment at every saddle requires exponentially many visits even on 65 corners.
  const ponds = 32;
  const count = ponds * 2 + 1;
  const members = Array.from({ length: count }, (_, i) => i);
  const height = Float32Array.from(members, (i) => (i === 0 ? 0 : i % 2 ? (i + 1) / 2 + 2 : 1));
  const grid = {
    cornerNeighbors: Uint32Array.from({ length: count * 3 }, (_, i) => {
      const c = Math.floor(i / 3);

      return i % 3 === 0 ? Math.max(0, c - 1) : i % 3 === 1 ? Math.min(count - 1, c + 1) : c;
    }),
    cornerEdges: new Uint32Array(count * 3),
    edgeLength: new Float64Array([1]),
  } as Grid;
  const input = new Float64Array(count);
  const rain = new Float64Array(count);
  const evap = new Float64Array(count).fill(0.1);
  const area = new Float64Array(count).fill(1);
  const discharge = Float64Array.from(members, (i) => (i > 0 && i % 2 === 0 ? 3 : 0));
  evap[0] = 1e9;
  const candidate = balanceLake(
    0,
    -1,
    ponds + 5,
    members,
    height,
    area,
    input,
    rain,
    evap,
    ponds * 3,
  );
  let id = 0;
  const result = resolveNestedLakes({
    grid,
    members,
    height,
    rank: Uint32Array.from(members),
    input,
    discharge,
    rain,
    evap,
    area,
    candidate,
    escapeFrom: count - 1,
    receiver: new Int32Array(count).fill(-1),
    lakeId: new Int32Array(count).fill(-1),
    allocateId: () => id++,
  });
  assert.ok(result);
  assert.equal(result.lakes.length, ponds + 1);
  assert.equal(result.outflow, 0);
  assert.ok(Math.abs(result.byCorner.get(0)!.inflow - ponds * 2.9) < 1e-9);
  assert.ok(
    Math.abs(result.lakes.reduce((sum, lake) => sum + lake.inflow - lake.outflow, 0) - ponds * 3) <
      1e-9,
  );
});

test('rainfall reconstruction preserves every parent volume and resolves variation inside it', () => {
  const process = buildGrid(2, 'rain-transfer', 0.5);
  const surface = buildGrid(4, 'rain-transfer', 0.5);
  const parent = buildTransfer(process, surface);
  const rainfall = Float32Array.from({ length: process.count }, (_, cell) =>
    Math.max(0, 200 + 250 * process.positions[cell * 3 + 1]),
  );
  const [fine] = prolongRainfall(surface, process, parent, [rainfall]);
  const volume = new Float64Array(process.count);
  let varyingNeighbors = 0;
  for (let cell = 0; cell < surface.count; cell++) {
    assert.ok(Number.isFinite(fine[cell]) && fine[cell] >= 0);
    volume[parent[cell]] += fine[cell] * surface.areas[cell];
    for (let offset = surface.offsets[cell]; offset < surface.offsets[cell + 1]; offset++) {
      const neighbor = surface.neighbors[offset];
      if (parent[cell] === parent[neighbor] && Math.abs(fine[cell] - fine[neighbor]) > 0.1) {
        varyingNeighbors++;
      }
    }
  }
  for (let coarse = 0; coarse < process.count; coarse++) {
    const expected = rainfall[coarse] * process.areas[coarse];
    assert.ok(Math.abs(volume[coarse] - expected) < 2e-7 * Math.max(1, expected));
  }
  assert.ok(varyingNeighbors > surface.count, 'rainfall varies within coarse cells');
});

test('snow feeds liquid lake input only after melting; an ice cover does not block incoming water', () => {
  const grid = buildGrid(1, 'snow-lake', 0);
  const terrain = {
    height: new Float32Array(grid.count).fill(100),
    ocean: new Uint8Array(grid.count),
    oxbows: [],
  } as unknown as Terrain;
  const climate = {
    rain: Array.from({ length: 4 }, () => new Float32Array(grid.count).fill(100)),
    temperature: Array.from({ length: 4 }, () => new Float32Array(grid.count).fill(-10)),
    wind: Array.from({ length: 4 }, () => new Float32Array(grid.count * 3)),
  } as Climate;
  const parent = Uint32Array.from({ length: grid.count }, (_, cell) => cell);
  const cold = solveLandWater(grid, grid, parent, climate, terrain, DEFAULT_CONFIG, terrain.height);
  assert.ok(cold.seasonalLiquid.every((field) => field.every((amount) => amount === 0)));
  assert.ok(cold.snow.every((amount) => amount === 1600));
  climate.temperature[2].fill(30);
  const melting = solveLandWater(
    grid,
    grid,
    parent,
    climate,
    terrain,
    DEFAULT_CONFIG,
    terrain.height,
  );
  assert.equal(melting.seasonalLiquid[2][0], 400);
  assert.equal(melting.seasonalLiquid[0][0], 0);
  const lake = balanceLake(
    0,
    1,
    2,
    [0],
    new Float32Array([0]),
    new Float64Array([1e6]),
    new Float64Array([0]),
    new Float64Array([0]),
    new Float64Array([0]),
    1,
    { inflow: [1, 1, 1, 1], at: () => [0, 0, 0] },
  );
  assert.ok(Math.abs(lake.outflow - 1) < 1e-8, 'liquid inflow still passes beneath an ice cover');
});

test('seasonal lake storage conserves water through filling, evaporation, drying and spill', () => {
  const lake = balanceLake(
    0,
    1,
    4,
    [0],
    new Float32Array([0]),
    new Float64Array([1e6]),
    new Float64Array([0]),
    new Float64Array([0]),
    new Float64Array([0.2]),
    0.25,
    { inflow: [1, 0, 0, 0], at: (_, season) => [0, [0.1, 0.3, 0.3, 0.1][season], 0] },
  );
  const state = lake.seasonal!;
  assert.ok(state.storage.every((storage) => storage >= 0 && storage <= lake.capacity));
  assert.ok(state.storage[0] > state.storage[3]);
  assert.ok(state.outflow[0] > 0 && state.outflow[2] === 0);
  assert.ok(
    Math.min(...state.area) < Math.max(...state.area),
    'shallow margins emerge when storage dries',
  );
  for (let season = 0; season < 4; season++) {
    const net =
      state.inflow[season] +
      state.directRain[season] -
      state.evaporation[season] -
      state.displacedRunoff[season] -
      state.outflow[season];
    assert.ok(Math.abs(net * SEASON - state.storageChange[season]) < 1e-6);
  }
  const closed = { ...lake, outflow: 0 };
  const flushed = { ...lake, outflow: 20 };
  assert.ok(lakeFreshwaterSuitability(closed) > 0, 'closed does not establish salinity');
  assert.ok(lakeFreshwaterSuitability(closed) < lakeFreshwaterSuitability(flushed));
});

test('river migration respects valley space and cutoffs preserve connected endpoints', () => {
  const young = evolveBend(30000, 10000, 0, 1, 1);
  const mobile = evolveBend(30000, 10000, 1, 1, 1);
  const confined = evolveBend(30000, 100, 1, 1, 1);
  assert.ok(young.points.every((p) => p[1] === 0));
  assert.ok(mobile.loops.length > 0, 'intersecting bends leave an abandoned loop');
  assert.deepEqual(mobile.points[0], [0, 0]);
  assert.deepEqual(mobile.points.at(-1), [30000, 0]);
  assert.ok(mobile.points.every((p) => Math.abs(p[1]) <= 10000));
  assert.equal(confined.loops.length, 0);
  assert.ok(confined.points.every((p) => Math.abs(p[1]) <= 100));
});

test('river incision keeps inland terrain above datum and accounts for the removed sediment', () => {
  const g = buildGrid(3, 'fluvial-budget', 0.4);
  const height = Float32Array.from({ length: g.count }, (_, i) =>
    g.positions[i * 3 + 1] < -0.65 ? -200 : 200 + (g.positions[i * 3 + 1] + 0.65) * 1500,
  );
  const terrain = {
    height,
    bedrock: new Float32Array(height),
    sediment: new Float32Array(g.count),
    ocean: Uint8Array.from(height, (h) => (h < 0 ? 1 : 0)),
    fluvialIncision: new Float32Array(g.count),
    deltaSediment: new Float32Array(g.count),
  } as Terrain;
  const water = {
    runoff: Float64Array.from(height, (h) => (h > 0 ? 10 : 0)),
    rain: new Float32Array(g.count).fill(800),
    pet: new Float32Array(g.count).fill(500),
    seasonalRunoff: Array.from({ length: 4 }, () =>
      Float32Array.from(height, (h) => (h > 0 ? 10 : 0)),
    ),
    seasonalLiquid: Array.from({ length: 4 }, () => new Float32Array(g.count).fill(200)),
    seasonalPet: Array.from({ length: 4 }, () => new Float32Array(g.count).fill(125)),
  } as LandWater;
  const d = routeWater(g, terrain, water, DEFAULT_CONFIG);
  const before = new Float32Array(height);
  assert.equal(erodeRiverLandscape(g, terrain, d, { ...DEFAULT_CONFIG, fluvialDuration: 0 }), 0);
  assert.deepEqual(height, before);
  const exported = erodeRiverLandscape(g, terrain, d, DEFAULT_CONFIG);
  let change = 0;
  let removed = 0;

  for (let i = 0; i < g.count; i++) {
    const area = g.areas[i] * DEFAULT_CONFIG.radius ** 2;
    change += (height[i] - before[i]) * area;
    removed += terrain.fluvialIncision[i] * area;
    assert.ok(terrain.ocean[i] || height[i] >= 0);
  }

  assert.ok(removed > 0 && exported > 0);
  assert.ok(
    Math.abs(change + exported) < removed * 1e-4,
    'deposition and export account for removal within terrain precision',
  );
});
