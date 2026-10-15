import type { PhysicalMeshPacket } from './physical-mesh-types';
import { simplifyRegionPacket } from './region-simplification';

export const TECTONIC_MAX_EDGE_ANGLE = Math.PI / 180;

export interface TectonicSimplificationOptions {
  /** Semantic plate IDs, including distinct plates that share a palette color.
   * Without these, only visible color boundaries can be distinguished. */
  triangleRegions?: Int32Array | Uint32Array;
  /** Fixed angular limit on newly created edges; independent of the camera. */
  maxEdgeAngle?: number;
}

/** Collapse only interior edges of equal-plate regions. Original packet edges
 * and plate boundaries remain exact, so independently simplified packets meet
 * without stitching, cracks, or camera-dependent topology. Heights are omitted
 * from this diagnostic layer; every surviving vertex keeps its saved direction. */
export function simplifyTectonicPacket(
  packet: PhysicalMeshPacket,
  options: TectonicSimplificationOptions = {},
): PhysicalMeshPacket {
  return simplifyRegionPacket(packet, {
    triangleRegions: options.triangleRegions,
    maxEdgeAngle: options.maxEdgeAngle ?? TECTONIC_MAX_EDGE_ANGLE,
  });
}
