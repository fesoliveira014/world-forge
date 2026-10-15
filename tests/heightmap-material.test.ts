import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createHeightmapMaterial } from '../src/render/HeightmapMaterial';

function displayByte(material: THREE.ShaderMaterial, elevation: number) {
  const range = material.uniforms.heightmapRange.value as THREE.Vector2;
  const gray = range.x === range.y ? 0.5 : (elevation - range.x) / (range.y - range.x);
  return Math.round(Math.min(1, Math.max(0, gray)) * 255);
}

test('heightmap uses world extrema, including underwater terrain, as black and white', () => {
  const material = createHeightmapMaterial([-12000, 18000], [-8000, 6000], false);
  assert.deepEqual(material.uniforms.elevationRange.value.toArray(), [-12000, 18000]);
  assert.equal(displayByte(material, -8000), 0);
  assert.equal(displayByte(material, 6000), 255);
  assert.equal(displayByte(material, -1000), 128);
  assert.equal(displayByte(material, 0), 146);
  assert.equal(displayByte(material, -12000), 0);
  assert.equal(displayByte(material, 18000), 255);
  // Seasonal water levels, biome colors and normals cannot alter the scalar.
  assert.deepEqual(Object.keys(material.uniforms).sort(), ['elevationRange', 'heightmapRange']);
  assert.match(material.vertexShader, /dot\(material0\.rg, vec2\(65280\.0, 255\.0\)\) \/ 65535\.0/);
  assert.doesNotMatch(material.vertexShader, /physicalHeight|packedNormal|color|material[1-4]/);
  material.dispose();
});

test('heightmap interpolates decoded elevation before normalization and writes direct grayscale', () => {
  const material = createHeightmapMaterial([-32768, 32767], [-10000, 20000], false);
  assert.match(material.vertexShader, /varying float heightmapElevation;/);
  assert.match(material.fragmentShader, /varying float heightmapElevation;/);
  assert.doesNotMatch(material.vertexShader, /heightmapRange|clamp|floor|round/);
  assert.match(
    material.fragmentShader,
    /clamp\(\(heightmapElevation - heightmapRange\.x\) \/ span, 0\.0, 1\.0\)/,
  );
  assert.match(material.fragmentShader, /gl_FragColor = vec4\(vec3\(gray\), 1\.0\);/);
  assert.doesNotMatch(material.fragmentShader, /#include|texture|pow|linearToOutputTexel/);
  assert.equal(material.lights, false);
  assert.equal(material.fog, false);
  assert.equal(material.toneMapped, false);
  assert.equal(material.transparent, false);
  assert.equal(material.userData.fixedSurfacePacketOrder, true);
  material.dispose();
});

test('heightmap clips flat map seam copies and keeps the globe front sided', () => {
  const globe = createHeightmapMaterial([-8000, 6000], [-8000, 6000], false);
  const flat = createHeightmapMaterial([-8000, 6000], [-8000, 6000], true);
  assert.equal(globe.side, THREE.FrontSide);
  assert.doesNotMatch(globe.fragmentShader, /discard/);
  assert.equal(flat.side, THREE.DoubleSide);
  assert.match(flat.vertexShader, /mapLongitude = position\.x;/);
  assert.match(flat.fragmentShader, /if \(abs\(mapLongitude\) > 3\.14159265359\) discard;/);
  for (const material of [globe, flat]) {
    assert.match(
      material.vertexShader,
      /projectionMatrix \* modelViewMatrix \* vec4\(position, 1\.0\)/,
    );
    assert.doesNotMatch(material.vertexShader, /spherePosition|normalMatrix|physicalRadius/);
    material.dispose();
  }
});

test('constant or invalid ranges retain finite uniforms and a deterministic neutral fallback', () => {
  for (const value of [-7000, 0, 5000]) {
    const material = createHeightmapMaterial([-8000, 6000], [value, value], false);
    assert.equal(displayByte(material, value), 128);
    assert.deepEqual(material.uniforms.heightmapRange.value.toArray(), [value, value]);
    material.dispose();
  }
  for (const range of [
    [NaN, Infinity],
    [-Infinity, 5000],
    [-Number.MAX_VALUE, Number.MAX_VALUE],
    [8000, -6000],
    [0, 1e-50],
  ] as const) {
    const material = createHeightmapMaterial(range, range, false);
    for (const uniform of Object.values(material.uniforms)) {
      assert.ok(
        uniform.value.toArray().every((value: number) => Number.isFinite(Math.fround(value))),
      );
    }
    material.dispose();
  }
});
