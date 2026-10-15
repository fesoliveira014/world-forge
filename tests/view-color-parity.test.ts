import assert from 'node:assert/strict';
import test from 'node:test';
import { BufferGeometry, Color } from 'three';
import { DEFAULT_CONFIG, type World } from '../src/core/model';
import { nearestCell } from '../src/core/grid/build';
import { clamp } from '../src/core/math';
import { createScalarStencilSampler } from '../src/core/operators/scalar-sampling';
import { generateWorld } from '../src/core/pipeline';
import { prepareWorldView } from '../src/core/view/prepare';
import {
  packRenderRecords,
  unpackRecord,
  RECORD_STRIDE,
  RECORDS_PER_BLOCK,
} from '../src/core/view/records';
import { LinearColor } from '../src/core/view/linear-color';
import {
  LAYERS as PACKED_LAYERS,
  sampleCellColor as samplePackedColor,
} from '../src/core/view/colors';
import { LAYERS, sampleCellColor } from '../src/render/palette';
import { getDeltaCells } from '../src/render/SurfaceHabitats';
import { updateNaturalSurface } from '../src/render/NaturalSurface';
import type { PageValues } from '../src/core/view/spatial-index';

let generated: World | undefined;
function generatedWorld() {
  generated ??= generateWorld({
    ...DEFAULT_CONFIG,
    seed: 'paged-color-parity',
    surfaceLevel: 3,
    processLevel: 3,
    tectonicDuration: 8,
    fluvialDuration: 0.1,
    landscapeBatches: 1,
  });
  return generated;
}

/** Reuse the generated geography and populate rare display states explicitly.
 * A small planet need not naturally contain every freeze/thaw/shore combination. */
function habitatWorld() {
  const world = structuredClone(generatedWorld());
  const land = Array.from(world.terrain.ocean.keys()).filter((cell) => !world.terrain.ocean[cell]);
  assert.ok(land.length > 10);
  const partial = land[0];
  const full = land[1];
  world.drainage.seasonalLakeCoverage ??= Array.from({ length: 4 }, () =>
    world.drainage.lakeCoverage.slice(),
  );
  world.drainage.lakeCoverage[partial] = 0.5;
  world.drainage.lakeCoverage[full] = 1;
  world.drainage.lakeDepth[partial] = 2;
  world.drainage.lakeDepth[full] = 130;
  for (let season = 0; season < 4; season++) {
    world.drainage.seasonalLakeCoverage[season][partial] = [0, 0.25, 0.75, 1][season];
    world.drainage.seasonalLakeCoverage[season][full] = 1;
    world.water.seasonalTemperature[season][partial] = [-22, -2, 14, 4][season];
    world.water.seasonalTemperature[season][full] = [-18, 0, 12, 2][season];
  }
  world.water.temperature[partial] = -1.5;
  world.water.temperature[full] = -1;
  world.water.snow[partial] = 400;
  world.ecology.biome[land[2]] = 1;
  world.water.snow[land[2]] = 800;
  let mouth = -1;
  for (let corner = 0; corner < world.drainage.receiver.length; corner++) {
    if (world.drainage.receiver[corner] < 0) {
      continue;
    }
    const cells = Array.from(world.grid.triangles.subarray(corner * 3, corner * 3 + 3));
    if (cells.every((cell) => !world.terrain.ocean[cell] && cell !== partial && cell !== full)) {
      mouth = corner;
      cells.forEach((cell, rank) => {
        world.drainage.lakeCoverage[cell] = 0;
        world.terrain.deltaSediment[cell] = 30 - rank * 5;
        world.water.rain[cell] = 1200;
        world.ecology.vegetation[cell] = 0.8;
        for (let season = 0; season < 4; season++) {
          world.drainage.seasonalLakeCoverage![season][cell] = 0;
          world.water.seasonalTemperature[season][cell] = [-20, 4, 25, 10][season];
          world.water.seasonalRain[season][cell] = [80, 240, 700, 180][season];
        }
      });
      break;
    }
  }
  assert.ok(mouth >= 0);
  world.rivers.deltas = [{ corner: mouth, lake: -1, sedimentVolume: 1e10, branches: [] }];
  assert.ok(getDeltaCells(world).includes(1));
  assert.ok(getDeltaCells(world).includes(2));
  return world;
}

function assertColor(
  actual: { r: number; g: number; b: number },
  expected: Color,
  context: string,
) {
  for (const component of ['r', 'g', 'b'] as const) {
    assert.ok(Number.isFinite(actual[component]), `${context}: finite ${component}`);
    assert.ok(
      Math.abs(actual[component] - expected[component]) < 1e-6,
      `${context}: ${component} ${actual[component]} != ${expected[component]}`,
    );
  }
}

function checkPackedPalette(world: World) {
  const prepared = prepareWorldView(world).sidecars.view;
  const actual = new LinearColor();
  const expected = new Color();
  for (const season of [-1, 0, 1, 2, 3]) {
    for (let row = 0; row < prepared.index.cells.length; row++) {
      const cell = prepared.index.cells[row];
      const block = prepared.records.blocks[Math.floor(row / prepared.records.rowsPerBlock)];
      const record = unpackRecord(
        block,
        (row % prepared.records.rowsPerBlock) * RECORD_STRIDE,
        season,
      );
      for (const layer of LAYERS) {
        samplePackedColor(record, layer.id, season, actual);
        sampleCellColor(world, cell, layer.id, season, expected);
        assertColor(actual, expected, `${layer.id}, season ${season}, cell ${cell}`);
      }
    }
  }
}

test('all 29 packed layer palettes match the original generated-world colors in every season', () => {
  assert.equal(LAYERS.length, 29);
  assert.deepEqual(PACKED_LAYERS, LAYERS, 'labels, units and color legends remain identical');
  checkPackedPalette(generatedWorld());
});

test('packed colors preserve partial lakes, frozen water, ice and both seasonal delta tints', () => {
  checkPackedPalette(habitatWorld());
});

test('record block boundaries and absent crust history retain original palette fallbacks', () => {
  const world = structuredClone(generatedWorld());
  delete world.geology.crust;
  const prepared = prepareWorldView(world).sidecars.view;
  const cells = Uint32Array.from(
    { length: RECORDS_PER_BLOCK + 37 },
    (_, row) => (row * 17) % world.grid.count,
  );
  const records = packRenderRecords(
    world,
    cells,
    prepared.strongest,
    prepared.basin,
    prepared.delta,
  );
  assert.equal(records.blocks.length, 2);
  const actual = new LinearColor();
  const expected = new Color();
  for (const row of [0, 1, RECORDS_PER_BLOCK - 1, RECORDS_PER_BLOCK, cells.length - 1]) {
    for (const season of [-1, 0, 1, 2, 3]) {
      const record = unpackRecord(
        records.blocks[Math.floor(row / RECORDS_PER_BLOCK)],
        (row % RECORDS_PER_BLOCK) * RECORD_STRIDE,
        season,
      );
      for (const layer of LAYERS) {
        samplePackedColor(record, layer.id, season, actual);
        sampleCellColor(world, cells[row], layer.id, season, expected);
        assertColor(actual, expected, `${layer.id}, season ${season}, block row ${row}`);
      }
    }
  }
});

function memoryPages(root: unknown): PageValues {
  const valueAt = (path: string) => {
    let value = root;
    for (const key of path.split('.')) {
      value = (value as Record<string, unknown>)[key];
    }
    return value;
  };
  return {
    async readValue(path) {
      return structuredClone(valueAt(path));
    },
    async readValues(path, indices) {
      const values = valueAt(path) as ArrayLike<number>;
      return Float64Array.from(indices, (index) => values[index]);
    },
    async readRange(path, start, count) {
      const values = valueAt(path) as ArrayLike<number>;
      return Float64Array.from({ length: count }, (_, offset) => values[start + offset]);
    },
  };
}

const naturalAttributes = [
  'surfaceTerrain',
  'surfaceClimate',
  'surfaceHabitat',
  'surfaceDelta',
  'surfaceWater',
] as const;

function blendedDirection(world: World, cells: ArrayLike<number>, weights: number[]) {
  const point = [0, 0, 0];
  for (let vertex = 0; vertex < cells.length; vertex++) {
    for (let axis = 0; axis < 3; axis++) {
      point[axis] += world.grid.positions[cells[vertex] * 3 + axis] * weights[vertex];
    }
  }
  const length = Math.hypot(...point);
  return point.map((value) => value / length);
}

function naturalQueries(world: World) {
  const points = Array.from(world.grid.positions);
  let coastInteriors = 0;
  let lakeInteriors = 0;
  for (let face = 0; face < world.grid.triangles.length / 3; face++) {
    const cells = world.grid.triangles.subarray(face * 3, face * 3 + 3);
    const coast = cells.some((cell) => world.terrain.ocean[cell] !== world.terrain.ocean[cells[0]]);
    const lake = cells.some((cell) => world.drainage.lakeCoverage[cell] > 0);
    if (coast || lake || face % 19 === 0) {
      points.push(...blendedDirection(world, cells, [0.2, 0.35, 0.45]));
      coastInteriors += coast ? 1 : 0;
      lakeInteriors += lake ? 1 : 0;
    }
  }
  assert.ok(coastInteriors > 0, 'queries include interiors of mixed ocean/land triangles');
  return { directions: Float32Array.from(points), lakeInteriors };
}

test('paged Natural fields reproduce original Float32 vertex interpolation in every season', async () => {
  const { WorldViewReader } = await import('../src/core/view/reader');
  for (const world of [generatedWorld(), habitatWorld()]) {
    const prepared = prepareWorldView(world);
    const reader = await WorldViewReader.open(memoryPages({ world, sidecars: prepared.sidecars }));
    const { directions, lakeInteriors } = naturalQueries(world);
    if (world !== generatedWorld()) {
      assert.ok(lakeInteriors > 0, 'rare habitat fixture exercises interpolated lake coverage');
    }
    const geometry = new BufferGeometry();
    const locate = createScalarStencilSampler(world.grid);
    const heights = Float32Array.from(
      world.terrain.height,
      (height, cell) => height + world.drainage.lakeDepth[cell],
    );
    const bankLand = Float32Array.from(world.terrain.ocean, (ocean, cell) =>
      ocean ? 0 : 1 - clamp(world.drainage.lakeCoverage[cell]),
    );
    const vertexColors = new Float32Array(world.grid.count * 3);
    const color = new Color();
    for (const season of [-1, 0, 1, 2, 3]) {
      const sample = await reader.sample(directions, 'world', season);
      updateNaturalSurface(geometry, world, season);
      assert.deepEqual(
        sample.cellIds.subarray(0, world.grid.count),
        Uint32Array.from({ length: world.grid.count }, (_, cell) => cell),
      );
      for (let cell = 0; cell < world.grid.count; cell++) {
        sampleCellColor(world, cell, 'world', season, color);
        vertexColors.set([color.r, color.g, color.b], cell * 3);
      }
      const attributes = [
        ...naturalAttributes.map((name) => ({
          name,
          original: geometry.getAttribute(name).array,
          size: geometry.getAttribute(name).itemSize,
          actual: sample[name],
        })),
        { name: 'heights', original: heights, size: 1, actual: sample.heights },
        { name: 'bankLand', original: bankLand, size: 1, actual: sample.bankLand },
        { name: 'colors', original: vertexColors, size: 3, actual: sample.colors },
      ];
      for (const attribute of attributes) {
        assert.equal(attribute.actual.length, (directions.length / 3) * attribute.size);
      }
      for (let query = 0; query < directions.length / 3; query++) {
        const x = directions[query * 3];
        const y = directions[query * 3 + 1];
        const z = directions[query * 3 + 2];
        const norm = Math.hypot(x, y, z);
        const stencil = locate(x / norm, y / norm, z / norm);
        for (const attribute of attributes) {
          for (let component = 0; component < attribute.size; component++) {
            let expected = 0;
            let scale = 1;
            for (let vertex = 0; vertex < 3; vertex++) {
              const value = attribute.original[stencil.cells[vertex] * attribute.size + component];
              expected += value * stencil.weights[vertex];
              scale = Math.max(scale, Math.abs(value));
            }
            const actual = attribute.actual[query * attribute.size + component];
            // One Float32 rounding unit allows a different cyclic face ordering.
            // The expected value uses actual query coordinates, never a looser
            // comparison with the nearest site's un-interpolated field.
            assert.ok(
              Math.abs(actual - Math.fround(expected)) <= scale * 1.2e-7,
              `${attribute.name}, season ${season}, query ${query}, component ${component}: ${actual} != ${Math.fround(expected)}`,
            );
          }
        }
      }
      // surfaceBank deliberately approximates the former rasterized corridor
      // texture; it is not included in the exact material-field comparison.
    }
    geometry.dispose();
  }
});

test('Natural shore fields remain continuous across nearest-cell ownership boundaries', async () => {
  const { WorldViewReader } = await import('../src/core/view/reader');
  const world = generatedWorld();
  const prepared = prepareWorldView(world);
  const reader = await WorldViewReader.open(memoryPages({ world, sidecars: prepared.sidecars }));
  const epsilon = 1e-4;
  let directions: Float32Array | undefined;
  let owners: number[] = [];
  for (let face = 0; face < world.grid.triangles.length / 3 && !directions; face++) {
    const cells = world.grid.triangles.subarray(face * 3, face * 3 + 3);
    for (let vertex = 0; vertex < 3; vertex++) {
      const first = cells[vertex];
      const second = cells[(vertex + 1) % 3];
      if (
        world.terrain.ocean[first] === world.terrain.ocean[second] ||
        world.drainage.lakeCoverage[first] > 0 ||
        world.drainage.lakeCoverage[second] > 0
      ) {
        continue;
      }
      const candidate = Float32Array.from(
        [0.5 - epsilon, 0.5, 0.5 + epsilon].flatMap((weight) =>
          blendedDirection(world, [first, second], [1 - weight, weight]),
        ),
      );
      const left = nearestCell(world.grid, candidate[0], candidate[1], candidate[2]);
      const right = nearestCell(world.grid, candidate[6], candidate[7], candidate[8]);
      if (left === first && right === second) {
        directions = candidate;
        owners = [first, second];
        break;
      }
    }
  }
  assert.ok(directions, 'a real coastal edge crosses two nearest-cell ownership regions');
  const sample = await reader.sample(directions, 'world', -1);
  assert.equal(sample.cellIds[0], owners[0]);
  assert.equal(sample.cellIds[2], owners[1]);
  for (const [name, stride, component] of [
    ['surfaceTerrain', 4, 1],
    ['surfaceWater', 2, 0],
    ['bankLand', 1, 0],
  ] as const) {
    const values = sample[name];
    assert.ok(Math.abs(values[stride + component] - 0.5) < 1e-6, `${name}: mixed shore midpoint`);
    assert.ok(
      Math.abs(values[component] - values[2 * stride + component]) < 3 * epsilon,
      `${name}: crossing ownership must not create a full land/water step`,
    );
  }
  const geometry = new BufferGeometry();
  updateNaturalSurface(geometry, world, -1);
  for (const name of naturalAttributes) {
    const original = geometry.getAttribute(name);
    for (let component = 0; component < original.itemSize; component++) {
      const first = original.array[owners[0] * original.itemSize + component];
      const second = original.array[owners[1] * original.itemSize + component];
      const scale = Math.max(1, Math.abs(first), Math.abs(second));
      assert.ok(
        Math.abs(sample[name][original.itemSize + component] - (first + second) / 2) < scale * 1e-6,
        `${name}: midpoint reproduces original linear vertex field`,
      );
    }
  }
  geometry.dispose();
  const diagnostic = await reader.sample(directions, 'biomes', -1);
  const color = new Color();
  for (let query = 0; query < 3; query++) {
    sampleCellColor(world, diagnostic.cellIds[query], 'biomes', -1, color);
    assertColor(
      {
        r: diagnostic.colors[query * 3],
        g: diagnostic.colors[query * 3 + 1],
        b: diagnostic.colors[query * 3 + 2],
      },
      color,
      `diagnostic palette retains nearest ownership at boundary query ${query}`,
    );
  }
});
