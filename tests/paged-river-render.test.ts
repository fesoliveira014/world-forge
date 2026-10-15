import assert from 'node:assert/strict';
import test from 'node:test';
import { Mesh, PerspectiveCamera, ShaderMaterial } from 'three';
import type { OverlayLines, OverlayPacket, WorldHandle } from '../src/core/view/types';
import { disposeRenderObject, PagedOverlays } from '../src/render/PagedOverlays';

const point = (longitude: number, latitude = 0) => [
  Math.cos(latitude) * Math.cos(longitude),
  Math.sin(latitude),
  Math.cos(latitude) * Math.sin(longitude),
];
const empty: OverlayLines = {
  positions: new Float32Array(),
  heights: new Float32Array(),
  widths: new Float32Array(),
  discharge: new Float32Array(),
};
const handle = { config: { radius: 6371000 } } as WorldHandle;

function ribbons(projection: 'globe' | 'map') {
  const packet: OverlayPacket = {
    rivers: {
      positions: Float32Array.from([
        ...point(-1),
        ...point(-0.8),
        ...point(3.13),
        ...point(-3.13),
        ...point(1, 1.5),
        ...point(1.2, 1.5),
        ...point(0.5),
        ...point(0.5),
      ]),
      heights: Float32Array.from([100, 110, 120, 130, 140, 150, 0, 0]),
      widths: Float32Array.from([50, 500, 1500, 3000]),
      discharge: Float32Array.from([40, 1000, 10000, 10000]),
    },
    coasts: empty,
    boundaries: empty,
    flow: empty,
    grid: empty,
    drift: empty,
    deposits: [],
    truncated: false,
  };
  return new PagedOverlays(
    packet,
    handle,
    {
      projection,
      relief: 26,
      mapStyle: 'natural',
      riverWidth: 1,
      particleCount: 0,
      vectors: false,
    },
    null,
  );
}

test('river map ribbons split dateline crossings without duplicating ordinary reaches or losing widths', () => {
  const overlays = ribbons('map');
  assert.equal(overlays.children.length, 1);
  const mesh = overlays.children[0] as Mesh;
  const positions = mesh.geometry.getAttribute('position');
  const other = mesh.geometry.getAttribute('other');
  const widths = mesh.geometry.getAttribute('channelWidth');
  assert.equal(positions.count, 4 * 6, 'one ordinary reach, two seam pieces, one polar reach');
  for (let segment = 0; segment < 4; segment++) {
    const expected = [50, 500, 500, 1500][segment] / handle.config.radius;
    for (let vertex = segment * 6; vertex < (segment + 1) * 6; vertex++) {
      assert.ok(Math.abs(widths.getX(vertex) - expected) < 1e-10);
      assert.ok(
        Math.abs(positions.getX(vertex) - other.getX(vertex)) < 0.21,
        'no ribbon crosses the map interior at the seam',
      );
      assert.ok(Math.abs(positions.getX(vertex)) <= Math.PI + 1e-6);
      for (let axis = 0; axis < 3; axis++) {
        assert.ok(Number.isFinite(positions.getComponent(vertex, axis)));
        assert.ok(Number.isFinite(other.getComponent(vertex, axis)));
      }
    }
  }
  assert.equal((mesh.material as ShaderMaterial).uniforms.flatView.value, true);
  disposeRenderObject(overlays);
});

test('globe rivers keep draped endpoint relief with viewport width and explicit horizon material', () => {
  const overlays = ribbons('globe');
  const mesh = overlays.children[0] as Mesh;
  const material = mesh.material as ShaderMaterial;
  const positions = mesh.geometry.getAttribute('position');
  assert.equal(positions.count, 18, 'a coincident-endpoint reach allocates no degenerate ribbon');
  const radial = Math.hypot(positions.getX(0), positions.getY(0), positions.getZ(0));
  assert.ok(Math.abs(radial - (1 + (100 / handle.config.radius) * 26 + 0.000018)) < 1e-7);
  assert.equal(
    material.depthTest,
    false,
    'coarser display triangles cannot bury the draped ribbon',
  );
  assert.equal(material.depthWrite, false);
  assert.equal(mesh.frustumCulled, false, 'centerline bounds do not cull a screen-expanded edge');
  assert.equal(material.uniforms.flatView.value, false);
  // This guards the required occlusion path when depth testing is disabled.
  // GPU front/back and near-camera coverage is also checked in the browser QA.
  assert.match(
    material.fragmentShader,
    /dot\(normalize\(surfacePoint\), cameraPosition - surfacePoint\) <= 0\.0/,
  );
  for (const [width, height] of [
    [320, 900],
    [1600, 800],
  ]) {
    overlays.animate(0, false, 1, new PerspectiveCamera(), width, height);
    assert.equal(material.uniforms.viewport.value.x, width);
    assert.equal(material.uniforms.viewport.value.y, height);
  }
  let geometryDisposed = false;
  let materialDisposed = false;
  mesh.geometry.addEventListener('dispose', () => {
    geometryDisposed = true;
  });
  material.addEventListener('dispose', () => {
    materialDisposed = true;
  });
  disposeRenderObject(overlays);
  assert.ok(geometryDisposed && materialDisposed);
});
