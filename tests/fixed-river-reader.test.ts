import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { generateWorld } from '../src/core/pipeline';
import { DEFAULT_CONFIG } from '../src/core/model';
import { prepareWorldView } from '../src/core/view/prepare';
import { RiverRenderReader } from '../src/core/view/river-render';
import { WorldViewReader } from '../src/core/view/reader';
import type { PageValues } from '../src/core/view/spatial-index';
import type { FixedRiverBatch } from '../src/core/view/river-render-types';
import { RiverGeometry } from '../src/render/RiverGeometry';
import { createRiverStrips } from '../src/render/RiverStrips';
import { paintFixedRiverBanks } from '../src/render/FixedRivers';
import { MissingSnapshotFieldError } from '../src/core/storage';
import { riverCurvatureLimits } from '../src/core/view/river-width-limits';

const world = generateWorld({
  ...DEFAULT_CONFIG,
  seed: 'fixed-river-parity',
  surfaceLevel: 3,
  processLevel: 3,
  tectonicDuration: 5,
  fluvialDuration: 0.2,
  landscapeBatches: 1,
  riverSourceArea: 1000,
  riverSourceFlow: 0.1,
});
function fixture() {
  const copy = structuredClone(world);
  copy.rivers.deltas = [];
  copy.terrain.oxbows = [];
  copy.water.oxbowDepth = Array.from({ length: 4 }, () => new Float32Array());
  const prepared = prepareWorldView(copy);
  const root = { world: copy, sidecars: prepared.sidecars };
  const allowed = new Set([
    'rivers.courses.corner',
    'rivers.courses.offsets',
    'rivers.courses.sinuosity',
    'drainage.receiver',
    'water.temperature',
    'water.seasonalTemperature',
    'terrain.ocean',
    'drainage.lakeCoverage',
    'drainage.seasonalLakeCoverage',
    'ecology.floodplains',
    'water.oxbowDepth',
    'terrain.height',
    'terrain.oxbows',
    'drainage.lakeDepth',
  ]);
  const lookup = (path: string): unknown =>
    path
      .split('.')
      .reduce<unknown>((value, key) => (value as Record<string, unknown>)?.[key], root);
  let reads = 0;
  const pages: PageValues = {
    async readValue(path) {
      reads++;
      if (path.startsWith('world.')) {
        assert.ok(
          [...allowed].some(
            (part) => path === `world.${part}` || path.startsWith(`world.${part}.`),
          ) || /^world\.drainage\.lakes\.\d+\.level$/.test(path),
          `only explicit render arrays may be restored: ${path}`,
        );
      }
      const value = lookup(path);
      if (value === undefined) {
        throw new MissingSnapshotFieldError(path);
      }
      return structuredClone(value);
    },
    async readValues(path, indices) {
      reads++;
      assert.ok(indices.length <= 8192);
      const values = lookup(path) as ArrayLike<number>;
      return Float64Array.from(indices, (index) => values[index]);
    },
    async readRange(path, start, count) {
      reads++;
      assert.ok(count <= 65536);
      const values = lookup(path) as ArrayLike<number>;
      return Float64Array.from({ length: count }, (_, index) => values[start + index]);
    },
  };
  return { world: copy, pages, summary: prepared.sidecars.view.summary, reads: () => reads };
}
async function all(reader: RiverRenderReader, season = -1, threshold = 0) {
  const first = await reader.read({ season, threshold, batch: 0 });
  const result = [first];
  for (let batch = 1; batch < first.totalBatches; batch++) {
    result.push(await reader.read({ season, threshold, batch }));
  }
  return result;
}
const pointKey = (point: THREE.Vector3) => point.normalize().toArray().map(Math.fround).join(',');
const waterPoints = (packet: FixedRiverBatch) =>
  Array.from(packet.kinds).flatMap((kind, path) =>
    kind === 4
      ? []
      : Array.from(
          { length: packet.offsets[path + 1] - packet.offsets[path] },
          (_, point) => packet.offsets[path] + point,
        ),
  );
const packetKeys = (packets: FixedRiverBatch[]) =>
  new Set(
    packets.flatMap((packet) =>
      waterPoints(packet).map((point) =>
        Array.from(packet.positions.subarray(point * 3, point * 3 + 3)).join(','),
      ),
    ),
  );

test('fixed river packets preserve original connected path curves, phase, sources, and every visible reach', async () => {
  const { world, pages, summary } = fixture();
  const network = new RiverGeometry(world);
  const original = network.getCoursePoints.bind(network);
  const expectedPoints = new Set<string>();
  let visibleReaches = 0;
  network.getCoursePoints = (corner) => {
    const points = original(corner);
    visibleReaches++;
    for (let point = 0; point < points.length / 3; point++) {
      expectedPoints.add(pointKey(new THREE.Vector3().fromArray(points, point * 3)));
    }
    return points;
  };
  const old = createRiverStrips(world, 0, 1, 0, -1, 'globe', 'world', network);
  const oldGeometry = (old.object.children[0] as THREE.Mesh).geometry;
  const reader = new RiverRenderReader(pages, summary);
  const packets = await all(reader);
  assert.ok(visibleReaches > 10, 'fixture has a real branched network');
  assert.equal(
    packets.reduce(
      (sum, packet) => sum + Array.from(packet.kinds).filter((kind) => kind !== 4).length,
      0,
    ),
    oldGeometry.userData.ribbons,
    'same connected trunks, not isolated routing edges',
  );
  assert.deepEqual(
    packetKeys(packets),
    expectedPoints,
    'exact original rounded/anchored geographic samples survive',
  );
  const phases = new Set(
    packets.flatMap((packet) => waterPoints(packet).map((point) => packet.phase[point])),
  );
  const originalPhases = new Set(
    Array.from({ length: oldGeometry.getAttribute('uv').count }, (_, point) =>
      oldGeometry.getAttribute('uv').getX(point),
    ),
  );
  assert.deepEqual(phases, originalPhases, 'confluence animation phase is unchanged');
  assert.deepEqual(
    new Set(packets.flatMap((packet) => waterPoints(packet).map((point) => packet.sources[point]))),
    new Set(Array.from(oldGeometry.getAttribute('sourceId').array)),
  );
  assert.ok(packets.every((packet) => packet.heights.length <= 16384));
  for (const packet of packets) {
    assert.equal(
      packet.outgoing?.length,
      packet.kinds.length * 3,
      'chunk endpoints retain their outgoing geometry halo',
    );
    assert.ok(packet.outgoing!.every(Number.isFinite));
    assert.equal(
      packet.curvatureLimits?.length,
      packet.heights.length,
      'worker packets retain one prepared limit per path point',
    );
    assert.ok(packet.curvatureLimits!.every((limit) => Number.isFinite(limit) && limit > 0));
    for (let path = 0; path < packet.kinds.length; path++) {
      if (packet.kinds[path] !== 0) {
        continue;
      }
      const start = packet.offsets[path];
      const end = packet.offsets[path + 1];
      assert.deepEqual(
        packet.curvatureLimits!.slice(start, end),
        riverCurvatureLimits(packet.positions, start, end),
        'complete-path curvature limits survive packet preparation',
      );
    }
  }
  assert.equal(
    packets[0].totalBytes,
    packets.reduce(
      (sum, packet) =>
        sum +
        Object.values(packet).reduce(
          (bytes, value) => bytes + (ArrayBuffer.isView(value) ? value.byteLength : 0),
          0,
        ),
      0,
    ),
  );
  oldGeometry.dispose();
  ((old.object.children[0] as THREE.Mesh).material as THREE.Material).dispose();
});

test('saved malformed courses are rebased before display without changing their stored history', async () => {
  const { world, pages, summary } = fixture();
  const courses = world.rivers.courses;
  const course = Array.from(courses.corner).findIndex((corner) => {
    const downstream = world.drainage.receiver[corner];
    return (
      downstream >= 0 &&
      world.drainage.receiver[downstream] >= 0 &&
      [corner, downstream].every(
        (node) =>
          world.drainage.lakeFraction[node] === 0 &&
          [0, 1, 2].every((slot) => {
            const cell = world.grid.triangles[node * 3 + slot];
            return !world.terrain.ocean[cell] && world.water.temperature[cell] > 5;
          }),
      )
    );
  });
  assert.ok(course >= 0, 'fixture contains a warm interior river');
  const first = courses.offsets[course];
  const end = courses.offsets[course + 1];
  // The old inheritance bug leaves the complete curve on an offset chord. The
  // snapshot still records its new authoritative routing corner/receiver IDs.
  for (let point = first; point < end; point++) {
    new THREE.Vector3()
      .fromArray(courses.points, point * 3)
      .add(new THREE.Vector3(0.012, -0.008, 0.015))
      .normalize()
      .toArray(courses.points, point * 3);
  }
  const saved = courses.points.slice();
  const originalHistory = structuredClone(world.terrain.migration);
  const expected = new RiverGeometry(world).getCoursePoints(courses.corner[course]);
  const packets = await all(new RiverRenderReader(pages, summary));
  const displayed = packetKeys(packets);
  for (let point = 0; point < expected.length / 3; point++) {
    assert.ok(
      displayed.has(pointKey(new THREE.Vector3().fromArray(expected, point * 3))),
      'paged rendering includes the corrected connected course',
    );
  }
  assert.ok(
    !displayed.has(pointKey(new THREE.Vector3().fromArray(saved, first * 3))),
    'the disconnected inherited endpoint is not emitted',
  );
  for (const packet of packets) {
    for (let path = 0; path < packet.kinds.length; path++) {
      if (packet.kinds[path] !== 0) {
        continue;
      }
      for (let point = packet.offsets[path] + 1; point < packet.offsets[path + 1]; point++) {
        assert.ok(packet.phase[point] >= packet.phase[point - 1], 'flow still moves downstream');
      }
    }
  }
  assert.deepEqual(courses.points, saved, 'display repair never mutates saved physical arrays');
  assert.deepEqual(world.terrain.migration, originalHistory);
});

test('saved oxbows retain wet, frozen and dry footprints with legacy seasonal coverage fallback', async () => {
  const { world, pages, summary } = fixture();
  const cells = Array.from(world.terrain.ocean.keys())
    .filter((cell) => !world.terrain.ocean[cell] && world.drainage.lakeCoverage[cell] < 0.5)
    .slice(0, 3);
  assert.equal(cells.length, 3);
  world.terrain.oxbows = cells.map((cell) => {
    const center = new THREE.Vector3().fromArray(world.grid.positions, cell * 3);
    const tangent = center
      .clone()
      .cross(new THREE.Vector3(0, 1, 0))
      .normalize();
    return {
      cell,
      width: 20,
      area: 100,
      capacity: 1,
      points: Float32Array.from([
        ...center.clone().addScaledVector(tangent, -0.001).normalize().toArray(),
        ...center.clone().addScaledVector(tangent, 0.001).normalize().toArray(),
      ]),
    };
  });
  summary.oxbowCount = 3;
  world.water.oxbowDepth = Array.from({ length: 4 }, () => Float32Array.from([0, 0.2, 0.2]));
  world.water.temperature.fill(20);
  world.water.seasonalTemperature[0].fill(-5);
  delete world.drainage.seasonalLakeCoverage;
  world.drainage.lakeCoverage[cells[2]] = 0.7;
  const reader = new RiverRenderReader(pages, summary);
  const kinds = (packets: FixedRiverBatch[]) =>
    packets.flatMap((packet) => Array.from(packet.kinds).filter((kind) => kind !== 4));
  assert.deepEqual(
    kinds(await all(reader, -1, 1e30)),
    [2, 1],
    'annual dry and wet states, submerged pond omitted',
  );
  assert.deepEqual(
    kinds(await all(reader, 0, 1e30)),
    [2, 3],
    'cold water freezes but a dry scar remains dry',
  );
});

test('fixed river heights agree with exact continuous terrain and cached repeats perform no additional reads', async () => {
  const { pages, summary, reads } = fixture();
  const reader = new RiverRenderReader(pages, summary);
  const packets = await all(reader);
  const count = reads();
  const again = await all(reader);
  assert.deepEqual(again, packets);
  assert.equal(reads(), count, 'camera/projection redraws need no saved-world reads');
  const view = await WorldViewReader.open(pages);
  for (const packet of packets) {
    const reference = await view.sample(packet.positions, 'world', -1);
    for (const point of waterPoints(packet)) {
      assert.ok(
        packet.heights[point] >= reference.heights[point] - 1e-4,
        'water never lies below the physical render surface',
      );
    }
  }
  await assert.rejects(reader.read({ season: -1, threshold: 0, batch: packets.length }), /outside/);
});

test('seasonal packets retain annual-threshold network while restoring activity and asymmetric banks', async () => {
  const { world, pages, summary } = fixture();
  world.water.temperature.fill(20);
  world.water.seasonalTemperature.forEach((field, season) => field.fill(season === 0 ? -4 : 20));
  const reader = new RiverRenderReader(pages, summary);
  const annual = await all(reader);
  const winter = await all(reader, 0);
  assert.deepEqual(
    packetKeys(winter),
    packetKeys(annual),
    'seasonal low flow changes activity, not annual channel selection',
  );
  assert.ok(winter.every((packet) => packet.activity.every((value) => value === 0)));
  assert.ok(annual.some((packet) => packet.bankWidths.some((value) => value > 0)));
  assert.ok(
    annual.some((packet) => packet.bankColors.some((value, index) => index % 4 === 3 && value > 0)),
  );
  const count = world.rivers.courses.corner.length;
  assert.ok(count > 0);
  const empty = await all(reader, -1, 1e30);
  assert.equal(packetKeys(empty).size, 0, 'threshold removes every live water path');
  const raster = (packets: FixedRiverBatch[]) => {
    const pixels = new Uint8Array(512 * 256 * 4);
    for (const packet of packets) {
      paintFixedRiverBanks(pixels, 512, 256, packet);
    }
    return pixels;
  };
  const bankPixels = raster(annual);
  assert.ok(bankPixels.some((value) => value > 0));
  assert.deepEqual(raster(empty), bankPixels, 'threshold never changes physical bank corridors');
  const network = new RiverGeometry(world);
  const expectedBankPaths = Array.from(world.ecology.floodplains.corner).filter((corner) =>
    [1, -1].some((sign) => world.ecology.floodplains.width[network.getBankIndex(corner, sign)] > 0),
  );
  const bankPaths = empty.flatMap((packet) =>
    Array.from(packet.kinds).flatMap((kind, path) =>
      kind === 4
        ? [packet.positions.slice(packet.offsets[path] * 3, packet.offsets[path + 1] * 3)]
        : [],
    ),
  );
  assert.equal(bankPaths.length, expectedBankPaths.length, 'exact original floodplain eligibility');
  for (let path = 0; path < bankPaths.length; path++) {
    assert.deepEqual(
      bankPaths[path],
      network.getCoursePoints(expectedBankPaths[path]),
      'banks retain each original course and constant reach data',
    );
  }
  await assert.rejects(reader.read({ season: 4, threshold: 0, batch: 0 }), /Invalid/);
});
