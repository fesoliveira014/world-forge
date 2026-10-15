import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { TerrainBatchRenderer, TERRAIN_SLAB_PACKETS } from '../src/render/TerrainBatchRenderer';
import type { FixedSurface } from '../src/render/FixedSurface';

function mockContext(extension = true) {
  const stores = new Map<WebGLBuffer, Uint8Array>();
  const deleted: WebGLBuffer[] = [];
  const targets: number[] = [];
  let bound: WebGLBuffer | null = null;
  let nextBuffer = 0;
  const originalVao = { original: true } as unknown as WebGLVertexArrayObject;
  let vao: WebGLVertexArrayObject | null = originalVao;
  const classification = new Map<WebGLBuffer, number>();
  const gl = {
    COPY_WRITE_BUFFER: 0x8f37,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    VERTEX_ARRAY_BINDING: 0x85b5,
    getParameter() {
      return vao;
    },
    createVertexArray() {
      return {} as WebGLVertexArrayObject;
    },
    bindVertexArray(value: WebGLVertexArrayObject | null) {
      vao = value;
    },
    deleteVertexArray(value: WebGLVertexArrayObject) {
      assert.notEqual(value, vao);
    },
    FLOAT: 0x1406,
    UNSIGNED_BYTE: 0x1401,
    BYTE: 0x1400,
    UNSIGNED_SHORT: 0x1403,
    SHORT: 0x1402,
    UNSIGNED_INT: 0x1405,
    INT: 0x1404,
    STATIC_DRAW: 0x88e4,
    copyBufferSubData() {},
    getExtension(name: string) {
      return name === 'WEBGL_multi_draw' && extension ? {} : null;
    },
    createBuffer() {
      return { id: nextBuffer++ } as unknown as WebGLBuffer;
    },
    bindBuffer(target: number, buffer: WebGLBuffer | null) {
      targets.push(target);
      if (buffer) {
        if (!classification.has(buffer)) {
          classification.set(buffer, target);
        }
        if (target === 0x8893) {
          assert.notEqual(vao, originalVao, 'Never mutate the renderer-owned VAO');
          assert.equal(classification.get(buffer), target, 'Index buffers must first bind as EAB');
        }
      }
      bound = buffer;
    },
    bufferData(target: number, bytes: number) {
      targets.push(target);
      assert.ok(bound);
      stores.set(bound, new Uint8Array(bytes));
    },
    bufferSubData(target: number, offset: number, view: ArrayBufferView) {
      targets.push(target);
      assert.ok(bound);
      stores.get(bound)!.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), offset);
    },
    deleteBuffer(buffer: WebGLBuffer) {
      deleted.push(buffer);
      stores.delete(buffer);
    },
  };
  return {
    gl: gl as unknown as WebGL2RenderingContext,
    stores,
    deleted,
    targets,
    classification,
    originalVao,
  };
}
function material() {
  const result = new THREE.ShaderMaterial();
  result.userData.fixedSurfacePacketOrder = true;
  return result;
}
function surface(shared: THREE.ShaderMaterial, x = 0, vertices = 3): FixedSurface {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(vertices * 3);
  positions.set([x - 0.1, -0.1, 0, x + 0.1, -0.1, 0, x, 0.1, 0]);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('spherePosition', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute(
    'packedNormal',
    new THREE.BufferAttribute(new Int16Array(vertices * 2).fill(13), 2, true),
  );
  geometry.setAttribute(
    'material0',
    new THREE.BufferAttribute(new Uint8Array(vertices * 4).fill(127), 4, true),
  );
  geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return new THREE.Mesh(geometry, shared) as unknown as FixedSurface;
}
function camera() {
  const result = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  result.position.z = 3;
  result.lookAt(0, 0, 0);
  result.updateMatrixWorld();
  return result;
}

test('GPU slabs keep original CPU arrays and concatenate exact packed attributes with Uint16 indices', () => {
  const mock = mockContext();
  const parent = new THREE.Group();
  const owner = new TerrainBatchRenderer({ getContext: () => mock.gl }, parent);
  const shared = material();
  const first = surface(shared, -0.2);
  const second = surface(shared, 0.2);
  const firstPosition = first.geometry.getAttribute('position');
  const originalIndex = first.geometry.index;
  parent.add(first);
  owner.add(first);
  parent.add(second);
  owner.add(second);
  const slab = owner.slabs[0];
  const identities = Object.values(slab.mesh.geometry.attributes);
  const nativeBuffers = identities.map(
    (field) => (field as unknown as THREE.GLBufferAttribute).buffer,
  );
  const allocationBeforeSeal = owner.stats.gpuBytes;
  owner.finish();
  assert.ok(owner.stats.gpuBytes < allocationBeforeSeal);
  assert.deepEqual(Object.values(slab.mesh.geometry.attributes), identities);
  assert.deepEqual(
    identities.map((field) => (field as unknown as THREE.GLBufferAttribute).buffer),
    nativeBuffers,
  );
  for (const [name, field] of Object.entries(slab.mesh.geometry.attributes)) {
    const attribute = field as unknown as THREE.GLBufferAttribute;
    const firstField = first.geometry.getAttribute(name) as THREE.BufferAttribute;
    const secondField = second.geometry.getAttribute(name) as THREE.BufferAttribute;
    const expected = Buffer.concat([
      Buffer.from(firstField.array.buffer),
      Buffer.from(secondField.array.buffer),
    ]);
    assert.deepEqual(Buffer.from(mock.stores.get(attribute.buffer)!), expected);
    assert.equal(attribute.normalized, firstField.normalized);
    assert.equal(attribute.itemSize, firstField.itemSize);
    assert.equal(attribute.count, 6);
  }
  const index = slab.mesh.geometry.index as unknown as THREE.GLBufferAttribute;
  assert.equal(index.type, mock.gl.UNSIGNED_SHORT);
  assert.deepEqual([...new Uint16Array(mock.stores.get(index.buffer)!.buffer)], [0, 1, 2, 3, 4, 5]);
  assert.equal(first.geometry.getAttribute('position'), firstPosition);
  assert.equal(first.geometry.index, originalIndex);
  assert.equal(first.parent, null);
  assert.equal(first.userData.terrainBatched, true);
  assert.equal(first.material, slab.mesh.material);
  assert.equal(owner.stats.gpuBytes, owner.stats.replacedGpuBytes);
  // Only the initial index classification uses EAB, inside an owned temporary
  // VAO; subsequent upload targets preserve Three's current VAO/index binding.
  assert.equal(mock.targets.filter((target) => target === mock.gl.ELEMENT_ARRAY_BUFFER).length, 1);
  assert.equal(mock.classification.get(index.buffer), mock.gl.ELEMENT_ARRAY_BUFFER);
  assert.equal(mock.gl.getParameter(mock.gl.VERTEX_ARRAY_BINDING), mock.originalVao);
  // Original CPU geometry remains raycastable after removal from scene.
  const ray = new THREE.Raycaster(new THREE.Vector3(-0.2, 0, 3), new THREE.Vector3(0, 0, -1));
  assert.equal(ray.intersectObject(first).length, 1);
  owner.dispose();
});

test('draw ranges preserve packet order, composed masks, and per-packet camera frustum on native/fallback paths', () => {
  for (const extension of [true, false]) {
    const mock = mockContext(extension);
    const owner = new TerrainBatchRenderer({ getContext: () => mock.gl }, new THREE.Group());
    const shared = material();
    const sources = [surface(shared), surface(shared, 50), surface(shared), surface(shared)];
    sources.forEach((source) => owner.add(source));
    sources[2].visible = false; // Zoom masked or horizon-culled original.
    owner.finish();
    owner.prepare(camera());
    const mesh = owner.slabs[0].mesh;
    assert.deepEqual([...mesh._multiDrawStarts.slice(0, mesh._multiDrawCount)], [0, 18]);
    assert.deepEqual([...mesh._multiDrawCounts.slice(0, mesh._multiDrawCount)], [3, 3]);
    assert.equal(owner.stats.visiblePackets, 2);
    assert.equal(owner.stats.drawCalls, extension ? 1 : 2);
    assert.equal(owner.mode, extension ? 'multi-draw' : 'fallback');
    assert.equal(mesh.colorTexture, null);
    assert.equal(mesh._colorsTexture, null);
    assert.equal(mesh._matricesTexture, null);
    assert.equal(mesh._indirectTexture, null);
    sources.forEach((source) => {
      source.visible = false;
    });
    owner.prepare(camera());
    assert.equal(mesh.visible, false);
    assert.equal(owner.stats.drawCalls, 0);
    owner.dispose();
  }
});

test('slab packet/vertex bounds and unsupported ordinary meshes preserve creation order', () => {
  const mock = mockContext();
  const parent = new THREE.Group();
  const owner = new TerrainBatchRenderer({ getContext: () => mock.gl }, parent);
  const shared = material();
  for (let i = 0; i < TERRAIN_SLAB_PACKETS + 1; i++) {
    const base = surface(shared);
    parent.add(base);
    assert.equal(owner.add(base), true);
  }
  assert.deepEqual(
    owner.slabs.map((slab) => slab.entries.length),
    [16, 1],
  );
  const unsupported = surface(shared, 0, 65536);
  parent.add(unsupported);
  assert.equal(owner.add(unsupported), false);
  assert.equal(unsupported.userData.terrainBatched, false);
  assert.equal(unsupported.parent, parent);
  const large = surface(shared, 0, 40000);
  parent.add(large);
  owner.add(large);
  const following = surface(shared, 0, 40000);
  parent.add(following);
  owner.add(following);
  owner.finish();
  assert.deepEqual(
    owner.slabs.map((slab) => slab.entries.length),
    [16, 1, 1, 1],
  );
  const ordered = [...owner.slabs.map((slab) => slab.mesh), unsupported].sort(
    (a, b) => a.id - b.id,
  );
  assert.deepEqual(ordered, [
    owner.slabs[0].mesh,
    owner.slabs[1].mesh,
    unsupported,
    owner.slabs[2].mesh,
    owner.slabs[3].mesh,
  ]);
  assert.equal(owner.add(large), true);
  assert.equal(owner.stats.packets, 19);
  owner.dispose();
});

test('explicit native ownership frees rendered and never-rendered stores exactly once without shared material disposal', () => {
  const mock = mockContext();
  const owner = new TerrainBatchRenderer({ getContext: () => mock.gl }, new THREE.Group());
  const shared = material();
  let materialDisposals = 0;
  shared.addEventListener('dispose', () => materialDisposals++);
  const base = surface(shared);
  owner.add(base);
  const slab = owner.slabs[0];
  const count = mock.stores.size;
  let geometryDisposals = 0;
  slab.mesh.geometry.addEventListener('dispose', () => {
    geometryDisposals++;
    assert.deepEqual(Object.keys(slab.mesh.geometry.attributes), []);
    assert.equal(slab.mesh.geometry.index, null);
  });
  owner.dispose();
  owner.dispose();
  assert.equal(mock.deleted.length, count);
  assert.equal(new Set(mock.deleted).size, count);
  assert.equal(mock.stores.size, 0);
  assert.equal(materialDisposals, 0);
  assert.equal(geometryDisposals, 1);
  assert.equal(base.userData.terrainBatched, false);
  assert.equal(base.geometry.getAttribute('position').count, 3);
  assert.equal(owner.stats.cpuBytes, 0);
});

test('stock shader batching chunks remain on the ordinary compatible path', () => {
  const mock = mockContext();
  const parent = new THREE.Group();
  const owner = new TerrainBatchRenderer({ getContext: () => mock.gl }, parent);
  const shared = material();
  shared.vertexShader = '#include <batching_vertex>\nvoid main(){}';
  const base = surface(shared);
  parent.add(base);
  assert.equal(owner.add(base), false);
  assert.equal(parent.children[0], base);
  assert.equal(mock.stores.size, 0);
  owner.dispose();
});

test('the final Uint16 vertex remains below primitive restart and the next packet starts a new slab', () => {
  const mock = mockContext();
  const owner = new TerrainBatchRenderer({ getContext: () => mock.gl }, new THREE.Group());
  const shared = material();
  owner.add(surface(shared, 0, 65532));
  owner.add(surface(shared));
  owner.add(surface(shared));
  owner.finish();
  assert.equal(owner.slabs.length, 2);
  const index = owner.slabs[0].mesh.geometry.index as unknown as THREE.GLBufferAttribute;
  assert.deepEqual(
    [...new Uint16Array(mock.stores.get(index.buffer)!.buffer)],
    [0, 1, 2, 65532, 65533, 65534],
  );
  assert.equal(owner.slabs[1].entries[0].vertexOffset, 0);
  owner.dispose();
});
