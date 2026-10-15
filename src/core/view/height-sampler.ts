import type { PageValues, PagedSpatialIndex } from './spatial-index';
import { PagedSurfaceStencils } from './surface-stencils';
import { PagedRenderRecords } from './records';

/** Bounded display-height queries on the existing atlas-view/v2 primal mesh.
 * Overlay draping uses exactly the geometry fields/rounding used by surface tiles;
 * routing-corner heights describe hydrology and need not lie on that mesh. */
export class PagedHeightSampler {
  private readonly stencils: PagedSurfaceStencils;
  private readonly records: PagedRenderRecords;
  constructor(
    pages: PageValues,
    private readonly index: PagedSpatialIndex,
    cellCount: number,
    shared?: { stencils: PagedSurfaceStencils; records: PagedRenderRecords },
  ) {
    this.stencils = shared?.stencils ?? new PagedSurfaceStencils(pages, cellCount);
    this.records = shared?.records ?? new PagedRenderRecords(pages);
  }
  async sample(directions: Float32Array): Promise<Float32Array> {
    const count = directions.length / 3;
    if (!Number.isSafeInteger(count) || count > 20000) {
      throw Error('A height request supports at most 20,000 unit directions.');
    }
    const seen = new Map<string, number>();
    const samples = new Uint32Array(count);
    const rows: number[] = [];
    const weights: number[] = [];
    // Segment packets repeat endpoints. Reuse their exact Float32 locations while
    // preserving separate output ownership for transfer into the renderer.
    for (let point = 0; point < count; point++) {
      const x = directions[point * 3];
      const y = directions[point * 3 + 1];
      const z = directions[point * 3 + 2];
      const key = `${x},${y},${z}`;
      let sample = seen.get(key);
      if (sample === undefined) {
        sample = seen.size;
        seen.set(key, sample);
        const nearest = await this.index.locate([x, y, z]);
        const stencil = await this.stencils.locate([x, y, z], nearest.row);
        rows.push(...stencil.rows);
        weights.push(...stencil.weights);
      }
      samples[point] = sample;
    }
    const heights = await this.records.read(rows, true);
    const unique = new Float32Array(seen.size);
    for (let sample = 0; sample < unique.length; sample++) {
      unique[sample] =
        heights[sample * 3] * weights[sample * 3] +
        heights[sample * 3 + 1] * weights[sample * 3 + 1] +
        heights[sample * 3 + 2] * weights[sample * 3 + 2];
    }
    return Float32Array.from(samples, (sample) => unique[sample]);
  }
  get cacheStats() {
    return { ...this.stencils.cacheStats, renderBlocks: this.records.cachedBlocks };
  }
}
