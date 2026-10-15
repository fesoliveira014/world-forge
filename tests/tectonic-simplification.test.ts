import assert from 'node:assert/strict';
import test from 'node:test';
import {
  simplifyTectonicPacket,
  TECTONIC_MAX_EDGE_ANGLE,
} from '../src/core/view/tectonic-simplification';
import type { PhysicalMeshPacket } from '../src/core/view/physical-mesh-types';

function fixture(
  size = 26,
  regionAt: (x: number, y: number) => number = () => 0,
  colorAt = (region: number) => region % 64,
) {
  const points: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const regions: number[] = [];
  const span = (6 * Math.PI) / 180;
  const vertex = (x: number, y: number, color: number) => {
    const direction = [1, (x / size - 0.5) * span, (y / size - 0.5) * span];
    const length = Math.hypot(...direction);
    const index = points.length / 3;
    points.push(...direction.map((v) => v / length));
    colors.push(color, 77, 149, 255);
    return index;
  };
  for (let y = 0; y <= size; y++) {
    for (let x = 0; x <= size; x++) {
      vertex(x, y, 0);
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const region = regionAt(x, y);
      const center = vertex(x + 0.5, y + 0.5, colorAt(region));
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
    batch: 11,
    mode: 'dual',
    directions: Float32Array.from(points),
    heights: new Float32Array(points.length / 3).fill(1234),
    normals: new Int16Array(),
    colors: Uint8Array.from(colors),
    materials: [],
    indices: Uint16Array.from(indices),
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
const edgeKey = (a: string, b: string) => [a, b].sort().join('|');
function edges(packet: PhysicalMeshPacket) {
  const result = new Map<string, number[]>();
  for (let face = 0; face < packet.indices.length / 3; face++) {
    for (let slot = 0; slot < 3; slot++) {
      const key = edgeKey(
        pointKey(packet, packet.indices[face * 3 + slot]),
        pointKey(packet, packet.indices[face * 3 + ((slot + 1) % 3)]),
      );
      const faces = result.get(key) ?? [];
      faces.push(face);
      result.set(key, faces);
    }
  }
  return result;
}
function signedArea(packet: PhysicalMeshPacket, face: number) {
  const p = Array.from(packet.indices.subarray(face * 3, face * 3 + 3), (v) => {
    const direction = Array.from(packet.directions.subarray(v * 3, v * 3 + 3));
    const length = Math.hypot(...direction);
    return direction.map((component) => component / length);
  });
  const dot = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  const cross = [
    p[1][1] * p[2][2] - p[1][2] * p[2][1],
    p[1][2] * p[2][0] - p[1][0] * p[2][2],
    p[1][0] * p[2][1] - p[1][1] * p[2][0],
  ];
  return 2 * Math.atan2(dot(p[0], cross), 1 + dot(p[0], p[1]) + dot(p[1], p[2]) + dot(p[2], p[0]));
}
function areaByColor(packet: PhysicalMeshPacket) {
  const result = new Map<number, number>();
  for (let face = 0; face < packet.indices.length / 3; face++) {
    const area = signedArea(packet, face);
    assert.ok(area > 0, 'every output face remains outward and nondegenerate');
    const owner = packet.indices[face * 3 + 2];
    const color = packet.colors[owner * 4];
    result.set(color, (result.get(color) ?? 0) + area);
  }
  return result;
}

test('fixed tectonic simplification removes interior geometry while retaining exact packet edges and bounded globe curvature', () => {
  const { packet, regions } = fixture();
  const original = structuredClone(packet);
  const result = simplifyTectonicPacket(packet, { triangleRegions: regions });
  assert.ok(
    result.indices.length < packet.indices.length * 0.4,
    'substantial triangle reduction beyond batching',
  );
  assert.ok(result.directions.length < packet.directions.length * 0.5);
  assert.ok(result.heights.every((height) => height === 0));
  assert.equal(result.batch, packet.batch);
  const inputEdges = edges(packet);
  const outputEdges = edges(result);
  assert.deepEqual(
    [...outputEdges]
      .filter(([, faces]) => faces.length === 1)
      .map(([edge]) => edge)
      .sort(),
    [...inputEdges]
      .filter(([, faces]) => faces.length === 1)
      .map(([edge]) => edge)
      .sort(),
  );
  for (const [edge, faces] of outputEdges) {
    assert.ok(faces.length <= 2, 'the welded output remains manifold');
    if (inputEdges.has(edge)) {
      continue;
    }
    const [a, b] = edge.split('|').map((key) => key.split(',').map(Number));
    const dot =
      a.reduce((sum, value, axis) => sum + value * b[axis], 0) /
      (Math.hypot(...a) * Math.hypot(...b));
    assert.ok(Math.acos(Math.max(-1, Math.min(1, dot))) <= TECTONIC_MAX_EDGE_ANGLE + 1e-12);
  }
  const before = areaByColor(packet);
  const after = areaByColor(result);
  assert.ok(
    Math.abs(before.get(0)! - after.get(0)!) < 1e-12,
    'spherical coverage has no holes or overlap',
  );
  assert.deepEqual(packet, original, 'source buffers stay immutable');
  assert.deepEqual(
    result,
    simplifyTectonicPacket(packet, { triangleRegions: regions }),
    'fixed deterministic output',
  );
});

test('plate borders, triple junctions, narrow connections and small plate islands keep exact geometry and flat colors', () => {
  const { packet, regions } = fixture(26, (x, y) => {
    if (x === 6 && y === 7) {
      return 3;
    }
    if (y === 13 && x >= 10 && x <= 17) {
      return 3;
    }
    return x < 13 ? 0 : y < 13 ? 1 : 2;
  });
  const result = simplifyTectonicPacket(packet, { triangleRegions: regions });
  const outputEdges = edges(result);
  for (const [edge, faces] of edges(packet)) {
    if (faces.length === 1 || regions[faces[0]] !== regions[faces[1]]) {
      assert.ok(outputEdges.has(edge), 'each boundary segment survives bit-identically');
    }
  }
  const before = areaByColor(packet);
  const after = areaByColor(result);
  assert.deepEqual([...before.keys()].sort(), [...after.keys()].sort());
  for (const [color, area] of before) {
    assert.ok(
      Math.abs(after.get(color)! - area) < 1e-12,
      'every plate keeps its exact spherical area',
    );
  }
  for (let offset = 0; offset < result.indices.length; offset += 3) {
    const a = result.indices[offset] * 4;
    const b = result.indices[offset + 1] * 4;
    const c = result.indices[offset + 2] * 4;
    assert.deepEqual(result.colors.subarray(a, a + 4), result.colors.subarray(c, c + 4));
    assert.deepEqual(result.colors.subarray(b, b + 4), result.colors.subarray(c, c + 4));
  }
});

test('semantic plate IDs preserve boundaries even when palette colors repeat modulo 64', () => {
  const { packet, regions } = fixture(24, (x) => (x < 12 ? 0 : 64));
  const result = simplifyTectonicPacket(packet, { triangleRegions: regions });
  const outputEdges = edges(result);
  const boundary = [...edges(packet)].filter(
    ([, faces]) => faces.length === 2 && regions[faces[0]] !== regions[faces[1]],
  );
  assert.equal(boundary.length, 24);
  for (const [edge] of boundary) {
    assert.ok(outputEdges.has(edge));
  }
  assert.ok(result.indices.length < packet.indices.length * 0.5);
  assert.throws(
    () => simplifyTectonicPacket(packet, { triangleRegions: new Uint32Array(3) }),
    /Invalid/,
  );
});
