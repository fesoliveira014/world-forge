import type { Grid } from '../model';
import type { Vec3 } from '../math';
import type { PageValues } from './spatial-index';

export const STENCIL_CELLS_PER_BLOCK = 2048;
export const STENCIL_FACES_PER_BLOCK = 8192;
export interface SurfaceStencils {
  /** Each row stores three spatial vertex rows, then three adjacent face rows. */
  faces: Uint32Array[];
  starts: Uint32Array[];
}

/** Spatially reorder only topology; exact positions already live in the view index.
 * This adds about 52 bytes/cell, avoiding a duplicated position/height fan per cell. */
export function packSurfaceStencils(grid: Grid, spatialCells: Uint32Array): SurfaceStencils {
  const spatialRows = new Uint32Array(grid.count);
  spatialCells.forEach((cell, row) => {
    spatialRows[cell] = row;
  });
  const faceCount = grid.triangles.length / 3;
  const counts = new Uint32Array(grid.count + 1);
  const owner = (face: number) =>
    Math.min(
      spatialRows[grid.triangles[face * 3]],
      spatialRows[grid.triangles[face * 3 + 1]],
      spatialRows[grid.triangles[face * 3 + 2]],
    );
  for (let face = 0; face < faceCount; face++) {
    counts[owner(face) + 1]++;
  }
  for (let cell = 1; cell < counts.length; cell++) {
    counts[cell] += counts[cell - 1];
  }
  const cursor = counts.slice(0, -1);
  const rows = new Uint32Array(faceCount);
  for (let face = 0; face < faceCount; face++) {
    rows[face] = cursor[owner(face)]++;
  }
  const faces = Array.from(
    { length: Math.ceil(faceCount / STENCIL_FACES_PER_BLOCK) },
    (_, block) =>
      new Uint32Array(
        Math.min(STENCIL_FACES_PER_BLOCK, faceCount - block * STENCIL_FACES_PER_BLOCK) * 6,
      ),
  );
  for (let face = 0; face < faceCount; face++) {
    const row = rows[face];
    const block = faces[Math.floor(row / STENCIL_FACES_PER_BLOCK)];
    const offset = (row % STENCIL_FACES_PER_BLOCK) * 6;
    for (let vertex = 0; vertex < 3; vertex++) {
      block[offset + vertex] = spatialRows[grid.triangles[face * 3 + vertex]];
      block[offset + 3 + vertex] = rows[grid.cornerNeighbors[face * 3 + vertex]];
    }
  }
  const starts = Array.from(
    { length: Math.ceil(grid.count / STENCIL_CELLS_PER_BLOCK) },
    (_, block) =>
      new Uint32Array(
        Math.min(STENCIL_CELLS_PER_BLOCK, grid.count - block * STENCIL_CELLS_PER_BLOCK),
      ),
  );
  spatialCells.forEach((cell, row) => {
    starts[Math.floor(row / STENCIL_CELLS_PER_BLOCK)][row % STENCIL_CELLS_PER_BLOCK] =
      rows[grid.cellCorners[grid.offsets[cell]]];
  });
  return { faces, starts };
}

export interface SurfaceStencil {
  rows: Uint32Array;
  weights: Float64Array;
}
/** Exact radial barycentrics on the original primal mesh. Cache ownership is
 * independent of world resolution:16 face blocks,16 starts and32 position blocks. */
export class PagedSurfaceStencils {
  private faces = new Map<number, Promise<Uint32Array>>();
  private starts = new Map<number, Promise<Uint32Array>>();
  private positions = new Map<number, Promise<Float64Array>>();
  constructor(
    private pages: PageValues,
    private cellCount: number,
  ) {}
  private uintBlock(kind: 'faces' | 'starts', block: number) {
    const cache = this[kind];
    let value = cache.get(block);
    if (!value) {
      value = this.pages.readValue(`sidecars.view.stencils.${kind}.${block}`).then((value) => {
        if (!(value instanceof Uint32Array)) {
          throw Error('Invalid saved surface stencil block.');
        }
        return value;
      });
    } else {
      cache.delete(block);
    }
    cache.set(block, value);
    if (cache.size > 16) {
      cache.delete(cache.keys().next().value!);
    }
    return value;
  }
  private positionBlock(row: number) {
    const block = Math.floor(row / STENCIL_CELLS_PER_BLOCK);
    let value = this.positions.get(block);
    if (!value) {
      value = this.pages.readRange(
        'sidecars.view.index.positions',
        block * STENCIL_CELLS_PER_BLOCK * 3,
        Math.min(STENCIL_CELLS_PER_BLOCK, this.cellCount - block * STENCIL_CELLS_PER_BLOCK) * 3,
      );
    } else {
      this.positions.delete(block);
    }
    this.positions.set(block, value);
    if (this.positions.size > 32) {
      this.positions.delete(this.positions.keys().next().value!);
    }
    return value;
  }
  async locate(direction: Vec3, nearestRow: number): Promise<SurfaceStencil> {
    const length = Math.hypot(...direction);
    const [x, y, z] = direction.map((value) => value / length);
    const starts = await this.uintBlock('starts', Math.floor(nearestRow / STENCIL_CELLS_PER_BLOCK));
    let face = starts[nearestRow % STENCIL_CELLS_PER_BLOCK];
    const rows = new Uint32Array(3);
    const weights = new Float64Array(3);
    const positions = new Float64Array(9);
    for (let visited = 0; visited < this.cellCount * 2 - 4; visited++) {
      const block = await this.uintBlock('faces', Math.floor(face / STENCIL_FACES_PER_BLOCK));
      const offset = (face % STENCIL_FACES_PER_BLOCK) * 6;
      for (let vertex = 0; vertex < 3; vertex++) {
        rows[vertex] = block[offset + vertex];
        const values = await this.positionBlock(rows[vertex]);
        const start = (rows[vertex] % STENCIL_CELLS_PER_BLOCK) * 3;
        positions.set(values.subarray(start, start + 3), vertex * 3);
      }
      for (let vertex = 0; vertex < 3; vertex++) {
        const a = ((vertex + 1) % 3) * 3;
        const b = ((vertex + 2) % 3) * 3;
        const ax = positions[a] - x;
        const ay = positions[a + 1] - y;
        const az = positions[a + 2] - z;
        const bx = positions[b] - x;
        const by = positions[b + 1] - y;
        const bz = positions[b + 2] - z;
        weights[vertex] =
          x * (ay * bz - az * by) + y * (az * bx - ax * bz) + z * (ax * by - ay * bx);
      }
      let smallest = 0;
      for (let vertex = 1; vertex < 3; vertex++) {
        if (weights[vertex] < weights[smallest]) {
          smallest = vertex;
        }
      }
      const sum = weights[0] + weights[1] + weights[2];
      if (sum > 0 && weights[smallest] >= -1e-12 * sum) {
        const positive =
          Math.max(0, weights[0]) + Math.max(0, weights[1]) + Math.max(0, weights[2]);
        for (let vertex = 0; vertex < 3; vertex++) {
          weights[vertex] = Math.max(0, weights[vertex]) / positive;
        }
        return { rows, weights };
      }
      face = block[offset + 3 + ((smallest + 1) % 3)];
    }
    throw Error('Saved surface sampling could not locate a containing triangle.');
  }
  get cacheStats() {
    return {
      faceBlocks: this.faces.size,
      startBlocks: this.starts.size,
      positionBlocks: this.positions.size,
    };
  }
}
