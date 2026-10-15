/** Even entirely disjoint edges fit 16,384 local vertices and Uint16 indices. */
export const FIXED_GRID_TEXTURE_WIDTH = 128;
export const FIXED_GRID_EDGES_PER_BATCH = 8192;

export interface FixedGridManifest {
  format: 'atlas-fixed-grid/v1';
  batches: number;
  edges: number;
  /** Unique physical dual corners, before copies on packet boundaries. */
  vertices: number;
  /** One CPU copy of directions, heights and indices before boundary duplication. */
  estimatedBytes: number;
}

export interface FixedGridPacket {
  batch: number;
  /** First saved edge ID. Indices follow the saved edge order and orientation. */
  firstEdge: number;
  /** Actual corner count, excluding texture-row padding. */
  vertexCount: number;
  /** Packed direction.xyz and physical height, padded to full texture rows.
   * Wet lake corners use their recorded routing water surface. */
  vertices: Float32Array;
  /** Normalized dry-land coverage, including mixed lake-shore corners. */
  landCoverage: Uint8Array;
  /** Actual edge count, excluding texture-row padding. */
  edgeCount: number;
  /** Two local corner indices per unique physical edge, padded to texture rows. */
  indices: Uint16Array;
  /** Exact retained typed-array bytes; GPU storage is additional. */
  bytes: number;
}
