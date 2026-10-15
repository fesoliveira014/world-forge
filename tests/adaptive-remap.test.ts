import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGrid, nearestCell } from '../src/core/grid/build';
import { createRegionSpacing, refineGrid } from '../src/core/grid/refine';
import { classifyWater } from '../src/core/generation/terrain';
import { solveLandWater } from '../src/core/generation/land-water';
import { DEFAULT_CONFIG, YEAR, type Climate, type Grid, type Terrain } from '../src/core/model';
import { normalizeVector, readVector } from '../src/core/math';
import { remapTerrain } from '../src/core/operators/remap';
import { createScalarSampler } from '../src/core/operators/scalar-sampling';
import { generateWorld } from '../src/core/pipeline';

const radius = 1000;

function meshes() {
  const source = buildGrid(2, 'persistent-terrain', 0.8);
  const spacing = createRegionSpacing(500, radius, [
    { center: [1, 0, 0], radiusMetres: 200, targetSpacingMetres: 60 },
  ]);
  const target = refineGrid(source, radius, 'persistent-terrain', spacing);
  return { source, target };
}

function material(grid: Grid): Terrain {
  const bedrock = Float32Array.from(
    { length: grid.count },
    (_, cell) => 300 * grid.positions[3 * cell] - 80,
  );
  const sediment = Float32Array.from({ length: grid.count }, (_, cell) => (cell % 7) ** 2);
  const height = Float32Array.from(bedrock, (value, cell) => value + sediment[cell]);
  return {
    bedrock,
    sediment,
    height,
    surfaceChange: Float32Array.from(bedrock, (_, cell) => -10 - (cell % 13)),
    fluvialIncision: Float32Array.from(bedrock, (_, cell) => 10 + (cell % 13)),
    deltaSediment: Float32Array.from(sediment, (value) => value * 0.25),
    oxbows: [],
    seaThreshold: 125,
    ...classifyWater(grid, height, radius),
  };
}

function volume(field: Float32Array, grid: Grid): number {
  return field.reduce((sum, value, cell) => sum + value * grid.areas[cell] * radius ** 2, 0);
}

test('refine-only terrain remapping preserves sediment and accumulated erosion volumes', () => {
  const { source, target } = meshes();
  const terrain = material(source);
  const original = structuredClone(terrain);
  const result = remapTerrain(source, target, terrain, { radius });
  assert.ok(target.count > source.count);
  assert.ok(
    source.areas.some((area, cell) => Math.abs(target.areas[cell] / area - 1) > 0.1),
    'insertion changes the polygons of retained neighboring sites',
  );
  for (const field of ['sediment', 'fluvialIncision', 'deltaSediment'] as const) {
    assert.equal(result[field].length, target.count);
    assert.ok(result[field].every((value) => value >= 0 && Number.isFinite(value)));
    assert.ok(Math.abs(volume(result[field], target) / volume(terrain[field], source) - 1) < 1e-7);
  }
  assert.ok(result.surfaceChange.every((value) => value <= -10 && value >= -22));
  assert.equal(result.seaThreshold, terrain.seaThreshold);
  for (let cell = 0; cell < target.count; cell++) {
    const closure = result.bedrock[cell] + result.sediment[cell] - result.height[cell];
    assert.ok(
      Math.abs(closure) <=
        Math.max(1, Math.abs(result.bedrock[cell]), result.sediment[cell]) * 2 ** -23,
      'the material interface closes within Float32 rounding without perturbing surface height',
    );
  }
  const water = classifyWater(target, result.height, radius);
  assert.deepEqual(result.ocean, water.ocean);
  assert.deepEqual(result.coastDistance, water.coastDistance);
  assert.notEqual(result.ocean, terrain.ocean);
  assert.deepEqual(terrain, original, 'remapping never mutates the previous material state');
});

test('surface reconstruction preserves previous incision, uniform fields, and height bounds', () => {
  const { source, target } = meshes();
  const terrain = material(source);
  const result = remapTerrain(source, target, terrain, { radius });
  const minimum = Math.min(...terrain.height);
  const maximum = Math.max(...terrain.height);
  assert.ok(result.height.every((value) => value >= minimum && value <= maximum));
  assert.ok(
    result.bedrock.every((value, cell) => Number.isFinite(value) && value <= result.height[cell]),
  );
  assert.deepEqual(result.bedrock.subarray(0, source.count), terrain.bedrock);
  assert.deepEqual(result.surfaceChange.subarray(0, source.count), terrain.surfaceChange);
  terrain.bedrock.fill(850);
  terrain.sediment.fill(0);
  terrain.height.fill(850);
  terrain.surfaceChange.fill(-150);
  terrain.fluvialIncision.fill(150);
  terrain.deltaSediment.fill(0);
  const uniform = remapTerrain(source, target, terrain, { radius });
  assert.ok(uniform.bedrock.every((value) => value === 850));
  assert.ok(uniform.height.every((value) => value === 850));
  assert.ok(uniform.surfaceChange.every((value) => value === -150));
  assert.ok(uniform.fluvialIncision.every((value) => value === 150));
});

test('salt inventories partition across inserted cells and conserve mass again on coarsening', () => {
  const { source, target } = meshes();
  const terrain = material(source);
  // A concentrated basin store beside salt-free land must be split, never copied
  // into every child cell, even when the original sample sites are retained.
  const anchor = nearestCell(source, 1, 0, 0);
  terrain.saltMass = new Float64Array(source.count);
  terrain.saltMass[anchor] = 8.5e12;
  terrain.saltParcels = {
    positions: new Float64Array(source.positions.subarray(anchor * 3, anchor * 3 + 3)),
    masses: new Float64Array([8.5e12]),
  };
  terrain.saltAgeYears = 1200;
  const before = structuredClone(terrain);
  const refined = remapTerrain(source, target, terrain, { radius });
  assert.ok(refined.saltMass instanceof Float64Array);
  assert.equal(refined.saltMass.length, target.count);
  assert.ok(refined.saltMass.filter((mass) => mass > 0).length > 1);
  assert.ok(refined.saltMass.every((mass) => Number.isFinite(mass) && mass >= 0));
  assert.ok(Math.abs(refined.saltMass.reduce((sum, mass) => sum + mass, 0) / 8.5e12 - 1) < 1e-9);
  assert.equal(refined.saltAgeYears, 1200);
  assert.equal(
    refined.saltParcels,
    terrain.saltParcels,
    'immutable geography is shared, never resampled',
  );
  const coarsened = remapTerrain(target, source, refined, { radius });
  assert.ok(Math.abs(coarsened.saltMass!.reduce((sum, mass) => sum + mass, 0) / 8.5e12 - 1) < 1e-9);
  assert.equal(coarsened.saltAgeYears, 1200);
  assert.equal(coarsened.saltParcels, terrain.saltParcels);
  assert.deepEqual(terrain, before, 'the source inventory stays available for rollback');
  const legacy = remapTerrain(source, target, material(source), { radius });
  assert.equal(legacy.saltMass, undefined, 'remeshing cannot invent a missing salt history');
  assert.equal(legacy.saltAgeYears, undefined);
});

function components(grid: Grid, selected: (cell: number) => boolean) {
  const seen = new Uint8Array(grid.count);
  let count = 0;
  for (let cell = 0; cell < grid.count; cell++) {
    if (seen[cell] || !selected(cell)) {
      continue;
    }
    count++;
    seen[cell] = 1;
    const queue = [cell];
    for (let index = 0; index < queue.length; index++) {
      for (let arc = grid.offsets[queue[index]]; arc < grid.offsets[queue[index] + 1]; arc++) {
        const neighbor = grid.neighbors[arc];
        if (!seen[neighbor] && selected(neighbor)) {
          seen[neighbor] = 1;
          queue.push(neighbor);
        }
      }
    }
  }
  return count;
}

test('refining a flat submerged floor preserves its level with heterogeneous conserved sediment', () => {
  const source = buildGrid(3, 'AETHER-6389', 0.65);
  const target = refineGrid(
    source,
    radius,
    'AETHER-6389',
    createRegionSpacing(500, radius, [
      { center: [1, 0, 0], radiusMetres: 180, targetSpacingMetres: 25 },
    ]),
  );
  for (const patchy of [false, true]) {
    const terrain = material(source);
    terrain.height.fill(598);
    terrain.sediment = Float32Array.from({ length: source.count }, (_, cell) =>
      patchy ? 20 + (cell % 7) * 30 : 100 + 50 * source.positions[cell * 3 + 1],
    );
    terrain.bedrock = Float32Array.from(terrain.sediment, (depth) => 598 - depth);
    const result = remapTerrain(source, target, terrain, { radius });
    assert.ok(target.count > source.count);
    assert.ok(
      result.height.every((height) => height === 598),
      'inserted and retained samples share the exact original floor',
    );
    assert.deepEqual(result.bedrock.subarray(0, source.count), terrain.bedrock);
    assert.equal(
      components(target, (cell) => result.height[cell] < 600),
      1,
    );
    assert.equal(
      components(target, (cell) => result.height[cell] >= 600),
      0,
      'refinement creates no islands in the inherited water plane',
    );
    assert.ok(
      Math.abs(volume(result.sediment, target) / volume(terrain.sediment, source) - 1) < 1e-7,
    );
    assert.ok(result.sediment.every((depth) => depth >= 0));
  }

  // A genuine emergent island is retained. Surface preservation must not flatten
  // every cell under a lake label or erase an inherited ridge to fill its holes.
  const island = material(source);
  island.height.fill(598);
  island.sediment = Float32Array.from({ length: source.count }, (_, cell) => 20 + (cell % 7) * 30);
  const peak = nearestCell(source, 1, 0, 0);
  island.height[peak] = 618;
  island.bedrock = Float32Array.from(
    island.height,
    (height, cell) => height - island.sediment[cell],
  );
  const result = remapTerrain(source, target, island, { radius });
  assert.equal(result.height[peak], 618);
  assert.equal(
    components(target, (cell) => result.height[cell] < 600),
    1,
  );
  assert.equal(
    components(target, (cell) => result.height[cell] >= 600),
    1,
    'the genuine island survives without new cellular islands',
  );
});

test('generated evolved terrain retains its continuous height and material inventories after insertion', () => {
  const world = generateWorld({
    ...DEFAULT_CONFIG,
    seed: 'AETHER-6389',
    surfaceLevel: 3,
    processLevel: 3,
    tectonicDuration: 10,
    fluvialDuration: 0.2,
    landscapeBatches: 1,
  });
  let anchor = 0;
  for (let cell = 1; cell < world.grid.count; cell++) {
    if (world.terrain.sediment[cell] > world.terrain.sediment[anchor]) {
      anchor = cell;
    }
  }
  assert.ok(world.terrain.sediment[anchor] > 0);
  const target = refineGrid(
    world.grid,
    world.config.radius,
    world.config.seed,
    createRegionSpacing(world.config.radius * 0.5, world.config.radius, [
      {
        center: readVector(world.grid.positions, anchor),
        radiusMetres: world.config.radius * 0.12,
        targetSpacingMetres: world.config.radius * 0.025,
      },
    ]),
  );
  const original = structuredClone(world.terrain);
  const result = remapTerrain(world.grid, target, world.terrain, world.config);
  const reference = createScalarSampler(world.grid, original.height);
  const priorBedrock = createScalarSampler(world.grid, original.bedrock);
  let previouslyDistorted = 0;
  for (let cell = 0; cell < target.count; cell++) {
    const position = readVector(target.positions, cell);
    assert.equal(result.height[cell], Math.fround(reference(...position)));
    if (
      Math.abs(
        Math.fround(priorBedrock(...position) + result.sediment[cell]) - result.height[cell],
      ) > 1e-4
    ) {
      previouslyDistorted++;
    }
    const closure = result.bedrock[cell] + result.sediment[cell] - result.height[cell];
    assert.ok(
      Math.abs(closure) <=
        Math.max(1, Math.abs(result.bedrock[cell]), result.sediment[cell]) * 2 ** -23,
    );
  }
  assert.ok(
    previouslyDistorted > 20,
    'real evolved materials expose the independent-remap mismatch',
  );
  assert.deepEqual(result.height.subarray(0, world.grid.count), original.height);
  for (const field of ['sediment', 'fluvialIncision', 'deltaSediment'] as const) {
    const before = volume(original[field], world.grid);
    assert.ok(Math.abs(volume(result[field], target) - before) <= Math.max(1, before) * 1e-7);
    assert.ok(result[field].every((depth) => Number.isFinite(depth) && depth >= 0));
  }
  assert.deepEqual(world.terrain, original);
});

test('persistent oxbow anchors relocate together and share a bounded water footprint', () => {
  const { source, target } = meshes();
  const targetCell = source.count;
  const direction = readVector(target.positions, targetCell);
  const nearest = Array.from({ length: source.count }, (_, cell) => cell).sort((first, second) => {
    const score = (cell: number) =>
      direction.reduce((sum, value, axis) => sum + value * source.positions[3 * cell + axis], 0);
    return score(second) - score(first);
  });
  const terrain = material(source);
  terrain.bedrock.fill(200);
  terrain.height.fill(200);
  terrain.sediment.fill(0);
  const targetArea = target.areas[targetCell] * radius ** 2;
  terrain.oxbows = nearest.slice(0, 2).map((cell, index) => {
    const anchor = normalizeVector(
      direction.map((value, axis) => value + 0.001 * source.positions[3 * cell + axis]),
    );
    assert.equal(nearestCell(source, ...anchor), cell);
    assert.equal(nearestCell(target, ...anchor), targetCell);
    return {
      cell,
      points: Float32Array.from([...anchor, ...anchor, ...anchor]),
      area: targetArea * 0.9,
      width: 40,
      capacity: index === 0 ? 0.2 : 0.8,
    };
  });
  const result = remapTerrain(source, target, terrain, { radius });
  assert.equal(result.oxbows.length, 2);
  for (let pond = 0; pond < result.oxbows.length; pond++) {
    assert.equal(result.oxbows[pond].cell, targetCell);
    assert.deepEqual(result.oxbows[pond].points, terrain.oxbows[pond].points);
    assert.notEqual(result.oxbows[pond].points, terrain.oxbows[pond].points);
    assert.equal(result.oxbows[pond].capacity, terrain.oxbows[pond].capacity);
  }
  assert.ok(
    Math.abs(result.oxbows.reduce((sum, pond) => sum + pond.area, 0) / targetArea - 1) < 1e-14,
  );
  const climate = {
    rain: Array.from({ length: 4 }, () => new Float32Array(target.count).fill(600)),
    temperature: Array.from({ length: 4 }, () => new Float32Array(target.count).fill(10)),
    wind: Array.from({ length: 4 }, () => new Float32Array(target.count * 3)),
  } as Climate;
  const identity = Uint32Array.from({ length: target.count }, (_, cell) => cell);
  const water = solveLandWater(
    target,
    target,
    identity,
    climate,
    result,
    { ...DEFAULT_CONFIG, radius },
    result.height,
  );
  for (const season of water.oxbowDepth) {
    assert.ok(Math.abs(season[0] - 0.2) < 1e-7);
    assert.ok(Math.abs(season[1] - 0.8) < 1e-7);
  }
  const expectedRunoff =
    ((water.rain[targetCell] - water.pet[targetCell]) * targetArea * 0.001) / YEAR;
  assert.ok(Math.abs(water.runoff[targetCell] / expectedRunoff - 1) < 1e-7);
  assert.ok(water.residual < 1e-8);
  assert.ok(water.runoff.every((value) => value >= 0 && Number.isFinite(value)));
});
