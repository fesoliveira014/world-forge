import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PHYSICAL_MATERIAL_FIELD_COUNT,
  type PhysicalMeshPacket,
} from '../src/core/view/physical-mesh-types';
import {
  decodeZoomNormal,
  MAX_ZOOM_HEIGHT_FRACTION,
  prepareZoomTriangle,
  sampleZoomHeight,
  sampleZoomHeightCorrection,
} from '../src/core/view/zoom-reconstruction';

const radius = 6_371_000;
type Vec3 = [number, number, number];
const normalized = (v: Vec3): Vec3 => {
  const length = Math.hypot(...v);
  return v.map((value) => value / length) as Vec3;
};
const dot = (a: Vec3, b: Vec3) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);

function encodeNormal(v: Vec3): [number, number] {
  const length = v.reduce((sum, value) => sum + Math.abs(value), 0);
  let x = v[0] / length;
  let y = v[1] / length;
  const z = v[2] / length;
  if (z < 0) {
    const oldX = x;
    x = (1 - Math.abs(y)) * (x < 0 ? -1 : 1);
    y = (1 - Math.abs(oldX)) * (y < 0 ? -1 : 1);
  }
  return [Math.round(x * 32767), Math.round(y * 32767)];
}

const field = (d: Vec3) => 1000 + 60_000 * d[1] ** 2 + 3000 * d[1] + 1000 * d[2];
function curvedLand(): PhysicalMeshPacket {
  const directions = Float32Array.from(
    [
      [1, 0, 0],
      [1, 0.02, 0],
      [1, 0, 0.02],
    ].flatMap((v) => normalized(v as Vec3)),
  );
  const heights = new Float32Array(3);
  const normals = new Int16Array(6);
  for (let vertex = 0; vertex < 3; vertex++) {
    const d = normalized(Array.from(directions.subarray(vertex * 3, vertex * 3 + 3)) as Vec3);
    const h = field(d);
    const gradient: Vec3 = [0, 120_000 * d[1] + 3000, 1000];
    const radial = dot(gradient, d);
    const tangent = gradient.map((value, axis) => value - radial * d[axis]);
    const normal = d.map((value, axis) => value - tangent[axis] / (radius + h)) as Vec3;
    heights[vertex] = h;
    normals.set(encodeNormal(normal), vertex * 2);
  }
  return {
    batch: 0,
    mode: 'primal',
    directions,
    heights,
    normals,
    materials: Array.from({ length: PHYSICAL_MATERIAL_FIELD_COUNT }, () => new Uint8Array(12)),
    colors: new Uint8Array(),
    indices: new Uint16Array([0, 1, 2]),
    bytes: 0,
  };
}

test('saved slope normals recover interior curvature without adding noise or retaining packet buffers', () => {
  const packet = curvedLand();
  const original = structuredClone(packet);
  const triangle = prepareZoomTriangle(packet, [0, 1, 2], radius);
  const barycentric = [1 / 3, 1 / 3, 1 / 3];
  const direction = normalized(
    [0, 1, 2].map((axis) =>
      barycentric.reduce(
        (sum, weight, vertex) => sum + weight * packet.directions[vertex * 3 + axis],
        0,
      ),
    ) as Vec3,
  );
  const expected = field(direction);
  const linear = packet.heights.reduce((sum, height) => sum + height / 3, 0);
  const reconstructed = sampleZoomHeight(triangle, barycentric);
  assert.ok(triangle.reconstructable);
  assert.ok(Math.abs(linear - expected) > 5, 'fixture has measurable saved curvature');
  assert.ok(
    Math.abs(reconstructed - expected) < Math.abs(linear - expected) * 0.1,
    'packed one-ring slopes improve the interior shape of a known smooth field',
  );
  assert.deepEqual(packet, original, 'the authoritative terrain and material data are immutable');
  packet.heights.fill(-100);
  packet.normals.fill(0);
  assert.equal(
    sampleZoomHeight(triangle, barycentric),
    reconstructed,
    'controls own only six scalars',
  );
});

test('parent edges and correction derivatives stay fixed regardless of local subdivision', () => {
  const triangle = prepareZoomTriangle(curvedLand(), [0, 1, 2], radius);
  for (let edge = 0; edge < 3; edge++) {
    for (let sample = 0; sample <= 20; sample++) {
      const weights = [sample / 20, 1 - sample / 20, 0];
      const barycentric = [weights[edge], weights[(edge + 1) % 3], weights[(edge + 2) % 3]];
      assert.equal(sampleZoomHeightCorrection(triangle, barycentric), 0);
      const linear = triangle.heights.reduce(
        (sum, height, vertex) => sum + height * barycentric[vertex],
        0,
      );
      assert.equal(sampleZoomHeight(triangle, barycentric), linear);
    }
  }
  const correction = (epsilon: number) =>
    Math.abs(sampleZoomHeightCorrection(triangle, [epsilon, (1 - epsilon) / 2, (1 - epsilon) / 2]));
  assert.ok(correction(0.001) > 0);
  assert.ok(
    correction(0.0005) / correction(0.001) < 0.251,
    'edge derivative vanishes quadratically',
  );
  for (const denominator of [3, 6, 12, 48]) {
    assert.equal(
      sampleZoomHeight(triangle, [1 / 3, 1 / 3, 1 / 3]),
      sampleZoomHeight(triangle, [denominator / (3 * denominator), 1 / 3, 1 / 3]),
      'height depends on geography, not the refinement level',
    );
  }
});

test('extreme slopes remain inside saved height extrema with a modest correction budget', () => {
  const packet = curvedLand();
  packet.heights.set([10, 300, 110]);
  for (let point = 0; point < 3; point++) {
    const direction = normalized(
      Array.from(packet.directions.subarray(point * 3, point * 3 + 3)) as Vec3,
    );
    const slope: Vec3 = [0, point === 1 ? -10 : 10, point === 2 ? -5 : 5];
    const radial = dot(slope, direction);
    const normal = direction.map((value, axis) => value - (slope[axis] - radial * value)) as Vec3;
    packet.normals.set(encodeNormal(normal), point * 2);
  }
  const triangle = prepareZoomTriangle(packet, [0, 1, 2], radius);
  assert.ok(
    triangle.reconstructable,
    'bounds are exercised, rather than disabling valid steep terrain',
  );
  let largest = 0;
  for (let a = 0; a <= 100; a++) {
    for (let b = 0; b <= 100 - a; b++) {
      const barycentric = [a / 100, b / 100, (100 - a - b) / 100];
      const result = sampleZoomHeight(triangle, barycentric);
      const correction = sampleZoomHeightCorrection(triangle, barycentric);
      assert.ok(result >= 10 - 1e-12 && result <= 300 + 1e-12);
      assert.ok(Math.abs(correction) <= MAX_ZOOM_HEIGHT_FRACTION * 290 + 1e-10);
      largest = Math.max(largest, Math.abs(correction));
    }
  }
  assert.ok(largest > 10, 'a nonzero bounded reconstruction is retained');
});

test('partial ocean/lake coverage, shore crossings, flat floors and unavailable fields preserve base geometry', () => {
  const fixtures: PhysicalMeshPacket[] = [];
  for (const channel of [2, 3]) {
    for (const vertex of [0, 1, 2]) {
      const packet = curvedLand();
      packet.materials[4][vertex * 4 + channel] = 1;
      fixtures.push(packet);
    }
  }
  const shore = curvedLand();
  shore.heights[0] = -1;
  const flat = curvedLand();
  flat.heights.fill(598);
  const noNormals = curvedLand();
  noNormals.normals = new Int16Array();
  const noWater = curvedLand();
  noWater.materials = [];
  const categorical = curvedLand();
  categorical.mode = 'dual';
  fixtures.push(shore, flat, noNormals, noWater, categorical);
  for (const packet of fixtures) {
    const triangle = prepareZoomTriangle(packet, [0, 1, 2], radius);
    assert.equal(triangle.reconstructable, false);
    for (const weights of [
      [1 / 3, 1 / 3, 1 / 3],
      [0.1, 0.4, 0.5],
    ]) {
      assert.equal(sampleZoomHeightCorrection(triangle, weights), 0);
      assert.equal(
        sampleZoomHeight(triangle, weights),
        triangle.heights.reduce((sum, h, i) => sum + h * weights[i], 0),
      );
    }
  }
});

test('geographic river protection returns exact base heights and smoothly attenuates land correction', () => {
  const triangle = prepareZoomTriangle(curvedLand(), [0, 1, 2], radius);
  const weights = [1 / 3, 1 / 3, 1 / 3];
  const full = sampleZoomHeightCorrection(triangle, weights);
  assert.notEqual(full, 0);
  for (const attenuation of [0, 0.01, 0.25, 0.5, 1]) {
    assert.ok(
      Math.abs(sampleZoomHeightCorrection(triangle, weights, attenuation) - full * attenuation) <
        1e-12,
    );
  }
  assert.equal(
    sampleZoomHeightCorrection(triangle, weights, Number.NaN),
    0,
    'invalid protection fails closed',
  );
  assert.equal(sampleZoomHeightCorrection(triangle, weights, -1), 0);
  assert.equal(sampleZoomHeightCorrection(triangle, weights, 2), full);
  assert.equal(
    sampleZoomHeight(triangle, weights, 0),
    triangle.heights.reduce((sum, h) => sum + h / 3, 0),
  );
});

test('octahedral normal decoding covers both hemispheres and input contracts are explicit', () => {
  for (const source of [
    [1, 0, 0],
    [0, 0, -1],
    [-0.2, -0.8, -0.4],
    [0.1, 0.9, 0.3],
  ]) {
    const expected = normalized(source as Vec3);
    const decoded = decodeZoomNormal(Int16Array.from(encodeNormal(expected)), 0);
    assert.ok(Math.hypot(...decoded.map((value, axis) => value - expected[axis])) < 0.000065);
  }
  assert.throws(() => prepareZoomTriangle(curvedLand(), [0, 1, 2], 0), RangeError);
  assert.throws(() => prepareZoomTriangle(curvedLand(), [0, 1, 3], radius), RangeError);
});
