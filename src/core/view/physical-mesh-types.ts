import type { Layer } from '../model';

export const PHYSICAL_FACES_PER_BATCH = 4096;
/** Fixed terrain uses the shared riverbank atlas, so the legacy dense field 5
 * (approximate bank tint) is not part of its vertex payload. */
export const PHYSICAL_MATERIAL_FIELD_COUNT = 5;
export const CATEGORICAL_PHYSICAL_LAYERS: readonly Layer[] = [
  'tectonics',
  'biomes',
  'drainage',
  'wetlands',
  'sources',
];
export const physicalMeshMode = (layer: Layer): 'primal' | 'dual' =>
  CATEGORICAL_PHYSICAL_LAYERS.includes(layer) ? 'dual' : 'primal';

export interface PhysicalMeshManifest {
  format: 'atlas-physical-mesh/v1';
  layer: Layer;
  season: number;
  mode: 'primal' | 'dual';
  batches: number;
  /** Source triangle count; an upper bound when simplified is true. */
  triangles: number;
  /** Fixed region simplification, prepared without camera-dependent detail. */
  simplified?: boolean;
  physicalVertices: number;
  elevationRange: [number, number];
  /** Buffer-only estimate before batch-border vertex duplication, one CPU copy. */
  estimatedBytes: number;
}

export interface PhysicalMeshPacket {
  batch: number;
  mode: 'primal' | 'dual';
  directions: Float32Array;
  heights: Float32Array;
  /** Signed normalized octahedral xy of the unexaggerated physical slope normal,
   * corrected for the base triangulated sphere's radial approximation bias. */
  normals: Int16Array;
  /** Linear RGB plus alpha, normalized bytes. Empty on the natural world layer.
   * Dual geometry MUST use flat shading: the last index supplies its whole
   * triangle's color. Full cell fans use the owning cell center; simplified
   * regions retain the same category color at every triangle vertex. */
  colors: Uint8Array;
  /** Five normalized RGBA8 attributes, matching DenseSurface fields 0–4. */
  materials: Uint8Array[];
  indices: Uint16Array;
  /** Exact retained array bytes for this packet; GPU copies are additional. */
  bytes: number;
}
