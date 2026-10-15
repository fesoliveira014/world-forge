import assert from 'node:assert/strict';
import test from 'node:test';
import { Color } from 'three';
import { DEFAULT_CONFIG, type World } from '../src/core/model';
import { generateWorld } from '../src/core/pipeline';
import { prepareWorldView } from '../src/core/view/prepare';
import { PhysicalMeshReader } from '../src/core/view/physical-mesh';
import {
  CATEGORICAL_PHYSICAL_LAYERS,
  PHYSICAL_MATERIAL_FIELD_COUNT,
} from '../src/core/view/physical-mesh-types';
import type { PhysicalMeshPacket } from '../src/core/view/physical-mesh-types';
import type { PageValues } from '../src/core/view/spatial-index';
import { sampleCellColor } from '../src/render/palette';
import { packMaterialFields } from '../src/render/DenseSurface';
import {
  recordAttributes,
  packMaterialAttributes,
  packPhysicalMaterialAttributes,
} from '../src/core/view/material-attributes';
import { LinearColor } from '../src/core/view/linear-color';
import { unpackRecord, RECORD_STRIDE } from '../src/core/view/records';
import type { CellSampleBatch } from '../src/core/view/types';

function fixture(modify?: (world: World) => void) {
  const world = generateWorld({
    ...DEFAULT_CONFIG,
    seed: 'fixed-physical-packets',
    surfaceLevel: 4,
    processLevel: 3,
    tectonicDuration: 5,
    fluvialDuration: 0,
    landscapeBatches: 1,
  });
  modify?.(world);
  const prepared = prepareWorldView(world);
  const root = { world, sidecars: prepared.sidecars };
  const value = (path: string): unknown =>
    path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], root);
  let largestRange = 0;
  const rangePaths = new Set<string>();
  const pages: PageValues = {
    async readValue(path) {
      assert.ok(
        /^sidecars\.view\.(stencils\.faces|records\.blocks)\.\d+$/.test(path) ||
          /^world\.drainage\.lakes\.\d+\.level$/.test(path),
        `never restore a complete world or render archive: ${path}`,
      );
      return structuredClone(value(path));
    },
    async readRange(path, start, count) {
      largestRange = Math.max(largestRange, count);
      rangePaths.add(path);
      const source = value(path) as ArrayLike<number>;
      return Float64Array.from({ length: count }, (_, i) => source[start + i]);
    },
    async readValues(path, ids) {
      const source = value(path) as ArrayLike<number>;
      return Float64Array.from(ids, (id) => source[id]);
    },
  };
  return {
    world,
    prepared,
    reader: new PhysicalMeshReader(pages, prepared.sidecars.view.summary),
    largestRange: () => largestRange,
    rangePaths,
  };
}
const key = (values: ArrayLike<number>, offset: number) =>
  [0, 1, 2].map((axis) => Math.fround(values[offset + axis])).join(',');
function bytes(packet: PhysicalMeshPacket) {
  return [
    packet.directions,
    packet.heights,
    packet.normals,
    packet.colors,
    ...packet.materials,
    packet.indices,
  ].reduce((sum, field) => sum + field.byteLength, 0);
}
function decodeNormal(values: Int16Array, offset: number) {
  let x = values[offset] / 32767;
  let y = values[offset + 1] / 32767;
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
    const previous = x;
    x = (1 - Math.abs(y)) * (x < 0 ? -1 : 1);
    y = (1 - Math.abs(previous)) * (y < 0 ? -1 : 1);
  }
  const norm = Math.hypot(x, y, z);
  return [x / norm, y / norm, z / norm];
}

test('fixed packets retain every physical face and identical shared normals across batch boundaries', async () => {
  const { world, reader, largestRange } = fixture();
  const manifest = await reader.manifest('world', -1);
  assert.ok(manifest.batches > 1);
  assert.equal(manifest.triangles, world.grid.triangles.length / 3);
  assert.equal(manifest.estimatedBytes, world.grid.count * 40 + manifest.triangles * 6);
  const cells = new Map(
    Array.from({ length: world.grid.count }, (_, cell) => [
      key(world.grid.positions, cell * 3),
      cell,
    ]),
  );
  const expected = new Set<string>();
  for (let face = 0; face < world.grid.triangles.length; face += 3) {
    expected.add(
      Array.from(world.grid.triangles.subarray(face, face + 3))
        .sort((a, b) => a - b)
        .join(','),
    );
  }
  const seen = new Set<string>();
  const shared = new Map<number, number[]>();
  let copies = 0;
  let measured = 0;
  for (let batch = 0; batch < manifest.batches; batch++) {
    const packet = await reader.batch('world', -1, batch);
    assert.ok(packet.heights.length <= 65535);
    assert.equal(packet.bytes, bytes(packet));
    assert.equal(packet.materials.length, PHYSICAL_MATERIAL_FIELD_COUNT);
    assert.equal(packet.bytes, packet.heights.length * 40 + packet.indices.byteLength);
    measured += packet.bytes;
    const ids: number[] = [];
    for (let vertex = 0; vertex < packet.heights.length; vertex++) {
      const cell = cells.get(key(packet.directions, vertex * 3));
      assert.notEqual(cell, undefined, 'vertices are original physical sites');
      ids.push(cell!);
      assert.equal(
        packet.heights[vertex],
        Math.fround(world.terrain.height[cell!] + world.drainage.lakeDepth[cell!]),
      );
      const actual = [
        packet.heights[vertex],
        ...packet.normals.subarray(vertex * 2, vertex * 2 + 2),
      ];
      if (shared.has(cell!)) {
        assert.deepEqual(actual, shared.get(cell!));
        copies++;
      } else {
        shared.set(cell!, actual);
      }
      const normal = decodeNormal(packet.normals, vertex * 2);
      assert.ok(normal.every(Number.isFinite));
      const outward = normal.reduce(
        (sum, component, axis) => sum + component * packet.directions[vertex * 3 + axis],
        0,
      );
      assert.ok(outward > 0.9, 'physical normals point outward before exaggeration');
    }
    for (let face = 0; face < packet.indices.length; face += 3) {
      const triangle = Array.from(packet.indices.subarray(face, face + 3), (index) => ids[index])
        .sort((a, b) => a - b)
        .join(',');
      assert.ok(expected.has(triangle));
      assert.ok(!seen.has(triangle), 'physical triangles are neither duplicated nor replaced');
      seen.add(triangle);
    }
  }
  assert.deepEqual(seen, expected);
  assert.equal(shared.size, world.grid.count);
  assert.ok(copies > 10);
  assert.ok(
    measured >= manifest.estimatedBytes,
    'manifest separates lower-bound payload from measured border duplication',
  );
  assert.ok(largestRange() <= 32768);
  const repeated = await reader.batch('world', -1, 0);
  const season = await reader.batch('world', 2, 0);
  assert.deepEqual(season.directions, repeated.directions);
  assert.deepEqual(season.indices, repeated.indices);
  assert.deepEqual(season.normals, repeated.normals);
  assert.notDeepEqual(season.materials, repeated.materials, 'season changes only saved appearance');
});

test('constant-height physical spheres do not exaggerate triangulation bias into false terrain slopes', async () => {
  const { reader } = fixture((world) => {
    world.terrain.height.fill(1500);
    world.drainage.lakeDepth.fill(0);
  });
  const manifest = await reader.manifest('world', -1);
  for (let batch = 0; batch < manifest.batches; batch++) {
    const packet = await reader.batch('world', -1, batch);
    for (let vertex = 0; vertex < packet.heights.length; vertex++) {
      const normal = decodeNormal(packet.normals, vertex * 2);
      const direction = packet.directions.subarray(vertex * 3, vertex * 3 + 3);
      const length = Math.hypot(...direction);
      const error = Math.hypot(
        ...normal.map((component, axis) => component - direction[axis] / length),
      );
      assert.ok(error < 0.000065, 'only oct16 quantization error remains on a level sphere');
    }
  }
});

test('terrain-following categorical layers retain exact dual polygons, water heights and cell colors', async () => {
  const { world, reader, rangePaths } = fixture();
  const cellIds = new Map(
    Array.from({ length: world.grid.count }, (_, cell) => [
      key(world.grid.positions, cell * 3),
      cell,
    ]),
  );
  const cornerIds = new Map(
    Array.from({ length: world.grid.corners.length / 3 }, (_, corner) => [
      key(world.grid.corners, corner * 3),
      corner,
    ]),
  );
  const reference = new Color();
  for (const layer of CATEGORICAL_PHYSICAL_LAYERS) {
    if (layer === 'tectonics') {
      continue;
    }
    for (const season of [-1, 0, 1, 2, 3]) {
      const manifest = await reader.manifest(layer, season);
      assert.equal(manifest.mode, 'dual');
      const fans = new Uint32Array(world.grid.count);
      const seen = new Set<string>();
      for (let batch = 0; batch < manifest.batches; batch++) {
        const packet = await reader.batch(layer, season, batch);
        assert.equal(packet.bytes, bytes(packet));
        assert.ok(packet.heights.length <= 65535);
        assert.equal(packet.materials.length, 0);
        for (let offset = 0; offset < packet.indices.length; offset += 3) {
          const a = packet.indices[offset];
          const b = packet.indices[offset + 1];
          const owner = packet.indices[offset + 2];
          const cell = cellIds.get(key(packet.directions, owner * 3));
          const first = cornerIds.get(key(packet.directions, a * 3));
          const second = cornerIds.get(key(packet.directions, b * 3));
          assert.notEqual(cell, undefined);
          assert.notEqual(first, undefined);
          assert.notEqual(second, undefined);
          const begin = world.grid.offsets[cell!];
          const end = world.grid.offsets[cell! + 1];
          const ring = Array.from(world.grid.cellCorners.subarray(begin, end));
          const index = ring.indexOf(first!);
          assert.ok(index >= 0);
          assert.ok(
            ring[(index + 1) % ring.length] === second ||
              ring[(index + ring.length - 1) % ring.length] === second,
          );
          const identity = `${cell}:${Math.min(first!, second!)}:${Math.max(first!, second!)}`;
          assert.ok(!seen.has(identity));
          seen.add(identity);
          fans[cell!]++;
          assert.equal(
            packet.heights[owner],
            Math.fround(world.terrain.height[cell!] + world.drainage.lakeDepth[cell!]),
          );
          for (const [vertex, corner] of [
            [a, first!],
            [b, second!],
          ]) {
            const lake = world.drainage.lakeId[corner];
            const floor = world.drainage.height[corner];
            const expectedHeight =
              lake >= 0 && world.drainage.lakeFraction[corner] > 0
                ? Math.max(floor, world.drainage.lakes[lake].level)
                : floor;
            assert.equal(packet.heights[vertex], Math.fround(expectedHeight));
          }
          sampleCellColor(world, cell!, layer, season, reference);
          assert.deepEqual(
            Array.from(packet.colors.subarray(owner * 4, owner * 4 + 4)),
            [reference.r, reference.g, reference.b]
              .map((c) => Math.round(Math.max(0, Math.min(1, Math.fround(c))) * 255))
              .concat(255),
          );
        }
      }
      assert.equal(seen.size, manifest.triangles);
      for (let cell = 0; cell < world.grid.count; cell++) {
        assert.equal(fans[cell], world.grid.offsets[cell + 1] - world.grid.offsets[cell]);
      }
    }
  }
  for (const field of [
    'world.grid.positions',
    'world.terrain.height',
    'world.drainage.lakeDepth',
  ]) {
    assert.equal(
      rangePaths.has(field),
      false,
      'already packed cell fields need no second raw-field read',
    );
  }
});

test('tectonic regions retain plate boundaries and complete spherical coverage without reading heights', async () => {
  const { world, reader, rangePaths } = fixture();
  const manifest = await reader.manifest('tectonics', -1);
  assert.equal(manifest.simplified, true);
  const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const expectedBoundaries = new Set<string>();
  const expectedAreas = new Map<string, number>();
  const actualAreas = new Map<string, number>();
  const reference = new Color();
  for (let cell = 0; cell < world.grid.count; cell++) {
    sampleCellColor(world, cell, 'tectonics', -1, reference);
    const color = [reference.r, reference.g, reference.b]
      .map((value) => Math.round(Math.fround(value) * 255))
      .concat(255)
      .join(',');
    expectedAreas.set(color, (expectedAreas.get(color) ?? 0) + world.grid.areas[cell]);
  }
  for (let edge = 0; edge < world.grid.edgeCells.length; edge += 2) {
    if (
      world.geology.plate[world.transfer[world.grid.edgeCells[edge]]] ===
      world.geology.plate[world.transfer[world.grid.edgeCells[edge + 1]]]
    ) {
      continue;
    }
    expectedBoundaries.add(
      edgeKey(
        key(world.grid.corners, world.grid.edgeCorners[edge] * 3),
        key(world.grid.corners, world.grid.edgeCorners[edge + 1] * 3),
      ),
    );
  }
  const edgeColors = new Map<string, Set<string>>();
  let area = 0;
  let triangleCount = 0;
  for (let batch = 0; batch < manifest.batches; batch++) {
    const packet = await reader.batch('tectonics', -1, batch);
    assert.deepEqual(
      packet,
      await reader.batch('tectonics', 2, batch),
      'plate display is season-independent',
    );
    assert.equal(packet.bytes, bytes(packet));
    assert.ok(packet.heights.every((height) => height === 0));
    assert.equal(packet.materials.length, 0);
    assert.equal(packet.normals.length, 0);
    triangleCount += packet.indices.length / 3;
    for (let offset = 0; offset < packet.indices.length; offset += 3) {
      const vertices = Array.from(packet.indices.subarray(offset, offset + 3));
      const color = Array.from(packet.colors.subarray(vertices[2] * 4, vertices[2] * 4 + 4)).join(
        ',',
      );
      const points = vertices.map((vertex) => {
        assert.equal(
          Array.from(packet.colors.subarray(vertex * 4, vertex * 4 + 4)).join(','),
          color,
        );
        const p = Array.from(packet.directions.subarray(vertex * 3, vertex * 3 + 3));
        const length = Math.hypot(...p);
        assert.ok(Math.abs(length - 1) < 1e-6);
        return p.map((value) => value / length);
      });
      const [a, b, c] = points;
      const determinant =
        a[0] * (b[1] * c[2] - b[2] * c[1]) +
        a[1] * (b[2] * c[0] - b[0] * c[2]) +
        a[2] * (b[0] * c[1] - b[1] * c[0]);
      assert.ok(determinant > 0, 'all regions keep outward winding');
      const dot = (p: number[], q: number[]) =>
        p.reduce((sum, value, axis) => sum + value * q[axis], 0);
      const triangleArea = 2 * Math.atan2(determinant, 1 + dot(a, b) + dot(b, c) + dot(c, a));
      area += triangleArea;
      actualAreas.set(color, (actualAreas.get(color) ?? 0) + triangleArea);
      for (let edge = 0; edge < 3; edge++) {
        const identity = edgeKey(
          key(packet.directions, vertices[edge] * 3),
          key(packet.directions, vertices[(edge + 1) % 3] * 3),
        );
        const colors = edgeColors.get(identity) ?? new Set<string>();
        colors.add(color);
        edgeColors.set(identity, colors);
      }
    }
  }
  const actualBoundaries = new Set(
    [...edgeColors].filter(([, colors]) => colors.size > 1).map(([edge]) => edge),
  );
  assert.deepEqual(
    actualBoundaries,
    expectedBoundaries,
    'every plate-border segment stays exact across packet seams',
  );
  assert.ok(Math.abs(area - 4 * Math.PI) < 1e-6, 'regions still cover the sphere once');
  assert.equal(actualAreas.size, expectedAreas.size);
  for (const [color, expected] of expectedAreas) {
    assert.ok(
      Math.abs(actualAreas.get(color)! - expected) < 1e-6,
      'each original plate color covers the same region',
    );
  }
  assert.ok(triangleCount <= manifest.triangles);
  assert.deepEqual([...rangePaths].sort(), [
    'world.geology.plate',
    'world.grid.cornerNeighbors',
    'world.grid.corners',
    'world.grid.positions',
    'world.grid.triangles',
    'world.transfer',
  ]);
});

test('compact vertex material encoding agrees with the established dense-material encoding', () => {
  const { prepared } = fixture();
  const range: [number, number] = [-32768, 32767];
  const actual = Array.from({ length: 6 }, () => new Uint8Array(128 * 4));
  const expected = actual.map((map) => map.slice());
  const physical = Array.from(
    { length: PHYSICAL_MATERIAL_FIELD_COUNT },
    () => new Uint8Array(128 * 4),
  );
  const values = new Float64Array(26);
  const color = new LinearColor();
  const delta = new LinearColor();
  const bank = new LinearColor();
  for (let i = 0; i < 128; i++) {
    recordAttributes(
      unpackRecord(prepared.sidecars.view.records.blocks[0], i * RECORD_STRIDE, i % 4),
      'world',
      i % 4,
      values,
      color,
      delta,
      bank,
    );
    packMaterialAttributes(values, actual, i, range);
    packPhysicalMaterialAttributes(values, physical, i, range);
    const fields = {
      heights: Float32Array.of(values[0]),
      surfaceTerrain: Float32Array.from(values.slice(5, 9)),
      surfaceClimate: Float32Array.from(values.slice(9, 13)),
      surfaceHabitat: Float32Array.from(values.slice(13, 16)),
      surfaceDelta: Float32Array.from(values.slice(16, 20)),
      surfaceWater: Float32Array.from(values.slice(20, 22)),
      surfaceBank: Float32Array.from(values.slice(22, 26)),
    } as CellSampleBatch;
    packMaterialFields(fields, expected, i, range);
  }
  assert.deepEqual(actual, expected);
  assert.deepEqual(physical, expected.slice(0, PHYSICAL_MATERIAL_FIELD_COUNT));
  assert.equal(actual.length, 6, 'legacy dense bank tint remains encoded');
  assert.equal(
    actual.reduce((sum, field) => sum + field.byteLength, 0) -
      physical.reduce((sum, field) => sum + field.byteLength, 0),
    128 * 4,
    'fixed packets omit exactly four unused bytes per vertex',
  );
});
