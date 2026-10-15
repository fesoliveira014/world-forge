import type { Vec3 } from '../math';

export interface PageValues {
  readValues(path: string, indices: readonly number[]): Promise<Float64Array>;
  readRange(path: string, start: number, count: number): Promise<Float64Array>;
  readValue(path: string): Promise<unknown>;
}
export interface SpatialIndex {
  count: number;
  /** Node rows: xmin,ymin,zmin,xmax,ymax,zmax,start,end,left,right. */
  nodes: Float64Array;
  positions: Float64Array;
  cells: Uint32Array;
}

/** Median-partitioned index saved once, with contiguous leaves for bounded I/O. */
export function buildSpatialIndex(positions: Float64Array): SpatialIndex {
  const count = positions.length / 3;
  const cells = Uint32Array.from({ length: count }, (_, index) => index);
  const rows: number[] = [];
  const coordinate = (id: number, axis: number) => positions[id * 3 + axis];
  function build(start: number, end: number): number {
    const node = rows.length / 10;
    const low = [Infinity, Infinity, Infinity];
    const high = [-Infinity, -Infinity, -Infinity];
    for (let offset = start; offset < end; offset++) {
      for (let axis = 0; axis < 3; axis++) {
        const value = coordinate(cells[offset], axis);
        low[axis] = Math.min(low[axis], value);
        high[axis] = Math.max(high[axis], value);
      }
    }
    rows.push(...low, ...high, start, end, -1, -1);
    if (end - start > 128) {
      let axis = 0;
      for (let candidate = 1; candidate < 3; candidate++) {
        if (high[candidate] - low[candidate] > high[axis] - low[axis]) {
          axis = candidate;
        }
      }
      const middle = (start + end) >>> 1;
      const compare = (a: number, b: number) => coordinate(a, axis) - coordinate(b, axis) || a - b;
      // Deterministic in-place quickselect avoids re-sorting every tree level.
      let lower = start;
      let upper = end - 1;
      while (lower < upper) {
        const pivot = cells[(lower + upper) >>> 1];
        let left = lower;
        let right = upper;
        while (left <= right) {
          while (compare(cells[left], pivot) < 0) {
            left++;
          }
          while (compare(cells[right], pivot) > 0) {
            right--;
          }
          if (left <= right) {
            const swap = cells[left];
            cells[left++] = cells[right];
            cells[right--] = swap;
          }
        }
        if (middle <= right) {
          upper = right;
        } else if (middle >= left) {
          lower = left;
        } else {
          break;
        }
      }
      rows[node * 10 + 8] = build(start, middle);
      rows[node * 10 + 9] = build(middle, end);
    }
    return node;
  }
  if (count) {
    build(0, count);
  }
  const packed = new Float64Array(positions.length);
  for (let index = 0; index < count; index++) {
    for (let axis = 0; axis < 3; axis++) {
      packed[index * 3 + axis] = positions[cells[index] * 3 + axis];
    }
  }
  return { count, nodes: Float64Array.from(rows), positions: packed, cells };
}

/** Exact nearest center with bounded node/leaf caches; no cold full-grid load. */
export class PagedSpatialIndex {
  private nodes = new Map<number, Promise<Float64Array>>();
  private leaves = new Map<number, Promise<{ positions: Float64Array; cells: Float64Array }>>();
  constructor(
    private pages: PageValues,
    private prefix = 'sidecars.view.index',
  ) {}
  private node(id: number) {
    let result = this.nodes.get(id);
    if (!result) {
      result = this.pages.readRange(`${this.prefix}.nodes`, id * 10, 10);
      this.nodes.set(id, result);
    } else {
      this.nodes.delete(id);
      this.nodes.set(id, result);
    }
    if (this.nodes.size > 4096) {
      this.nodes.delete(this.nodes.keys().next().value!);
    }
    return result;
  }
  private leaf(id: number, row: Float64Array) {
    let result = this.leaves.get(id);
    if (!result) {
      result = Promise.all([
        this.pages.readRange(`${this.prefix}.positions`, row[6] * 3, (row[7] - row[6]) * 3),
        this.pages.readRange(`${this.prefix}.cells`, row[6], row[7] - row[6]),
      ]).then(([positions, cells]) => ({ positions, cells }));
      this.leaves.set(id, result);
    } else {
      this.leaves.delete(id);
      this.leaves.set(id, result);
    }
    if (this.leaves.size > 128) {
      this.leaves.delete(this.leaves.keys().next().value!);
    }
    return result;
  }
  async locate(direction: Vec3): Promise<{ cell: number; row: number }> {
    const norm = Math.hypot(...direction);
    if (!(norm > 0) || !Number.isFinite(norm)) {
      throw Error('A finite nonzero direction is required.');
    }
    const point = direction.map((value) => value / norm);
    const distance = (row: Float64Array) =>
      point.reduce(
        (sum, value, axis) => sum + Math.max(0, row[axis] - value, value - row[axis + 3]) ** 2,
        0,
      );
    let bestDistance = Infinity;
    let best = -1;
    let bestRow = -1;
    const pending: { id: number; row: Float64Array; distance: number }[] = [
      { id: 0, row: await this.node(0), distance: 0 },
    ];
    while (pending.length) {
      const item = pending.pop()!;
      if (item.distance > bestDistance + 1e-15) {
        continue;
      }
      const row = item.row;
      if (row[8] < 0) {
        const leaf = await this.leaf(item.id, row);
        for (let offset = 0; offset < leaf.cells.length; offset++) {
          let squared = 0;
          for (let axis = 0; axis < 3; axis++) {
            squared += (point[axis] - leaf.positions[offset * 3 + axis]) ** 2;
          }
          if (squared < bestDistance || (squared === bestDistance && leaf.cells[offset] < best)) {
            bestDistance = squared;
            best = leaf.cells[offset];
            bestRow = row[6] + offset;
          }
        }
      } else {
        const children = await Promise.all(
          [row[8], row[9]].map(async (id) => {
            const child = await this.node(id);
            return { id, row: child, distance: distance(child) };
          }),
        );
        children.sort((first, second) => second.distance - first.distance);
        pending.push(...children);
      }
    }
    if (best < 0) {
      throw Error('Saved spatial index is empty.');
    }
    return { cell: best, row: bestRow };
  }
  async nearest(direction: Vec3) {
    return (await this.locate(direction)).cell;
  }
  get cachedNodes() {
    return this.nodes.size;
  }
  get cachedLeaves() {
    return this.leaves.size;
  }
}
