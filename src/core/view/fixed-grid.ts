import type { PageValues } from './spatial-index';
import type { WorldSummary } from './types';
import {
  FIXED_GRID_EDGES_PER_BATCH,
  FIXED_GRID_TEXTURE_WIDTH,
  type FixedGridManifest,
  type FixedGridPacket,
} from './fixed-grid-types';

/** A complete physical cell grid read in stable bounded packets. No camera,
 * spatial search, full-world restoration or resolution-dependent lookup table
 * is involved. All output buffers are fresh; only the snapshot page cache stays
 * resident between requests and may be released when the viewer owns the grid.
 */
export class FixedGridReader {
  constructor(
    private readonly pages: PageValues,
    private readonly summary: Pick<WorldSummary, 'surfaceCells'>,
  ) {}

  async manifest(): Promise<FixedGridManifest> {
    const cells = this.summary.surfaceCells;
    const edges = cells * 3 - 6;
    if (!Number.isSafeInteger(cells) || cells < 4 || !Number.isSafeInteger(edges)) {
      throw Error('Invalid saved physical grid size.');
    }
    const vertices = cells * 2 - 4;
    return {
      format: 'atlas-fixed-grid/v1',
      batches: Math.ceil(edges / FIXED_GRID_EDGES_PER_BATCH),
      edges,
      vertices,
      estimatedBytes: vertices * 17 + edges * 4,
    };
  }

  async batch(batch: number): Promise<FixedGridPacket> {
    const manifest = await this.manifest();
    if (!Number.isSafeInteger(batch) || batch < 0 || batch >= manifest.batches) {
      throw Error('Physical grid batch is outside the saved surface.');
    }
    const firstEdge = batch * FIXED_GRID_EDGES_PER_BATCH;
    const edges = await this.pages.readRange(
      'world.grid.edgeCorners',
      firstEdge * 2,
      Math.min(FIXED_GRID_EDGES_PER_BATCH, manifest.edges - firstEdge) * 2,
    );
    for (const corner of edges) {
      if (!Number.isSafeInteger(corner) || corner < 0 || corner >= manifest.vertices) {
        throw Error('Invalid saved physical grid corner.');
      }
    }
    // Sorting the bounded local set groups page reads even after adaptive edge
    // flips have changed raw corner order. It never changes edge orientation.
    const corners = [...new Set(edges)].sort((a, b) => a - b);
    const local = new Map(corners.map((corner, index) => [corner, index]));
    const positions = await this.pages.readValues(
      'world.grid.corners',
      corners.flatMap((corner) => [corner * 3, corner * 3 + 1, corner * 3 + 2]),
    );
    const heights = Float32Array.from(
      await this.pages.readValues('world.drainage.height', corners),
    );
    const lakeIds = await this.pages.readValues('world.drainage.lakeId', corners);
    const fractions = await this.pages.readValues('world.drainage.lakeFraction', corners);
    const textureWidth = Math.min(FIXED_GRID_TEXTURE_WIDTH, corners.length);
    const paddedCount = Math.ceil(corners.length / textureWidth) * textureWidth;
    const landCoverage = new Uint8Array(paddedCount);
    for (let vertex = 0; vertex < corners.length; vertex++) {
      landCoverage[vertex] =
        heights[vertex] > 0
          ? Math.round(255 * (1 - Math.min(1, Math.max(0, fractions[vertex]))))
          : 0;
    }
    const levels = new Map<number, number>();
    for (let vertex = 0; vertex < corners.length; vertex++) {
      const lake = lakeIds[vertex];
      if (lake >= 0 && fractions[vertex] > 0) {
        if (!levels.has(lake)) {
          const level = await this.pages.readValue(`world.drainage.lakes.${lake}.level`);
          if (typeof level !== 'number' || !Number.isFinite(level)) {
            throw Error('Invalid saved lake water level.');
          }
          levels.set(lake, level);
        }
        heights[vertex] = Math.max(heights[vertex], levels.get(lake)!);
      }
      const offset = vertex * 3;
      if (
        !Number.isFinite(heights[vertex]) ||
        !Number.isFinite(positions[offset] + positions[offset + 1] + positions[offset + 2]) ||
        Math.hypot(positions[offset], positions[offset + 1], positions[offset + 2]) === 0
      ) {
        throw Error('Invalid saved physical grid vertex.');
      }
    }
    const vertices = new Float32Array(paddedCount * 4);
    for (let vertex = 0; vertex < corners.length; vertex++) {
      vertices.set(positions.subarray(vertex * 3, vertex * 3 + 3), vertex * 4);
      vertices[vertex * 4 + 3] = heights[vertex];
    }
    const edgeCount = edges.length / 2;
    const edgeWidth = Math.min(FIXED_GRID_TEXTURE_WIDTH, edgeCount);
    const indices = new Uint16Array(Math.ceil(edgeCount / edgeWidth) * edgeWidth * 2);
    for (let i = 0; i < edges.length; i++) {
      indices[i] = local.get(edges[i])!;
    }
    return {
      batch,
      firstEdge,
      vertexCount: corners.length,
      vertices,
      landCoverage,
      edgeCount,
      indices,
      bytes: vertices.byteLength + landCoverage.byteLength + indices.byteLength,
    };
  }
}
