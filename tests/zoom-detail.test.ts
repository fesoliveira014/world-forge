import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  PHYSICAL_MATERIAL_FIELD_COUNT,
  type PhysicalMeshPacket,
} from '../src/core/view/physical-mesh-types';
import { fixedSurfaceGeometry, type FixedSurface } from '../src/render/FixedSurface';
import { ZoomDetail } from '../src/render/ZoomDetail';

function fixture() {
  const radius = 6_371_000;
  const packet: PhysicalMeshPacket = {
    batch: 0,
    mode: 'primal',
    directions: Float32Array.from(
      [
        [1, 0, 0],
        [1, 0.02, 0],
        [1, 0, 0.02],
      ].flatMap((v) => new THREE.Vector3(...v).normalize().toArray()),
    ),
    heights: new Float32Array([1000, 1200, 1100]),
    normals: new Int16Array([32767, 0, 32767, 0, 32767, 0]),
    materials: Array.from({ length: PHYSICAL_MATERIAL_FIELD_COUNT }, () => new Uint8Array(12)),
    colors: new Uint8Array(),
    indices: new Uint16Array([0, 1, 2]),
    bytes: 0,
  };
  const appearance = {
    projection: 'globe' as const,
    mapStyle: 'natural' as const,
    relief: 26,
    coastlines: false,
  };
  const material = new THREE.ShaderMaterial();
  const geometry = fixedSurfaceGeometry(packet, radius, appearance);
  const surface = new THREE.Mesh(geometry, material) as FixedSurface;
  const parent = new THREE.Group();
  parent.add(surface);
  parent.updateMatrixWorld();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 10);
  camera.position.set(1.05, 0.007, 0.007);
  camera.lookAt(1, 0.007, 0.007);
  camera.updateMatrixWorld();
  const canvas = { dataset: {} } as HTMLCanvasElement;
  const makeController = () =>
    new ZoomDetail(parent, [surface], [packet], [], radius, appearance, material, canvas);
  const detail = makeController();
  const tick = (time: number) => detail.tick(camera, 1000, 1000, time);
  const cleanup = () => {
    detail.dispose();
    geometry.dispose();
    material.dispose();
  };
  return {
    detail,
    makeController,
    camera,
    surface,
    material,
    packet,
    parent,
    canvas,
    tick,
    cleanup,
  };
}

async function installed(f: ReturnType<typeof fixture>) {
  for (let time = 0; time < 100; time++) {
    f.tick(time);
    await Promise.resolve();
    if (Number(f.canvas.dataset.zoomDetailRevision) > 0) {
      return time;
    }
  }
  assert.fail(`detail did not install: ${JSON.stringify(f.canvas.dataset)}`);
}

function preparing(f: ReturnType<typeof fixture>) {
  // Drain cooperative selection without resolving the asynchronous constraint
  // promise yet. This remains deterministic if a busy test runner preempts a slice.
  for (let attempt = 0; attempt < 100; attempt++) {
    f.tick(0);
    if (f.canvas.dataset.zoomDetailState === 'preparing') {
      return;
    }
  }
  assert.fail(`constraints did not start: ${JSON.stringify(f.canvas.dataset)}`);
}

test('complete patches morph in, preserve base buffers, and release only their own geometry', async () => {
  const f = fixture();
  const original = structuredClone(f.packet);
  const attributes = { ...f.surface.geometry.attributes };
  const index = f.surface.geometry.index;
  let materialDisposals = 0;
  let baseDisposals = 0;
  f.material.addEventListener('dispose', () => materialDisposals++);
  f.surface.geometry.addEventListener('dispose', () => baseDisposals++);
  try {
    f.tick(0);
    assert.equal(f.surface.visible, true, 'the complete base remains visible during preparation');
    const start = await installed(f);
    assert.equal(f.surface.visible, false);
    assert.equal(f.canvas.dataset.zoomDetailBlend, '0.000');
    assert.equal(f.parent.children.length, 3, 'base, shared-attribute mask, and one patch');
    f.tick(start + 120);
    assert.equal(f.material.uniforms.zoomBlend.value, 0.5);
    f.tick(start + 240);
    assert.equal(f.canvas.dataset.zoomDetailState, 'ready');
    assert.equal(f.material.uniforms.zoomBlend.value, 1);
    assert.ok(f.detail.bytes > 0);
    assert.ok(Number(f.canvas.dataset.zoomDetailVertices) <= 32760);
    assert.deepEqual(f.packet, original);
    assert.deepEqual(f.surface.geometry.attributes, attributes);
    assert.equal(f.surface.geometry.index, index);
    f.detail.dispose();
    f.detail.dispose();
    assert.equal(f.surface.visible, true);
    assert.deepEqual(f.parent.children, [f.surface]);
    assert.equal(f.detail.bytes, 0);
    assert.equal(f.material.uniforms.zoomBlend.value, 0);
    assert.equal(materialDisposals, 0, 'the controller borrows the shared material');
    assert.equal(baseDisposals, 0, 'the controller borrows base terrain buffers');
  } finally {
    f.cleanup();
  }
});

test('an empty replacement fades the old complete patch out and settles without recurring work', async () => {
  const f = fixture();
  try {
    const start = await installed(f);
    f.tick(start + 240);
    const patch = f.parent.children.find((child) => child.name === 'zoom-detail');
    f.camera.lookAt(2, 0.007, 0.007);
    f.camera.updateMatrixWorld();
    f.tick(start + 250);
    f.tick(start + 339);
    assert.equal(f.material.uniforms.zoomBlend.value, 1, 'quiet interval avoids chatter');
    for (let attempt = 0; attempt < 100; attempt++) {
      f.tick(start + 340);
      if (f.canvas.dataset.zoomDetailState === 'transitioning') {
        break;
      }
    }
    assert.equal(f.canvas.dataset.zoomDetailState, 'transitioning');
    assert.equal(f.parent.children.includes(patch!), true);
    f.tick(start + 430);
    assert.equal(f.material.uniforms.zoomBlend.value, 0.5);
    assert.equal(f.surface.visible, false, 'base replacement happens only at zero morph');
    f.tick(start + 520);
    assert.equal(f.surface.visible, true);
    assert.deepEqual(f.parent.children, [f.surface]);
    assert.equal(f.canvas.dataset.zoomDetailRevision, '2');
    for (let time = 1000; time < 10_000; time += 100) {
      f.tick(time);
    }
    assert.equal(f.canvas.dataset.zoomDetailRevision, '2');
    assert.equal(f.canvas.dataset.zoomDetailState, 'ready');
    assert.equal(f.detail.bytes, 0);
  } finally {
    f.cleanup();
  }
});

test('disposal while river constraints prepare cannot install a late patch into a replacement view', async () => {
  const f = fixture();
  try {
    preparing(f);
    f.detail.dispose();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(f.tick(1000), false);
    assert.deepEqual(f.parent.children, [f.surface]);
    assert.equal(f.canvas.dataset.zoomDetailState, 'off');
    assert.equal(f.detail.bytes, 0);
    assert.equal(f.material.uniforms.zoomBlend.value, 0);
  } finally {
    f.cleanup();
  }
});

test('errors abort pending work, restore base terrain, and do not poison the next controller', async () => {
  const f = fixture();
  try {
    preparing(f);
    f.detail.tick({} as THREE.Camera, 1000, 1000, 1);
    assert.equal(f.canvas.dataset.zoomDetailState, 'error');
    assert.ok(f.canvas.dataset.zoomDetailError);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(f.tick(1000), false);
    assert.equal(f.detail.bytes, 0);
    assert.equal(f.canvas.dataset.zoomDetailBlend, '0.000');
    assert.deepEqual(f.parent.children, [f.surface]);
    f.detail.dispose();
    const replacement = f.makeController();
    try {
      assert.equal(f.canvas.dataset.zoomDetailError, undefined);
      replacement.tick(f.camera, 1000, 1000, 0);
      await Promise.resolve();
      for (let time = 1; time < 100; time++) {
        replacement.tick(f.camera, 1000, 1000, time);
      }
      assert.equal(f.canvas.dataset.zoomDetailRevision, '1');
      assert.equal(f.surface.visible, false);
    } finally {
      replacement.dispose();
    }
  } finally {
    f.cleanup();
  }
});
