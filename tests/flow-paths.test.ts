import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGrid, nearestCell } from '../src/core/grid/build';
import type { Vec3 } from '../src/core/math';
import {
  buildSpatialIndex,
  PagedSpatialIndex,
  type PageValues,
} from '../src/core/view/spatial-index';
import {
  FLOW_PATH_LIMIT,
  FLOW_PATH_STEP_LIMIT,
  FLOW_SAMPLE_CACHE_LIMIT,
  flowPathSeeds,
  readFlowPaths,
} from '../src/core/view/flow-paths';

const bounds = { west: -Math.PI, east: Math.PI, south: -Math.PI / 2, north: Math.PI / 2 };
const axis: Vec3 = [0.3, 0.9, 0.25];
const cross = (point: Vec3): Vec3 => [
  axis[1] * point[2] - axis[2] * point[1],
  axis[2] * point[0] - axis[0] * point[2],
  axis[0] * point[1] - axis[1] * point[0],
];
function fixture(ocean: (point: Vec3) => boolean = () => true, oppositeSeasons = false) {
  const grid = buildGrid(3, 'streamline-field', 0.1);
  const vector = new Float32Array(grid.count * 3);
  for (let cell = 0; cell < grid.count; cell++) {
    vector.set(
      cross(Array.from(grid.positions.subarray(cell * 3, cell * 3 + 3)) as Vec3).map(
        (value) => value * 15,
      ),
      cell * 3,
    );
  }
  const world = {
    grid,
    process: grid,
    transfer: Uint32Array.from({ length: grid.count }, (_, cell) => cell),
    terrain: {
      height: new Float32Array(grid.count),
      ocean: Uint8Array.from({ length: grid.count }, (_, cell) =>
        Number(ocean(Array.from(grid.positions.subarray(cell * 3, cell * 3 + 3)) as Vec3)),
      ),
    },
    climate: {
      wind: Array.from({ length: 4 }, (_, season) =>
        Float32Array.from(vector, (value) => value * (oppositeSeasons && season % 2 ? -1 : 1)),
      ),
      current: Array.from({ length: 4 }, () => Float32Array.from(vector, (value) => value / 30)),
    },
  };
  const root = { world, sidecars: { view: { index: buildSpatialIndex(grid.positions) } } };
  const get = (path: string) =>
    path
      .split('.')
      .reduce<unknown>(
        (value, key) => (value as Record<string, unknown>)[key],
        root,
      ) as ArrayLike<number>;
  let largestRead = 0;
  let reads = 0;
  const pages: PageValues = {
    async readValue(path) {
      throw Error(`No whole field restoration: ${path}`);
    },
    async readValues(path, ids) {
      largestRead = Math.max(largestRead, ids.length);
      reads++;
      return Float64Array.from(ids, (id) => get(path)[id]);
    },
    async readRange(path, first, count) {
      largestRead = Math.max(largestRead, count);
      reads++;
      return Float64Array.from({ length: count }, (_, i) => get(path)[first + i]);
    },
  };
  return {
    world,
    pages,
    index: new PagedSpatialIndex(pages),
    metrics: () => ({ largestRead, reads }),
  };
}

test('streamlines follow curved seasonal fields forward with connected history and bounded reads', async () => {
  const f = fixture();
  const { lines, stats } = await readFlowPaths(f.pages, f.index, {
    bounds,
    kind: 'wind',
    season: 0,
    maxPaths: 32,
    maxSegments: 1536,
  });
  assert.equal(lines.pathOffsets!.length, 33);
  assert.equal(lines.pathOffsets!.at(-1), lines.positions.length / 6);
  assert.ok(lines.positions.length / 6 <= 1536);
  let bent = false;
  let long = false;
  for (let path = 0; path < lines.pathSpeeds!.length; path++) {
    const first = lines.pathOffsets![path];
    const last = lines.pathOffsets![path + 1];
    const start = Array.from(lines.positions.subarray(first * 6, first * 6 + 3)) as Vec3;
    const initial = cross(start);
    let length = 0;
    for (let segment = first; segment < last; segment++) {
      const a = Array.from(lines.positions.subarray(segment * 6, segment * 6 + 3)) as Vec3;
      const b = Array.from(lines.positions.subarray(segment * 6 + 3, segment * 6 + 6)) as Vec3;
      assert.ok(cross(a).reduce((n, x, i) => n + x * (b[i] - a[i]), 0) > 0);
      assert.ok(Math.abs(Math.hypot(...a) - 1) < 1e-6);
      length += Math.acos(
        Math.min(
          1,
          a.reduce((n, x, i) => n + x * b[i], 0),
        ),
      );
      if (segment + 1 < last) {
        assert.deepEqual(
          lines.positions.subarray(segment * 6 + 3, segment * 6 + 6),
          lines.positions.subarray(segment * 6 + 6, segment * 6 + 9),
        );
      }
      const normal: Vec3 = [
        start[1] * initial[2] - start[2] * initial[1],
        start[2] * initial[0] - start[0] * initial[2],
        start[0] * initial[1] - start[1] * initial[0],
      ];
      if (Math.abs(normal.reduce((n, x, i) => n + x * b[i], 0)) > 0.02) {
        bent = true;
      }
    }
    if (length > 0.4) {
      long = true;
    }
  }
  assert.ok(bent, 'Paths curve with the field rather than extending the initial great circle');
  assert.ok(long, 'Visible history spans substantially more than a local vector');
  assert.ok(stats.samples <= 32 * (1 + FLOW_PATH_STEP_LIMIT * 2));
  assert.ok(stats.peakSurfaceCache <= FLOW_SAMPLE_CACHE_LIMIT);
  assert.ok(stats.peakProcessCache <= FLOW_SAMPLE_CACHE_LIMIT);
  assert.ok(f.metrics().largestRead <= 384, 'No full climate/grid array read');
});

test('ocean streamlines stop at resolved land and stay inside the segment budget', async () => {
  const f = fixture((point) => point[0] > 0.15 || point[0] < -0.15);
  const { lines } = await readFlowPaths(f.pages, f.index, {
    bounds,
    kind: 'current',
    season: -1,
    maxPaths: 1024,
    maxSegments: 3200,
  });
  assert.ok(lines.pathSpeeds!.length <= FLOW_PATH_LIMIT);
  assert.ok(lines.widths.length <= 3200);
  for (let segment = 0; segment < lines.widths.length; segment++) {
    const a = lines.positions.subarray(segment * 6, segment * 6 + 3);
    const b = lines.positions.subarray(segment * 6 + 3, segment * 6 + 6);
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const point = Array.from(a, (x, i) => x + (b[i] - x) * t) as Vec3;
      assert.ok(
        f.world.terrain.ocean[nearestCell(f.world.grid, ...point)],
        'A segment may not bridge the land barrier',
      );
    }
  }
  assert.ok(lines.pathSpeeds!.every((value) => value >= 0 && value <= 1));
});

test('zero and seasonally cancelling fields produce no invented motion', async () => {
  const f = fixture(undefined, true);
  const options = { bounds, kind: 'wind' as const, season: -1, maxPaths: 16, maxSegments: 512 };
  assert.equal((await readFlowPaths(f.pages, f.index, options)).lines.positions.length, 0);
  for (const field of f.world.climate.wind) {
    field.fill(0);
  }
  assert.equal(
    (await readFlowPaths(f.pages, f.index, { ...options, season: 0 })).lines.positions.length,
    0,
  );
  const none = await readFlowPaths(f.pages, f.index, { ...options, maxPaths: 0 });
  assert.equal(none.stats.samples, 0);
});

test('a finer physical surface increases coast sampling without shortening open-ocean paths', async () => {
  const f = fixture();
  const options = { bounds, kind: 'current' as const, season: 0, maxPaths: 16, maxSegments: 768 };
  const coarse = await readFlowPaths(f.pages, f.index, options);
  f.world.grid.areas.fill((4 * Math.PI) / 2621442);
  const fine = await readFlowPaths(f.pages, f.index, options);
  assert.deepEqual(fine.lines.positions, coarse.lines.positions);
  assert.deepEqual(fine.lines.pathOffsets, coarse.lines.pathOffsets);
  assert.ok(fine.stats.oceanProbes > coarse.stats.oceanProbes * 5);
  assert.ok(fine.stats.oceanProbes <= 16 * 512);
});

test('kilometre-scale ocean refinement keeps safe partial paths instead of disappearing', async () => {
  const f = fixture();
  f.world.grid.areas.fill((1000 / 6371000) ** 2);
  const { lines, stats } = await readFlowPaths(f.pages, f.index, {
    bounds,
    kind: 'current',
    season: 0,
    maxPaths: 16,
    maxSegments: 768,
  });
  assert.equal(lines.pathSpeeds!.length, 16);
  assert.ok(lines.positions.length > 0 && lines.positions.every(Number.isFinite));
  assert.ok(lines.widths.length <= 768);
  assert.ok(stats.oceanProbes <= 16 * 512);
});

test('small camera pans retain geographic seeds and dateline/pole seeds remain finite', () => {
  const view = { west: -0.5, east: 0.5, south: -0.4, north: 0.4 };
  const before = flowPathSeeds(view, 64);
  const after = flowPathSeeds({ ...view, west: -0.49, east: 0.51 }, 64);
  const set = new Set(before.points.map((p) => p.join(',')));
  assert.ok(after.points.filter((p) => set.has(p.join(','))).length >= 60);
  for (const bounds of [
    { west: 3, east: -3, south: -0.3, north: 0.3 },
    { west: -Math.PI, east: Math.PI, south: 1.5, north: Math.PI / 2 },
  ]) {
    const points = flowPathSeeds(bounds, 64).points;
    assert.ok(points.length > 0 && points.length <= 64);
    for (const point of points) {
      assert.ok(point.every(Number.isFinite) && Math.abs(Math.hypot(...point) - 1) < 1e-10);
    }
  }
});
