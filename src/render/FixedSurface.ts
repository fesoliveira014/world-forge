import * as THREE from 'three';
import {
  PHYSICAL_MATERIAL_FIELD_COUNT,
  type PhysicalMeshManifest,
  type PhysicalMeshPacket,
} from '../core/view/physical-mesh-types';
import type { WorldHandle } from '../core/view/types';
import type { Layer } from '../core/model';
import { createNaturalMaterial } from './NaturalSurface';
import { createArtMaterial, mapReliefScale, type MapStyle } from './MapStyle';
import { isFantasyMapStyle } from './FantasyStyle';
import { createHeightmapMaterial } from './HeightmapMaterial';
import {
  clipMapMaterial,
  MAP_HEIGHT_SHEAR,
  mapPoint,
  projectMesh,
  type Projection,
} from './projection';

export interface FixedSurfaceAppearance {
  projection: Projection;
  mapStyle: MapStyle;
  relief: number;
  coastlines: boolean;
}

/** Display policy only; the user's style/relief preferences and saved heights
 * remain available when returning from a diagnostic or illustrated view. */
export function worldSurfaceAppearance(layer: Layer, mapStyle: MapStyle, relief: number) {
  return {
    mapStyle: layer === 'world' ? mapStyle : ('natural' as const),
    relief:
      layer === 'tectonics' ||
      (layer === 'world' && (isFantasyMapStyle(mapStyle) || mapStyle === 'heightmap'))
        ? 0
        : relief,
  };
}

/** The packet is physical topology, never a camera sample. GPU geometry can be
 * rebuilt for a projection or relief change without another reader request. */
export function fixedSurfaceGeometry(
  packet: PhysicalMeshPacket,
  radius: number,
  appearance: FixedSurfaceAppearance,
) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(packet.directions.length);
  for (let i = 0; i < packet.heights.length; i++) {
    const scale = 1 + (Math.max(0, packet.heights[i]) / radius) * appearance.relief;
    for (let axis = 0; axis < 3; axis++) {
      positions[i * 3 + axis] = packet.directions[i * 3 + axis] * scale;
    }
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('spherePosition', new THREE.BufferAttribute(packet.directions, 3));
  geometry.setAttribute('physicalHeight', new THREE.BufferAttribute(packet.heights, 1));
  if (packet.normals.length) {
    geometry.setAttribute('packedNormal', new THREE.BufferAttribute(packet.normals, 2, true));
  }
  if (packet.colors.length) {
    geometry.setAttribute('color', new THREE.BufferAttribute(packet.colors, 4, true));
  }
  for (
    let index = 0;
    index < Math.min(PHYSICAL_MATERIAL_FIELD_COUNT, packet.materials.length);
    index++
  ) {
    geometry.setAttribute(
      `material${index}`,
      new THREE.BufferAttribute(packet.materials[index], 4, true),
    );
  }
  geometry.setIndex(new THREE.BufferAttribute(packet.indices, 1));
  geometry.userData.mapOctNormalAttributes = ['packedNormal'];
  geometry.userData.mapPackedPairs = { material0: [0], material1: [1], material3: [0] };
  if (packet.mode === 'dual') {
    geometry.userData.mapFlatAttributes = ['color'];
  }
  if (appearance.projection === 'map') {
    projectMesh(geometry, 0, mapReliefScale(appearance.mapStyle), { computeNormals: false });
    // No chunk-local normal calculation: smooth normals come from the complete
    // physical one-ring in the reader, including vertices on batch boundaries.
    geometry.deleteAttribute('normal');
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

const packedDeclarations = /* glsl */ `
  attribute vec4 material0; attribute vec4 material1; attribute vec4 material2;
  attribute vec4 material3; attribute vec4 material4;
  attribute vec2 packedNormal; attribute float physicalHeight;
  uniform vec2 elevationRange; uniform float physicalRadius; uniform float fixedRelief;
  float scalar16(vec2 pair) { return dot(pair, vec2(65280.0, 255.0)) / 65535.0; }
  vec3 decodedNormal() {
    vec3 n = vec3(packedNormal, 1.0 - abs(packedNormal.x) - abs(packedNormal.y));
    if (n.z < 0.0) n.xy = (1.0 - abs(n.yx)) * mix(vec2(-1.0), vec2(1.0), step(vec2(0.0), n.xy));
    return normalize(n);
  }
`;
const decodedFields = /* glsl */ `
  vec4 surfaceTerrain = vec4(mix(elevationRange.x, elevationRange.y, scalar16(material0.rg)), material0.ba, material1.r);
  vec4 surfaceClimate = vec4(mix(-128.0, 128.0, scalar16(material1.gb)), material1.a, material2.rg);
  vec3 surfaceHabitat = vec3(material2.b * 4.0, material2.a, scalar16(material3.rg) * 65535.0);
  vec4 surfaceDelta = vec4(material3.ba, material4.rg);
  vec2 surfaceWater = material4.ba;
`;

export function createFixedSurfaceMaterial(
  handle: WorldHandle,
  manifest: PhysicalMeshManifest,
  appearance: FixedSurfaceAppearance,
  banks: THREE.Texture,
) {
  const flat = appearance.projection === 'map';
  if (manifest.layer !== 'world') {
    const categorical = manifest.mode === 'dual';
    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: `${categorical ? 'flat' : ''} out vec4 cellColor; in vec4 color;
        out vec3 displayPosition;
        void main() { cellColor = color; displayPosition = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader:
        `${categorical ? 'flat' : ''} in vec4 cellColor; in vec3 displayPosition; out vec4 outColor;
        void main() { ${flat ? 'if (abs(displayPosition.x) > 3.141592654) discard;' : ''}
          outColor = vec4(cellColor.rgb, 1.0);
          #include <colorspace_fragment>
        }`.replace('#include <colorspace_fragment>', 'outColor = linearToOutputTexel(outColor);'),
      side: flat ? THREE.DoubleSide : THREE.FrontSide,
    });
    material.userData.fixedSurfacePacketOrder = true;
    return material;
  }
  if (appearance.mapStyle === 'heightmap') {
    return createHeightmapMaterial(
      manifest.elevationRange,
      [handle.summary.minimumHeight, handle.summary.maximumHeight],
      flat,
    );
  }
  const natural = appearance.mapStyle === 'natural';
  const material = natural
    ? createNaturalMaterial(handle.config.seed, flat, banks)
    : createArtMaterial(
        handle.config.seed,
        appearance.mapStyle as Exclude<MapStyle, 'natural'>,
        flat,
        banks,
      );
  material.uniforms.elevationRange = { value: new THREE.Vector2(...manifest.elevationRange) };
  material.uniforms.physicalRadius = { value: handle.config.radius };
  material.uniforms.fixedRelief = { value: appearance.relief };
  material.uniforms.fixedCoastlines = { value: Number(appearance.coastlines) };
  material.vertexShader = material.vertexShader.replace(/attribute vec[234] surface\w+;/g, '');
  if (!flat) {
    material.vertexShader = 'attribute vec3 spherePosition;\n' + material.vertexShader;
  }
  const normal = /* glsl */ `
    vec3 fixedPhysicalNormal() {
      vec3 d = normalize(spherePosition);
      ${flat ? 'vec3 up = vec3(0.0, 0.0, 1.0);' : 'vec3 up = d;'}
      if (physicalHeight <= 0.0) return up;
      vec3 n = decodedNormal();
      vec3 tangent = d - n / max(0.05, dot(n, d));
      float baseRadius = 1.0 + physicalHeight / physicalRadius;
      ${
        flat
          ? `
        float horizontal = max(0.00001, length(d.xz));
        vec3 east = vec3(-d.z, 0.0, d.x) / horizontal;
        vec3 north = cross(east, d);
        float sx = dot(tangent, east) * baseRadius * horizontal * fixedRelief * ${mapReliefScale(appearance.mapStyle).toFixed(1)};
        float sy = dot(tangent, north) * baseRadius * fixedRelief * ${mapReliefScale(appearance.mapStyle).toFixed(1)};
        return normalize(vec3(-sx, -sy, 1.0 + ${MAP_HEIGHT_SHEAR} * sy));`
          : 'return normalize(d - tangent * fixedRelief * baseRadius / (1.0 + physicalHeight / physicalRadius * fixedRelief));'
      }
    }
  `;
  material.vertexShader = packedDeclarations + material.vertexShader;
  material.vertexShader = material.vertexShader.replace('void main()', normal + '\nvoid main()');
  material.vertexShader = material.vertexShader.replace(
    'void main() {',
    'void main() {\n' + decodedFields,
  );
  if (natural) {
    material.vertexShader = material.vertexShader.replace(
      /vSurfaceNormal = [^;]+;/,
      'vSurfaceNormal = normalize(normalMatrix * fixedPhysicalNormal());',
    );
  } else {
    material.vertexShader = 'varying vec3 fixedViewNormal;\n' + material.vertexShader;
    material.vertexShader = material.vertexShader.replace(
      'void main() {',
      'void main() { fixedViewNormal = normalize(normalMatrix * fixedPhysicalNormal());',
    );
    material.fragmentShader = 'varying vec3 fixedViewNormal;\n' + material.fragmentShader;
    material.fragmentShader = material.fragmentShader.replace(
      /vec3 faceNormal = [^;]+;/,
      'vec3 faceNormal = normalize(fixedViewNormal);',
    );
  }
  material.fragmentShader =
    'uniform float fixedCoastlines; uniform vec3 surfaceCoastColor;\n' + material.fragmentShader;
  const field = natural ? 'vWater.x' : 'waterCoverage.x';
  const color = natural ? 'shaded' : 'albedo';
  material.fragmentShader = material.fragmentShader.replace(
    'gl_FragColor =',
    `float fixedCoastDistance = abs(${field} - .5) / max(fwidth(${field}), .0001);
    float fixedCoastCoverage = (1.0 - smoothstep(.45, 1.25, fixedCoastDistance)) * fixedCoastlines;
    ${color} = mix(${color}, surfaceCoastColor, fixedCoastCoverage * .82);
    gl_FragColor =`,
  );
  if (flat) {
    clipMapMaterial(material);
  }
  material.side = flat ? THREE.DoubleSide : THREE.FrontSide;
  material.userData.fixedSurfacePacketOrder = true;
  return material;
}

export function setFixedSurfaceCoastlines(material: THREE.ShaderMaterial, enabled: boolean) {
  if (material.uniforms.fixedCoastlines) {
    material.uniforms.fixedCoastlines.value = Number(enabled);
  }
}

export function setFixedSurfaceBanks(material: THREE.ShaderMaterial, texture: THREE.Texture) {
  if (material.uniforms.riverbankMap) {
    material.uniforms.riverbankMap.value = texture;
  }
}

export class FixedSurface extends THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> {
  readonly retainedBytes: number;
  readonly triangles: number;
  /** Largest straight edge of the displayed base mesh, including relief and map
   * projection. A camera-dependent selector can reject tiny batches in O(1). */
  readonly maximumEdgeLength: number;
  private readonly ownsMaterial: boolean;
  private disposed = false;
  constructor(
    packet: PhysicalMeshPacket,
    handle: WorldHandle,
    manifest: PhysicalMeshManifest,
    appearance: FixedSurfaceAppearance,
    banks: THREE.Texture,
    sharedMaterial?: THREE.ShaderMaterial,
  ) {
    const geometry = fixedSurfaceGeometry(packet, handle.config.radius, appearance);
    const material =
      sharedMaterial ?? createFixedSurfaceMaterial(handle, manifest, appearance, banks);
    super(geometry, material);
    this.ownsMaterial = !sharedMaterial;
    this.triangles = geometry.index!.count / 3;
    const positions = geometry.getAttribute('position');
    const index = geometry.index!;
    let maximumEdgeSquared = 0;
    for (let offset = 0; offset < index.count; offset += 3) {
      for (let edge = 0; edge < 3; edge++) {
        const a = index.getX(offset + edge);
        const b = index.getX(offset + ((edge + 1) % 3));
        const dx = positions.getX(a) - positions.getX(b);
        const dy = positions.getY(a) - positions.getY(b);
        const dz = positions.getZ(a) - positions.getZ(b);
        maximumEdgeSquared = Math.max(maximumEdgeSquared, dx * dx + dy * dy + dz * dz);
      }
    }
    this.maximumEdgeLength = Math.sqrt(maximumEdgeSquared);
    // Count all packet CPU storage, plus distinct expanded CPU arrays and GPU
    // allocations. Shared packet/geometry arrays are counted once on the CPU.
    const packetArrays = new Set<ArrayBufferView>([
      packet.directions,
      packet.heights,
      packet.normals,
      packet.colors,
      packet.indices,
      ...packet.materials,
    ]);
    let bytes = packet.bytes;
    for (const attribute of [...Object.values(geometry.attributes), geometry.index!]) {
      bytes += attribute.array.byteLength;
      if (!packetArrays.has(attribute.array)) {
        bytes += attribute.array.byteLength;
      }
    }
    this.retainedBytes = bytes;
    this.name = `physical-batch-${packet.batch}`;
  }
  setCoastlines(enabled: boolean) {
    setFixedSurfaceCoastlines(this.material, enabled);
  }
  setBankTexture(texture: THREE.Texture) {
    setFixedSurfaceBanks(this.material, texture);
  }
  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.removeFromParent();
    this.geometry.dispose();
    if (this.ownsMaterial) {
      this.material.dispose();
    }
  }
}

/** Mark density is fixed in physical angular bins, independent of zoom, camera,
 * batch size, or the number of physical vertices in a refined region. */
export function fixedSurfaceSymbols(
  packet: PhysicalMeshPacket,
  handle: WorldHandle,
  appearance: FixedSurfaceAppearance,
  atlas: THREE.Texture,
  occupied: Set<string>,
) {
  const anchors: number[] = [];
  const variants: number[] = [];
  const flat = appearance.projection === 'map';
  const step = Math.PI / 60;
  for (let i = 0; i < packet.heights.length; i++) {
    const m0 = packet.materials[0];
    const m1 = packet.materials[1];
    const m4 = packet.materials[4];
    if (!m0 || m0[i * 4 + 2] < 235 || m4[i * 4 + 3] > 5) {
      continue;
    }
    const elevation = packet.heights[i];
    const forest = m1[i * 4] / 255;
    if (elevation < 650 && forest < 0.5) {
      continue;
    }
    const x = packet.directions[i * 3];
    const y = packet.directions[i * 3 + 1];
    const z = packet.directions[i * 3 + 2];
    const [lon, lat] = mapPoint(x, y, z);
    const row = Math.floor((lat + Math.PI / 2) / step);
    const columns = Math.max(1, Math.round(120 * Math.cos((row + 0.5) * step - Math.PI / 2)));
    const column = Math.min(columns - 1, Math.floor(((lon + Math.PI) / (2 * Math.PI)) * columns));
    const key = `${row}:${column}`;
    if (occupied.has(key)) {
      continue;
    }
    occupied.add(key);
    const radius = 1.00004 + (Math.max(0, elevation) / handle.config.radius) * appearance.relief;
    if (flat) {
      anchors.push(lon, lat, 0.00004);
    } else {
      anchors.push(x * radius, y * radius, z * radius);
    }
    variants.push(elevation > 3000 ? 1 : elevation > 1400 ? 0 : forest > 0.5 ? 5 : 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(anchors, 3));
  geometry.setAttribute('variant', new THREE.Float32BufferAttribute(variants, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: { atlas: { value: atlas }, pixelRatio: { value: 1 } },
    vertexShader: `attribute float variant; uniform float pixelRatio; varying float mark; varying float visible;
      void main() { mark = variant; vec4 point = modelViewMatrix * vec4(position, 1.0);
        visible = ${flat ? '1.0' : 'smoothstep(.05, .3, dot(normalize(normalMatrix * normalize(position)), normalize(-point.xyz)))'};
        gl_Position = projectionMatrix * point; gl_PointSize = (variant < 3.0 ? 34.0 : 26.0) * pixelRatio;
      }`,
    fragmentShader: `uniform sampler2D atlas; varying float mark; varying float visible;
      void main() { vec2 uv = (vec2(gl_PointCoord.x, 1.0 - gl_PointCoord.y) + vec2(mod(mark, 4.0), 1.0 - floor(mark / 4.0))) / vec2(4.0, 2.0); uv.y = 1.0 - uv.y;
        vec2 pigment = texture2D(atlas, uv).rg; float coverage = min(1.0, pigment.r + pigment.g) * visible;
        if (coverage < .01) discard;
        vec3 color = (vec3(.86, .81, .65) * pigment.g + vec3(.037, .04, .028) * pigment.r) / max(.001, pigment.r + pigment.g);
        gl_FragColor = vec4(color, coverage);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
  });
  const points = new THREE.Points(geometry, material);
  points.renderOrder = 1;
  points.onBeforeRender = (renderer) => {
    material.uniforms.pixelRatio.value = renderer.getPixelRatio();
  };
  return points;
}
