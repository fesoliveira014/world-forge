import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { serialize } from 'node:v8';
import test from 'node:test';
import { Color } from 'three';
import { DEFAULT_CONFIG, type Layer, type World } from '../src/core/model';
import { generateWorld } from '../src/core/pipeline';
import { refineExistingWorld } from '../src/core/regional-refinement';
import { prepareWorldView } from '../src/core/view/prepare';
import { PhysicalMeshReader } from '../src/core/view/physical-mesh';
import type { PageValues } from '../src/core/view/spatial-index';
import { sampleCellColor } from '../src/render/palette';

const layers = ['drainage', 'sources', 'biomes', 'wetlands'] as const;
const key = (values: ArrayLike<number>, offset: number) =>
  [0, 1, 2].map((axis) => Math.fround(values[offset + axis])).join(',');
const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const faceKey = (a: string, b: string, c: string) => [a, b, c].sort().join('|');
const digest = (value: unknown) => createHash('sha256').update(serialize(value)).digest('hex');

function fixture() {
  // A genuinely dense physical cap is cheaper than generating a globally dense
  // world. Its ~0.086-degree spacing admits new edges below the 0.5-degree bound.
  const base = generateWorld({
    ...DEFAULT_CONFIG,
    seed: 'categorical-regions-reader',
    surfaceLevel: 3,
    processLevel: 3,
    tectonicDuration: 0,
    fluvialDuration: 0,
    landscapeBatches: 1,
  });
  const world = refineExistingWorld(base, {
    kind: 'region',
    center: [1, 0, 0],
    radiusMetres: base.config.radius * 0.025,
    targetSpacingMetres: base.config.radius * 0.0015,
  });
  const { grid, drainage, terrain, ecology, rivers, water } = world;
  assert.ok(grid.count > 2500 && grid.count < 5000);
  const mountain = (x: number, y: number, z: number) => x > 0.998 && y > 0.006 && z > 0.006;
  const lakeDistance = (y: number, z: number) => Math.hypot(y - 0.007, z + 0.007);
  const floor = (x: number, y: number, z: number) =>
    y < -0.007
      ? -1000 - 300 * z
      : mountain(x, y, z)
        ? 420 + (y - 0.006) * 200000
        : x > 0.998 && lakeDistance(y, z) < 0.006
          ? 320
          : 420;
  const template = drainage.lakes[0];
  assert.ok(template);
  drainage.lakes = [0, 1].map((id) => ({ ...template, id, level: 420, area: 1e6 }));
  drainage.lakeDepth.fill(0);
  drainage.lakeCoverage.fill(0);
  drainage.lakeId.fill(-1);
  drainage.lakeFraction.fill(0);
  for (const coverage of drainage.seasonalLakeCoverage!) {
    coverage.fill(0);
  }
  rivers.channel.fill(0);
  rivers.deltas = [];
  terrain.oxbows = [];
  for (let corner = 0; corner < grid.corners.length / 3; corner++) {
    const [x, y, z] = grid.corners.subarray(corner * 3, corner * 3 + 3);
    drainage.height[corner] = floor(x, y, z);
    drainage.discharge[corner] = 10 + (corner % 7);
    // Full system identity differs while its modulo-64 display color is identical.
    rivers.system[corner] = y > 0 ? 64 : 0;
    rivers.source[corner] = y > 0.012 ? 1 : 2;
    rivers.channel[corner] = Number(x > 0.998 && y > 0 && z < -0.017);
    if (x > 0.998 && lakeDistance(y, z) < 0.006) {
      drainage.lakeId[corner] = z < -0.007 ? 0 : 1;
      drainage.lakeFraction[corner] = lakeDistance(y, z) < 0.004 ? 1 : 0.5;
    }
  }
  for (let cell = 0; cell < grid.count; cell++) {
    const [x, y, z] = grid.positions.subarray(cell * 3, cell * 3 + 3);
    terrain.height[cell] = floor(x, y, z);
    terrain.ocean[cell] = Number(y < -0.007);
    ecology.biome[cell] = terrain.ocean[cell] ? 0 : z > 0.007 ? 8 : 4;
    ecology.wetland[cell] = z < -0.012 ? 2 : 0;
    ecology.wetlandFraction[cell] = ecology.wetland[cell] ? 0.6 : 0;
    water.temperature[cell] = 10;
    for (let season = 0; season < 4; season++) {
      water.seasonalTemperature[season][cell] = season === 0 ? -12 : 15;
    }
    if (x > 0.998 && lakeDistance(y, z) < 0.006) {
      drainage.lakeDepth[cell] = 100;
      drainage.lakeCoverage[cell] = lakeDistance(y, z) < 0.004 ? 1 : 0.45;
      for (let season = 0; season < 4; season++) {
        drainage.seasonalLakeCoverage![season][cell] =
          drainage.lakeCoverage[cell] * [0.25, 0.6, 1, 0.8][season];
      }
    }
  }
  const prepared = prepareWorldView(world);
  const source = { world, sidecars: prepared.sidecars };
  const value = (path: string): unknown =>
    path
      .split('.')
      .reduce<unknown>((node, name) => (node as Record<string, unknown>)[name], source);
  const pages: PageValues = {
    async readValue(path) {
      assert.ok(
        /^sidecars\.view\.records\.blocks\.\d+$/.test(path) ||
          /^world\.drainage\.lakes\.\d+\.level$/.test(path),
        `bounded reader value: ${path}`,
      );
      return structuredClone(value(path));
    },
    async readRange(path, start, count) {
      assert.ok(count <= 32768, 'reader requests stay bounded');
      const field = value(path) as ArrayLike<number>;
      return Float64Array.from({ length: count }, (_, i) => field[start + i]);
    },
    async readValues(path, ids) {
      const field = value(path) as ArrayLike<number>;
      return Float64Array.from(ids, (id) => field[id]);
    },
  };
  const cellKeys = Array.from({ length: grid.count }, (_, cell) => key(grid.positions, cell * 3));
  const cornerKeys = Array.from({ length: grid.corners.length / 3 }, (_, corner) =>
    key(grid.corners, corner * 3),
  );
  const heights = new Map<string, number>();
  cellKeys.forEach((point, cell) =>
    heights.set(point, Math.fround(terrain.height[cell] + drainage.lakeDepth[cell])),
  );
  cornerKeys.forEach((point, corner) => {
    const lake = drainage.lakeId[corner];
    heights.set(
      point,
      Math.fround(
        lake >= 0 && drainage.lakeFraction[corner] > 0
          ? Math.max(drainage.height[corner], drainage.lakes[lake].level)
          : drainage.height[corner],
      ),
    );
  });
  return {
    world,
    prepared,
    source,
    reader: new PhysicalMeshReader(pages, prepared.summary),
    before: digest(source),
    cellKeys,
    cornerKeys,
    heights,
  };
}
let shared: ReturnType<typeof fixture> | undefined;
const getFixture = () => (shared ??= fixture());

function colors(world: World, layer: Layer, season: number) {
  const color = new Color();
  return Array.from({ length: world.grid.count }, (_, cell) => {
    sampleCellColor(world, cell, layer, season, color);
    return [color.r, color.g, color.b]
      .map((value) => Math.round(Math.max(0, Math.min(1, Math.fround(value))) * 255))
      .concat(255)
      .join(',');
  });
}
function triangleArea(values: Float32Array, a: number, b: number, c: number) {
  const vectors = [a, b, c].map((index) => {
    const p = Array.from(values.subarray(index * 3, index * 3 + 3));
    const length = Math.hypot(...p);
    return p.map((value) => value / length);
  });
  const [x, y, z] = vectors;
  const determinant =
    x[0] * (y[1] * z[2] - y[2] * z[1]) +
    x[1] * (y[2] * z[0] - y[0] * z[2]) +
    x[2] * (y[0] * z[1] - y[1] * z[0]);
  assert.ok(determinant > 0, 'every retained triangle winds outward');
  const dot = (p: number[], q: number[]) => p.reduce((sum, value, i) => sum + value * q[i], 0);
  return 2 * Math.atan2(determinant, 1 + dot(x, y) + dot(y, z) + dot(z, x));
}

for (const layer of layers) {
  test(`${layer} reader simplifies dense flat interiors while retaining heights, boundaries, and seasonal water colors`, async () => {
    const { world, prepared, reader, source, before, cellKeys, cornerKeys, heights } = getFixture();
    const { grid, terrain, drainage } = world;
    const annualColors = colors(world, layer, -1);
    let changedWaterColor = false;
    for (const season of [-1, 0, 1, 2, 3]) {
      const expectedColors = colors(world, layer, season);
      const manifest = await reader.manifest(layer, season);
      assert.equal(manifest.simplified, true);
      const faces = new Set<string>();
      const edgeColors = new Map<string, Set<string>>();
      const edgeIncidence = new Map<string, { count: number; winding: number }>();
      const actualAreas = new Map<string, number>();
      let triangles = 0;
      for (let batch = 0; batch < manifest.batches; batch++) {
        const packet = await reader.batch(layer, season, batch);
        assert.ok(packet.heights.length <= 65535);
        for (let vertex = 0; vertex < packet.heights.length; vertex++) {
          const point = key(packet.directions, vertex * 3);
          assert.ok(
            heights.has(point),
            'simplification retains saved sites/corners, not invented samples',
          );
          assert.equal(
            packet.heights[vertex],
            heights.get(point),
            'retained raw height stays bit-exact, including underwater floors',
          );
        }
        for (let offset = 0; offset < packet.indices.length; offset += 3) {
          const [a, b, c] = packet.indices.subarray(offset, offset + 3);
          const ids = [a, b, c].map((vertex) => key(packet.directions, vertex * 3));
          const color = Array.from(packet.colors.subarray(c * 4, c * 4 + 4)).join(',');
          const identity = faceKey(...(ids as [string, string, string]));
          assert.ok(!faces.has(identity), 'packets cover each triangle once');
          faces.add(identity);
          const area = triangleArea(packet.directions, a, b, c);
          actualAreas.set(color, (actualAreas.get(color) ?? 0) + area);
          for (let side = 0; side < 3; side++) {
            const edge = edgeKey(ids[side], ids[(side + 1) % 3]);
            const palette = edgeColors.get(edge) ?? new Set<string>();
            palette.add(color);
            edgeColors.set(edge, palette);
            const incidence = edgeIncidence.get(edge) ?? { count: 0, winding: 0 };
            incidence.count++;
            incidence.winding += ids[side] < ids[(side + 1) % 3] ? 1 : -1;
            edgeIncidence.set(edge, incidence);
          }
          triangles++;
        }
      }
      assert.ok(
        triangles < manifest.triangles * 0.98,
        'dense flat areas must actually enter simplification',
      );
      for (const incidence of edgeIncidence.values()) {
        assert.equal(
          incidence.count,
          2,
          'every output edge retains both incident triangles, with no tiny holes or nonmanifold overlaps',
        );
        assert.equal(
          incidence.winding,
          0,
          'incident triangles traverse their shared edge in opposite directions',
        );
      }
      const expectedAreas = new Map<string, number>();
      let removedOcean = 0;
      let removedPlateau = 0;
      let protectedFans = 0;
      let mountainFans = 0;
      for (let cell = 0; cell < grid.count; cell++) {
        const color = expectedColors[cell];
        expectedAreas.set(color, (expectedAreas.get(color) ?? 0) + grid.areas[cell]);
        const [x, y, z] = grid.positions.subarray(cell * 3, cell * 3 + 3);
        const mountain = x > 0.9998 && y > 0.011 && z > 0.011;
        const shore = drainage.lakeCoverage[cell] > 0 && drainage.lakeCoverage[cell] < 1;
        changedWaterColor ||= drainage.lakeCoverage[cell] > 0 && color !== annualColors[cell];
        for (let arc = grid.offsets[cell]; arc < grid.offsets[cell + 1]; arc++) {
          const next = arc + 1 === grid.offsets[cell + 1] ? grid.offsets[cell] : arc + 1;
          const face = faceKey(
            cellKeys[cell],
            cornerKeys[grid.cellCorners[arc]],
            cornerKeys[grid.cellCorners[next]],
          );
          if (mountain || shore) {
            assert.ok(
              faces.has(face),
              'steep mountains and partially wet lake shores retain their complete original fans',
            );
            mountainFans += Number(mountain);
            protectedFans += Number(shore);
          } else if (!faces.has(face)) {
            removedOcean += Number(terrain.ocean[cell] > 0);
            removedPlateau += Number(
              !terrain.ocean[cell] &&
                terrain.height[cell] === 420 &&
                drainage.lakeCoverage[cell] === 0,
            );
          }
        }
      }
      assert.ok(
        removedOcean > 20,
        'flat displayed sea floor simplifies despite varying negative raw depths',
      );
      assert.ok(removedPlateau > 20, 'dry constant-height plateaus simplify too');
      assert.ok(
        protectedFans > 20 && mountainFans > 20,
        'fixture exercises both protected lake and steep mountain fans',
      );
      assert.equal(actualAreas.size, expectedAreas.size);
      for (const [color, expected] of expectedAreas) {
        assert.ok(
          Math.abs(actualAreas.get(color)! - expected) < 1e-6,
          'each exact annual/seasonal color retains its original geographic area',
        );
      }
      let semanticOnlyEdges = 0;
      let lakeBoundaryEdges = 0;
      let coastEdges = 0;
      for (let edge = 0; edge < grid.edgeCells.length; edge += 2) {
        const a = grid.edgeCells[edge];
        const b = grid.edgeCells[edge + 1];
        const colorBoundary = expectedColors[a] !== expectedColors[b];
        const coast = terrain.ocean[a] !== terrain.ocean[b];
        const dry =
          !terrain.ocean[a] &&
          !terrain.ocean[b] &&
          !drainage.lakeCoverage[a] &&
          !drainage.lakeCoverage[b];
        const systemBoundary =
          layer === 'drainage' &&
          dry &&
          world.rivers.system[prepared.sidecars.view.basin[a]] !==
            world.rivers.system[prepared.sidecars.view.basin[b]];
        const lakeBoundary =
          drainage.lakeCoverage[a] > 0 &&
          drainage.lakeCoverage[b] > 0 &&
          prepared.sidecars.view.lake[a] !== prepared.sidecars.view.lake[b];
        if (!colorBoundary && !coast && !systemBoundary && !lakeBoundary) {
          continue;
        }
        const identity = edgeKey(
          cornerKeys[grid.edgeCorners[edge]],
          cornerKeys[grid.edgeCorners[edge + 1]],
        );
        assert.deepEqual(
          edgeColors.get(identity),
          new Set([expectedColors[a], expectedColors[b]]),
          'exact original coast, category, or same-color semantic boundary survives across packets',
        );
        semanticOnlyEdges += Number(systemBoundary && !colorBoundary);
        lakeBoundaryEdges += Number(lakeBoundary);
        coastEdges += Number(coast);
      }
      assert.ok(coastEdges > 10 && lakeBoundaryEdges > 0);
      if (layer === 'drainage') {
        assert.ok(
          semanticOnlyEdges > 10,
          'full 0/64 basin IDs must remain distinct despite identical palette colors',
        );
      }
    }
    assert.ok(
      changedWaterColor,
      'season switching genuinely changes wet/frozen colors in this fixture',
    );
    assert.equal(
      digest(source),
      before,
      'all physical arrays and prepared saved-page buffers remain immutable',
    );
  });
}
