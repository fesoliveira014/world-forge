import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGrid } from '../src/core/grid/build';
import { createRegionSpacing, refineGrid } from '../src/core/grid/refine';
import {
  DEFAULT_CONFIG,
  type Drainage,
  type Grid,
  type LandWater,
  type Terrain,
} from '../src/core/model';
import { routeWater } from '../src/core/generation/drainage';
import { erodeRiverLandscape } from '../src/core/generation/erosion';
import { depositRiverMouth, riverSettlingFraction } from '../src/core/generation/river-sediment';
import {
  createMigrationLookup,
  evolveRiverBanks,
  sampleMigrationCourse,
} from '../src/core/generation/river-migration';
import { remapTerrain } from '../src/core/operators/remap';
import { normalizeVector } from '../src/core/math';

function terrainOn(grid: Grid, heightAt: (cell: number) => number): Terrain {
  const height = Float32Array.from({ length: grid.count }, (_, cell) => heightAt(cell));
  return {
    height,
    bedrock: height.slice(),
    sediment: new Float32Array(grid.count),
    ocean: Uint8Array.from(height, (value) => +(value < 0)),
    coastDistance: new Float32Array(grid.count),
    surfaceChange: new Float32Array(grid.count),
    fluvialIncision: new Float32Array(grid.count),
    deltaSediment: new Float32Array(grid.count),
    seaThreshold: 0,
    oxbows: [],
  };
}

test('a physical sediment reach retains the same load when subdivided', () => {
  for (const slope of [0, 0.0005, 0.008]) {
    const deliver = (pieces: number) => {
      let load = 1e9;
      for (let piece = 0; piece < pieces; piece++) {
        load *= 1 - riverSettlingFraction(350000 / pieces, slope);
      }
      return load;
    };
    assert.ok(Math.abs(deliver(2) - deliver(80)) / deliver(2) < 1e-12);
  }
});

const radius = 1e6;
const base = buildGrid(3, 'delta-progradation', 0.45);
const refined = refineGrid(
  base,
  radius,
  'delta-progradation',
  createRegionSpacing(200000, radius, [
    { center: [1, 0, 0], radiusMetres: 200000, targetSpacingMetres: 18000 },
  ]),
);

function mouthFixture(grid: Grid) {
  const terrain = terrainOn(grid, (cell) => (grid.positions[cell * 3 + 1] < 0 ? -2 : 20));
  let corner = 0;
  let best = Infinity;
  for (let index = 0; index < grid.corners.length / 3; index++) {
    if (![0, 1, 2].some((slot) => terrain.ocean[grid.triangles[index * 3 + slot]])) {
      continue;
    }
    const distance =
      (grid.corners[index * 3] - 1) ** 2 +
      (grid.corners[index * 3 + 1] + 0.01) ** 2 +
      grid.corners[index * 3 + 2] ** 2;
    if (distance < best) {
      best = distance;
      corner = index;
    }
  }
  const drainage = {
    discharge: new Float64Array(grid.corners.length / 3).fill(5000),
    lakeCoverage: new Float32Array(grid.count),
    lakeId: new Int32Array(grid.corners.length / 3).fill(-1),
    lakes: [],
  } as unknown as Drainage;
  return { terrain, drainage, corner };
}

test('mouth deposits grow connected land beyond the first neighbor ring and conserve delivery', () => {
  const config = { ...DEFAULT_CONFIG, radius, waveErosion: 1 };
  const volume = 2e11;
  for (const grid of [base, refined]) {
    const { terrain, drainage, corner } = mouthFixture(grid);
    const original = terrain.height.slice();
    const local = new Set<number>();
    for (let incident = 0; incident < 3; incident++) {
      const cell = grid.triangles[corner * 3 + incident];
      local.add(cell);
      for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
        local.add(grid.neighbors[offset]);
      }
    }
    const exported = depositRiverMouth(grid, terrain, drainage, corner, volume, -1, config);
    let deposited = 0;
    let grown = 0;
    let beyond = 0;
    for (let cell = 0; cell < grid.count; cell++) {
      deposited += terrain.sediment[cell] * grid.areas[cell] * radius ** 2;
      if (original[cell] < 0 && terrain.height[cell] >= 0) {
        grown++;
      }
      if (!local.has(cell) && terrain.deltaSediment[cell] > 0) {
        beyond++;
      }
      assert.ok(terrain.height[cell] <= Math.max(3.00001, original[cell]));
      assert.equal(terrain.bedrock[cell], original[cell]);
    }
    assert.ok(Math.abs(deposited + exported - volume) / volume < 1e-7);
    assert.ok(grown > 0, 'supplied material raises real seabed above the datum');
    if (grid === refined) {
      assert.ok(beyond > 0, 'physical footprint survives inserted surface sites');
    }
  }
});

function riverFixture() {
  const grid = buildGrid(3, 'bank-exchange', 0.5);
  const terrain = terrainOn(grid, (cell) => (grid.positions[cell * 3 + 1] < -0.65 ? -20 : 100));
  const runoff = Float64Array.from(terrain.ocean, (ocean) => (ocean ? 0 : 100));
  const water = {
    runoff,
    pet: new Float32Array(grid.count).fill(500),
    seasonalRunoff: Array.from({ length: 4 }, () => Float32Array.from(runoff)),
    seasonalLiquid: Array.from({ length: 4 }, () => new Float32Array(grid.count).fill(200)),
    seasonalPet: Array.from({ length: 4 }, () => new Float32Array(grid.count).fill(125)),
  } as LandWater;
  const config = { ...DEFAULT_CONFIG, radius: 1e5, erosion: 1, fluvialDuration: 0.2 };
  const drainage = routeWater(grid, terrain, water, config);
  return { grid, terrain, drainage, config };
}

test('bank migration funds real point bars and downstream load without losing material', () => {
  const { grid, terrain, drainage, config } = riverFixture();
  const before = terrain.height.slice();
  const load = evolveRiverBanks(grid, terrain, drainage, config);
  let balance = load.reduce((sum, volume) => sum + volume, 0);
  let removed = 0;
  for (let cell = 0; cell < grid.count; cell++) {
    const area = grid.areas[cell] * config.radius ** 2;
    balance += (terrain.height[cell] - before[cell]) * area;
    removed += terrain.fluvialIncision[cell] * area;
    assert.ok(terrain.sediment[cell] >= 0);
  }
  assert.ok(removed > 0);
  assert.ok(terrain.sediment.some((depth) => depth > 0));
  assert.ok(Math.abs(balance) / removed < 1e-4);
  assert.ok(terrain.migration!.length > 0);
  assert.ok(terrain.migration!.every((record) => record.elapsedMyr === config.fluvialDuration));
});

test('migration clock is incremental and geographic records survive remeshing', () => {
  const full = riverFixture();
  evolveRiverBanks(full.grid, full.terrain, full.drainage, full.config);
  const split = riverFixture();
  evolveRiverBanks(split.grid, split.terrain, split.drainage, {
    ...split.config,
    fluvialDuration: 0.1,
  });
  evolveRiverBanks(split.grid, split.terrain, split.drainage, {
    ...split.config,
    fluvialDuration: 0.1,
  });
  assert.equal(split.terrain.migration!.length, full.terrain.migration!.length);
  for (const record of split.terrain.migration!) {
    assert.equal(record.elapsedMyr, 0.2);
  }
  const volume = (data: typeof full) =>
    data.terrain.fluvialIncision.reduce(
      (sum, depth, cell) => sum + depth * data.grid.areas[cell],
      0,
    );
  assert.ok(Math.abs(volume(split) - volume(full)) / volume(full) < 1e-4);
  const record = full.terrain.migration![0];
  const center = normalizeVector(record.start.map((value, axis) => value + record.end[axis]));
  const fine = refineGrid(
    full.grid,
    full.config.radius,
    'migration-refine',
    createRegionSpacing(20000, full.config.radius, [
      { center, radiusMetres: 10000, targetSpacingMetres: 2000 },
    ]),
  );
  const remapped = remapTerrain(full.grid, fine, full.terrain, full.config);
  assert.deepEqual(remapped.migration, full.terrain.migration);
  const lookup = createMigrationLookup(remapped.migration!, full.config.radius);
  assert.equal(lookup(record.start, center), remapped.migration![0]);
  const first = sampleMigrationCourse(record, record.start, center, full.config.radius);
  const second = sampleMigrationCourse(record, center, record.end, full.config.radius);
  assert.deepEqual(
    first.at(-1),
    second[0],
    'inserted shared endpoint samples the same inherited curve',
  );
});

test('zero duration and disabled migration leave terrain and history unchanged', () => {
  for (const key of ['fluvialDuration', 'erosion', 'bankMobility'] as const) {
    const { grid, terrain, drainage, config } = riverFixture();
    const before = structuredClone(terrain);
    const load = evolveRiverBanks(grid, terrain, drainage, { ...config, [key]: 0 });
    assert.ok(load.every((value) => value === 0));
    assert.deepEqual(terrain, before);
  }
  const { grid, terrain, drainage, config } = riverFixture();
  const before = structuredClone(terrain);
  assert.equal(erodeRiverLandscape(grid, terrain, drainage, { ...config, fluvialDuration: 0 }), 0);
  assert.deepEqual(terrain, before);
});

test('seasonal overflow increases accessible floodplain deposition without adding sediment', () => {
  const run = (peakFactor: number) => {
    const { grid, terrain, drainage, config } = riverFixture();
    // A fixed terrain and receiver graph isolate inundation from incision and
    // migration. The supplied seasonal peak only changes sediment trapping.
    for (let cell = 0; cell < grid.count; cell++) {
      if (!terrain.ocean[cell]) {
        terrain.bedrock[cell] += Math.max(0, grid.positions[cell * 3 + 1]) * 300;
        terrain.height[cell] = terrain.bedrock[cell];
      }
    }
    drainage.seasonalPeak = Float32Array.from(drainage.discharge, (mean) => mean * peakFactor);
    const before = terrain.height.slice();
    const exported = erodeRiverLandscape(grid, terrain, drainage, { ...config, bankMobility: 0 });
    let balance = exported;
    let removed = 0;
    let deposited = 0;
    for (let cell = 0; cell < grid.count; cell++) {
      const area = grid.areas[cell] * config.radius ** 2;
      balance += (terrain.height[cell] - before[cell]) * area;
      removed += terrain.fluvialIncision[cell] * area;
      if (!terrain.ocean[cell]) {
        deposited += terrain.sediment[cell] * area;
      }
    }
    assert.ok(Math.abs(balance) / removed < 1e-4);
    return { deposited, removed, exported };
  };
  const steady = run(1);
  const seasonal = run(4);
  assert.equal(seasonal.removed, steady.removed);
  assert.ok(
    seasonal.deposited > steady.deposited,
    'floods retain supplied load on accessible banks',
  );
  assert.ok(seasonal.exported < steady.exported);
});

test('confining valley walls bound lateral bank exchange', () => {
  const free = riverFixture();
  evolveRiverBanks(free.grid, free.terrain, free.drainage, free.config);
  const confined = riverFixture();
  confined.drainage.height.fill(0);
  evolveRiverBanks(confined.grid, confined.terrain, confined.drainage, confined.config);
  const total = (data: typeof free) =>
    data.terrain.fluvialIncision.reduce(
      (sum, depth, cell) => sum + depth * data.grid.areas[cell],
      0,
    );
  assert.ok(
    total(confined) < total(free) * 0.5,
    `confined/free removal: ${total(confined) / total(free)}`,
  );
});
