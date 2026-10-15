import assert from 'node:assert/strict';
import test from 'node:test';
import { generateWorld } from '../src/core/pipeline';
import { DEFAULT_CONFIG } from '../src/core/model';
import type { Vec3 } from '../src/core/math';
import { evaluateFertilityCell } from '../src/core/generation/fertility';
import {
  lakeAtCell,
  lakeCoverageAt,
  lakeWaterDescription,
} from '../src/core/generation/lake-state';
import { prepareWorldView, FERTILITY_FIELDS } from '../src/core/view/prepare';
import { WorldViewReader } from '../src/core/view/reader';
import { MissingSnapshotFieldError } from '../src/core/storage';
import {
  buildSpatialIndex,
  PagedSpatialIndex,
  type PageValues,
} from '../src/core/view/spatial-index';

function memoryPages(root: unknown) {
  const reads: { path: string; count: number }[] = [];
  const objectReads: string[] = [];
  const value = (path: string): unknown =>
    path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], root);
  const pages: PageValues = {
    async readValues(path, indices) {
      reads.push({ path, count: indices.length });
      const source = value(path) as ArrayLike<number>;
      return Float64Array.from(indices, (index) => source[index]);
    },
    async readRange(path, start, count) {
      reads.push({ path, count });
      assert.ok(count >= 0 && Number.isSafeInteger(count));
      const source = value(path) as ArrayLike<number>;
      assert.ok(start + count <= source.length, `${path} requested beyond field`);
      return Float64Array.from({ length: count }, (_, index) => source[start + index]);
    },
    async readValue(path) {
      // Every cold display request names only a small metadata object, one sparse
      // feature, or one independently paged render block.
      assert.ok(
        path !== 'world' &&
          path !== 'world.grid' &&
          path !== 'sidecars.view' &&
          path !== 'sidecars.view.records.blocks',
        `Unbounded restore: ${path}`,
      );
      objectReads.push(path);
      const result = value(path);
      if (result === undefined) {
        throw new MissingSnapshotFieldError(path);
      }
      return structuredClone(result);
    },
  };
  return { pages, reads, objectReads };
}

function exhaustive(positions: Float64Array, point: Vec3) {
  const norm = Math.hypot(...point);
  const p = point.map((value) => value / norm);
  let nearest = -1;
  let best = Infinity;
  for (let cell = 0; cell < positions.length / 3; cell++) {
    const distance = p.reduce(
      (sum, value, axis) => sum + (value - positions[cell * 3 + axis]) ** 2,
      0,
    );
    if (distance < best) {
      best = distance;
      nearest = cell;
    }
  }
  return nearest;
}

test('saved spatial queries stay exact at poles/dateline and evict leaf pages', async () => {
  const count = 32768;
  const positions = new Float64Array(count * 3);
  for (let cell = 0; cell < count; cell++) {
    const y = 1 - (2 * (cell + 0.5)) / count;
    const angle = cell * Math.PI * (3 - Math.sqrt(5));
    const radius = Math.sqrt(1 - y * y);
    positions.set([radius * Math.cos(angle), y, radius * Math.sin(angle)], cell * 3);
  }
  const index = buildSpatialIndex(positions);
  const { pages, reads } = memoryPages({ sidecars: { view: { index } } });
  const reader = new PagedSpatialIndex(pages);
  const probes: Vec3[] = [
    [0, 1, 0],
    [0, -1, 0],
    [-1, 0, 1e-12],
    [-1, 0, -1e-12],
    [1, 0, 0],
  ];
  for (let i = 0; i < 200; i++) {
    probes.push([Math.cos(i * 1.77), Math.sin(i * 2.59), Math.cos(i * 0.379)]);
  }
  for (const point of probes) {
    assert.equal(await reader.nearest(point), exhaustive(positions, point));
  }
  // Visit every saved leaf, forcing the 128-leaf LRU to replace old entries.
  for (let node = 0; node < index.nodes.length / 10; node++) {
    if (index.nodes[node * 10 + 8] < 0) {
      const row = index.nodes[node * 10 + 6];
      const point = Array.from(index.positions.subarray(row * 3, row * 3 + 3)) as Vec3;
      assert.equal(await reader.nearest(point), index.cells[row]);
    }
  }
  assert.equal(reader.cachedLeaves, 128);
  assert.ok(reader.cachedNodes <= 4096);
  assert.ok(
    reads.every((read) => read.count <= 384),
    'only individual nodes/leaves were loaded',
  );
  await assert.rejects(() => reader.nearest([0, 0, 0]), /finite nonzero/);
  await assert.rejects(() => reader.nearest([NaN, 1, 0]), /finite nonzero/);
});

test('cold detailed inspection and resource pages preserve physical diagnostics', async () => {
  const world = generateWorld({
    ...DEFAULT_CONFIG,
    seed: 'cold-inspection-parity',
    surfaceLevel: 3,
    processLevel: 3,
    tectonicDuration: 5,
    fluvialDuration: 0.15,
    landscapeBatches: 1,
  });
  const before = world.terrain.height.slice();
  const prepared = prepareWorldView(world);
  assert.deepEqual(
    world.terrain.height,
    before,
    'view preparation does not mutate physical terrain',
  );
  const { pages, reads, objectReads } = memoryPages({ world, ...prepared });
  const reader = await WorldViewReader.open(pages);
  assert.equal(reader.handle.summary.surfaceCells, world.grid.count);
  const selected = new Set<number>([0, world.grid.count - 1]);
  for (let cell = 0; cell < world.grid.count; cell += 31) {
    selected.add(cell);
  }
  for (const pond of world.terrain.oxbows) {
    selected.add(pond.cell);
  }
  for (const cell of selected) {
    const point = Array.from(world.grid.positions.subarray(cell * 3, cell * 3 + 3)) as Vec3;
    const season = (cell % 5) - 1;
    const result = await reader.inspect(point, season);
    const fertility = evaluateFertilityCell(world, cell);
    assert.equal(result.cell, cell);
    assert.equal(result.height, world.terrain.height[cell]);
    assert.equal(result.bedrock, world.terrain.bedrock[cell]);
    assert.equal(
      result.rain,
      season < 0 ? world.water.rain[cell] : world.water.seasonalRain[season][cell],
    );
    assert.equal(
      result.temperature,
      season < 0 ? world.water.temperature[cell] : world.water.seasonalTemperature[season][cell],
    );
    assert.equal(result.lakeCoverage, lakeCoverageAt(world.drainage, cell, season));
    assert.equal(result.areaM2, world.grid.areas[cell] * world.config.radius ** 2);
    assert.equal(result.storedCellFertility, world.resources.fertility[cell]);
    for (const field of FERTILITY_FIELDS) {
      assert.equal(result.fertility[field], Math.fround(fertility[field]), `fertility ${field}`);
    }
    assert.equal(result.fertility.soilSalinity, fertility.soilSalinity);
    assert.equal(result.fertility.salineFraction, fertility.salineFraction);
    assert.equal(result.fertility.salinityLimit, fertility.salinityLimit);
    assert.deepEqual(result.fertility.limitations, fertility.limitations);
    const wetLake = lakeAtCell(world.grid, world.drainage, cell);
    if (wetLake || !result.lake) {
      assert.deepEqual(result.lake, wetLake ?? null);
    } else {
      assert.equal(result.lake.area, 0);
      assert.ok((result.lake.salinity?.bedSalt ?? 0) > 0, 'dry salt basins remain inspectable');
    }
    const corners = world.grid.cellCorners.subarray(
      world.grid.offsets[cell],
      world.grid.offsets[cell + 1],
    );
    assert.equal(result.outline.length, corners.length * 3);
    let strongest = -1;
    for (const corner of corners) {
      if (
        world.rivers.channel[corner] &&
        (strongest < 0 || world.drainage.discharge[corner] > world.drainage.discharge[strongest])
      ) {
        strongest = corner;
      }
    }
    assert.equal(result.river?.corner ?? -1, strongest);
    if (result.river) {
      assert.equal(result.river.discharge, world.drainage.discharge[strongest]);
      assert.deepEqual(
        result.river.seasonalDischarge,
        world.rivers.seasonalDischarge.map((field) => field[strongest]),
      );
      assert.deepEqual(
        result.river.sourceFractions,
        world.rivers.sourceFractions.map((field) => field[strongest]),
      );
    }
  }
  for (const filter of ['all', 'copper', 'tin', 'iron', 'gold', 'corundum'] as const) {
    const expected = world.resources.deposits.filter(
      (deposit) => filter === 'all' || deposit.resourceType === filter,
    );
    const actual = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page = await reader.listDeposits(filter, cursor, 3);
      assert.equal(page.total, expected.length);
      actual.push(...page.items);
      cursor = page.nextCursor;
    }
    assert.deepEqual(actual, expected);
  }
  for (const deposit of world.resources.deposits.slice(0, 5)) {
    const inspection = await reader.inspectDeposit(deposit.id);
    assert.ok(inspection);
    assert.deepEqual(inspection.deposit, deposit);
    assert.equal(inspection.cell, exhaustive(world.grid.positions, deposit.anchor));
  }
  assert.equal(await reader.inspectDeposit('not-a-deposit'), null);
  await assert.rejects(() => reader.listDeposits('all', 0, 10000), /1–200/);
  await assert.rejects(() => reader.sample(new Float32Array(60003), 'world', -1), /20,000/);
  const direction = Float32Array.from(world.grid.positions.subarray(0, 3));
  const first = await reader.sample(direction, 'world', 0);
  const original = first.colors.slice();
  structuredClone(first, { transfer: [first.colors.buffer] });
  const second = await reader.sample(direction, 'world', 0);
  assert.deepEqual(
    second.colors,
    original,
    'transferring renderer packets never detaches cached records',
  );
  assert.ok(
    reads.every(
      (read) => read.count <= (read.path === 'sidecars.view.index.positions' ? 6144 : 384),
    ),
    'inspection and sampling load bounded physical subsets',
  );
  assert.ok(
    objectReads.every((path) => !path.startsWith('world.grid.')),
    'no cold full-grid restoration',
  );
});

test('salt inspection stays bounded and older snapshots retain unknown salt state', async () => {
  const world = generateWorld({
    ...DEFAULT_CONFIG,
    seed: 'salt-reader-compatibility',
    surfaceLevel: 3,
    processLevel: 3,
    tectonicDuration: 0,
    fluvialDuration: 0,
    landscapeBatches: 1,
  });
  const cell = Array.from({ length: world.grid.count }, (_, index) => index).find(
    (index) =>
      !world.terrain.ocean[index] &&
      world.ecology.biome[index] !== 1 &&
      world.drainage.lakeCoverage[index] < 0.5,
  )!;
  assert.ok(Number.isInteger(cell));
  world.drainage.soilSalinity = new Float32Array(world.grid.count);
  world.drainage.soilSalinityFraction = new Float32Array(world.grid.count);
  world.drainage.riverSalinity = new Float32Array(world.drainage.receiver.length).fill(7.5);
  world.drainage.soilSalinity[cell] = 35;
  world.drainage.soilSalinityFraction[cell] = 0.2;
  const point = Array.from(world.grid.positions.subarray(cell * 3, cell * 3 + 3)) as Vec3;
  const prepared = prepareWorldView(world);
  const source = memoryPages({ world, ...prepared });
  const reader = await WorldViewReader.open(source.pages);
  const modeled = await reader.inspect(point, 2);
  assert.equal(modeled.soilSalinity, 35);
  assert.equal(modeled.soilSalinityFraction, Math.fround(0.2));
  assert.equal(modeled.fertility.soilSalinity, 35);
  assert.ok(modeled.fertility.salinityLimit < 0.81);
  assert.ok(modeled.fertility.limitations.includes('Saline soil'));
  assert.deepEqual(modeled.fertility.limitations, evaluateFertilityCell(world, cell).limitations);
  const channelCell = prepared.sidecars.view.strongest.findIndex((corner) => corner >= 0);
  if (channelCell >= 0) {
    const channelPoint = Array.from(
      world.grid.positions.subarray(channelCell * 3, channelCell * 3 + 3),
    ) as Vec3;
    assert.equal((await reader.inspect(channelPoint, -1)).river?.salinity, 7.5);
  }
  assert.ok(
    source.reads.filter((read) => /Salinity/.test(read.path)).every((read) => read.count === 1),
  );
  assert.ok(
    source.objectReads.every((path) => !/world\.drainage\.(soil|river)Salinity/.test(path)),
    'salt arrays are never restored in full',
  );

  const dryWorld = structuredClone(world);
  const basinCorner = dryWorld.drainage.lakeId.findIndex((id) => id >= 0);
  assert.ok(basinCorner >= 0, 'fixture has a lake basin');
  const dryLake = dryWorld.drainage.lakes[dryWorld.drainage.lakeId[basinCorner]];
  dryLake.area = 0;
  dryLake.storage = 0;
  dryLake.salinity = {
    concentration: 0,
    dissolvedSalt: 0,
    bedSalt: 1e6,
    inflowSalt: 0,
    outflowSalt: 0,
    elapsedYears: 100,
  };
  dryWorld.drainage.lakeFraction.fill(0);
  const dryCell = dryWorld.grid.triangles[basinCorner * 3];
  assert.equal(
    lakeAtCell(dryWorld.grid, dryWorld.drainage, dryCell),
    undefined,
    'a dry salt bed is not treated as an active wet shoreline',
  );
  const drySource = memoryPages({ world: dryWorld, ...prepareWorldView(dryWorld) });
  const dryReader = await WorldViewReader.open(drySource.pages);
  const dryPoint = Array.from(
    dryWorld.grid.positions.subarray(dryCell * 3, dryCell * 3 + 3),
  ) as Vec3;
  const dryInspection = await dryReader.inspect(dryPoint, -1);
  assert.equal(dryInspection.lake?.id, dryLake.id);
  assert.equal(lakeWaterDescription(dryInspection.lake!), 'Dry basin · salt deposits');

  // Emulate the pre-salt archive: its packed render rows and fertility rows are
  // identical layouts, but neither raw salt arrays nor the marker exist.
  delete world.drainage.soilSalinity;
  delete world.drainage.soilSalinityFraction;
  delete world.drainage.riverSalinity;
  for (const lake of world.drainage.lakes) {
    delete lake.salinity;
  }
  const legacyPrepared = prepareWorldView(world);
  Reflect.deleteProperty(legacyPrepared.sidecars.view, 'salinityFields');
  const legacySource = memoryPages({ world, ...legacyPrepared });
  const legacy = await WorldViewReader.open(legacySource.pages);
  const unknown = await legacy.inspect(point, 2);
  assert.equal(unknown.height, modeled.height);
  assert.equal(unknown.soilSalinity, null);
  assert.equal(unknown.soilSalinityFraction, null);
  assert.equal(unknown.fertility.soilSalinity, 0);
  assert.equal(unknown.fertility.salineFraction, 0);
  assert.equal(unknown.fertility.salinityLimit, 1);
  assert.ok(!unknown.fertility.limitations.includes('Saline soil'));
  assert.ok(!legacySource.reads.some((read) => /Salinity/.test(read.path)));

  const failedPages: PageValues = {
    ...source.pages,
    async readValue(path) {
      if (path === 'sidecars.view.salinityFields') {
        throw new Error('Snapshot storage failed');
      }
      return source.pages.readValue(path);
    },
  };
  await assert.rejects(
    WorldViewReader.open(failedPages),
    /Snapshot storage failed/,
    'I/O failures must not be mistaken for an old snapshot without salt data',
  );
});
