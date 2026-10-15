/** Immutable display data derived from the saved river graph, never simulation state. */
export interface FixedRiverRequest {
  season: number;
  threshold: number;
  batch: number;
}

export interface FixedRiverBatch {
  batch: number;
  totalBatches: number;
  /** Total CPU buffer payload across the current prepared variant. */
  totalBytes: number;
  totalPaths: number;
  totalPoints: number;
  /** Stable point ranges for complete connected paths; terminal offset included. */
  offsets: Uint32Array;
  /** Per-path incoming direction for a continued chunk; zero means a true start. */
  incoming: Float32Array;
  /** Next direction beyond a continued chunk; zero means a true endpoint. */
  outgoing?: Float32Array;
  positions: Float32Array;
  /** Metres above the common sea datum, including receiving-water surfaces. */
  heights: Float32Array;
  /** Original cartographic angular HALF width, before the display width slider. */
  halfWidths: Float32Array;
  /** Per-point display ceiling derived from the complete curve before batching.
   * Optional for older packets; physical widths and bank footprints stay unchanged.
   */
  curvatureLimits?: Float32Array;
  phase: Float32Array;
  activity: Float32Array;
  sources: Uint8Array;
  /** Per path: 0 river/delta, 1 wet oxbow, 2 dry scar, 3 frozen oxbow, 4 banks only. */
  kinds: Uint8Array;
  /** Per point, left then right angular bank radius INCLUDING channel half width. */
  bankWidths: Float32Array;
  /** Per point left/right straight RGBA habitat pigment (eight components). */
  bankColors: Float32Array;
}
