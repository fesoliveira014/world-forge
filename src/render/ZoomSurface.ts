import * as THREE from 'three';
import {
  PHYSICAL_MATERIAL_FIELD_COUNT,
  type PhysicalMeshPacket,
} from '../core/view/physical-mesh-types';
import {
  decodeZoomNormal,
  prepareZoomTriangle,
  sampleZoomHeightCorrection,
} from '../core/view/zoom-reconstruction';
import { buildZoomTopology } from '../core/view/zoom-subdivision';
import type { FixedSurface, FixedSurfaceAppearance } from './FixedSurface';
import type { ZoomFaceCandidate } from './ZoomSelection';
import { mapReliefScale } from './MapStyle';
import { MAP_HEIGHT_SHEAR } from './projection';

export const ZOOM_VERTEX_BUDGET = 32760;
export const ZOOM_BATCH_BUDGET = 32;
export interface ZoomRiverProtection {
  attenuation(direction: ArrayLike<number>, marginMetres?: number, widthScale?: number): number;
}

/** Installed once on the shared Natural material. Ordinary terrain has zero
 * default offsets and continues to use the original shader expressions. */
export function enableZoomSurfaceMaterial(material: THREE.ShaderMaterial, flat = false) {
  if (material.uniforms.zoomBlend) {
    return;
  }
  material.uniforms.zoomBlend = { value: 0 };
  const defaults = material.defaultAttributeValues as Record<string, number[]>;
  defaults.zoomOffset = [0, 0, 0, 0];
  defaults.zoomNormal = [0, 0, 0];
  let shader = material.vertexShader.replace(/\bposition\b/g, 'zoomPosition');
  shader = shader.replace(
    'void main() {',
    'void main() { vec3 zoomPosition = position + zoomOffset.xyz * zoomBlend;',
  );
  const natural = shader.includes('vSurfaceNormal');
  shader = shader.replace(
    'gl_Position =',
    natural
      ? `vSphere = mix(vSphere, spherePosition, zoomOffset.w);
     vSurfaceNormal = mix(vSurfaceNormal, normalMatrix * zoomNormal, zoomOffset.w);
     gl_Position =`
      : `sphereDirection = mix(sphereDirection, spherePosition, zoomOffset.w);
     fixedViewNormal = mix(fixedViewNormal, normalMatrix * zoomNormal, zoomOffset.w);
     viewUp = mix(viewUp, normalMatrix * ${flat ? 'vec3(0.0, 0.0, 1.0)' : 'spherePosition'}, zoomOffset.w);
     gl_Position =`,
  );
  material.vertexShader =
    'attribute vec4 zoomOffset; attribute vec3 zoomNormal; uniform float zoomBlend;\n' + shader;
  material.needsUpdate = true;
}

/** CPU equivalent of FixedSurface's untransformed normal, so new vertices can
 * interpolate the original varyings exactly instead of changing the lighting
 * when a parent triangle is tessellated at zero displacement. */
function displayedNormal(
  packet: PhysicalMeshPacket,
  vertex: number,
  radius: number,
  appearance: FixedSurfaceAppearance,
) {
  const d = new THREE.Vector3().fromArray(packet.directions, vertex * 3).normalize();
  const n = new THREE.Vector3(...decodeZoomNormal(packet.normals, vertex));
  const tangent = d.clone().addScaledVector(n, -1 / Math.max(0.05, n.dot(d)));
  const height = packet.heights[vertex];
  const baseRadius = 1 + height / radius;
  if (appearance.projection === 'globe') {
    return d
      .addScaledVector(
        tangent,
        (-appearance.relief * baseRadius) / (1 + (height / radius) * appearance.relief),
      )
      .normalize();
  }
  const horizontal = Math.max(0.00001, Math.hypot(d.x, d.z));
  const east = new THREE.Vector3(-d.z / horizontal, 0, d.x / horizontal);
  const north = new THREE.Vector3().crossVectors(east, d);
  const scale = baseRadius * appearance.relief * mapReliefScale(appearance.mapStyle);
  const sx = tangent.dot(east) * scale * horizontal;
  const sy = tangent.dot(north) * scale;
  return new THREE.Vector3(-sx, -sy, 1 + MAP_HEIGHT_SHEAR * sy).normalize();
}

/** All original packet arrays stay immutable. The temporary index alone omits
 * the replaced faces; the rest of each affected batch shares its vertex buffers. */
export class ZoomSurfacePatch {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly selections: readonly ZoomFaceCandidate[];
  private readonly masks: {
    base: FixedSurface;
    mesh: THREE.Mesh;
    privateGpuAttributes: boolean;
  }[] = [];
  private installed = false;
  private disposed = false;
  readonly bytes: number;
  /** Largest shader displacement at any morph value between zero and one. */
  readonly maximumDisplacement: number;
  constructor(
    geometry: THREE.BufferGeometry,
    selections: readonly ZoomFaceCandidate[],
    private readonly surfaces: readonly FixedSurface[],
    material: THREE.ShaderMaterial,
  ) {
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'zoom-detail';
    this.selections = selections;
    const offsets = geometry.getAttribute('zoomOffset');
    let maximumDisplacement = 0;
    for (let vertex = 0; vertex < offsets.count; vertex++) {
      maximumDisplacement = Math.max(
        maximumDisplacement,
        Math.hypot(offsets.getX(vertex), offsets.getY(vertex), offsets.getZ(vertex)),
      );
    }
    this.maximumDisplacement = maximumDisplacement;
    this.bytes =
      2 *
      [...Object.values(geometry.attributes), geometry.index!].reduce(
        (sum, attribute) => sum + attribute.array.byteLength,
        0,
      );
  }
  get vertices() {
    return this.mesh.geometry.getAttribute('position').count;
  }
  get triangles() {
    return this.mesh.geometry.index!.count / 3;
  }
  get maskBytes() {
    return this.masks.reduce(
      (sum, mask) =>
        sum +
        mask.mesh.geometry.index!.array.byteLength * 2 +
        (mask.privateGpuAttributes
          ? Object.values(mask.mesh.geometry.attributes).reduce(
              (bytes, attribute) => bytes + attribute.array.byteLength,
              0,
            )
          : 0),
      0,
    );
  }
  isMasked(base: FixedSurface) {
    return this.masks.some((mask) => mask.base === base);
  }
  /** Compose culling with the replacement indices without restoring the original
   * faces underneath the patch. The caller separately controls the patch mesh. */
  applyBaseVisibility(isVisible: (base: FixedSurface) => boolean): void {
    for (const { base, mesh } of this.masks) {
      base.visible = false;
      mesh.visible = isVisible(base);
    }
  }
  install(parent: THREE.Group) {
    if (this.installed || this.disposed) {
      return;
    }
    const groups = new Map<number, Set<number>>();
    for (const { batch, face } of this.selections) {
      if (!groups.has(batch)) {
        groups.set(batch, new Set());
      }
      groups.get(batch)!.add(face);
    }
    for (const [batch, faces] of groups) {
      const base = this.surfaces[batch];
      const geometry = new THREE.BufferGeometry();
      const privateGpuAttributes = base.userData.terrainBatched === true;
      for (const [name, attribute] of Object.entries(base.geometry.attributes)) {
        if (privateGpuAttributes) {
          // The batched owner uploads its combined geometry, not these source
          // attributes. A mask needs its own disposable GPU buffers while still
          // borrowing the immutable CPU arrays used for picking/reconstruction.
          const wrapper = new THREE.BufferAttribute(
            attribute.array,
            attribute.itemSize,
            attribute.normalized,
          );
          if (attribute instanceof THREE.BufferAttribute) {
            wrapper.gpuType = attribute.gpuType;
            wrapper.setUsage(attribute.usage);
          }
          geometry.setAttribute(name, wrapper);
        } else {
          geometry.setAttribute(name, attribute);
        }
      }
      const original = base.geometry.index!;
      const ArrayType = original.array.constructor as typeof Uint16Array | typeof Uint32Array;
      const index = new ArrayType(original.count - faces.size * 3);
      let next = 0;
      for (let offset = 0; offset < original.count; offset += 3) {
        if (!faces.has(offset / 3)) {
          index[next++] = original.getX(offset);
          index[next++] = original.getX(offset + 1);
          index[next++] = original.getX(offset + 2);
        }
      }
      geometry.setIndex(new THREE.BufferAttribute(index, 1));
      geometry.boundingBox = base.geometry.boundingBox;
      geometry.boundingSphere = base.geometry.boundingSphere;
      const mesh = new THREE.Mesh(geometry, base.material);
      mesh.name = `zoom-base-${batch}`;
      base.visible = false;
      parent.add(mesh);
      this.masks.push({ base, mesh, privateGpuAttributes });
    }
    parent.add(this.mesh);
    this.installed = true;
  }
  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    for (const { base, mesh, privateGpuAttributes } of this.masks) {
      base.visible = true;
      mesh.removeFromParent();
      // Three removes every attached attribute's GPU buffer on disposal, even
      // when another geometry still owns that same BufferAttribute. Detach the
      // borrowed wrappers first; batched masks instead own their GPU wrappers.
      if (!privateGpuAttributes) {
        for (const name of Object.keys(mesh.geometry.attributes)) {
          mesh.geometry.deleteAttribute(name);
        }
      }
      mesh.geometry.dispose();
    }
    this.masks.length = 0;
  }
}

/** Bounded cooperative build. No reader requests, global mesh copy, or new
 * simulation cells. Every yield is a cancellation point for camera/world changes. */
export function* buildZoomSurface(
  candidates: readonly ZoomFaceCandidate[],
  surfaces: readonly FixedSurface[],
  packets: readonly PhysicalMeshPacket[],
  radius: number,
  appearance: FixedSurfaceAppearance,
  material: THREE.ShaderMaterial,
  rivers: ZoomRiverProtection,
): Generator<void, ZoomSurfacePatch | null> {
  const accepted: ZoomFaceCandidate[] = [];
  const groups = new Map<number, ZoomFaceCandidate[]>();
  const controls = new Map<
    string,
    { triangle: ReturnType<typeof prepareZoomTriangle>; attenuation: number }
  >();
  let vertexBudget = ZOOM_VERTEX_BUDGET;
  for (const candidate of candidates) {
    const { batch, face, segments } = candidate;
    if (!groups.has(batch) && groups.size >= ZOOM_BATCH_BUDGET) {
      continue;
    }
    const packet = packets[batch];
    const ids = Array.from(packet.indices.subarray(face * 3, face * 3 + 3)) as [
      number,
      number,
      number,
    ];
    const triangle = prepareZoomTriangle(packet, ids, radius);
    if (!triangle.reconstructable) {
      continue;
    }
    const directions = ids.map((id) =>
      new THREE.Vector3().fromArray(packet.directions, id * 3).normalize(),
    );
    const centre = directions.reduce((sum, d) => sum.add(d), new THREE.Vector3()).normalize();
    const extent = Math.max(...directions.map((d) => centre.angleTo(d))) * radius;
    // Protect the entire parent face, including the gaps between fine samples.
    // 2.5 is the maximum river width display setting; changing it needs no rebuild.
    const attenuation = rivers.attenuation(centre.toArray(), extent + 10, 2.5);
    if (attenuation <= 0) {
      continue;
    }
    const cost = segments === 2 ? 4 : 3 + ((segments - 1) * (segments - 2)) / 2;
    if (cost > vertexBudget) {
      continue;
    }
    vertexBudget -= cost;
    accepted.push(candidate);
    if (!groups.has(batch)) {
      groups.set(batch, []);
    }
    groups.get(batch)!.push(candidate);
    controls.set(`${batch}:${face}`, { triangle, attenuation });
    yield;
  }
  if (!accepted.length) {
    return null;
  }
  const parts = [...groups].map(([batch, faces]) => ({
    batch,
    topology: buildZoomTopology(packets[batch], faces, ZOOM_VERTEX_BUDGET),
  }));
  const count = parts.reduce((sum, part) => sum + part.topology.vertexCount, 0);
  const indexCount = parts.reduce((sum, part) => sum + part.topology.indices.length, 0);
  const positions = new Float32Array(count * 3);
  const offsets = new Float32Array(count * 4);
  const spheres = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const physicalHeights = new Float32Array(count);
  const packedNormals = new Float32Array(count * 2);
  const fields = Array.from(
    { length: PHYSICAL_MATERIAL_FIELD_COUNT },
    () => new Float32Array(count * 4),
  );
  const indices = new Uint16Array(indexCount);
  let firstVertex = 0;
  let firstIndex = 0;
  for (const { batch, topology } of parts) {
    const packet = packets[batch];
    const original = surfaces[batch].geometry.getAttribute('position');
    let lastFace = -1;
    let ids: [number, number, number] = [0, 0, 0];
    let cornerNormals: THREE.Vector3[] = [];
    let cornerDirections: THREE.Vector3[] = [];
    for (let v = 0; v < topology.vertexCount; v++) {
      const destination = firstVertex + v;
      const face = topology.sourceFaces[v];
      if (face !== lastFace) {
        ids = Array.from(packet.indices.subarray(face * 3, face * 3 + 3)) as [
          number,
          number,
          number,
        ];
        cornerNormals = ids.map((id) => displayedNormal(packet, id, radius, appearance));
        cornerDirections = ids.map((id) =>
          new THREE.Vector3().fromArray(packet.directions, id * 3).normalize(),
        );
        lastFace = face;
      }
      const weights = topology.barycentrics.subarray(v * 3, v * 3 + 3);
      const control = controls.get(`${batch}:${face}`)!;
      const correction = sampleZoomHeightCorrection(control.triangle, weights, control.attenuation);
      for (let corner = 0; corner < 3; corner++) {
        const id = ids[corner];
        const w = weights[corner];
        positions[destination * 3] += original.getX(id) * w;
        positions[destination * 3 + 1] += original.getY(id) * w;
        positions[destination * 3 + 2] += original.getZ(id) * w;
        physicalHeights[destination] += packet.heights[id] * w;
        for (let axis = 0; axis < 3; axis++) {
          spheres[destination * 3 + axis] += cornerDirections[corner].getComponent(axis) * w;
          normals[destination * 3 + axis] += cornerNormals[corner].getComponent(axis) * w;
        }
        for (let field = 0; field < PHYSICAL_MATERIAL_FIELD_COUNT; field++) {
          const source = packet.materials[field];
          for (let component = 0; component < 4; component++) {
            const pair =
              (field === 0 && component === 0) ||
              (field === 1 && component === 1) ||
              (field === 3 && component === 0);
            if (pair) {
              // Preserve the decoded scalar exactly. Fractional high channels
              // are legal in Float32 attributes and avoid rounding new colors.
              fields[field][destination * 4 + component] +=
                ((source[id * 4 + component] * 256 + source[id * 4 + component + 1]) / 65280) * w;
              component++;
            } else {
              fields[field][destination * 4 + component] += (source[id * 4 + component] / 255) * w;
            }
          }
        }
      }
      const direction = new THREE.Vector3().fromArray(spheres, destination * 3).normalize();
      const shift = (correction / radius) * appearance.relief;
      if (appearance.projection === 'map') {
        offsets[destination * 4 + 1] =
          shift * mapReliefScale(appearance.mapStyle) * MAP_HEIGHT_SHEAR;
        offsets[destination * 4 + 2] = shift * mapReliefScale(appearance.mapStyle);
      } else {
        for (let axis = 0; axis < 3; axis++) {
          offsets[destination * 4 + axis] = direction.getComponent(axis) * shift;
        }
      }
      offsets[destination * 4 + 3] = 1;
      if (v % 64 === 63) {
        yield;
      }
    }
    for (let i = 0; i < topology.indices.length; i++) {
      indices[firstIndex + i] = topology.indices[i] + firstVertex;
    }
    firstVertex += topology.vertexCount;
    firstIndex += topology.indices.length;
    yield;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('zoomOffset', new THREE.BufferAttribute(offsets, 4));
  geometry.setAttribute('zoomNormal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('spherePosition', new THREE.BufferAttribute(spheres, 3));
  geometry.setAttribute('physicalHeight', new THREE.BufferAttribute(physicalHeights, 1));
  geometry.setAttribute('packedNormal', new THREE.BufferAttribute(packedNormals, 2));
  fields.forEach((field, index) =>
    geometry.setAttribute(`material${index}`, new THREE.BufferAttribute(field, 4)),
  );
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingBox();
  // Shader displacement must be included in culling, including its negative end.
  const point = new THREE.Vector3();
  for (let v = 0; v < count; v++) {
    point
      .fromArray(positions, v * 3)
      .add(new THREE.Vector3(offsets[v * 4], offsets[v * 4 + 1], offsets[v * 4 + 2]));
    geometry.boundingBox!.expandByPoint(point);
  }
  geometry.boundingSphere = geometry.boundingBox!.getBoundingSphere(new THREE.Sphere());
  return new ZoomSurfacePatch(geometry, accepted, surfaces, material);
}
