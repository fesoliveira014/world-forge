import type { Vec3 } from '../math';
import type { PageValues } from './spatial-index';
import type { OverlayLines, ViewBounds } from './types';
import { clipOverlaySegment } from './overlays';

// These bounds limit both cold reads and temporary topology. They are independent
// of world size. Overflow asks for a closer view instead of severing a coastline.
export const MAX_COAST_EDGES = 262144;
export const MAX_COAST_INDEX_VALUES = 16777216;
const CACHE_IDS = 262144;
const READ_VALUES = 8192;
const cache = new WeakMap<PageValues, Map<number, Uint32Array>>();

interface Path {
  points: Vec3[];
  heights: number[];
  length: number;
  closed: boolean;
}
interface Segment {
  path: number;
  first: number;
  last: number;
  split: number;
  error: number;
}

const emptyLines = (): OverlayLines => ({
  positions: new Float32Array(),
  heights: new Float32Array(),
  widths: new Float32Array(),
  discharge: new Float32Array(),
});
const same = (a: Vec3, b: Vec3) => a.every((value, axis) => Math.abs(value - b[axis]) < 1e-10);

function binsFor(bounds: ViewBounds) {
  const clamp = (value: number, maximum: number) => Math.max(0, Math.min(maximum, value));
  const firstRow = clamp(Math.floor(((bounds.south + Math.PI / 2) * 16) / Math.PI), 15);
  const lastRow = clamp(Math.floor(((bounds.north + Math.PI / 2) * 16) / Math.PI), 15);
  const intervals =
    bounds.west <= bounds.east
      ? [[bounds.west, bounds.east]]
      : [
          [bounds.west, Math.PI],
          [-Math.PI, bounds.east],
        ];
  const bins = new Set<number>();
  for (const [west, east] of intervals) {
    const firstColumn = clamp(Math.floor(((west + Math.PI) * 16) / Math.PI), 31);
    const lastColumn = clamp(Math.floor(((east + Math.PI) * 16) / Math.PI), 31);
    for (let row = firstRow; row <= lastRow; row++) {
      for (let column = firstColumn; column <= lastColumn; column++) {
        bins.add(row * 32 + column);
      }
    }
  }
  return [...bins].sort((a, b) => a - b);
}

async function coastIds(pages: PageValues, bounds: ViewBounds) {
  const bins = binsFor(bounds);
  const offsets = await pages.readValues(
    'sidecars.view.overlay.offsets',
    bins.flatMap((bin) => [bin, bin + 1]),
  );
  let saved = cache.get(pages);
  if (!saved) {
    saved = new Map();
    cache.set(pages, saved);
  }
  const ids = new Set<number>();
  let read = 0;
  for (let slot = 0; slot < bins.length; slot++) {
    const bin = bins[slot];
    let edges = saved.get(bin);
    if (edges) {
      saved.delete(bin);
      saved.set(bin, edges);
    } else {
      const found: number[] = [];
      const end = offsets[slot * 2 + 1];
      for (let start = offsets[slot * 2]; start < end; start += READ_VALUES) {
        const count = Math.min(READ_VALUES, end - start);
        if (read + count > MAX_COAST_INDEX_VALUES) {
          return null;
        }
        read += count;
        const refs = await pages.readRange('sidecars.view.overlay.refs', start, count);
        for (let pair = 0; pair < refs.length; pair += 2) {
          if (refs[pair] === 1) {
            if (found.length >= MAX_COAST_EDGES) {
              return null;
            }
            found.push(refs[pair + 1]);
          }
        }
      }
      edges = Uint32Array.from(found);
      saved.set(bin, edges);
      let retained = 0;
      for (const values of saved.values()) {
        retained += values.length;
      }
      while (retained > CACHE_IDS || saved.size > 512) {
        const oldest = saved.keys().next().value!;
        retained -= saved.get(oldest)!.length;
        saved.delete(oldest);
      }
    }
    for (const edge of edges) {
      ids.add(edge);
      if (ids.size > MAX_COAST_EDGES) {
        return null;
      }
    }
  }
  return Uint32Array.from(ids).sort();
}

/** Join authoritative shared corner IDs before simplifying. Indexed kind1 is the
 * saved ocean/land boundary, so no full ocean field or new sidecar is needed. */
async function pathsFor(
  pages: PageValues,
  edges: Uint32Array,
  bounds: ViewBounds,
): Promise<Path[]> {
  const corners = new Uint32Array(edges.length * 2);
  for (let start = 0; start < edges.length; start += 2048) {
    corners.set(
      await pages.readValues(
        'world.grid.edgeCorners',
        Array.from(edges.subarray(start, start + 2048)).flatMap((edge) => [edge * 2, edge * 2 + 1]),
      ),
      start * 2,
    );
  }
  const unique = corners.slice().sort();
  let count = 0;
  for (let i = 0; i < unique.length; i++) {
    if (i === 0 || unique[i] !== unique[i - 1]) {
      unique[count++] = unique[i];
    }
  }
  const positions = new Float64Array(count * 3);
  const heights = new Float32Array(count);
  for (let start = 0; start < count; start += 2048) {
    const ids = Array.from(unique.subarray(start, Math.min(count, start + 2048)));
    const [points, levels] = await Promise.all([
      pages.readValues(
        'world.grid.corners',
        ids.flatMap((corner) => [corner * 3, corner * 3 + 1, corner * 3 + 2]),
      ),
      pages.readValues('world.drainage.height', ids),
    ]);
    positions.set(points, start * 3);
    heights.set(levels, start);
  }
  const indexOf = (corner: number) => {
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (unique[middle] < corner) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  };
  const incident = new Int32Array(count * 2).fill(-1);
  for (let endpoint = 0; endpoint < corners.length; endpoint++) {
    const row = indexOf(corners[endpoint]);
    corners[endpoint] = row;
    const slot = row * 2 + (incident[row * 2] < 0 ? 0 : 1);
    if (incident[slot] >= 0) {
      throw new Error('Saved coastline has branching corner topology.');
    }
    incident[slot] = endpoint >>> 1;
  }
  const point = (row: number) => Array.from(positions.subarray(row * 3, row * 3 + 3)) as Vec3;
  const paths: Path[] = [];
  const visited = new Uint8Array(edges.length);
  const trace = (firstEdge: number, firstCorner: number) => {
    const firstPath = paths.length;
    let edge = firstEdge;
    let corner = firstCorner;
    let previous: Path | undefined;
    while (edge >= 0 && !visited[edge]) {
      visited[edge] = 1;
      const next = corners[edge * 2] === corner ? corners[edge * 2 + 1] : corners[edge * 2];
      const parts = clipOverlaySegment(point(corner), point(next), bounds).sort(
        (a, b) => a.start - b.start,
      );
      if (!parts.length) {
        previous = undefined;
      }
      for (const part of parts) {
        const difference = heights[next] - heights[corner];
        const firstHeight = heights[corner] + difference * part.start;
        const lastHeight = heights[corner] + difference * part.end;
        if (!previous || !same(previous.points.at(-1)!, part.first)) {
          previous = { points: [part.first], heights: [firstHeight], length: 0, closed: false };
          paths.push(previous);
        }
        previous.points.push(part.second);
        previous.heights.push(lastHeight);
        previous.length += Math.hypot(
          ...part.second.map((value, axis) => value - part.first[axis]),
        );
      }
      corner = next;
      edge = incident[corner * 2] === edge ? incident[corner * 2 + 1] : incident[corner * 2];
    }
    // A cyclic trace can start in the middle of a visible arc. Join the two
    // clipped ends before assigning budgets so that arc remains one whole path.
    if (corner === firstCorner && paths.length > firstPath + 1) {
      const first = paths[firstPath];
      const last = paths.at(-1)!;
      if (same(last.points.at(-1)!, first.points[0])) {
        first.points = [...last.points, ...first.points.slice(1)];
        first.heights = [...last.heights, ...first.heights.slice(1)];
        first.length += last.length;
        paths.pop();
      }
    }
  };
  // Open components at index-bin/viewport boundaries must be traced from an end.
  for (let corner = 0; corner < count; corner++) {
    if (incident[corner * 2 + 1] < 0) {
      trace(incident[corner * 2], corner);
    }
  }
  for (let edge = 0; edge < edges.length; edge++) {
    if (!visited[edge]) {
      trace(edge, corners[edge * 2]);
    }
  }
  for (const path of paths) {
    path.closed = path.points.length > 3 && same(path.points[0], path.points.at(-1)!);
  }
  return paths;
}

class ErrorHeap {
  private items: Segment[] = [];
  push(value: Segment) {
    if (value.split < 0) {
      return;
    }
    let index = this.items.length;
    this.items.push(value);
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (this.items[parent].error >= value.error) {
        break;
      }
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = value;
  }
  pop() {
    const result = this.items[0];
    const last = this.items.pop();
    if (this.items.length && last) {
      let index = 0;
      while (index * 2 + 1 < this.items.length) {
        let child = index * 2 + 1;
        if (
          child + 1 < this.items.length &&
          this.items[child + 1].error > this.items[child].error
        ) {
          child++;
        }
        if (this.items[child].error <= last.error) {
          break;
        }
        this.items[index] = this.items[child];
        index = child;
      }
      this.items[index] = last;
    }
    return result;
  }
}

/** Complete paths receive their minimum first; remaining segments resolve the
 * largest bends globally. A small budget reduces detail, never every nth edge. */
function simplify(paths: Path[], limit: number) {
  paths.sort((a, b) => b.length - a.length);
  const chosen: { path: Path; vertices: Set<number> }[] = [];
  const heap = new ErrorHeap();
  let remaining = limit;
  const segment = (path: number, first: number, last: number): Segment => {
    const points = chosen[path].path.points;
    const a = points[first];
    const b = points[last];
    const direction = b.map((value, axis) => value - a[axis]);
    const length = direction.reduce((sum, value) => sum + value * value, 0);
    let error = -1;
    let split = -1;
    for (let point = first + 1; point < last; point++) {
      const value = points[point];
      const fraction =
        length > 0
          ? Math.max(
              0,
              Math.min(
                1,
                value.reduce(
                  (sum, coordinate, axis) => sum + (coordinate - a[axis]) * direction[axis],
                  0,
                ) / length,
              ),
            )
          : 0;
      const distance = value.reduce(
        (sum, coordinate, axis) => sum + (coordinate - a[axis] - fraction * direction[axis]) ** 2,
        0,
      );
      if (distance > error) {
        error = distance;
        split = point;
      }
    }
    return { path, first, last, split, error };
  };
  const divide = (node: Segment) => {
    chosen[node.path].vertices.add(node.split);
    return [segment(node.path, node.first, node.split), segment(node.path, node.split, node.last)];
  };
  for (const path of paths) {
    const minimum = path.closed ? 3 : 1;
    if (remaining < minimum) {
      continue;
    }
    const id = chosen.length;
    chosen.push({ path, vertices: new Set([0, path.points.length - 1]) });
    let pieces = [segment(id, 0, path.points.length - 1)];
    for (let part = 1; part < minimum; part++) {
      pieces.sort((a, b) => b.error - a.error);
      pieces = [...divide(pieces[0]), ...pieces.slice(1)];
    }
    pieces.forEach((piece) => heap.push(piece));
    remaining -= minimum;
  }
  while (remaining > 0) {
    const node = heap.pop();
    if (!node) {
      break;
    }
    divide(node).forEach((piece) => heap.push(piece));
    remaining--;
  }
  const positions: number[] = [];
  const heights: number[] = [];
  for (const { path, vertices } of chosen) {
    const indices = [...vertices].sort((a, b) => a - b);
    for (let index = 1; index < indices.length; index++) {
      const first = indices[index - 1];
      const last = indices[index];
      positions.push(...path.points[first], ...path.points[last]);
      heights.push(path.heights[first], path.heights[last]);
    }
  }
  const count = positions.length / 6;
  return {
    lines: {
      positions: Float32Array.from(positions),
      heights: Float32Array.from(heights),
      widths: new Float32Array(count).fill(1),
      discharge: new Float32Array(count),
    },
    truncated: count < paths.reduce((sum, path) => sum + path.points.length - 1, 0),
  };
}

export async function readCoastOverlays(
  pages: PageValues,
  bounds: ViewBounds,
  limit: number,
): Promise<{ lines: OverlayLines; truncated: boolean; status: 'visible' | 'zoom-in' }> {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 8192) {
    throw new Error('Invalid coastline segment budget.');
  }
  if (!limit) {
    return { lines: emptyLines(), truncated: true, status: 'zoom-in' };
  }
  const ids = await coastIds(pages, bounds);
  if (!ids) {
    return { lines: emptyLines(), truncated: true, status: 'zoom-in' };
  }
  const paths = await pathsFor(pages, ids, bounds);
  const simplified = simplify(paths, limit);
  return {
    ...simplified,
    status: paths.length && !simplified.lines.widths.length ? 'zoom-in' : 'visible',
  };
}
