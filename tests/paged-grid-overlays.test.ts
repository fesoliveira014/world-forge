import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGrid } from '../src/core/grid/build';
import { createRegionSpacing, refineGrid } from '../src/core/grid/refine';
import type { Vec3 } from '../src/core/math';
import type { Grid } from '../src/core/model';
import { clipGlobeGridSegment, clipOverlaySegment, readOverlays } from '../src/core/view/overlays';
import {
  buildSpatialIndex,
  PagedSpatialIndex,
  type PageValues,
} from '../src/core/view/spatial-index';
import type { GlobeGridFootprint, ViewBounds, WorldSummary } from '../src/core/view/types';

const fullBounds = { west: -Math.PI, east: Math.PI, south: -Math.PI / 2, north: Math.PI / 2 };
const grid = buildGrid(4, 'complete-visible-grid', 0.8);

function fixture(grid: Grid) {
  const data = {
    world: { grid, drainage: { height: new Float32Array(grid.corners.length / 3) } },
    sidecars: { view: { index: buildSpatialIndex(grid.positions) } },
  };
  let visitedCells = 0;
  const field = (path: string): ArrayLike<number> =>
    path
      .split('.')
      .reduce<unknown>(
        (value, part) => (value as Record<string, unknown>)[part],
        data,
      ) as ArrayLike<number>;
  const pages: PageValues = {
    async readValue() {
      throw new Error('Grid overlays must not restore whole fields');
    },
    async readRange(path, start, count) {
      return Float64Array.from({ length: count }, (_, index) => field(path)[start + index]);
    },
    async readValues(path, indices) {
      if (path === 'world.grid.offsets') {
        visitedCells += indices.length / 2;
      }
      return Float64Array.from(indices, (index) => field(path)[index]);
    },
  };
  return {
    pages,
    index: new PagedSpatialIndex(pages),
    summary: { surfaceCells: grid.count } as WorldSummary,
    get visitedCells() {
      return visitedCells;
    },
  };
}

function key(first: ArrayLike<number>, second: ArrayLike<number>) {
  const a = Array.from(Float32Array.from(first)).join(',');
  const b = Array.from(Float32Array.from(second)).join(',');
  return [a, b].sort().join(';');
}

function expectedEdges(bounds: ViewBounds) {
  const expected = new Set<string>();
  for (let edge = 0; edge < grid.edgeLength.length; edge++) {
    const first = grid.edgeCorners[edge * 2];
    const second = grid.edgeCorners[edge * 2 + 1];
    for (const part of clipOverlaySegment(
      Array.from(grid.corners.subarray(first * 3, first * 3 + 3)) as Vec3,
      Array.from(grid.corners.subarray(second * 3, second * 3 + 3)) as Vec3,
      bounds,
    )) {
      expected.add(key(part.first, part.second));
    }
  }
  return expected;
}

for (const [name, bounds] of [
  ['regional close view', { west: -0.18, east: 0.22, south: -0.15, north: 0.16 }],
  ['dateline close view', { west: 3, east: -3, south: -0.2, north: 0.2 }],
  ['polar close view', { west: -Math.PI, east: Math.PI, south: 1.35, north: Math.PI / 2 }],
] as const) {
  test(`physical grid includes every intersecting edge in a ${name}`, async () => {
    const source = fixture(grid);
    const packet = await readOverlays(source.pages, source.index, source.summary, {
      bounds,
      season: -1,
      gridLines: true,
      maxSegments: 8192,
    });
    assert.equal(packet.gridStatus, 'visible');
    assert.equal(packet.truncated, false);
    const actual = new Set<string>();
    for (let start = 0; start < packet.grid.positions.length; start += 6) {
      actual.add(
        key(
          packet.grid.positions.subarray(start, start + 3),
          packet.grid.positions.subarray(start + 3, start + 6),
        ),
      );
    }
    assert.deepEqual(actual, expectedEdges(bounds));
    assert.equal(actual.size, packet.grid.positions.length / 6, 'shared edges are emitted once');
    assert.ok(source.visitedCells < grid.count / 4, 'close viewing must not scan the entire grid');
  });
}

test('a resolved overview emits the complete connected grid rather than 128 isolated cells', async () => {
  const source = fixture(grid);
  const packet = await readOverlays(source.pages, source.index, source.summary, {
    bounds: fullBounds,
    season: -1,
    gridLines: true,
    maxSegments: 8192,
  });
  assert.equal(packet.gridStatus, 'visible');
  assert.equal(packet.grid.positions.length / 6, expectedEdges(fullBounds).size);
  assert.ok(packet.grid.positions.length / 6 > 7000);
  assert.equal(packet.truncated, false);
});

test('an unresolved overview returns a zoom cue and bounds its traversal instead of arbitrary fragments', async () => {
  const source = fixture(grid);
  const packet = await readOverlays(source.pages, source.index, source.summary, {
    bounds: fullBounds,
    season: -1,
    gridLines: true,
    maxSegments: 120,
  });
  assert.equal(packet.gridStatus, 'zoom-in');
  assert.equal(packet.grid.positions.length, 0);
  assert.equal(packet.truncated, true);
  assert.ok(source.visitedCells <= 304);
  const hidden = await readOverlays(source.pages, source.index, source.summary, {
    bounds: fullBounds,
    season: -1,
    gridLines: false,
  });
  assert.equal(hidden.gridStatus, undefined);
  assert.equal(hidden.grid.positions.length, 0);
});

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const direction = (longitude: number, latitude: number): Vec3 => [
  Math.cos(latitude) * Math.cos(longitude),
  Math.sin(latitude),
  Math.cos(latitude) * Math.sin(longitude),
];

/** Independent oracle: find the extrema of normalized Cartesian interpolation,
 * then bisect each monotone interval. It does not reuse the great-circle solver.
 */
function capOracle(first: Vec3, second: Vec3, cap: GlobeGridFootprint) {
  const delta = second.map((value, axis) => value - first[axis]) as Vec3;
  const a = dot(first, first);
  const b = dot(first, delta);
  const c = dot(delta, delta);
  const u = dot(first, cap.center);
  const v = dot(delta, cap.center);
  const critical = (u * b - v * a) / (v * b - u * c);
  const cuts = [0, ...(critical > 0 && critical < 1 ? [critical] : []), 1];
  const point = (t: number): Vec3 => {
    const p = first.map((value, axis) => value + delta[axis] * t) as Vec3;
    const length = Math.hypot(...p);
    return p.map((value) => value / length) as Vec3;
  };
  const inside = (t: number) => dot(point(t), cap.center) >= Math.cos(cap.radius);
  const ranges: [number, number][] = [];
  for (let index = 1; index < cuts.length; index++) {
    let lo = cuts[index - 1];
    let hi = cuts[index];
    const left = inside(lo);
    const right = inside(hi);
    if (!left && !right) {
      continue;
    }
    if (left !== right) {
      let low = lo;
      let high = hi;
      for (let step = 0; step < 55; step++) {
        const mid = (low + high) / 2;
        if (inside(mid) === left) {
          low = mid;
        } else {
          high = mid;
        }
      }
      if (left) {
        hi = (low + high) / 2;
      } else {
        lo = (low + high) / 2;
      }
    }
    if (hi - lo <= 1e-12) {
      continue;
    }
    if (ranges.length && Math.abs(ranges.at(-1)![1] - lo) < 1e-12) {
      ranges.at(-1)![1] = hi;
    } else {
      ranges.push([lo, hi]);
    }
  }
  return ranges.map(([start, end]) => ({ first: point(start), second: point(end), start, end }));
}

const capKey = (first: ArrayLike<number>, second: ArrayLike<number>) =>
  [first, second]
    .map((point) => Array.from(point, (value) => Math.round(Math.fround(value) * 1e6)).join(','))
    .sort()
    .join(';');
function expectedCapEdges(mesh: Grid, cap: GlobeGridFootprint) {
  const expected = new Set<string>();
  for (let edge = 0; edge < mesh.edgeLength.length; edge++) {
    const points = [0, 1].map((slot) => {
      const corner = mesh.edgeCorners[edge * 2 + slot];
      return Array.from(mesh.corners.subarray(corner * 3, corner * 3 + 3)) as Vec3;
    });
    for (const part of capOracle(points[0], points[1], cap)) {
      expected.add(capKey(part.first, part.second));
    }
  }
  return expected;
}

test('globe clipping retains a crossing whose endpoints both lie outside the footprint', () => {
  const first = direction(-0.2, 0);
  const second = direction(0.2, 0);
  const cap = { center: [1, 0, 0] as Vec3, radius: 0.05 };
  const actual = clipGlobeGridSegment(first, second, cap);
  const expected = capOracle(first, second, cap);
  assert.equal(actual.length, 1);
  assert.equal(expected.length, 1);
  assert.ok(actual[0].start > 0 && actual[0].end < 1);
  assert.ok(Math.abs(actual[0].start - expected[0].start) < 1e-12);
  assert.ok(Math.abs(actual[0].end - expected[0].end) < 1e-12);
  assert.deepEqual(
    capKey(actual[0].first, actual[0].second),
    capKey(expected[0].first, expected[0].second),
  );
});

test('polar grid includes arcs that bow into view with both endpoints below its latitude boundary', async () => {
  const cap: GlobeGridFootprint = { center: [0, 1, 0], radius: Math.PI / 2 - 1.53 };
  const bounds = { ...fullBounds, south: 1.53 };
  const expected = expectedCapEdges(grid, cap);
  assert.equal(expected.size, 8, 'independent Cartesian oracle counts all crossing edges');
  assert.ok(expectedEdges(bounds).size < expected.size, 'linear latitude clipping omitted edges');
  const source = fixture(grid);
  const packet = await readOverlays(source.pages, source.index, source.summary, {
    bounds,
    season: -1,
    gridLines: true,
    gridGlobeFootprint: cap,
    maxSegments: 8192,
  });
  const actual = new Set<string>();
  for (let i = 0; i < packet.grid.positions.length; i += 6) {
    actual.add(
      capKey(
        packet.grid.positions.subarray(i, i + 3),
        packet.grid.positions.subarray(i + 3, i + 6),
      ),
    );
  }
  assert.equal(packet.gridStatus, 'visible');
  assert.deepEqual(actual, expected);
});

test('rotating an equal-area globe footprint through poles and the seam preserves its complete grid and budget', async () => {
  let count = -1;
  for (const [longitude, latitude] of [
    [0, 0],
    [0.7, 1],
    [Math.PI, 1.4],
    [-2, -Math.PI / 2],
    [0.3, Math.PI / 2],
  ]) {
    const rotate = (values: Float64Array) =>
      Float64Array.from(values, (_, offset) => {
        const start = offset - (offset % 3);
        const x = values[start] * Math.cos(latitude) - values[start + 1] * Math.sin(latitude);
        const y = values[start] * Math.sin(latitude) + values[start + 1] * Math.cos(latitude);
        const z = values[start + 2];
        return [
          x * Math.cos(longitude) - z * Math.sin(longitude),
          y,
          x * Math.sin(longitude) + z * Math.cos(longitude),
        ][offset % 3];
      });
    const mesh = { ...grid, positions: rotate(grid.positions), corners: rotate(grid.corners) };
    const cap = { center: direction(longitude, latitude), radius: 0.68 };
    const source = fixture(mesh);
    const packet = await readOverlays(source.pages, source.index, source.summary, {
      bounds: fullBounds,
      season: -1,
      gridLines: true,
      gridGlobeFootprint: cap,
      maxSegments: 1200,
    });
    const expected = expectedCapEdges(mesh, cap);
    const actual = new Set<string>();
    for (let i = 0; i < packet.grid.positions.length; i += 6) {
      actual.add(
        capKey(
          packet.grid.positions.subarray(i, i + 3),
          packet.grid.positions.subarray(i + 3, i + 6),
        ),
      );
    }
    assert.equal(packet.gridStatus, 'visible', `${longitude},${latitude}`);
    assert.equal(packet.truncated, false);
    assert.deepEqual(actual, expected);
    if (count < 0) {
      count = actual.size;
    }
    assert.equal(actual.size, count, 'rotation cannot consume a larger rectangular budget');
    assert.ok(source.visitedCells < grid.count / 2);
  }
});

test('globe grid crosses a locally refined polar region without missing coarse/fine adjacency', async () => {
  const base = buildGrid(2, 'grid-region-insertion', 0.65);
  const mesh = refineGrid(
    base,
    1000,
    'grid-region-insertion',
    createRegionSpacing(500, 1000, [
      { center: direction(0.4, 1.47), radiusMetres: 80, targetSpacingMetres: 25 },
    ]),
  );
  assert.ok(mesh.count > base.count + 50);
  assert.ok(Math.max(...mesh.edgeLength) > Math.min(...mesh.edgeLength) * 4);
  const cap = { center: direction(0.4, 1.4), radius: 0.18 };
  const source = fixture(mesh);
  const packet = await readOverlays(source.pages, source.index, source.summary, {
    bounds: fullBounds,
    season: -1,
    gridLines: true,
    gridGlobeFootprint: cap,
    maxSegments: 4096,
  });
  const actual = new Set<string>();
  for (let i = 0; i < packet.grid.positions.length; i += 6) {
    actual.add(
      capKey(
        packet.grid.positions.subarray(i, i + 3),
        packet.grid.positions.subarray(i + 3, i + 6),
      ),
    );
  }
  assert.equal(packet.gridStatus, 'visible');
  assert.deepEqual(actual, expectedCapEdges(mesh, cap));
  assert.ok(actual.size > 100);
  const dense = fixture(mesh);
  const limited = await readOverlays(dense.pages, dense.index, dense.summary, {
    bounds: fullBounds,
    season: -1,
    gridLines: true,
    gridGlobeFootprint: cap,
    maxSegments: 16,
  });
  assert.equal(limited.gridStatus, 'zoom-in');
  assert.equal(limited.grid.positions.length, 0);
  assert.ok(dense.visitedCells <= 96, 'local insertion cannot remove the traversal bound');
});

test('globe footprint validation rejects invalid coordinates and angles before any grid reads', async () => {
  const source = fixture(grid);
  for (const cap of [
    { center: [0, 0, 0], radius: 0.1 },
    { center: [2, 0, 0], radius: 0.1 },
    { center: [NaN, 0, 0], radius: 0.1 },
    { center: [1, 0], radius: 0.1 },
    { center: [1, 0, 0], radius: -0.1 },
    { center: [1, 0, 0], radius: Math.PI + 0.1 },
    { center: [1, 0, 0], radius: Infinity },
  ]) {
    await assert.rejects(
      readOverlays(source.pages, source.index, source.summary, {
        bounds: fullBounds,
        season: -1,
        gridLines: true,
        gridGlobeFootprint: cap as GlobeGridFootprint,
      }),
      /Invalid globe grid footprint/,
    );
  }
  assert.equal(source.visitedCells, 0);
});

test('a globe footprint wholly inside one coarse cell is an empty visible grid, not a budget failure', async () => {
  const center = Array.from(grid.positions.subarray(0, 3)) as Vec3;
  for (const radius of [0, 1e-7]) {
    const source = fixture(grid);
    const packet = await readOverlays(source.pages, source.index, source.summary, {
      bounds: fullBounds,
      season: -1,
      gridLines: true,
      gridGlobeFootprint: { center, radius },
      maxSegments: 16,
    });
    assert.equal(packet.gridStatus, 'visible');
    assert.equal(packet.grid.positions.length, 0);
    assert.equal(packet.truncated, false);
    assert.ok(source.visitedCells <= 16, 'only the containing cell and its neighbor ring are read');
  }
});
