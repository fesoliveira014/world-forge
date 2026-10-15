import * as THREE from 'three';
import {
  PHYSICAL_MATERIAL_FIELD_COUNT,
  type PhysicalMeshPacket,
} from '../core/view/physical-mesh-types';
import type { FixedSurface } from './FixedSurface';

export interface ZoomFaceCandidate {
  /** Index in the aligned surface/packet arrays, rather than a persistent ID. */
  batch: number;
  face: number;
  segments: 2 | 4 | 8 | 16;
  /** Squared screen-centre distance in pixels; lower values have priority. */
  priority: number;
}

export interface ZoomSelectionProgress {
  scannedFaces: number;
}

const MAX_CANDIDATES = 384;
const compare = (a: ZoomFaceCandidate, b: ZoomFaceCandidate) =>
  a.priority - b.priority || a.batch - b.batch || a.face - b.face;

function level(edgePixels: number, previous?: ZoomFaceCandidate['segments']) {
  const desired = Math.min(
    16,
    Math.max(2, 2 ** Math.ceil(Math.log2(edgePixels / 18))),
  ) as ZoomFaceCandidate['segments'];
  if (
    previous &&
    ((desired > previous && edgePixels <= previous * 18 * 1.2) ||
      (desired < previous && edgePixels >= (previous / 2) * 18 * 0.8))
  ) {
    return previous;
  }
  return desired;
}

/** A conservative pixel-length bound over every edge in one displayed batch.
 * The perspective Jacobian has norm at most F/depth * sqrt(1 + lateral²/depth²).
 * Its bound over the entire convex sphere also bounds each projected edge.
 * Unsupported projections and spheres crossing the near plane fail open. */
export function maximumZoomEdgePixels(
  maximumEdgeLength: number,
  sphere: THREE.Sphere,
  modelView: THREE.Matrix4,
  projection: THREE.Matrix4,
  width: number,
  height: number,
  near = 0,
) {
  if (!(maximumEdgeLength >= 0) || !Number.isFinite(maximumEdgeLength)) {
    return Infinity;
  }
  const m = modelView.elements;
  const p = projection.elements;
  if (m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1 || p[1] !== 0 || p[4] !== 0) {
    return Infinity;
  }
  // The maximum absolute row sum of MᵀM bounds its largest eigenvalue. Unlike
  // maximum column length, this remains conservative under affine shear too.
  const xx = m[0] ** 2 + m[1] ** 2 + m[2] ** 2;
  const yy = m[4] ** 2 + m[5] ** 2 + m[6] ** 2;
  const zz = m[8] ** 2 + m[9] ** 2 + m[10] ** 2;
  const xy = Math.abs(m[0] * m[4] + m[1] * m[5] + m[2] * m[6]);
  const xz = Math.abs(m[0] * m[8] + m[1] * m[9] + m[2] * m[10]);
  const yz = Math.abs(m[4] * m[8] + m[5] * m[9] + m[6] * m[10]);
  const scale = Math.sqrt(Math.max(xx + xy + xz, yy + xy + yz, zz + xz + yz)) * (1 + 1e-12);
  const focalPixels = Math.max(Math.abs(p[0]) * width, Math.abs(p[5]) * height) / 2;
  const common = maximumEdgeLength * scale * focalPixels;
  if (p[3] === 0 && p[7] === 0 && p[11] === 0 && p[15] === 1 && p[8] === 0 && p[9] === 0) {
    return Number.isFinite(common) ? common : Infinity;
  }
  if (p[3] !== 0 || p[7] !== 0 || p[11] !== -1 || p[15] !== 0 || p[12] !== 0 || p[13] !== 0) {
    return Infinity;
  }
  const x = sphere.center.x;
  const y = sphere.center.y;
  const z = sphere.center.z;
  const viewX = m[0] * x + m[4] * y + m[8] * z + m[12];
  const viewY = m[1] * x + m[5] * y + m[9] * z + m[13];
  const viewZ = m[2] * x + m[6] * y + m[10] * z + m[14];
  const radius = sphere.radius * scale;
  const minimumDepth = -viewZ - radius;
  if (!(minimumDepth > Math.max(near, 1e-8))) {
    return Infinity;
  }
  const maximumLateral = Math.hypot(viewX, viewY) + radius;
  const bound = (common / minimumDepth) * Math.hypot(1, maximumLateral / minimumDepth);
  return Number.isFinite(bound) ? bound : Infinity;
}

/** Cooperatively select a bounded set from already resident Natural meshes.
 * Camera matrices are captured on the first step and never reread mid-scan.
 * Callers keep scene/camera matrices current, as for an ordinary Three render.
 * Base meshes may be hidden by a temporary patch; visibility is not consulted.
 */
export function* selectZoomFaces(
  surfaces: readonly FixedSurface[],
  packets: readonly PhysicalMeshPacket[],
  camera: THREE.Camera,
  width: number,
  height: number,
  previous: readonly ZoomFaceCandidate[] = [],
): Generator<ZoomSelectionProgress, ZoomFaceCandidate[]> {
  if (!(width > 0 && height > 0 && Number.isFinite(width + height))) {
    return [];
  }
  const cameraWorld = camera.matrixWorld.clone();
  const cameraPosition = new THREE.Vector3().setFromMatrixPosition(cameraWorld);
  const projection = camera.projectionMatrix.clone();
  const view = cameraWorld.invert();
  const clip = new THREE.Matrix4().multiplyMatrices(projection, view);
  const modelView = new THREE.Matrix4();
  const near = 'near' in camera && typeof camera.near === 'number' ? camera.near : 0;
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().makeScale(1 / 1.3, 1 / 1.3, 1).multiply(clip),
  );
  const sphere = new THREE.Sphere();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const edge = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const toCamera = new THREE.Vector3();
  const pa = new THREE.Vector4();
  const pb = new THREE.Vector4();
  const pc = new THREE.Vector4();
  const previousFaces = new Map<number, Map<number, ZoomFaceCandidate['segments']>>();
  for (const candidate of previous.slice(0, MAX_CANDIDATES)) {
    let faces = previousFaces.get(candidate.batch);
    if (!faces) {
      faces = new Map();
      previousFaces.set(candidate.batch, faces);
    }
    faces.set(candidate.face, candidate.segments);
  }
  // A max heap retains only the nearest candidates. Scanning never allocates
  // an array proportional to the world, nor sorts all of its physical faces.
  const heap: ZoomFaceCandidate[] = [];
  const retain = (candidate: ZoomFaceCandidate) => {
    if (heap.length < MAX_CANDIDATES) {
      let child = heap.push(candidate) - 1;
      while (child > 0) {
        const parent = (child - 1) >> 1;
        if (compare(heap[parent], heap[child]) >= 0) {
          break;
        }
        [heap[parent], heap[child]] = [heap[child], heap[parent]];
        child = parent;
      }
      return;
    }
    heap[0] = candidate;
    let parent = 0;
    while (parent * 2 + 1 < heap.length) {
      let child = parent * 2 + 1;
      if (child + 1 < heap.length && compare(heap[child + 1], heap[child]) > 0) {
        child++;
      }
      if (compare(heap[parent], heap[child]) >= 0) {
        break;
      }
      [heap[parent], heap[child]] = [heap[child], heap[parent]];
      parent = child;
    }
  };
  let scannedFaces = 0;
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  for (let batch = 0; batch < surfaces.length; batch++) {
    const surface = surfaces[batch];
    const packet = packets[batch];
    if (
      !packet ||
      packet.mode !== 'primal' ||
      packet.materials.length !== PHYSICAL_MATERIAL_FIELD_COUNT ||
      packet.colors.length
    ) {
      continue;
    }
    const geometry = surface.geometry;
    const positions = geometry.getAttribute('position');
    const indices = geometry.index;
    if (!positions || !indices || !geometry.boundingSphere) {
      continue;
    }
    const flat = geometry.userData.mapCopies !== undefined;
    const world = surface.matrixWorld.clone();
    sphere.copy(geometry.boundingSphere).applyMatrix4(world);
    const faceCount = packet.indices.length / 3;
    if (
      !frustum.intersectsSphere(sphere) ||
      maximumZoomEdgePixels(
        surface.maximumEdgeLength,
        geometry.boundingSphere,
        modelView.multiplyMatrices(view, world),
        projection,
        width,
        height,
        near,
      ) < 25
    ) {
      scannedFaces += faceCount;
      yield { scannedFaces };
      continue;
    }
    const prior = previousFaces.get(batch);
    const water = packet.materials[4];
    for (let face = 0; face < faceCount; face++) {
      if (scannedFaces > 0 && scannedFaces % 256 === 0) {
        yield { scannedFaces };
      }
      scannedFaces++;
      const offset = face * 3;
      const ia = packet.indices[offset];
      const ib = packet.indices[offset + 1];
      const ic = packet.indices[offset + 2];
      if (
        flat &&
        (indices.getX(offset) !== ia ||
          indices.getX(offset + 1) !== ib ||
          indices.getX(offset + 2) !== ic)
      ) {
        continue;
      }
      const ha = packet.heights[ia];
      const hb = packet.heights[ib];
      const hc = packet.heights[ic];
      if (
        Math.min(ha, hb, hc) <= 0 ||
        Math.max(ha, hb, hc) - Math.min(ha, hb, hc) < 0.05 ||
        water[ia * 4 + 2] > 0 ||
        water[ia * 4 + 3] > 0 ||
        water[ib * 4 + 2] > 0 ||
        water[ib * 4 + 3] > 0 ||
        water[ic * 4 + 2] > 0 ||
        water[ic * 4 + 3] > 0
      ) {
        continue;
      }
      a.fromBufferAttribute(positions, ia).applyMatrix4(world);
      b.fromBufferAttribute(positions, ib).applyMatrix4(world);
      c.fromBufferAttribute(positions, ic).applyMatrix4(world);
      if (
        !flat &&
        normal
          .subVectors(b, a)
          .cross(edge.subVectors(c, a))
          .dot(toCamera.subVectors(cameraPosition, a)) <= 0
      ) {
        continue;
      }
      pa.set(a.x, a.y, a.z, 1).applyMatrix4(clip);
      pb.set(b.x, b.y, b.z, 1).applyMatrix4(clip);
      pc.set(c.x, c.y, c.z, 1).applyMatrix4(clip);
      if (Math.min(pa.w, pb.w, pc.w) <= 1e-8) {
        continue;
      }
      pa.multiplyScalar(1 / pa.w);
      pb.multiplyScalar(1 / pb.w);
      pc.multiplyScalar(1 / pc.w);
      if (
        Math.min(pa.x, pb.x, pc.x) > 1.3 ||
        Math.max(pa.x, pb.x, pc.x) < -1.3 ||
        Math.min(pa.y, pb.y, pc.y) > 1.3 ||
        Math.max(pa.y, pb.y, pc.y) < -1.3 ||
        Math.min(pa.z, pb.z, pc.z) > 1 ||
        Math.max(pa.z, pb.z, pc.z) < -1
      ) {
        continue;
      }
      const edgePixels = Math.max(
        Math.hypot((pa.x - pb.x) * halfWidth, (pa.y - pb.y) * halfHeight),
        Math.hypot((pb.x - pc.x) * halfWidth, (pb.y - pc.y) * halfHeight),
        Math.hypot((pc.x - pa.x) * halfWidth, (pc.y - pa.y) * halfHeight),
      );
      const oldLevel = prior?.get(face);
      if (!(edgePixels > (oldLevel ? 26 : 36))) {
        continue;
      }
      const priority =
        (((pa.x + pb.x + pc.x) / 3) * halfWidth) ** 2 +
        (((pa.y + pb.y + pc.y) / 3) * halfHeight) ** 2;
      if (!Number.isFinite(priority)) {
        continue;
      }
      if (
        heap.length < MAX_CANDIDATES ||
        priority < heap[0].priority ||
        (priority === heap[0].priority &&
          (batch < heap[0].batch || (batch === heap[0].batch && face < heap[0].face)))
      ) {
        retain({ batch, face, segments: level(edgePixels, oldLevel), priority });
      }
    }
    yield { scannedFaces };
  }
  return heap.sort(compare);
}
