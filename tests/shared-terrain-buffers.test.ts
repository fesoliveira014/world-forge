import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  Triangle,
  Vector3,
} from 'three';
import { DEFAULT_CONFIG } from '../src/core/model';
import { buildGrid } from '../src/core/grid/build';
import {
  PHYSICAL_MATERIAL_FIELD_COUNT,
  type PhysicalMeshPacket,
} from '../src/core/view/physical-mesh-types';
import { fixedSurfaceGeometry } from '../src/render/FixedSurface';
import { projectMesh, spherePoint } from '../src/render/projection';

function packet(directions?: Float32Array, indices?: Uint16Array): PhysicalMeshPacket {
  const points =
    directions ??
    Float32Array.from(
      [
        [-0.4, -0.2],
        [0.4, -0.2],
        [-0.4, 0.2],
        [0.4, 0.2],
      ].flatMap(([lon, lat]) => spherePoint(lon, lat, new Vector3()).toArray()),
    );
  const count = points.length / 3;
  const data = {
    batch: 0,
    mode: 'primal' as const,
    directions: points,
    heights: Float32Array.from({ length: count }, (_, i) => 100 + i * 17),
    normals: Int16Array.from({ length: count * 2 }, (_, i) => (i * 7919) % 32767),
    colors: Uint8Array.from({ length: count * 4 }, (_, i) => (i * 41) % 256),
    materials: Array.from({ length: PHYSICAL_MATERIAL_FIELD_COUNT }, (_, field) =>
      Uint8Array.from({ length: count * 4 }, (_, i) => (i * 79 + field * 11) % 256),
    ),
    indices: indices ?? Uint16Array.of(0, 2, 1, 1, 2, 3),
    bytes: 0,
  };
  data.bytes = [
    data.directions,
    data.heights,
    data.normals,
    data.colors,
    ...data.materials,
    data.indices,
  ].reduce((sum, array) => sum + array.byteLength, 0);
  return data;
}
const appearance = {
  projection: 'map' as const,
  mapStyle: 'natural' as const,
  relief: 26,
  coastlines: true,
};

test('ordinary map batches share immutable fields and topology while preserving exact picking', () => {
  for (const mapStyle of ['natural', 'relief', 'illustrated'] as const) {
    const input = packet();
    const before = structuredClone(input);
    const globe = fixedSurfaceGeometry(input, DEFAULT_CONFIG.radius, {
      ...appearance,
      projection: 'globe',
      mapStyle,
    });
    const map = fixedSurfaceGeometry(input, DEFAULT_CONFIG.radius, { ...appearance, mapStyle });
    assert.equal(map.getAttribute('position').count, input.heights.length);
    assert.equal(map.index!.array, input.indices);
    assert.notEqual(map.getAttribute('position').array, input.directions);
    assert.notEqual(map.getAttribute('position').array, globe.getAttribute('position').array);
    for (const [name, attribute] of Object.entries(globe.attributes)) {
      if (name === 'position') {
        continue;
      }
      assert.equal(map.getAttribute(name).array, attribute.array, `${name} retains one CPU buffer`);
      assert.equal(map.getAttribute(name).normalized, attribute.normalized);
    }
    assert.equal(map.getAttribute('normal'), undefined);
    // Click a real projected triangle, then reconstruct the same spherical anchor
    // used by the app. Buffer sharing must not turn this into a flat-map coordinate.
    const position = map.getAttribute('position');
    const a = new Vector3().fromBufferAttribute(position, input.indices[0]);
    const b = new Vector3().fromBufferAttribute(position, input.indices[1]);
    const c = new Vector3().fromBufferAttribute(position, input.indices[2]);
    const point = a.clone().add(b).add(c).divideScalar(3);
    const mesh = new Mesh(map, new MeshBasicMaterial({ side: DoubleSide }));
    const ray = new Raycaster(new Vector3(point.x, point.y, point.z + 2), new Vector3(0, 0, -1));
    const hit = ray.intersectObject(mesh)[0];
    assert.ok(hit?.face);
    const weights = Triangle.getBarycoord(hit.point, a, b, c, new Vector3())!;
    const sphere = map.getAttribute('spherePosition');
    const anchor = new Vector3();
    const expected = new Vector3();
    [input.indices[0], input.indices[1], input.indices[2]].forEach((vertex, i) => {
      anchor.addScaledVector(
        new Vector3().fromBufferAttribute(sphere, vertex),
        weights.getComponent(i),
      );
      expected.add(new Vector3().fromArray(input.directions, vertex * 3));
    });
    assert.ok(anchor.normalize().distanceTo(expected.normalize()) < 1e-12);
    map.dispose();
    mesh.material.dispose();
    assert.deepEqual(input, before, 'map disposal/rebuild cannot mutate retained source buffers');
    const rebuilt = fixedSurfaceGeometry(input, DEFAULT_CONFIG.radius, {
      ...appearance,
      projection: 'globe',
      mapStyle,
    });
    assert.deepEqual(rebuilt.getAttribute('position').array, globe.getAttribute('position').array);
    rebuilt.dispose();
    globe.dispose();
  }
});

test('seam and pole expansion keeps separate writable copies and leaves every source field unchanged', () => {
  const grid = buildGrid(2, 'shared-fields-polar-coverage', 0.7);
  const input = packet(Float32Array.from(grid.positions), Uint16Array.from(grid.triangles));
  const before = structuredClone(input);
  const geometry = fixedSurfaceGeometry(input, DEFAULT_CONFIG.radius, {
    ...appearance,
    mapStyle: 'relief',
  });
  assert.ok(geometry.getAttribute('position').count > input.heights.length);
  assert.notEqual(geometry.index!.array, input.indices);
  for (const [name, source] of [
    ['spherePosition', input.directions],
    ['physicalHeight', input.heights],
    ['packedNormal', input.normals],
    ['color', input.colors],
    ...input.materials.map((array, field) => [`material${field}`, array]),
  ] as const) {
    const attribute = geometry.getAttribute(name as string);
    assert.notEqual(attribute.array, source);
    assert.deepEqual(attribute.array.slice(0, (source as ArrayLike<number>).length), source);
  }
  assert.deepEqual(input, before);
  assert.ok(Array.from(geometry.getAttribute('position').array).every(Number.isFinite));
  geometry.dispose();
});

test('projection normal generation is optional without changing projected geometry or source normals', () => {
  const input = packet();
  const positions = Float32Array.from(input.directions, (value) => value * 1.03);
  const normals = new Float32Array(input.directions.length).fill(0.25);
  const before = normals.slice();
  const create = () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(normals, 3));
    geometry.setIndex(new BufferAttribute(input.indices, 1));
    return geometry;
  };
  const computed = create();
  const retained = create();
  projectMesh(computed, 0, 4);
  projectMesh(retained, 0, 4, { computeNormals: false });
  assert.deepEqual(
    computed.getAttribute('position').array,
    retained.getAttribute('position').array,
  );
  assert.deepEqual(computed.index!.array, retained.index!.array);
  assert.notEqual(computed.getAttribute('normal').array, normals);
  assert.equal(retained.getAttribute('normal').array, normals);
  assert.deepEqual(normals, before, 'rewritten normals cannot corrupt a shared source array');
  computed.dispose();
  retained.dispose();
});
