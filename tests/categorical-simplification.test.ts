import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CATEGORICAL_MAX_EDGE_ANGLE,
  simplifyCategoricalPacket,
} from '../src/core/view/categorical-simplification';
import type { PhysicalMeshPacket } from '../src/core/view/physical-mesh-types';

function fixture(
  heightAt: (x: number, y: number) => number,
  regionAt: (x: number, y: number) => number = () => 0,
  size = 24,
) {
  const directions: number[] = [];
  const heights: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const regions: number[] = [];
  const vertex = (x: number, y: number, region: number) => {
    const p = [1, (x / size - 0.5) * 0.04, (y / size - 0.5) * 0.04];
    const length = Math.hypot(...p);
    const id = heights.length;
    directions.push(...p.map((v) => v / length));
    heights.push(heightAt(x / size, y / size));
    // Semantic IDs deliberately repeat a visible color.
    colors.push(region % 64, 77, 149, 255);
    return id;
  };
  for (let y = 0; y <= size; y++) {
    for (let x = 0; x <= size; x++) {
      vertex(x, y, 0);
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const region = regionAt(x / size, y / size);
      const center = vertex(x + 0.5, y + 0.5, region);
      const a = y * (size + 1) + x;
      const b = a + 1;
      const d = a + size + 1;
      const c = d + 1;
      for (const [first, second] of [
        [a, b],
        [b, c],
        [c, d],
        [d, a],
      ]) {
        indices.push(first, second, center);
        regions.push(region);
      }
    }
  }
  const packet: PhysicalMeshPacket = {
    batch: 17,
    mode: 'dual',
    directions: Float32Array.from(directions),
    heights: Float32Array.from(heights),
    colors: Uint8Array.from(colors),
    indices: Uint16Array.from(indices),
    normals: new Int16Array(),
    materials: [],
    bytes: 0,
  };
  packet.bytes =
    packet.directions.byteLength +
    packet.heights.byteLength +
    packet.colors.byteLength +
    packet.indices.byteLength;
  return { packet, regions: Uint32Array.from(regions) };
}
const pointKey = (packet: PhysicalMeshPacket, vertex: number) =>
  Array.from(packet.directions.subarray(vertex * 3, vertex * 3 + 3)).join(',');
const triangleKey = (packet: PhysicalMeshPacket, face: number) =>
  Array.from(packet.indices.subarray(face * 3, face * 3 + 3), (v) => pointKey(packet, v))
    .sort()
    .join('|');
function edges(packet: PhysicalMeshPacket) {
  const result = new Map<string, number[]>();
  for (let face = 0; face < packet.indices.length / 3; face++) {
    for (let slot = 0; slot < 3; slot++) {
      const key = [
        pointKey(packet, packet.indices[face * 3 + slot]),
        pointKey(packet, packet.indices[face * 3 + ((slot + 1) % 3)]),
      ]
        .sort()
        .join('|');
      const faces = result.get(key) ?? [];
      faces.push(face);
      result.set(key, faces);
    }
  }
  return result;
}
function assertRetainedHeights(source: PhysicalMeshPacket, result: PhysicalMeshPacket) {
  const original = new Map(
    Array.from(source.heights, (height, vertex) => [pointKey(source, vertex), height]),
  );
  for (let vertex = 0; vertex < result.heights.length; vertex++) {
    assert.equal(result.heights[vertex], original.get(pointKey(result, vertex)));
  }
}
function sampleHeight(packet: PhysicalMeshPacket, direction: number[]) {
  // Independent gnomonic containment; inverse x converts planar barycentrics
  // into the radial chord barycentrics used by the saved directional field.
  const x = direction[1] / direction[0];
  const y = direction[2] / direction[0];
  for (let face = 0; face < packet.indices.length / 3; face++) {
    const ids = Array.from(packet.indices.subarray(face * 3, face * 3 + 3));
    const p = ids.map((v) => [
      packet.directions[v * 3 + 1] / packet.directions[v * 3],
      packet.directions[v * 3 + 2] / packet.directions[v * 3],
    ]);
    const denominator =
      (p[1][1] - p[2][1]) * (p[0][0] - p[2][0]) + (p[2][0] - p[1][0]) * (p[0][1] - p[2][1]);
    const a =
      ((p[1][1] - p[2][1]) * (x - p[2][0]) + (p[2][0] - p[1][0]) * (y - p[2][1])) / denominator;
    const b =
      ((p[2][1] - p[0][1]) * (x - p[2][0]) + (p[0][0] - p[2][0]) * (y - p[2][1])) / denominator;
    const weights = [a, b, 1 - a - b];
    if (weights.some((w) => w < -1e-8)) {
      continue;
    }
    const radial = weights.map((w, i) => w / packet.directions[ids[i] * 3]);
    const sum = radial.reduce((total, w) => total + w, 0);
    return radial.reduce((total, w, i) => total + w * Math.max(0, packet.heights[ids[i]]), 0) / sum;
  }
  assert.fail('simplification must cover every original interior sample');
}

test('height-aware simplification retains flat land/lake levels and raw ocean depths with fixed angular bounds', () => {
  for (const heightAt of [() => 712.25, (x: number, y: number) => -1 - 3000 * x - 200 * y]) {
    const { packet, regions } = fixture(heightAt);
    const before = structuredClone(packet);
    const result = simplifyCategoricalPacket(packet, { triangleRegions: regions });
    assert.ok(result.indices.length < packet.indices.length * 0.35);
    assert.ok(result.bytes < packet.bytes * 0.5);
    assertRetainedHeights(packet, result);
    const oldEdges = edges(packet);
    const newEdges = edges(result);
    for (const [edge, faces] of oldEdges) {
      if (faces.length === 1) {
        assert.ok(newEdges.has(edge), 'exact packet boundary');
      }
    }
    for (const [edge, faces] of newEdges) {
      assert.ok(faces.length <= 2);
      if (oldEdges.has(edge)) {
        continue;
      }
      const [a, b] = edge.split('|').map((v) => v.split(',').map(Number));
      const dot =
        a.reduce((sum, v, i) => sum + v * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b));
      assert.ok(Math.acos(Math.min(1, dot)) <= CATEGORICAL_MAX_EDGE_ANGLE + 1e-12);
    }
    assert.deepEqual(packet, before, 'saved inputs stay immutable');
    assert.deepEqual(simplifyCategoricalPacket(packet, { triangleRegions: regions }), result);
  }
});

test('cumulative scalar height envelopes bound repeated collapses on slopes, saddles and narrow ridges', () => {
  for (const heightAt of [
    (x: number) => 300 + 50 * x,
    (x: number, y: number) => 400 + 28 * (x - 0.5) * (y - 0.5),
    (x: number, y: number) => 800 + 350 * Math.exp(-(((x - 0.5) / 0.045) ** 2)) + 3 * y,
  ]) {
    const { packet, regions } = fixture(heightAt);
    const result = simplifyCategoricalPacket(packet, { triangleRegions: regions });
    assert.ok(result.indices.length < packet.indices.length * 0.8);
    assertRetainedHeights(packet, result);
    const originals = new Set(
      Array.from({ length: packet.indices.length / 3 }, (_, face) => triangleKey(packet, face)),
    );
    for (let face = 0; face < result.indices.length / 3; face++) {
      if (originals.has(triangleKey(result, face))) {
        continue;
      }
      const heights = Array.from(result.indices.subarray(face * 3, face * 3 + 3), (v) =>
        Math.max(0, result.heights[v]),
      );
      assert.ok(Math.max(...heights) - Math.min(...heights) <= 5);
    }
    let samples = 0;
    for (let face = 0; face < packet.indices.length / 3; face += 7) {
      const ids = packet.indices.subarray(face * 3, face * 3 + 3);
      const direction = [0, 1, 2].map((axis) =>
        [0.2, 0.3, 0.5].reduce((sum, w, i) => sum + w * packet.directions[ids[i] * 3 + axis], 0),
      );
      const before = [0.2, 0.3, 0.5].reduce(
        (sum, w, i) => sum + w * Math.max(0, packet.heights[ids[i]]),
        0,
      );
      assert.ok(
        Math.abs(sampleHeight(result, direction) - before) <= 5 + 1e-6,
        'error stays within accumulated original height range',
      );
      samples++;
    }
    assert.ok(samples > 300);
    assert.equal(
      Math.max(...result.heights),
      Math.max(...packet.heights),
      'steep ridge crest remains',
    );
  }
});

test('semantic boundaries and protected shoreline/channel faces retain exact saved geometry', () => {
  const { packet, regions } = fixture(
    (x) => 100 + 3 * x,
    (x) => (x < 0.5 ? 0 : 64),
  );
  const protectedVertices = new Uint8Array(packet.heights.length);
  const protectedFaces: number[] = [];
  for (let face = 0; face < packet.indices.length / 3; face++) {
    const ids = packet.indices.subarray(face * 3, face * 3 + 3);
    if (Array.from(ids).some((v) => Math.abs(packet.directions[v * 3 + 2]) < 0.0001)) {
      protectedFaces.push(face);
      for (const v of ids) {
        protectedVertices[v] = 1;
      }
    }
  }
  const result = simplifyCategoricalPacket(packet, { triangleRegions: regions, protectedVertices });
  const outputEdges = edges(result);
  for (const [edge, faces] of edges(packet)) {
    if (faces.length === 1 || regions[faces[0]] !== regions[faces[1]]) {
      assert.ok(outputEdges.has(edge));
    }
  }
  const outputFaces = new Set(
    Array.from({ length: result.indices.length / 3 }, (_, face) => triangleKey(result, face)),
  );
  assert.ok(protectedFaces.length > 50);
  for (const face of protectedFaces) {
    assert.ok(outputFaces.has(triangleKey(packet, face)));
  }
  assert.ok(result.indices.length < packet.indices.length * 0.6);
  assertRetainedHeights(packet, result);
  const points = new Set(Array.from(result.heights, (_, v) => pointKey(result, v)));
  for (let v = 0; v < protectedVertices.length; v++) {
    if (protectedVertices[v]) {
      assert.ok(points.has(pointKey(packet, v)));
    }
  }
});

test('irreducible packets return original buffers and invalid bounds are rejected', () => {
  const { packet, regions } = fixture((x, y) => x * 10000 + y * 13000);
  assert.equal(simplifyCategoricalPacket(packet, { triangleRegions: regions }), packet);
  assert.equal(
    simplifyCategoricalPacket(packet, {
      protectedVertices: new Uint8Array(packet.heights.length).fill(1),
    }),
    packet,
  );
  for (const options of [
    { maxHeightRange: -1 },
    { maxHeightRange: NaN },
    { maxEdgeAngle: 0 },
    { protectedVertices: new Uint8Array(2) },
    { triangleRegions: new Uint32Array(2) },
  ]) {
    assert.throws(() => simplifyCategoricalPacket(packet, options), /Invalid/);
  }
  const invalid = { ...packet, heights: packet.heights.slice() };
  invalid.heights[3] = Infinity;
  assert.throws(() => simplifyCategoricalPacket(invalid), /finite/);
});
