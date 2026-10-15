import * as THREE from 'three';
import type { Projection } from './projection';

type TerrainSurface = THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;

export interface TerrainVisibilityOptions {
  projection: Projection;
  /** True only when ALL batches of the opaque, closed physical surface exist. */
  complete: boolean;
  /** Maximum possible inward world-space displacement of any zoom patch vertex,
   * including pending patches and the whole morph, rather than its current blend. */
  inwardDisplacement: number;
}

export interface TerrainVisibilityStats {
  enabled: boolean;
  reason:
    | 'ready'
    | 'map'
    | 'incomplete'
    | 'invalid-geometry'
    | 'changed-geometry'
    | 'transformed'
    | 'non-opaque'
    | 'invalid-displacement'
    | 'invalid-camera';
  /** Unpadded minimum origin-to-triangle distance of the complete base mesh. */
  inscribedRadius: number;
  /** Inscribed radius after numerical and temporary-deformation allowances. */
  occluderRadius: number;
  registeredBatches: number;
  /** Horizon counts only; Three's ordinary frustum rejection remains separate. */
  visibleBatches: number;
  culledBatches: number;
  visibleTriangles: number;
  culledTriangles: number;
}

interface Entry {
  surface: TerrainSurface;
  geometry: THREE.BufferGeometry;
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  positionVersion: number;
  index: THREE.BufferAttribute;
  indexVersion: number;
  triangles: number;
  bound: THREE.Sphere;
  radius: number;
  scale: number;
  visible: boolean;
}

// CPU positions are Float32, while shader transforms round again. These margins
// deliberately exceed a handful of Float32 ulps, including near the silhouette.
const POSITION_MARGIN = 2e-6;
const IDENTITY = new THREE.Matrix4().elements;

function version(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute) {
  return attribute instanceof THREE.InterleavedBufferAttribute
    ? attribute.data.version
    : attribute.version;
}

function opaque(surface: TerrainSurface) {
  const materials = Array.isArray(surface.material) ? surface.material : [surface.material];
  return materials.every(
    (material) =>
      material.visible &&
      !material.transparent &&
      material.opacity === 1 &&
      material.depthWrite &&
      material.side !== THREE.BackSide &&
      material.alphaTest === 0 &&
      !material.clippingPlanes?.length,
  );
}

/** A sufficient whole-sphere occlusion test. The first inequality puts the
 * entire bound inside the occluder's tangent cone. The second puts it behind
 * the plane through the cone's tangent circle: all near ray/sphere intersections
 * occur at or before that plane. Merely testing the cone would also hide objects
 * in front of the planet. Tangencies deliberately remain visible. */
export function terrainBoundOccluded(
  bound: THREE.Sphere,
  camera: THREE.Vector3,
  occluderRadius: number,
) {
  const distance = camera.length();
  if (
    !(occluderRadius > 0) ||
    !(distance > occluderRadius) ||
    !(bound.radius >= 0) ||
    !Number.isFinite(distance + bound.radius + bound.center.length())
  ) {
    return false;
  }
  const projection = bound.center.dot(camera) / distance;
  const axial = distance - projection;
  const radialSquared = Math.max(0, bound.center.lengthSq() - projection * projection);
  const sin = occluderRadius / distance;
  const cos = Math.sqrt(Math.max(0, 1 - sin * sin));
  const margin = POSITION_MARGIN * Math.max(1, occluderRadius, bound.radius);
  const radius = bound.radius + margin;
  return (
    axial * sin - Math.sqrt(radialSquared) * cos > radius &&
    axial - radius > distance - occluderRadius * sin
  );
}

/** Metadata only: neither mesh visibility, draw order, nor any geometry buffer
 * is changed here. Register the immutable base meshes, including bases hidden by
 * zoom masks. Their COMPLETE closed sphere encloses the origin, so the smallest
 * distance to its finite triangles gives an insphere, including chorded facets.
 * The caller composes isVisible with temporary masks or shared draw submissions. */
export class TerrainVisibility {
  private readonly entries = new Map<TerrainSurface, Entry>();
  private minimumRadius = Infinity;
  private maximumScale = 1;
  private triangles = 0;
  private ready = false;
  private readonly cameraPosition = new THREE.Vector3();

  register(surface: TerrainSurface, projection: Projection = 'globe') {
    if (this.entries.has(surface)) {
      return false;
    }
    const geometry = surface.geometry;
    const position = geometry.getAttribute('position');
    const index = geometry.index;
    if (!position || !index) {
      throw new Error('Terrain visibility requires indexed physical positions');
    }
    const triangles = index.count / 3;
    let radius = Infinity;
    let scale = 1;
    const box = new THREE.Box3();
    const point = new THREE.Vector3();
    const triangle = new THREE.Triangle();
    const origin = new THREE.Vector3();
    const existingBound = geometry.boundingSphere?.clone();
    let boundValid =
      !!existingBound && Number.isFinite(existingBound.radius) && existingBound.radius >= 0;
    let valid = projection === 'globe' && Number.isInteger(triangles) && triangles > 0;
    if (projection === 'globe') {
      for (let i = 0; i < position.count; i++) {
        point.fromBufferAttribute(position, i);
        if (!Number.isFinite(point.x + point.y + point.z)) {
          valid = false;
          break;
        }
        box.expandByPoint(point);
        scale = Math.max(scale, point.length());
        if (existingBound && point.distanceTo(existingBound.center) > existingBound.radius) {
          boundValid = false;
        }
      }
      // No per-face vectors or retained full-world copies. Scan once as each
      // packet arrives; subsequent camera updates touch only batch metadata.
      for (let i = 0; valid && i < index.count; i += 3) {
        const a = index.getX(i);
        const b = index.getX(i + 1);
        const c = index.getX(i + 2);
        if (a >= position.count || b >= position.count || c >= position.count) {
          valid = false;
          break;
        }
        const ax = position.getX(a);
        const ay = position.getY(a);
        const az = position.getZ(a);
        const ux = position.getX(b) - ax;
        const uy = position.getY(b) - ay;
        const uz = position.getZ(b) - az;
        const vx = position.getX(c) - ax;
        const vy = position.getY(c) - ay;
        const vz = position.getZ(c) - az;
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        const areaSquared = nx * nx + ny * ny + nz * nz;
        const edgeProduct = (ux * ux + uy * uy + uz * uz) * (vx * vx + vy * vy + vz * vz);
        const signed = nx * ax + ny * ay + nz * az;
        // Reject degenerate, numerically unstable, or inward-facing faces rather
        // than assuming that a partial subset can supply an opaque occluder.
        if (!(areaSquared > edgeProduct * 1e-12) || !(signed > 0)) {
          valid = false;
          break;
        }
        // The supporting plane is a cheap lower bound. Its perpendicular foot
        // can be far outside a steep/skinny dual face, however: using that plane
        // alone can shrink a radius-one planet's occluder below .5. Only faces
        // whose lower bound can change the minimum need the finite-triangle
        // closest point. The final Float32 allowance also covers these double
        // precision operations; the area guard excludes ill-conditioned faces.
        const planeDistance = signed / Math.sqrt(areaSquared);
        if (planeDistance < radius) {
          if (areaSquared <= edgeProduct * 1e-8) {
            // Closest-point barycentrics are less well conditioned than the
            // plane calculation. Retain the lower bound for these thin faces.
            radius = planeDistance;
          } else {
            triangle.a.set(ax, ay, az);
            triangle.b.set(ax + ux, ay + uy, az + uz);
            triangle.c.set(ax + vx, ay + vy, az + vz);
            triangle.closestPointToPoint(origin, point);
            radius = Math.min(radius, point.length());
          }
        }
      }
    }
    const bound = new THREE.Sphere();
    if (valid) {
      if (boundValid && existingBound) {
        bound.copy(existingBound);
      } else {
        box.getBoundingSphere(bound);
      }
      bound.radius += POSITION_MARGIN * scale;
    } else {
      radius = 0;
      bound.radius = Infinity;
    }
    const entry: Entry = {
      surface,
      geometry,
      position,
      positionVersion: version(position),
      index,
      indexVersion: index.version,
      triangles,
      bound,
      radius,
      scale,
      visible: true,
    };
    this.entries.set(surface, entry);
    this.ready = false;
    this.minimumRadius = Math.min(this.minimumRadius, radius);
    this.maximumScale = Math.max(this.maximumScale, scale);
    this.triangles += triangles;
    return true;
  }

  isVisible(surface: TerrainSurface) {
    // An unregistered newly arrived batch is always retained until its metadata
    // joins the proof; an old result must never hide unknown geometry.
    return !this.ready || (this.entries.get(surface)?.visible ?? true);
  }

  update(camera: THREE.Camera, options: TerrainVisibilityOptions): TerrainVisibilityStats {
    const inscribedRadius = Number.isFinite(this.minimumRadius) ? this.minimumRadius : 0;
    const guardedRadius =
      inscribedRadius - options.inwardDisplacement - POSITION_MARGIN * this.maximumScale;
    let reason: TerrainVisibilityStats['reason'] = 'ready';
    if (options.projection === 'map') {
      reason = 'map';
    } else if (!options.complete || !this.entries.size) {
      reason = 'incomplete';
    } else if (!(inscribedRadius > 0)) {
      reason = 'invalid-geometry';
    } else if (
      !(options.inwardDisplacement >= 0) ||
      !Number.isFinite(options.inwardDisplacement) ||
      !(guardedRadius > 0)
    ) {
      reason = 'invalid-displacement';
    }
    if (reason === 'ready') {
      for (const entry of this.entries.values()) {
        const { surface, geometry, position, index } = entry;
        if (
          surface.geometry !== geometry ||
          geometry.getAttribute('position') !== position ||
          geometry.index !== index ||
          version(position) !== entry.positionVersion ||
          index.version !== entry.indexVersion ||
          geometry.drawRange.start !== 0 ||
          geometry.drawRange.count < index.count
        ) {
          reason = 'changed-geometry';
          break;
        }
        surface.updateWorldMatrix(true, false);
        if (surface.matrixWorld.elements.some((value, axis) => value !== IDENTITY[axis])) {
          reason = 'transformed';
          break;
        }
        if (!opaque(surface)) {
          reason = 'non-opaque';
          break;
        }
      }
    }
    camera.getWorldPosition(this.cameraPosition);
    if (
      reason === 'ready' &&
      (!(camera instanceof THREE.PerspectiveCamera) ||
        !Number.isFinite(this.cameraPosition.length()) ||
        !(this.cameraPosition.length() > guardedRadius))
    ) {
      reason = 'invalid-camera';
    }
    const enabled = reason === 'ready';
    this.ready = enabled;
    const occluderRadius = enabled ? guardedRadius : 0;
    let culledBatches = 0;
    let culledTriangles = 0;
    for (const entry of this.entries.values()) {
      entry.visible =
        !enabled || !terrainBoundOccluded(entry.bound, this.cameraPosition, occluderRadius);
      if (!entry.visible) {
        culledBatches++;
        culledTriangles += entry.triangles;
      }
    }
    return {
      enabled,
      reason,
      inscribedRadius,
      occluderRadius,
      registeredBatches: this.entries.size,
      visibleBatches: this.entries.size - culledBatches,
      culledBatches,
      visibleTriangles: this.triangles - culledTriangles,
      culledTriangles,
    };
  }

  clear() {
    this.entries.clear();
    this.minimumRadius = Infinity;
    this.maximumScale = 1;
    this.triangles = 0;
    this.ready = false;
  }
}
