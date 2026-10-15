import * as THREE from 'three';
import {
  FIXED_GRID_EDGES_PER_BATCH,
  FIXED_GRID_TEXTURE_WIDTH,
  type FixedGridPacket,
} from '../core/view/fixed-grid-types';
import { anchorLineMaterial } from './PagedOverlays';
import { mapReliefScale, type MapStyle } from './MapStyle';
import { MAP_HEIGHT_SHEAR, mapPoint, type Projection } from './projection';

export interface FixedGridAppearance {
  projection: Projection;
  relief: number;
  mapStyle: MapStyle;
}

export interface FixedGridVisibility {
  visibleBatches: number;
  culledBatches: number;
  drawCalls: number;
}

const GRID_LIFT = 0.000018;
const MAP_DEPTH = 0.00003;
const ANGULAR_MARGIN = 2e-6;

interface GridBatch {
  line: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  vertices: THREE.DataTexture;
  coverage: THREE.DataTexture;
  edges: THREE.DataTexture;
  capAxis: THREE.Vector3;
  capRadius: number;
  maximumRadius: number;
}

/** Project the shared endpoints once. Only seam crossings and exact polar
 * endpoints need new vertices; ordinary edges keep the immutable source index.
 */
function mapGeometry(packet: FixedGridPacket, radius: number, appearance: FixedGridAppearance) {
  const count = packet.vertexCount;
  const scale = (appearance.relief / radius) * mapReliefScale(appearance.mapStyle);
  const extra: number[] = [];
  const extraCoverage: number[] = [];
  const replacements = new Map<number, number[]>();
  const point = (vertex: number, longitude?: number): [number, number, number] => {
    const start = vertex * 4;
    const [lon, lat] = mapPoint(
      ...(packet.vertices.subarray(start, start + 3) as unknown as [number, number, number]),
    );
    const height = Math.max(0, packet.vertices[vertex * 4 + 3]) * scale;
    return [longitude ?? lon, lat + height * MAP_HEIGHT_SHEAR, MAP_DEPTH + height];
  };
  const append = (x: number, y: number, z: number, coverage: number) => {
    const vertex = count + extra.length / 3;
    extra.push(x, y, z);
    extraCoverage.push(coverage);
    return vertex;
  };
  const isPole = (vertex: number) =>
    Math.hypot(packet.vertices[vertex * 4], packet.vertices[vertex * 4 + 2]) <=
    Math.abs(packet.vertices[vertex * 4 + 1]) * 1e-12;
  for (let edge = 0; edge < packet.edgeCount * 2; edge += 2) {
    const a = packet.indices[edge];
    const b = packet.indices[edge + 1];
    const [ax, ay, az] = point(a);
    const [bx, by, bz] = point(b);
    const poleA = isPole(a);
    const poleB = isPole(b);
    if (poleA !== poleB) {
      // Longitude at an exact pole is undefined. Give this endpoint the
      // incident edge's meridian, rather than bending every edge toward x=0.
      replacements.set(
        edge,
        poleA
          ? [append(bx, ay, az, packet.landCoverage[a]), b]
          : [a, append(ax, by, bz, packet.landCoverage[b])],
      );
      continue;
    }
    const difference = bx - ax;
    if (!poleA && !poleB && Math.abs(Math.abs(difference) - Math.PI) < 1e-7) {
      const rawA = Math.atan2(
        packet.vertices[a * 4 + 1],
        Math.hypot(packet.vertices[a * 4], packet.vertices[a * 4 + 2]),
      );
      const rawB = Math.atan2(
        packet.vertices[b * 4 + 1],
        Math.hypot(packet.vertices[b * 4], packet.vertices[b * 4 + 2]),
      );
      if (Math.abs(rawA + rawB) > 1e-8) {
        // A meridian crossing the pole has two map pieces with separate pole
        // longitudes, not a horizontal line spanning half of the map.
        const pole = (Math.sign(rawA + rawB) * Math.PI) / 2;
        const fraction = Math.abs(pole - rawA) / (Math.abs(pole - rawA) + Math.abs(pole - rawB));
        const height = (az - MAP_DEPTH) * (1 - fraction) + (bz - MAP_DEPTH) * fraction;
        const y = pole + height * MAP_HEIGHT_SHEAR;
        const z = MAP_DEPTH + height;
        const coverage =
          packet.landCoverage[a] * (1 - fraction) + packet.landCoverage[b] * fraction;
        replacements.set(edge, [a, append(ax, y, z, coverage), append(bx, y, z, coverage), b]);
        continue;
      }
    }
    if (Math.abs(difference) > Math.PI) {
      const end = bx + (ax > 0 ? Math.PI * 2 : -Math.PI * 2);
      const seam = ax > 0 ? Math.PI : -Math.PI;
      if (Math.abs(end - ax) < 1e-12) {
        // Signed zero can place an entire physical edge on both +pi and -pi.
        // Keep its height/latitude variation on both map borders; 0/0 seam
        // interpolation here would otherwise poison the batch bounds.
        replacements.set(edge, [
          a,
          append(ax, by, bz, packet.landCoverage[b]),
          append(bx, ay, az, packet.landCoverage[a]),
          b,
        ]);
        continue;
      }
      const fraction = (seam - ax) / (end - ax);
      const y = ay + (by - ay) * fraction;
      const z = az + (bz - az) * fraction;
      const coverage = packet.landCoverage[a] * (1 - fraction) + packet.landCoverage[b] * fraction;
      replacements.set(edge, [a, append(seam, y, z, coverage), append(-seam, y, z, coverage), b]);
    }
  }
  const vertexCount = count + extraCoverage.length;
  const width = Math.min(FIXED_GRID_TEXTURE_WIDTH, vertexCount);
  const paddedCount = Math.ceil(vertexCount / width) * width;
  const vertices = new Float32Array(paddedCount * 4);
  for (let vertex = 0; vertex < count; vertex++) {
    vertices.set(point(vertex), vertex * 4);
  }
  for (let vertex = count; vertex < vertexCount; vertex++) {
    vertices.set(extra.slice((vertex - count) * 3, (vertex - count) * 3 + 3), vertex * 4);
  }
  let indices: Uint16Array | Uint32Array = packet.indices;
  let edgeCount = packet.edgeCount;
  if (replacements.size) {
    let length = packet.edgeCount * 2;
    for (const replacement of replacements.values()) {
      length += replacement.length - 2;
    }
    edgeCount = length / 2;
    const edgeWidth = Math.min(FIXED_GRID_TEXTURE_WIDTH, edgeCount);
    const paddedLength = Math.ceil(edgeCount / edgeWidth) * edgeWidth * 2;
    indices = vertexCount <= 65535 ? new Uint16Array(paddedLength) : new Uint32Array(paddedLength);
    let offset = 0;
    for (let edge = 0; edge < packet.edgeCount * 2; edge += 2) {
      const replacement = replacements.get(edge);
      if (replacement) {
        indices.set(replacement, offset);
        offset += replacement.length;
      } else {
        indices[offset++] = packet.indices[edge];
        indices[offset++] = packet.indices[edge + 1];
      }
    }
  }
  let coverage = packet.landCoverage;
  if (extraCoverage.length) {
    coverage = new Uint8Array(paddedCount);
    coverage.set(packet.landCoverage.subarray(0, count));
    coverage.set(extraCoverage.map(Math.round), count);
  }
  const box = new THREE.Box3();
  const location = new THREE.Vector3();
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    box.expandByPoint(location.fromArray(vertices, vertex * 4));
  }
  return {
    vertices,
    coverage,
    indices,
    edgeCount,
    vertexCount,
    box,
    axis: new THREE.Vector3(),
    capRadius: Math.PI,
    maximumRadius: 1,
  };
}

function globeGeometry(packet: FixedGridPacket, radius: number, relief: number) {
  // The shader raises source positions. Bounds must include that relief.
  const box = new THREE.Box3();
  const point = new THREE.Vector3();
  const axis = new THREE.Vector3();
  let maximumRadius = 1;
  for (let vertex = 0; vertex < packet.vertexCount; vertex++) {
    point.fromArray(packet.vertices, vertex * 4);
    axis.addScaledVector(point, 1 / point.length());
    point.multiplyScalar(
      1 + (Math.max(0, packet.vertices[vertex * 4 + 3]) / radius) * relief + GRID_LIFT,
    );
    maximumRadius = Math.max(maximumRadius, point.length());
    box.expandByPoint(point);
  }
  box.expandByScalar(1e-6 * maximumRadius);
  let capRadius = Math.PI;
  if (axis.lengthSq() > 1e-16) {
    axis.normalize();
    let minimumDot = 1;
    for (let vertex = 0; vertex < packet.vertexCount; vertex++) {
      point.fromArray(packet.vertices, vertex * 4).normalize();
      minimumDot = Math.min(minimumDot, point.dot(axis));
    }
    capRadius = Math.min(Math.PI, Math.acos(Math.max(-1, minimumDot)) + ANGULAR_MARGIN);
  }
  return {
    vertices: packet.vertices,
    coverage: packet.landCoverage,
    indices: packet.indices,
    edgeCount: packet.edgeCount,
    vertexCount: packet.vertexCount,
    box,
    axis,
    capRadius,
    maximumRadius: maximumRadius + 1e-6,
  };
}

function vertexTexture(data: Float32Array | Uint8Array, count: number) {
  const width = Math.min(FIXED_GRID_TEXTURE_WIDTH, count);
  const texture = new THREE.DataTexture(
    data,
    width,
    Math.ceil(count / width),
    data instanceof Float32Array ? THREE.RGBAFormat : THREE.RedFormat,
    data instanceof Float32Array ? THREE.FloatType : THREE.UnsignedByteType,
  );
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

/** One camera-independent display of the authoritative physical grid. The
 * caller retains one compact packet asset for future projection/style rebuilds.
 * Globe vertex textures directly share that asset; map geometry adds only
 * projected corners and seam/pole replacements. A shared sequential index
 * buffer drives ordinary triangle draws; vertex shaders fetch edge endpoints.
 * This avoids both duplicated positions and tiny-instance overhead on software
 * renderers while retaining reliable screen-pixel widths.
 *
 * Like anchorLineMaterial, the planet is centred at the world origin and this
 * group must keep its identity transform. Camera motion only changes visibility.
 */
export class FixedGrid extends THREE.Group {
  readonly material: THREE.ShaderMaterial;
  private readonly records = new Map<number, GridBatch>();
  private disposed = false;
  private sourceByteCount = 0;
  private additionalByteCount = 0;
  private gpuByteCount = 0;
  private edgeCount = 0;
  private segmentCount = 0;
  private readonly frustum = new THREE.Frustum();
  private readonly clip = new THREE.Matrix4();
  private readonly cameraPosition = new THREE.Vector3();
  private readonly cameraAxis = new THREE.Vector3();
  private readonly viewport = new THREE.Vector4();
  private readonly strokeVertices = new THREE.BufferAttribute(new Float32Array(3), 3);
  // At most one extra segment per map seam/pole crossing. Reuse four vertices
  // across each quad's two triangles; this keeps indices Uint16 and lets the
  // GPU vertex cache avoid repeating the shared-corner texture fetches.
  private readonly strokeIndices = new THREE.BufferAttribute(
    Uint16Array.from(
      { length: FIXED_GRID_EDGES_PER_BATCH * 12 },
      (_, index) => Math.floor(index / 6) * 4 + [0, 1, 2, 2, 1, 3][index % 6],
    ),
    1,
  );

  private wideStrokeIndices: THREE.BufferAttribute | null = null;
  private narrowIndicesUploaded = false;
  private wideIndicesUploaded = false;

  constructor(
    private readonly radius: number,
    private readonly appearance: FixedGridAppearance,
  ) {
    super();
    if (
      !(radius > 0 && Number.isFinite(radius)) ||
      !(appearance.relief >= 0 && Number.isFinite(appearance.relief))
    ) {
      throw new RangeError('Physical grid needs a finite positive radius and nonnegative relief.');
    }
    this.name = 'fixed-grid';
    this.material = anchorLineMaterial('#a0c6ca', appearance.projection === 'map', 0.13, true);
    Object.assign(this.material.uniforms, {
      physicalRadius: { value: radius },
      physicalRelief: { value: appearance.relief },
      viewportSize: { value: new THREE.Vector2(1, 1) },
      landInk: { value: new THREE.Color('#24382d') },
      landOpacity: { value: 0.55 },
      vertexData: { value: null },
      landData: { value: null },
      edgeData: { value: null },
      edgeTextureWidth: { value: 1 },
      vertexTextureWidth: { value: 1 },
      landWidth: { value: 2.2 },
      waterWidth: { value: 1.0 },
    });
    this.material.vertexShader = `
      uniform sampler2D vertexData; uniform sampler2D landData;
      uniform highp usampler2D edgeData; uniform float edgeTextureWidth;
      uniform float vertexTextureWidth; uniform float physicalRadius; uniform float physicalRelief;
      uniform vec2 viewportSize; uniform float landWidth; uniform float waterWidth;
      varying vec3 point; varying float ground; varying float across; varying float halfWidth;
      ivec2 corner(float id) { return ivec2(mod(id, vertexTextureWidth), floor(id / vertexTextureWidth)); }
      vec3 displayPoint(vec4 data) {
        return ${
          appearance.projection === 'globe'
            ? `data.xyz * (1.0 + max(0.0, data.w) / physicalRadius * physicalRelief + ${GRID_LIFT})`
            : 'data.xyz'
        };
      }
      void main() {
        float edgeId = floor(float(gl_VertexID) / 4.0);
        int slot = gl_VertexID % 4;
        float along = float(slot % 2);
        float side = slot < 2 ? -1.0 : 1.0;
        uvec2 edge = texelFetch(edgeData, ivec2(mod(edgeId, edgeTextureWidth), floor(edgeId / edgeTextureWidth)), 0).rg;
        float edgeStart = float(edge.r); float edgeEnd = float(edge.g);
        vec3 start = displayPoint(texelFetch(vertexData, corner(edgeStart), 0));
        vec3 end = displayPoint(texelFetch(vertexData, corner(edgeEnd), 0));
        float dryStart = texelFetch(landData, corner(edgeStart), 0).r;
        float dryEnd = texelFetch(landData, corner(edgeEnd), 0).r;
        vec4 viewStart = modelViewMatrix * vec4(start, 1.0);
        vec4 viewEnd = modelViewMatrix * vec4(end, 1.0);
        if (projectionMatrix[2][3] == -1.0) {
          // Clip before dividing by w: a close globe edge can cross the camera.
          float nearZ = -projectionMatrix[3][2] / (projectionMatrix[2][2] - 1.0);
          if (viewStart.z > nearZ && viewEnd.z > nearZ) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return;
          }
          if (viewStart.z > nearZ) {
            float f = (nearZ - viewStart.z) / (viewEnd.z - viewStart.z);
            viewStart = mix(viewStart, viewEnd, f); start = mix(start, end, f); dryStart = mix(dryStart, dryEnd, f);
          } else if (viewEnd.z > nearZ) {
            float f = (nearZ - viewEnd.z) / (viewStart.z - viewEnd.z);
            viewEnd = mix(viewEnd, viewStart, f); end = mix(end, start, f); dryEnd = mix(dryEnd, dryStart, f);
          }
        }
        vec4 clipStart = projectionMatrix * viewStart;
        vec4 clipEnd = projectionMatrix * viewEnd;
        vec2 delta = (clipEnd.xy / clipEnd.w - clipStart.xy / clipStart.w) * viewportSize;
        vec2 normal = vec2(-delta.y, delta.x) / max(length(delta), 0.000001);
        point = mix(start, end, along);
        ground = mix(dryStart, dryEnd, along);
        halfWidth = (mix(waterWidth, landWidth, ground) + 1.0) * 0.5;
        across = side * halfWidth;
        gl_Position = mix(clipStart, clipEnd, along);
        gl_Position.xy += normal * across * 2.0 / viewportSize * gl_Position.w;
      }`;
    this.material.fragmentShader = this.material.fragmentShader
      .replace(
        'varying vec3 point;',
        `varying vec3 point; varying float ground; varying float across; varying float halfWidth;
         uniform vec3 landInk; uniform float landOpacity;`,
      )
      .replace(
        'gl_FragColor = vec4(ink, opacity);',
        `float coverage = 1.0 - smoothstep(halfWidth - 1.0, halfWidth, abs(across));
         gl_FragColor = vec4(mix(ink, landInk, ground), mix(opacity, landOpacity, ground) * coverage);`,
      );
    this.material.side = THREE.DoubleSide;
    if (appearance.projection === 'map') {
      // The displayed latitude includes the relief shear. Clip geographic
      // latitude, otherwise raised terrain near the north pole loses its grid.
      this.material.fragmentShader = this.material.fragmentShader.replace(
        'abs(point.y) > 1.570797',
        `abs(point.y - (point.z - ${MAP_DEPTH}) * ${MAP_HEIGHT_SHEAR}) > 1.570797`,
      );
    }
  }

  get batches() {
    return this.records.size;
  }
  get segments() {
    return this.edgeCount;
  }
  get renderSegments() {
    return this.segmentCount;
  }
  /** Canonical asset bytes, counted even though the external asset owns them. */
  get sourceBytes() {
    return this.sourceByteCount;
  }
  /** CPU arrays beyond canonical packets; one shared sequential index buffer. */
  get additionalCpuBytes() {
    return this.additionalByteCount;
  }
  get gpuBytes() {
    return this.gpuByteCount;
  }
  get retainedBytes() {
    return this.sourceBytes + this.additionalCpuBytes + this.gpuBytes;
  }

  addBatch(packet: FixedGridPacket): boolean {
    if (this.disposed || this.records.has(packet.batch)) {
      return false;
    }
    if (!packet.edgeCount) {
      return false;
    }
    const width = Math.min(FIXED_GRID_TEXTURE_WIDTH, packet.vertexCount);
    const paddedCount = Math.ceil(packet.vertexCount / width) * width;
    const edgeWidth = Math.min(FIXED_GRID_TEXTURE_WIDTH, packet.edgeCount);
    const paddedEdges = Math.ceil(packet.edgeCount / edgeWidth) * edgeWidth;
    if (
      packet.vertices.length !== paddedCount * 4 ||
      packet.landCoverage.length !== paddedCount ||
      packet.indices.length !== paddedEdges * 2
    ) {
      throw new RangeError('Physical grid packet contains incomplete endpoints or edge pairs.');
    }
    const display =
      this.appearance.projection === 'globe'
        ? globeGeometry(packet, this.radius, this.appearance.relief)
        : mapGeometry(packet, this.radius, this.appearance);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', this.strokeVertices);
    geometry.setDrawRange(0, display.edgeCount * 6);
    if (geometry.drawRange.count > this.strokeIndices.count) {
      throw new RangeError('Physical grid packet exceeds the bounded edge capacity.');
    }
    // WebGL2 reserves 0xffff for fixed primitive restart. The maximum map
    // packet can split all 8,192 edges, requiring vertex 65,535 for its final
    // quad. Only that exceptional capacity needs the wider shared index type.
    const needsWideIndices = display.edgeCount * 4 - 1 >= 0xffff;
    let allocatedWideIndices = false;
    if (needsWideIndices && !this.wideStrokeIndices) {
      this.wideStrokeIndices = new THREE.BufferAttribute(
        Uint32Array.from(this.strokeIndices.array),
        1,
      );
      allocatedWideIndices = true;
    }
    geometry.setIndex(needsWideIndices ? this.wideStrokeIndices! : this.strokeIndices);
    geometry.boundingBox = display.box;
    geometry.boundingSphere = display.box.getBoundingSphere(new THREE.Sphere());
    const vertices = vertexTexture(display.vertices, display.vertexCount);
    const coverage = vertexTexture(display.coverage, display.vertexCount);
    const edgeTextureWidth = Math.min(FIXED_GRID_TEXTURE_WIDTH, display.edgeCount);
    const edges = new THREE.DataTexture(
      display.indices,
      edgeTextureWidth,
      Math.ceil(display.edgeCount / edgeTextureWidth),
      THREE.RGIntegerFormat,
      display.indices instanceof Uint16Array ? THREE.UnsignedShortType : THREE.UnsignedIntType,
    );
    edges.internalFormat = display.indices instanceof Uint16Array ? 'RG16UI' : 'RG32UI';
    edges.minFilter = edges.magFilter = THREE.NearestFilter;
    edges.generateMipmaps = false;
    edges.unpackAlignment = 1;
    edges.needsUpdate = true;
    // Retain inspectable shared assets on the geometry; no copies are made.
    geometry.userData.cornerTexture = vertices;
    geometry.userData.landTexture = coverage;
    geometry.userData.vertexCount = display.vertexCount;
    geometry.userData.edgeTexture = edges;
    geometry.userData.edgeCount = display.edgeCount;
    const line = new THREE.Mesh(geometry, this.material);
    line.onBeforeRender = (renderer) => {
      renderer.getCurrentViewport(this.viewport);
      this.material.uniforms.viewportSize.value.set(this.viewport.z, this.viewport.w);
      this.material.uniforms.vertexData.value = vertices;
      this.material.uniforms.landData.value = coverage;
      this.material.uniforms.edgeData.value = edges;
      this.material.uniforms.edgeTextureWidth.value = edgeTextureWidth;
      this.material.uniforms.vertexTextureWidth.value = vertices.image.width;
      this.material.uniformsNeedUpdate = true;
    };
    line.name = `fixed-grid-${packet.batch}`;
    line.renderOrder = 2;
    line.frustumCulled = true;
    this.records.set(packet.batch, {
      line,
      vertices,
      coverage,
      edges,
      capAxis: display.axis,
      capRadius: display.capRadius,
      maximumRadius: display.maximumRadius,
    });
    const sourceArrays = new Set<ArrayBufferView>([
      packet.vertices,
      packet.landCoverage,
      packet.indices,
    ]);
    for (const source of sourceArrays) {
      this.sourceByteCount += source.byteLength;
    }
    const renderArrays = new Set<ArrayBufferView>([
      display.vertices,
      display.coverage,
      display.indices,
    ]);
    if (this.records.size === 1) {
      renderArrays.add(this.strokeVertices.array);
      this.additionalByteCount += this.strokeIndices.array.byteLength;
    }
    if (allocatedWideIndices) {
      this.additionalByteCount += this.wideStrokeIndices!.array.byteLength;
    }
    if (needsWideIndices ? !this.wideIndicesUploaded : !this.narrowIndicesUploaded) {
      this.gpuByteCount += geometry.index!.array.byteLength;
      if (needsWideIndices) {
        this.wideIndicesUploaded = true;
      } else {
        this.narrowIndicesUploaded = true;
      }
    }
    for (const array of renderArrays) {
      this.gpuByteCount += array.byteLength;
      if (!sourceArrays.has(array)) {
        this.additionalByteCount += array.byteLength;
      }
    }
    this.edgeCount += packet.edgeCount;
    this.segmentCount += display.edgeCount;
    this.add(line);
    return true;
  }

  updateVisibility(camera: THREE.Camera): FixedGridVisibility {
    if (this.disposed || !this.visible) {
      return { visibleBatches: 0, culledBatches: this.batches, drawCalls: 0 };
    }
    camera.updateWorldMatrix(true, false);
    this.clip.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.clip);
    this.cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    const distance = this.cameraPosition.length();
    this.cameraAxis.copy(this.cameraPosition).normalize();
    const cameraHorizon = distance > 1 ? Math.acos(1 / distance) : Math.PI;
    let visible = 0;
    for (const record of this.records.values()) {
      let show = this.frustum.intersectsSphere(record.line.geometry.boundingSphere!);
      if (
        show &&
        this.appearance.projection === 'globe' &&
        distance > 1 &&
        record.capRadius < Math.PI / 2
      ) {
        // A positive-radius angular cap is geodesically convex below 90°:
        // every normalized line chord lies inside it. Larger caps stay visible
        // for the fragment shader to clip. Raised endpoints can remain visible
        // past the ordinary surface horizon, so use BOTH tangent angles.
        const limit =
          cameraHorizon + Math.acos(1 / record.maximumRadius) + record.capRadius + ANGULAR_MARGIN;
        if (limit < Math.PI && record.capAxis.dot(this.cameraAxis) < Math.cos(limit)) {
          show = false;
        }
      }
      record.line.visible = show;
      if (show) {
        visible++;
      }
    }
    return { visibleBatches: visible, culledBatches: this.batches - visible, drawCalls: visible };
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.removeFromParent();
    for (const { line, vertices, coverage, edges } of this.records.values()) {
      line.geometry.dispose();
      vertices.dispose();
      coverage.dispose();
      edges.dispose();
    }
    this.clear();
    this.records.clear();
    this.material.dispose();
    this.wideStrokeIndices = null;
    this.wideIndicesUploaded = this.narrowIndicesUploaded = false;
    this.sourceByteCount = this.additionalByteCount = this.gpuByteCount = 0;
    this.edgeCount = this.segmentCount = 0;
  }
}
