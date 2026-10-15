import { Vector3 } from 'three';
import { MAP_HEIGHT_SHEAR, spherePoint, type Projection } from './projection';

/** Recover geography from the visible terrain hit, independent of triangle size.
 * Map terrain uses depth zero before relief; undo its height shear using the
 * interpolated displayed z, including seam and pole vertices. */
export function geographicSurfaceAnchor(
  point: Readonly<Vector3>,
  projection: Projection,
): Vector3 | null {
  if (![point.x, point.y, point.z].every(Number.isFinite)) {
    return null;
  }
  if (projection === 'globe') {
    return point.lengthSq() > 0 ? new Vector3().copy(point).normalize() : null;
  }
  const latitude = point.y - MAP_HEIGHT_SHEAR * point.z;
  // Ignore seam copies outside the fragment shader's visible longitude range.
  // Float32 projection can place an exact pole a few ulps beyond its latitude.
  if (Math.abs(point.x) > Math.PI || Math.abs(latitude) > Math.PI / 2 + 1e-6) {
    return null;
  }
  return spherePoint(
    point.x,
    Math.max(-Math.PI / 2, Math.min(Math.PI / 2, latitude)),
    new Vector3(),
  );
}
