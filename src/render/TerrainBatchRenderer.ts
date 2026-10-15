import * as THREE from 'three';
import type { FixedSurface } from './FixedSurface';

/** Leave 65535 unused: WebGL2 reserves that Uint16 value for primitive restart. */
export const TERRAIN_SLAB_VERTICES = 65535;
export const TERRAIN_SLAB_PACKETS = 16;
const SLAB_INDICES = 393216;

interface AttributeLayout {
  name: string;
  type: number;
  itemSize: number;
  elementSize: 1 | 2 | 4;
  normalized: boolean;
  gpuType: THREE.AttributeGPUType;
}
interface SlabEntry {
  surface: FixedSurface;
  vertexOffset: number;
  indexOffset: number;
  count: number;
}

/** Deliberately narrow r185 WebGLRenderer adapter, NOT a general BatchedMesh.
 * These custom shaders never include Three's batching chunks or matrix textures.
 * r185 submits _multiDrawStarts as BYTE offsets, and falls back to one ordinary
 * indexed draw per range when WEBGL_multi_draw is unavailable. Picking remains
 * on the original CPU meshes; stock override/shadow materials are unsupported. */
class TerrainSlabMesh extends THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> {
  readonly isBatchedMesh = true;
  readonly _colorsTexture = null;
  readonly colorTexture = null;
  readonly _matricesTexture = null;
  readonly _indirectTexture = null;
  readonly _multiDrawStarts = new Int32Array(TERRAIN_SLAB_PACKETS);
  readonly _multiDrawCounts = new Int32Array(TERRAIN_SLAB_PACKETS);
  _multiDrawCount = 0;
  override raycast() {}
}

function attributeType(array: THREE.TypedArray, gl: WebGL2RenderingContext): number | null {
  if (array instanceof Float32Array) {
    return gl.FLOAT;
  }
  if (array instanceof Uint8Array || array instanceof Uint8ClampedArray) {
    return gl.UNSIGNED_BYTE;
  }
  if (array instanceof Int8Array) {
    return gl.BYTE;
  }
  if (array instanceof Uint16Array) {
    return gl.UNSIGNED_SHORT;
  }
  if (array instanceof Int16Array) {
    return gl.SHORT;
  }
  if (array instanceof Uint32Array) {
    return gl.UNSIGNED_INT;
  }
  if (array instanceof Int32Array) {
    return gl.INT;
  }
  return null;
}

function layoutOf(surface: FixedSurface, gl: WebGL2RenderingContext): AttributeLayout[] | null {
  const geometry = surface.geometry;
  const material = surface.material;
  const vertices = geometry.getAttribute('position')?.count;
  if (
    !material.isShaderMaterial ||
    material.userData.fixedSurfacePacketOrder !== true ||
    material.transparent ||
    material.wireframe ||
    /#include\s*<batching_/.test(material.vertexShader) ||
    !vertices ||
    vertices > TERRAIN_SLAB_VERTICES ||
    !geometry.index ||
    geometry.index.count > SLAB_INDICES ||
    geometry.groups.length ||
    geometry.drawRange.start !== 0 ||
    geometry.drawRange.count !== Infinity
  ) {
    return null;
  }
  const layout: AttributeLayout[] = [];
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    if (!(attribute instanceof THREE.BufferAttribute) || attribute.count !== vertices) {
      return null;
    }
    const type = attributeType(attribute.array, gl);
    if (type === null) {
      return null;
    }
    layout.push({
      name,
      type,
      itemSize: attribute.itemSize,
      elementSize: attribute.array.BYTES_PER_ELEMENT as 1 | 2 | 4,
      normalized: attribute.normalized,
      gpuType: attribute.gpuType,
    });
  }
  return layout;
}

function sameLayout(a: readonly AttributeLayout[], b: readonly AttributeLayout[]) {
  return (
    a.length === b.length &&
    a.every((field, i) => {
      const other = b[i];
      return (
        field.name === other.name &&
        field.type === other.type &&
        field.itemSize === other.itemSize &&
        field.elementSize === other.elementSize &&
        field.normalized === other.normalized &&
        field.gpuType === other.gpuType
      );
    })
  );
}

export class TerrainGpuSlab {
  readonly mesh: TerrainSlabMesh;
  readonly entries: SlabEntry[] = [];
  readonly sources: FixedSurface[] = [];
  private readonly buffers: WebGLBuffer[] = [];
  private readonly attributes: THREE.GLBufferAttribute[] = [];
  private indexAttribute!: THREE.GLBufferAttribute;
  private vertexCount = 0;
  private indexCount = 0;
  private sealed = false;
  private disposed = false;
  gpuBytes = 0;
  replacedGpuBytes = 0;
  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly layout: readonly AttributeLayout[],
    material: THREE.ShaderMaterial,
    private readonly scratch: (count: number) => Uint16Array,
  ) {
    const geometry = new THREE.BufferGeometry();
    geometry.boundingBox = new THREE.Box3();
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);
    this.mesh = new TerrainSlabMesh(geometry, material);
    this.mesh.name = 'fixed-terrain-slab';
    this.mesh.frustumCulled = false; // Visibility is evaluated per original packet.
    try {
      for (const field of layout) {
        const buffer = this.allocate(TERRAIN_SLAB_VERTICES * field.itemSize * field.elementSize);
        const attribute = new THREE.GLBufferAttribute(
          buffer,
          field.type,
          field.itemSize,
          field.elementSize,
          TERRAIN_SLAB_VERTICES,
          field.normalized,
        );
        // BindingStates honors integer pointer semantics for unnormalized INT attrs.
        Object.assign(attribute, { gpuType: field.gpuType });
        this.attributes.push(attribute);
        geometry.setAttribute(field.name, attribute as unknown as THREE.BufferAttribute);
      }
      const buffer = this.allocate(SLAB_INDICES * Uint16Array.BYTES_PER_ELEMENT, true);
      this.indexAttribute = new THREE.GLBufferAttribute(
        buffer,
        gl.UNSIGNED_SHORT,
        1,
        2,
        SLAB_INDICES,
      );
      geometry.setIndex(this.indexAttribute as unknown as THREE.BufferAttribute);
    } catch (error) {
      this.dispose();
      throw error;
    } finally {
      gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);
    }
  }
  private allocate(bytes: number, index = false) {
    const buffer = this.gl.createBuffer();
    if (!buffer) {
      throw new Error('Unable to allocate terrain draw buffers.');
    }
    this.buffers.push(buffer);
    if (index) {
      // WebGL2 permanently classifies an index buffer on its FIRST binding.
      // COPY_WRITE-first would classify it as ordinary data and make the later
      // element binding INVALID_OPERATION. Isolate that initial EAB bind in an
      // owned VAO, then restore Three's exact VAO without touching its contents.
      const previous = this.gl.getParameter(
        this.gl.VERTEX_ARRAY_BINDING,
      ) as WebGLVertexArrayObject | null;
      const temporary = this.gl.createVertexArray();
      if (!temporary) {
        throw new Error('Unable to allocate terrain index binding.');
      }
      try {
        this.gl.bindVertexArray(temporary);
        this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, buffer);
      } finally {
        this.gl.bindVertexArray(previous);
        this.gl.deleteVertexArray(temporary);
      }
    }
    this.gl.bindBuffer(this.gl.COPY_WRITE_BUFFER, buffer);
    this.gl.bufferData(this.gl.COPY_WRITE_BUFFER, bytes, this.gl.STATIC_DRAW);
    this.gpuBytes += bytes;
    return buffer;
  }
  accepts(surface: FixedSurface, layout: readonly AttributeLayout[]) {
    return (
      !this.sealed &&
      this.entries.length < TERRAIN_SLAB_PACKETS &&
      this.mesh.material === surface.material &&
      sameLayout(this.layout, layout) &&
      this.vertexCount + surface.geometry.getAttribute('position').count <= TERRAIN_SLAB_VERTICES &&
      this.indexCount + surface.geometry.index!.count <= SLAB_INDICES
    );
  }
  private upload(entry: SlabEntry) {
    const gl = this.gl;
    for (let i = 0; i < this.layout.length; i++) {
      const field = this.layout[i];
      const attribute = entry.surface.geometry.getAttribute(field.name) as THREE.BufferAttribute;
      gl.bindBuffer(gl.COPY_WRITE_BUFFER, this.attributes[i].buffer);
      gl.bufferSubData(
        gl.COPY_WRITE_BUFFER,
        entry.vertexOffset * field.itemSize * field.elementSize,
        attribute.array as ArrayBufferView<ArrayBuffer>,
      );
    }
    const source = entry.surface.geometry.index!;
    const indices = this.scratch(source.count);
    for (let i = 0; i < source.count; i++) {
      indices[i] = source.getX(i) + entry.vertexOffset;
    }
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, this.indexAttribute.buffer);
    gl.bufferSubData(
      gl.COPY_WRITE_BUFFER,
      entry.indexOffset * 2,
      indices.subarray(0, source.count) as Uint16Array<ArrayBuffer>,
    );
  }
  add(surface: FixedSurface) {
    const entry = {
      surface,
      vertexOffset: this.vertexCount,
      indexOffset: this.indexCount,
      count: surface.geometry.index!.count,
    };
    try {
      this.upload(entry);
    } finally {
      this.gl.bindBuffer(this.gl.COPY_WRITE_BUFFER, null);
    }
    this.entries.push(entry);
    this.sources.push(surface);
    this.vertexCount += surface.geometry.getAttribute('position').count;
    this.indexCount += entry.count;
    this.replacedGpuBytes += [
      ...Object.values(surface.geometry.attributes),
      surface.geometry.index!,
    ].reduce((sum, attribute) => sum + attribute.array.byteLength, 0);
    if (surface.geometry.boundingBox) {
      this.mesh.geometry.boundingBox!.union(surface.geometry.boundingBox);
    }
    this.mesh.geometry.boundingBox!.getBoundingSphere(this.mesh.geometry.boundingSphere!);
    surface.userData.terrainBatched = true;
    surface.removeFromParent();
  }
  /** Compact a completed slab in-place. Native buffer and attribute identities
   * remain stable, so previously cached VAOs still point at the correct stores.
   * Re-upload reads original arrays directly; there is no merged CPU mesh. */
  seal() {
    if (this.sealed || this.disposed) {
      return;
    }
    this.sealed = true;
    const gl = this.gl;
    this.gpuBytes = 0;
    try {
      for (let i = 0; i < this.layout.length; i++) {
        const field = this.layout[i];
        const bytes = this.vertexCount * field.itemSize * field.elementSize;
        gl.bindBuffer(gl.COPY_WRITE_BUFFER, this.attributes[i].buffer);
        gl.bufferData(gl.COPY_WRITE_BUFFER, bytes, gl.STATIC_DRAW);
        this.attributes[i].count = this.vertexCount;
        this.gpuBytes += bytes;
      }
      gl.bindBuffer(gl.COPY_WRITE_BUFFER, this.indexAttribute.buffer);
      gl.bufferData(gl.COPY_WRITE_BUFFER, this.indexCount * 2, gl.STATIC_DRAW);
      this.indexAttribute.count = this.indexCount;
      this.gpuBytes += this.indexCount * 2;
      for (const entry of this.entries) {
        this.upload(entry);
      }
    } finally {
      gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);
    }
  }
  prepare(frustum?: THREE.Frustum) {
    let count = 0;
    for (const entry of this.entries) {
      if (
        !entry.surface.visible ||
        (frustum && entry.surface.frustumCulled && !frustum.intersectsObject(entry.surface))
      ) {
        continue;
      }
      this.mesh._multiDrawStarts[count] = entry.indexOffset * 2;
      this.mesh._multiDrawCounts[count] = entry.count;
      count++;
    }
    this.mesh._multiDrawCount = count;
    this.mesh.visible = count > 0;
    return count;
  }
  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.mesh.removeFromParent();
    // Geometry.dispose releases VAOs. Explicit native ownership also handles
    // stores that were allocated but never reached a renderer frame. Detaching
    // attributes first prevents Three from deleting these same buffers twice.
    for (const name of Object.keys(this.mesh.geometry.attributes)) {
      this.mesh.geometry.deleteAttribute(name);
    }
    this.mesh.geometry.setIndex(null);
    this.mesh.geometry.dispose();
    for (const buffer of this.buffers) {
      this.gl.deleteBuffer(buffer);
    }
    for (const surface of this.sources) {
      surface.userData.terrainBatched = false;
    }
    this.buffers.length = 0;
    this.attributes.length = 0;
    this.sources.length = 0;
    this.entries.length = 0;
    this.gpuBytes = 0;
    this.replacedGpuBytes = 0;
  }
}

/** Only original fixed terrain is batched. Zoom masks/patches remain ordinary
 * meshes, created later in the same group, preserving the existing opaque order.
 * Masks use private BufferAttribute wrappers over existing CPU arrays and own
 * their temporary GPU copies. Dispose this owner before the original CPU meshes.
 * On context replacement, construct a new owner and upload from those CPU arrays. */
export class TerrainBatchRenderer {
  readonly slabs: TerrainGpuSlab[] = [];
  readonly mode: 'multi-draw' | 'fallback' | 'ordinary';
  private readonly gl: WebGL2RenderingContext;
  private tail: TerrainGpuSlab | null = null;
  private readonly frustum = new THREE.Frustum();
  private readonly projectionView = new THREE.Matrix4();
  private seen = new WeakSet<FixedSurface>();
  private scratchIndices = new Uint16Array(0);
  private disposed = false;
  constructor(
    renderer: Pick<THREE.WebGLRenderer, 'getContext'>,
    private readonly parent: THREE.Group,
  ) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    // The internal adapter is intentionally pinned. A Three upgrade safely uses
    // ordinary meshes until this contract and its GPU parity tests are reviewed.
    this.mode =
      THREE.REVISION !== '185' || typeof this.gl.copyBufferSubData !== 'function'
        ? 'ordinary'
        : this.gl.getExtension('WEBGL_multi_draw')
          ? 'multi-draw'
          : 'fallback';
  }
  add(surface: FixedSurface): boolean {
    if (this.disposed || this.seen.has(surface)) {
      return surface.userData.terrainBatched === true;
    }
    this.seen.add(surface);
    const layout = this.mode === 'ordinary' ? null : layoutOf(surface, this.gl);
    if (!layout) {
      this.finish();
      surface.userData.terrainBatched = false;
      return false;
    }
    if (!this.tail?.accepts(surface, layout)) {
      this.finish();
      this.tail = new TerrainGpuSlab(this.gl, layout, surface.material, (count) => {
        if (this.scratchIndices.length < count) {
          this.scratchIndices = new Uint16Array(count);
        }
        return this.scratchIndices;
      });
      this.slabs.push(this.tail);
      this.parent.add(this.tail.mesh);
    }
    this.tail.add(surface);
    return true;
  }
  finish() {
    this.tail?.seal();
    this.tail = null;
  }
  /** Call after per-packet visibility and Zoom mask composition, before render. */
  prepare(camera: THREE.Camera) {
    this.projectionView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(
      this.projectionView,
      camera.coordinateSystem,
      camera.reversedDepth,
    );
    for (const slab of this.slabs) {
      slab.prepare(this.frustum);
    }
  }
  get stats() {
    let packets = 0;
    let visiblePackets = 0;
    let drawCalls = 0;
    let gpuBytes = 0;
    let replacedGpuBytes = 0;
    for (const slab of this.slabs) {
      packets += slab.entries.length;
      visiblePackets += slab.mesh._multiDrawCount;
      drawCalls +=
        this.mode === 'multi-draw'
          ? Number(slab.mesh._multiDrawCount > 0)
          : slab.mesh._multiDrawCount;
      gpuBytes += slab.gpuBytes;
      replacedGpuBytes += slab.replacedGpuBytes;
    }
    return {
      mode: this.mode,
      slabs: this.slabs.length,
      packets,
      visiblePackets,
      drawCalls,
      gpuBytes,
      replacedGpuBytes,
      cpuBytes: this.scratchIndices.byteLength + this.slabs.length * TERRAIN_SLAB_PACKETS * 8,
    };
  }
  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const slab of this.slabs) {
      slab.dispose();
    }
    this.slabs.length = 0;
    this.scratchIndices = new Uint16Array(0);
    this.seen = new WeakSet();
    this.tail = null;
  }
}
