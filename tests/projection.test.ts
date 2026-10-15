import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Vector3,
} from 'three';
import { buildGrid, nearestCell } from '../src/core/grid/build';
import {
  mapPoint,
  projectMesh,
  spherePoint,
  updateMapAttributes,
  writeMapSegment,
  MAP_HEIGHT_SHEAR,
} from '../src/render/projection';

test('oblique relief preserves sea-level geography and interpolates height across the map seam', () => {
  const grid = buildGrid(2, 'oblique-map', 0.5);
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute(
      Array.from(grid.positions, (value) => value * 1.03),
      3,
    ),
  );
  geometry.setIndex(Array.from(grid.triangles));
  projectMesh(geometry, 0, 4);
  const position = geometry.getAttribute('position');
  for (let cell = 0; cell < grid.count; cell++) {
    const [longitude, latitude] = mapPoint(
      ...(Array.from(grid.positions.slice(cell * 3, cell * 3 + 3)) as [number, number, number]),
    );
    assert.ok(Math.abs(position.getX(cell) - longitude) < 1e-6);
    assert.ok(Math.abs(position.getY(cell) - latitude - 0.12 * MAP_HEIGHT_SHEAR) < 1e-6);
    assert.ok(Math.abs(position.getZ(cell) - 0.12) < 1e-6);
  }
  const first = spherePoint(Math.PI - 0.1, 0.2, new Vector3()).multiplyScalar(1.02);
  const second = spherePoint(-Math.PI + 0.1, 0.4, new Vector3()).multiplyScalar(1.04);
  const output = new Float32Array(12);
  writeMapSegment([...first.toArray(), ...second.toArray()], 0, 3, output, 0, 0, 4);
  assert.ok(Math.abs(output[3] - Math.PI) < 1e-6);
  assert.ok(Math.abs(output[6] + Math.PI) < 1e-6);
  assert.ok(Math.abs(output[5] - 0.12) < 1e-6);
  assert.equal(output[5], output[8]);
  assert.equal(output[4], output[7]);
});

test('map coordinates preserve north/east and pick the original spherical cell', () => {
  const grid = buildGrid(2, 'map-picking', 0.7);
  const p = new Vector3();

  for (let i = 0; i < grid.count; i++) {
    const lonlat = mapPoint(
      grid.positions[i * 3],
      grid.positions[i * 3 + 1],
      grid.positions[i * 3 + 2],
    );
    spherePoint(...lonlat, p);
    assert.equal(nearestCell(grid, p.x, p.y, p.z), i);
  }

  assert.deepEqual(mapPoint(1, 0, 0), [0, 0]);
  assert.equal(mapPoint(0, 0, 1)[0], Math.PI / 2);
  assert.equal(mapPoint(0, 1, 0)[1], Math.PI / 2);
});

type Point = [number, number];

// The material clips at ±π. Integrate its visible triangles to detect missing polar
// sectors or triangles incorrectly covering the entire map, without a browser harness.
function visibleArea(points: Point[]) {
  for (const sign of [-1, 1]) {
    const clipped: Point[] = [];

    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const insideA = sign * a[0] <= Math.PI;
      const insideB = sign * b[0] <= Math.PI;

      if (insideA) {
        clipped.push(a);
      }

      if (insideA !== insideB) {
        const x = sign * Math.PI;
        const t = (x - a[0]) / (b[0] - a[0]);
        clipped.push([x, a[1] + t * (b[1] - a[1])]);
      }
    }

    points = clipped;
  }

  return (
    Math.abs(
      points.reduce((area, p, i) => {
        const q = points[(i + 1) % points.length];

        return area + p[0] * q[1] - q[0] * p[1];
      }, 0),
    ) / 2
  );
}

test('regular and jittered meshes cover the complete map, including both poles and the seam', () => {
  for (const irregularity of [0, 0.7]) {
    const grid = buildGrid(2, 'map-surface', irregularity);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(grid.positions, 3));
    const field = new Float32Array(grid.count).fill(1);
    geometry.setAttribute('field', new Float32BufferAttribute(field, 1));
    geometry.setIndex(Array.from(grid.triangles));
    projectMesh(geometry);
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex()!;
    assert.ok(Array.from(position.array).every(Number.isFinite));
    let area = 0;

    for (let i = 0; i < index.count; i += 3) {
      const triangle = [0, 1, 2].map((d) => {
        const j = index.getX(i + d);

        return [position.getX(j), position.getY(j)] as Point;
      });
      assert.ok(
        Math.max(...triangle.map((p) => p[0])) - Math.min(...triangle.map((p) => p[0])) <=
          Math.PI + 1e-6,
      );
      area += visibleArea(triangle);
    }

    assert.ok(Math.abs(area - 2 * Math.PI ** 2) < 1e-5, `visible map area = ${area}`);

    // A field change must also reach seam copies and the interpolated polar values.
    for (let i = 0; i < grid.count; i++) {
      geometry.getAttribute('field').setX(i, 7);
    }

    updateMapAttributes(geometry, ['field']);
    assert.ok(
      Array.from(geometry.getAttribute('field').array).every((v) => Math.abs(v - 7) < 1e-5),
    );
    geometry.dispose();
  }
});

test('flow segments cross the dateline at the two map edges, never through its center', () => {
  const a = spherePoint((179 * Math.PI) / 180, 0.2, new Vector3());
  const b = spherePoint((-179 * Math.PI) / 180, 0.4, new Vector3());
  const source = new Float32Array([...a.toArray(), ...b.toArray()]);
  const output = new Float32Array(12);
  writeMapSegment(source, 0, 3, output, 0, 0.01);
  assert.ok(Math.abs(output[3] - Math.PI) < 1e-6);
  assert.ok(Math.abs(output[6] + Math.PI) < 1e-6);
  assert.ok(Math.abs(output[4] - 0.3) < 1e-6 && output[4] === output[7]);
  assert.ok(Math.abs(output[0] - output[3]) < 0.04 && Math.abs(output[6] - output[9]) < 0.04);
  writeMapSegment(source, 3, 0, output, 0, 0.01);
  assert.ok(Math.abs(output[3] + Math.PI) < 1e-6);
  assert.ok(Math.abs(output[6] - Math.PI) < 1e-6);
});

test('map seam and pole copies retain compact normalized attributes and refresh decoded values', () => {
  const grid = buildGrid(2, 'compact-map-fields', 0.7);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(grid.positions, 3));
  geometry.setIndex(Array.from(grid.triangles));
  const bytes = Uint8Array.from({ length: grid.count * 4 }, (_, i) => (i * 79) % 256);
  const signed = Int16Array.from(
    { length: grid.count * 2 },
    (_, i) => ((i * 8191) % 65535) - 32767,
  );
  const packed = new BufferAttribute(bytes, 4, true).setUsage(DynamicDrawUsage);
  const normal = new BufferAttribute(signed, 2, true);
  geometry.setAttribute('packed', packed);
  geometry.setAttribute('packedNormal', normal);
  geometry.setAttribute(
    'reference',
    new Float32BufferAttribute(
      Array.from(bytes, (v) => v / 255),
      4,
    ),
  );
  geometry.setAttribute(
    'normalReference',
    new Float32BufferAttribute(
      Array.from(signed, (v) => v / 32767),
      2,
    ),
  );
  projectMesh(geometry);
  const mapped = geometry.getAttribute('packed') as BufferAttribute;
  const mappedNormal = geometry.getAttribute('packedNormal') as BufferAttribute;
  assert.ok(mapped.count > grid.count);
  assert.ok(mapped.array instanceof Uint8Array);
  assert.ok(mappedNormal.array instanceof Int16Array);
  assert.equal(mapped.normalized, true);
  assert.equal(mappedNormal.normalized, true);
  assert.equal(mapped.usage, DynamicDrawUsage);
  assert.deepEqual(mapped.array.slice(0, bytes.length), bytes);
  assert.deepEqual(mappedNormal.array.slice(0, signed.length), signed);
  const verify = () => {
    for (const [name, referenceName, step] of [
      ['packed', 'reference', 1 / 255],
      ['packedNormal', 'normalReference', 1 / 32767],
    ] as const) {
      const attribute = geometry.getAttribute(name);
      const reference = geometry.getAttribute(referenceName);
      for (let vertex = 0; vertex < attribute.count; vertex++) {
        for (let component = 0; component < attribute.itemSize; component++) {
          assert.ok(
            Math.abs(
              attribute.getComponent(vertex, component) - reference.getComponent(vertex, component),
            ) <=
              step / 2 + 1e-7,
          );
        }
      }
    }
  };
  verify();
  for (let vertex = 0; vertex < grid.count; vertex++) {
    for (let component = 0; component < 4; component++) {
      const value = ((vertex * 17 + component * 59) % 256) / 255;
      mapped.setComponent(vertex, component, value);
      geometry.getAttribute('reference').setComponent(vertex, component, value);
    }
  }
  updateMapAttributes(geometry, ['packed', 'reference']);
  verify();
  geometry.dispose();
});

test('interpolated polar material pairs retain uint16 scalar precision', () => {
  const grid = buildGrid(2, 'compact-map-pairs', 0.7);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(grid.positions, 3));
  geometry.setIndex(Array.from(grid.triangles));
  const bytes = new Uint8Array(grid.count * 4);
  const scalar = new Float32Array(grid.count);
  for (let vertex = 0; vertex < grid.count; vertex++) {
    const value = (vertex * 7919) % 65536;
    bytes[vertex * 4 + 1] = value >> 8;
    bytes[vertex * 4 + 2] = value & 255;
    scalar[vertex] = value;
  }
  geometry.setAttribute('material1', new BufferAttribute(bytes, 4, true));
  geometry.setAttribute('scalar', new Float32BufferAttribute(scalar, 1));
  geometry.userData.mapPackedPairs = { material1: [1] };
  projectMesh(geometry);
  const material = geometry.getAttribute('material1');
  const reference = geometry.getAttribute('scalar');
  assert.ok(
    Array.from(reference.array).some((value) => Math.abs(value - Math.round(value)) > 0.1),
    'fixture must include interpolated polar vertices',
  );
  for (let vertex = 0; vertex < material.count; vertex++) {
    const decoded = (material.getY(vertex) * 256 + material.getZ(vertex)) * 255;
    assert.ok(
      Math.abs(decoded - reference.getX(vertex)) <= 0.505,
      `vertex ${vertex}: ${decoded} vs ${reference.getX(vertex)}`,
    );
  }
  geometry.dispose();
});

test('categorical map pole and seam triangles retain the original provoking owner through refresh', () => {
  const geometry = new BufferGeometry();
  const directions = [
    ...[0, (2 * Math.PI) / 3, (-2 * Math.PI) / 3].flatMap((longitude) =>
      spherePoint(longitude, 1.4, new Vector3()).toArray(),
    ),
    ...[0, (-2 * Math.PI) / 3, (2 * Math.PI) / 3].flatMap((longitude) =>
      spherePoint(longitude, -1.4, new Vector3()).toArray(),
    ),
    ...[
      [3, 0.2],
      [-3, 0.2],
      [3.1, 0.4],
    ].flatMap(([longitude, latitude]) => spherePoint(longitude, latitude, new Vector3()).toArray()),
  ];
  geometry.setAttribute('position', new Float32BufferAttribute(directions, 3));
  const colors = new Uint8Array(9 * 4);
  const ownerColors = [
    [255, 127, 31, 255],
    [31, 193, 255, 255],
    [97, 31, 193, 255],
  ];
  for (let triangle = 0; triangle < 3; triangle++) {
    colors.set(ownerColors[triangle], (triangle * 3 + 2) * 4);
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 4, true));
  geometry.setIndex([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  geometry.userData.mapFlatAttributes = ['color'];
  projectMesh(geometry);
  const index = geometry.getIndex()!;
  const position = geometry.getAttribute('position');
  const color = geometry.getAttribute('color') as BufferAttribute;
  const seen = new Set<number>();
  const verify = () => {
    for (let i = 0; i < index.count; i += 3) {
      const [a, b, c] = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
      if (a === b || a === c) {
        continue;
      }
      const latitude = (position.getY(a) + position.getY(b) + position.getY(c)) / 3;
      const owner = latitude > 1 ? 0 : latitude < -1 ? 1 : 2;
      seen.add(owner);
      assert.deepEqual(Array.from(color.array.slice(c * 4, c * 4 + 4)), ownerColors[owner]);
    }
  };
  verify();
  assert.equal(seen.size, 3);
  ownerColors[0] = [71, 89, 113, 255];
  for (let component = 0; component < 4; component++) {
    color.setComponent(2, component, ownerColors[0][component] / 255);
  }
  updateMapAttributes(geometry, ['color']);
  verify();
  geometry.dispose();
});

test('map indices stay compact through seam expansion and promote before the Uint16 restart limit', () => {
  const seam = [
    [3, 0.2],
    [-3, 0.2],
    [3.1, 0.4],
  ].flatMap(([longitude, latitude]) => spherePoint(longitude, latitude, new Vector3()).toArray());
  let referencePositions: number[] | undefined;
  for (const count of [3, 65529, 65530]) {
    const positions = new Float32Array(count * 3);
    for (let vertex = 0; vertex < count; vertex++) {
      positions[vertex * 3] = 1;
    }
    positions.set(seam, (count - 3) * 3);
    const original = new Uint16Array([count - 3, count - 2, count - 1]);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setIndex(new BufferAttribute(original, 1));
    projectMesh(geometry);
    const projected = geometry.getAttribute('position');
    const index = geometry.index!.array;
    assert.equal(projected.count, count + 6, 'one crossing triangle gains two unwrapped copies');
    assert.deepEqual(Array.from(index), [
      count - 3,
      count - 3,
      count - 3,
      count,
      count + 1,
      count + 2,
      count + 3,
      count + 4,
      count + 5,
    ]);
    assert.deepEqual(
      Array.from(original),
      [count - 3, count - 2, count - 1],
      'input topology is not modified',
    );
    if (count + 6 <= 65535) {
      assert.ok(index instanceof Uint16Array);
      assert.equal(index.byteLength, index.length * 2);
    } else {
      assert.ok(index instanceof Uint32Array);
      assert.equal(index.byteLength, index.length * 4);
      assert.ok(
        Array.from(index).includes(65535),
        'overflow fixture references the value reserved by Uint16',
      );
    }
    const copies = Array.from(projected.array.slice(count * 3));
    if (referencePositions) {
      assert.deepEqual(copies, referencePositions);
    } else {
      referencePositions = copies;
    }
    geometry.dispose();
  }
});

test('octahedral map normals remain radial on a constant-height sphere at both synthesized poles', () => {
  const grid = buildGrid(2, 'oct-projection-review', 0.7);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(grid.positions, 3));
  geometry.setAttribute('spherePosition', new Float32BufferAttribute(grid.positions, 3));
  const normals = new Int16Array(grid.count * 2);
  for (let vertex = 0; vertex < grid.count; vertex++) {
    let x = grid.positions[vertex * 3];
    let y = grid.positions[vertex * 3 + 1];
    const z = grid.positions[vertex * 3 + 2];
    const length = Math.abs(x) + Math.abs(y) + Math.abs(z);
    x /= length;
    y /= length;
    if (z < 0) {
      const previousX = x;
      x = (1 - Math.abs(y)) * (x < 0 ? -1 : 1);
      y = (1 - Math.abs(previousX)) * (y < 0 ? -1 : 1);
    }
    normals[vertex * 2] = Math.round(x * 32767);
    normals[vertex * 2 + 1] = Math.round(y * 32767);
  }
  geometry.setAttribute('packedNormal', new BufferAttribute(normals, 2, true));
  geometry.setIndex(Array.from(grid.triangles));
  geometry.userData.mapOctNormalAttributes = ['packedNormal'];
  projectMesh(geometry);
  const position = geometry.getAttribute('position');
  const sphere = geometry.getAttribute('spherePosition');
  const packed = geometry.getAttribute('packedNormal');
  const poles = new Set<number>();
  for (let vertex = grid.count; vertex < position.count; vertex++) {
    let x = packed.getX(vertex);
    let y = packed.getY(vertex);
    const z = 1 - Math.abs(x) - Math.abs(y);
    if (z < 0) {
      const previousX = x;
      x = (1 - Math.abs(y)) * (x < 0 ? -1 : 1);
      y = (1 - Math.abs(previousX)) * (y < 0 ? -1 : 1);
    }
    const normal = new Vector3(x, y, z).normalize();
    const radial = new Vector3().fromBufferAttribute(sphere, vertex).normalize();
    assert.ok(
      normal.angleTo(radial) < 0.00015,
      'display relief must not amplify artificial polar slopes',
    );
    if (Math.abs(Math.abs(position.getY(vertex)) - Math.PI / 2) < 1e-6) {
      poles.add(Math.sign(position.getY(vertex)));
    }
  }
  assert.equal(poles.size, 2, 'both poles must be synthesized in this irregular fixture');
  assert.deepEqual(
    packed.array.slice(0, normals.length),
    normals,
    'original normal bits are unchanged',
  );
  for (let vertex = 0; vertex < grid.count; vertex++) {
    packed.setXY(vertex, 0, 0);
  }
  updateMapAttributes(geometry, ['packedNormal']);
  assert.ok(
    Array.from(packed.array).every((component) => component === 0),
    'normal refresh uses the same decoded interpolation',
  );
  geometry.dispose();
});
