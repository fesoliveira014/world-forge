import type { PhysicalMeshPacket } from './physical-mesh-types';
import { simplifyRegionPacket } from './region-simplification';

export const CATEGORICAL_MAX_EDGE_ANGLE = Math.PI / 360;
export const CATEGORICAL_MAX_HEIGHT_RANGE = 5;

export interface CategoricalSimplificationOptions {
  /** Semantic categories, including distinct categories sharing a palette color. */
  triangleRegions?: Int32Array | Uint32Array;
  /** Pinned saved vertices. Protect all three vertices to freeze an entire face. */
  protectedVertices?: Uint8Array;
  /** Fixed angular limit on newly created edges, independent of the camera. */
  maxEdgeAngle?: number;
  /** Metres of rendered scalar height variation in each replaced original fan. */
  maxHeightRange?: number;
}

/** Simplify only equal-category interiors with a bounded accumulated height
 * envelope. Every retained direction and raw height stays bit-identical, while
 * max(0, height) matches the renderer's sea-level floor. Original packet edges,
 * categorical boundaries and explicitly protected vertices remain unchanged.
 *
 * The height bound concerns the scalar elevation field, not sphere chord sag:
 * the separate angular edge bound controls that geometric approximation (about
 * 61 m maximum midpoint sag for a 0.5-degree edge on an Earth-sized sphere).
 * Shorelines, partial water coverage and physical river corridors should be
 * protected by the caller. No geological detail or camera-dependent LOD is added.
 */
export function simplifyCategoricalPacket(
  packet: PhysicalMeshPacket,
  options: CategoricalSimplificationOptions = {},
): PhysicalMeshPacket {
  return simplifyRegionPacket(packet, {
    triangleRegions: options.triangleRegions,
    protectedVertices: options.protectedVertices,
    maxEdgeAngle: options.maxEdgeAngle ?? CATEGORICAL_MAX_EDGE_ANGLE,
    maxHeightRange: options.maxHeightRange ?? CATEGORICAL_MAX_HEIGHT_RANGE,
  });
}
