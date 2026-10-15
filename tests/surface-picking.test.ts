import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { PhysicalMeshPacket } from '../src/core/view/physical-mesh-types';
import { fixedSurfaceGeometry } from '../src/render/FixedSurface';
import { geographicSurfaceAnchor } from '../src/render/SurfacePicking';
import { mapPoint, spherePoint } from '../src/render/projection';

const locations = [
  [2.95, 1.52],
  [3, 1.53],
  [3.05, 1.52],
];
const directions = Float32Array.from(
  locations.flatMap(([lon, lat]) => spherePoint(lon, lat, new THREE.Vector3()).toArray()),
);
const packet: PhysicalMeshPacket = {
  batch: 0,
  mode: 'dual',
  directions,
  heights: new Float32Array([2000, 2002, 1998]),
  normals: new Int16Array(),
  colors: new Uint8Array(12).fill(255),
  materials: [],
  indices: new Uint16Array([0, 1, 2]),
  bytes: 0,
};
const weights = [0.2, 0.3, 0.5];

test('simplified map picks recover geographic location through relief shear near a pole', () => {
  const expected = [0, 0];
  for (let vertex = 0; vertex < 3; vertex++) {
    const [lon, lat] = mapPoint(...new THREE.Vector3().fromArray(directions, vertex * 3).toArray());
    expected[0] += lon * weights[vertex];
    expected[1] += lat * weights[vertex];
  }
  for (const mapStyle of ['natural', 'relief'] as const) {
    const geometry = fixedSurfaceGeometry(packet, 6_371_000, {
      projection: 'map',
      mapStyle,
      relief: 26,
      coastlines: false,
    });
    const hit = new THREE.Vector3();
    for (let vertex = 0; vertex < 3; vertex++) {
      hit.addScaledVector(
        new THREE.Vector3().fromBufferAttribute(geometry.getAttribute('position'), vertex),
        weights[vertex],
      );
    }
    const anchor = geographicSurfaceAnchor(hit, 'map')!;
    assert.ok(anchor.distanceTo(spherePoint(expected[0], expected[1], new THREE.Vector3())) < 1e-7);
    assert.ok(Math.abs(anchor.length() - 1) < 1e-12);
    if (mapStyle === 'relief') {
      assert.ok(hit.z > 0);
    }
    geometry.dispose();
  }
});

test('globe picks use the displayed terrain hit direction without altering it', () => {
  const point = spherePoint(-1.1, 0.7, new THREE.Vector3()).multiplyScalar(1.02);
  const before = point.clone();
  const anchor = geographicSurfaceAnchor(point, 'globe')!;
  assert.ok(anchor.distanceTo(spherePoint(-1.1, 0.7, new THREE.Vector3())) < 1e-12);
  assert.deepEqual(point, before);
});

test('geographic picks reject clipped map copies and invalid hits while accepting pole rounding', () => {
  assert.equal(geographicSurfaceAnchor(new THREE.Vector3(Math.PI + 0.001, 0, 0), 'map'), null);
  assert.equal(geographicSurfaceAnchor(new THREE.Vector3(0, Math.PI / 2 + 0.001, 0), 'map'), null);
  assert.equal(geographicSurfaceAnchor(new THREE.Vector3(), 'globe'), null);
  assert.equal(geographicSurfaceAnchor(new THREE.Vector3(NaN, 1, 1), 'map'), null);
  const pole = geographicSurfaceAnchor(new THREE.Vector3(0, Math.fround(Math.PI / 2), 0), 'map')!;
  assert.ok(pole.distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-12);
});
