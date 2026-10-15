import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildZoomTopology,
  type ZoomSegments,
  type ZoomTopology,
} from '../src/core/view/zoom-subdivision';

const packet = { indices: Uint16Array.of(0, 1, 2) };
const levels: ZoomSegments[] = [2, 4, 8, 16];
type Point = [number, number, number];

function edges(indices: ArrayLike<number>) {
  const result = new Map<string, { count: number; orientation: number }>();
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    for (let edge = 0; edge < 3; edge++) {
      const a = indices[triangle + edge];
      const b = indices[triangle + ((edge + 1) % 3)];
      assert.notEqual(a, b);
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const value = result.get(key) ?? { count: 0, orientation: 0 };
      value.count++;
      value.orientation += a < b ? 1 : -1;
      result.set(key, value);
    }
  }
  return result;
}

function point(topology: ZoomTopology, vertex: number): Point {
  return Array.from(topology.barycentrics.subarray(vertex * 3, vertex * 3 + 3)) as Point;
}

test('every level covers exactly one parent with consistent winding and only its original boundary', () => {
  for (const segments of levels) {
    const topology = buildZoomTopology(packet, [{ face: 0, segments }], 65535);
    assert.deepEqual(Array.from(topology.barycentrics.subarray(0, 9)), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    for (let vertex = 0; vertex < topology.vertexCount; vertex++) {
      const weights = point(topology, vertex);
      assert.ok(Math.abs(weights[0] + weights[1] + weights[2] - 1) < 1e-14);
      if (vertex >= 3) {
        assert.ok(weights.every((weight) => weight > 0 && weight < 1));
      }
    }
    let area = 0;
    for (let face = 0; face < topology.indices.length; face += 3) {
      const [a, b, c] = [0, 1, 2].map((offset) => point(topology, topology.indices[face + offset]));
      const twiceArea = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
      assert.ok(twiceArea > 0, `no reversed or degenerate child at ${segments}`);
      area += twiceArea / 2;
    }
    assert.ok(Math.abs(area - 0.5) < 1e-13, `complete parent coverage at ${segments}`);
    const incidence = edges(topology.indices);
    const boundary: string[] = [];
    for (const [edge, value] of incidence) {
      if (value.count === 1) {
        boundary.push(edge);
      } else {
        assert.equal(value.count, 2);
        assert.equal(value.orientation, 0);
      }
    }
    assert.deepEqual(boundary.sort(), ['0,1', '0,2', '1,2']);
    assert.equal(topology.vertexCount - incidence.size + topology.triangleCount, 1);
  }
});

test('independently refined batches join unchanged neighbours into the same closed physical surface', () => {
  const corners: Point[] = [
    [1, 1, 1],
    [-1, -1, 1],
    [-1, 1, -1],
    [1, -1, -1],
  ];
  const faces = [
    [0, 2, 1],
    [0, 1, 3],
    [0, 3, 2],
    [1, 2, 3],
  ];
  const vertices: Point[] = [];
  const indices: number[] = [];
  const ids = new Map<string, number>();
  const add = (position: Point) => {
    const key = position.map((value) => value.toFixed(14)).join(',');
    let id = ids.get(key);
    if (id === undefined) {
      id = vertices.length;
      vertices.push(position);
      ids.set(key, id);
    }
    return id;
  };
  for (let face = 0; face < faces.length; face++) {
    const source = faces[face].map((id) => corners[id]);
    if (face % 2) {
      indices.push(...source.map(add));
      continue;
    }
    // Each replacement comes from a different packet with different local IDs;
    // no shared vertex table, adjacency, or neighbouring level is supplied.
    const localPacket = { indices: Uint16Array.of(7, 3, 5) };
    const topology = buildZoomTopology(localPacket, [{ face: 0, segments: face ? 4 : 16 }], 65535);
    const localIds = Array.from({ length: topology.vertexCount }, (_, vertex) => {
      const weights = point(topology, vertex);
      const position = [0, 1, 2].map((axis) =>
        source.reduce((sum, corner, index) => sum + corner[axis] * weights[index], 0),
      ) as Point;
      return add(position);
    });
    indices.push(...Array.from(topology.indices, (index) => localIds[index]));
  }
  const incidence = edges(indices);
  for (const value of incidence.values()) {
    assert.equal(value.count, 2, 'no exposed cracks, duplicate overlays, or T-junctions');
    assert.equal(value.orientation, 0);
  }
  assert.equal(vertices.length - incidence.size + indices.length / 3, 2);
  const volume = (points: Point[], triangles: number[]) => {
    let sum = 0;
    for (let offset = 0; offset < triangles.length; offset += 3) {
      const [a, b, c] = triangles.slice(offset, offset + 3).map((id) => points[id]);
      sum +=
        (a[0] * (b[1] * c[2] - b[2] * c[1]) +
          a[1] * (b[2] * c[0] - b[0] * c[2]) +
          a[2] * (b[0] * c[1] - b[1] * c[0])) /
        6;
    }
    return sum;
  };
  assert.ok(Math.abs(volume(vertices, indices) - volume(corners, faces.flat())) < 1e-13);
});

test('budget limits complete replacements without silently lowering requested resolution', () => {
  const source = { indices: new Uint16Array(9) };
  const selections = [
    { face: 2, segments: 16 as const },
    { face: 0, segments: 8 as const },
    { face: 1, segments: 2 as const },
  ];
  const empty = buildZoomTopology(source, selections, 0);
  assert.equal(empty.vertexCount, 0);
  assert.equal(empty.skippedFaces, 3);
  const first = buildZoomTopology(source, selections.slice(0, 1), 65535);
  const second = buildZoomTopology(source, selections.slice(1, 2), 65535);
  const bounded = buildZoomTopology(source, selections, first.vertexCount + second.vertexCount);
  assert.deepEqual(Array.from(bounded.selectedFaces), [2, 0]);
  assert.equal(bounded.skippedFaces, 1);
  assert.equal(bounded.triangleCount, first.triangleCount + second.triangleCount);
  assert.deepEqual(bounded.barycentrics.subarray(0, first.vertexCount * 3), first.barycentrics);
  assert.deepEqual(bounded.indices.subarray(0, first.indices.length), first.indices);
  assert.equal(bounded.interiorVertexCount, bounded.vertexCount - 6);
  assert.deepEqual(Array.from(source.indices), Array(9).fill(0));

  const many = buildZoomTopology(
    { indices: new Uint16Array(4096 * 3) },
    Array.from({ length: 4096 }, (_, face) => ({ face, segments: 16 as const })),
    65535,
  );
  assert.ok(many.vertexCount <= 65535);
  assert.ok(many.skippedFaces > 0);
  assert.ok(many.indices.every((index) => index < many.vertexCount));
  assert.equal(many.selectedFaces.length + many.skippedFaces, 4096);
});

test('nested interior samples and independent results remain deterministic and immutable', () => {
  let previous = new Set<string>();
  for (const segments of [4, 8, 16] as const) {
    const topology = buildZoomTopology(packet, [{ face: 0, segments }], 65535);
    const current = new Set(
      Array.from({ length: topology.vertexCount }, (_, vertex) =>
        point(topology, vertex).join(','),
      ),
    );
    for (const key of previous) {
      assert.ok(current.has(key), 'higher levels retain earlier samples');
    }
    previous = current;
    const repeated = buildZoomTopology(packet, [{ face: 0, segments }], 65535);
    assert.deepEqual(repeated, topology);
    topology.barycentrics.fill(-1);
    topology.indices.fill(0);
    assert.deepEqual(buildZoomTopology(packet, [{ face: 0, segments }], 65535), repeated);
  }
});

test('invalid or overlapping replacement requests fail before producing geometry', () => {
  assert.throws(() => buildZoomTopology(packet, [{ face: 1, segments: 4 }], 100), RangeError);
  assert.throws(() => buildZoomTopology(packet, [{ face: 0.5, segments: 4 }], 100), RangeError);
  assert.throws(
    () => buildZoomTopology(packet, [{ face: 0, segments: 3 as ZoomSegments }], 100),
    RangeError,
  );
  assert.throws(
    () =>
      buildZoomTopology(
        packet,
        [
          { face: 0, segments: 4 },
          { face: 0, segments: 8 },
        ],
        100,
      ),
    RangeError,
  );
  assert.throws(() => buildZoomTopology(packet, [], 65536), RangeError);
  assert.throws(() => buildZoomTopology(packet, [], -1), RangeError);
  assert.throws(() => buildZoomTopology(packet, [], 1.5), RangeError);
  assert.throws(() => buildZoomTopology({ indices: Uint16Array.of(0, 1) }, [], 100), RangeError);
});
