import assert from 'node:assert/strict';
import test from 'node:test';
import { clipOverlaySegment, readOverlays } from '../src/core/view/overlays';
import { PagedSpatialIndex, type PageValues } from '../src/core/view/spatial-index';
import type { Vec3 } from '../src/core/math';
import type { OverlayLines, WorldSummary } from '../src/core/view/types';

const point = (lon: number, lat = 0): Vec3 => [
  Math.cos(lat) * Math.cos(lon),
  Math.sin(lat),
  Math.cos(lat) * Math.sin(lon),
];
const fullBounds = { west: -Math.PI, east: Math.PI, south: -Math.PI / 2, north: Math.PI / 2 };

test('flow packets preserve a complete streamline across the dateline for continuous animation', async () => {
  const values: Record<string, ArrayLike<number>> = {
    'world.transfer': [0],
    'world.terrain.height': [0],
    'world.grid.areas': [0.01],
    'world.process.positions': [-1, 0, 0],
    'world.process.offsets': [0, 0],
    'world.process.neighbors': [],
    'world.climate.wind.0': [0, 0, -15],
  };
  const pages = {
    async readRange(path: string, first: number, count: number) {
      assert.ok(values[path], `unexpected field read: ${path}`);
      return Float64Array.from({ length: count }, (_, index) => values[path][first + index]);
    },
    async readValues(path: string, indices: number[]) {
      assert.ok(values[path], `unexpected field read: ${path}`);
      return Float64Array.from(indices, (index) => values[path][index]);
    },
  } as PageValues;
  const index = { nearest: async () => 0 } as unknown as PagedSpatialIndex;
  const packet = await readOverlays(pages, index, { surfaceCells: 1 } as WorldSummary, {
    bounds: { west: 3.04, east: -3.1, south: -0.1, north: 0.1 },
    layer: 'wind',
    season: 0,
    vectors: true,
    maxVectors: 1,
    maxSegments: 8,
  });
  assert.equal(
    packet.flow.pathOffsets?.length,
    2,
    'one continuous path, not independently phased halves',
  );
  const direction = packet.flow.positions;
  assert.ok(Math.atan2(direction[2], direction[0]) > 3);
  assert.ok(Math.atan2(direction[direction.length - 1], direction[direction.length - 3]) < -2.9);
  assert.equal(packet.flow.pathOffsets?.[1], direction.length / 6);
  assert.equal(packet.truncated, false);
});

test('overlay clipping keeps crossing segments and handles the dateline without duplicate seam lines', () => {
  const bounds = { west: -0.2, east: 0.2, south: -0.1, north: 0.1 };
  const clipped = clipOverlaySegment(point(-0.5), point(0.5), bounds);
  assert.equal(clipped.length, 1);
  assert.ok(Math.abs(Math.atan2(clipped[0].first[2], clipped[0].first[0]) + 0.2) < 1e-12);
  assert.ok(Math.abs(Math.atan2(clipped[0].second[2], clipped[0].second[0]) - 0.2) < 1e-12);
  const wrapped = clipOverlaySegment(point(3), point(-3), { ...bounds, west: 3.1, east: -3.1 });
  assert.equal(wrapped.length, 2);
  assert.ok(
    wrapped.every((part) =>
      [part.first, part.second].every((p) => Math.abs(Math.atan2(p[2], p[0])) >= 3.1 - 1e-12),
    ),
  );
  assert.equal(clipOverlaySegment(point(Math.PI, -0.2), point(Math.PI, 0.2), fullBounds).length, 1);
  assert.deepEqual(clipOverlaySegment(point(-1, 0.3), point(1, 0.3), bounds), []);
});

function fixture(lakeDelta = false) {
  const river = Float32Array.from(
    [point(-0.8), point(-0.3, 0.2), point(0.3, -0.2), point(0.8)].flat(),
  );
  const branch = Float32Array.from([point(-0.1), point(0, -0.12), point(0.1, -0.15)].flat());
  const pond = Float32Array.from([point(-0.2, -0.1), point(0, -0.3), point(0.2, -0.1)].flat());
  const pairs = [0, 0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0];
  const data = {
    sidecars: {
      view: {
        overlay: {
          offsets: Uint32Array.from({ length: 513 }, (_, index) =>
            index > 272 ? pairs.length : 0,
          ),
          refs: Uint32Array.from(pairs),
        },
      },
    },
    world: {
      grid: {
        edgeCorners: new Uint32Array([0, 1]),
        corners: new Float64Array([...point(-0.8), ...point(0.8)]),
      },
      drainage: {
        height: new Float32Array([10, 2]),
        discharge: new Float64Array([100, 0]),
        receiver: new Int32Array([1, -1]),
        lakes: [{ level: 80, seasonal: { level: [81, 82, 83, 84] } }],
      },
      rivers: {
        courses: { corner: new Uint32Array([0]), offsets: new Uint32Array([0, 4]), points: river },
        seasonalDischarge: Array.from({ length: 4 }, () => new Float32Array([100, 0])),
        deltas: [
          { corner: 0, lake: lakeDelta ? 0 : -1, branches: [{ points: branch, fraction: 1 }] },
        ],
      },
      terrain: { height: new Float32Array([12]), oxbows: [{ cell: 0, points: pond, width: 20 }] },
      water: { oxbowDepth: Array.from({ length: 4 }, () => new Float32Array([1])) },
      resources: {
        deposits: [{ id: 'gold-1', resourceType: 'gold', anchor: point(0, 0.05), amount: 10 }],
      },
    },
  };
  const valueAt = (path: string): unknown =>
    path
      .split('.')
      .reduce<unknown>((value, key) => (value as Record<string, unknown>)?.[key], data);
  const pages: PageValues = {
    async readValue(path) {
      return valueAt(path);
    },
    async readValues(path, indices) {
      const values = valueAt(path) as ArrayLike<number>;
      return Float64Array.from(indices, (index) => values[index]);
    },
    async readRange(path, start, count) {
      const values = valueAt(path) as ArrayLike<number>;
      return Float64Array.from({ length: count }, (_, index) => values[start + index]);
    },
  };
  const summary = { surfaceCells: 2 } as WorldSummary;
  return { pages, summary, index: new PagedSpatialIndex(pages), river, branch, pond };
}

test('paged overlays preserve saved river bends, delta branches, and wet oxbows within one packet budget', async () => {
  const { pages, index, summary, river, branch, pond } = fixture();
  const packet = await readOverlays(pages, index, summary, {
    bounds: fullBounds,
    season: -1,
    rivers: true,
    coasts: true,
    boundaries: true,
    resources: true,
    maxSegments: 60,
  });
  assert.equal(packet.rivers.positions.length / 6, 7);
  assert.equal(packet.coasts.positions.length / 6, 1);
  assert.equal(packet.boundaries.positions.length / 6, 1);
  assert.equal(packet.deposits.length, 1);
  const hasPoint = (values: Float32Array) => {
    for (let offset = 0; offset < packet.rivers.positions.length; offset += 3) {
      if (values.every((value, axis) => value === packet.rivers.positions[offset + axis])) {
        return true;
      }
    }
    return false;
  };
  assert.ok(hasPoint(river.subarray(3, 6)));
  assert.ok(hasPoint(branch.subarray(3, 6)));
  assert.ok(hasPoint(pond.subarray(3, 6)));
  const limited = await readOverlays(pages, index, summary, {
    bounds: fullBounds,
    season: -1,
    rivers: true,
    coasts: true,
    boundaries: true,
    maxSegments: 6,
  });
  const lines = [
    limited.rivers,
    limited.coasts,
    limited.boundaries,
    limited.flow,
    limited.grid,
    limited.drift,
  ];
  assert.ok(lines.reduce((sum, line) => sum + line.positions.length / 6, 0) <= 6);
  assert.ok(limited.truncated);
  for (const line of lines) {
    assert.equal(line.heights.length, line.positions.length / 3);
    assert.equal(line.widths.length, line.positions.length / 6);
    assert.equal(line.discharge.length, line.widths.length);
  }
});

test('overlay queries clip physical features and apply resource filters without broadening the viewport', async () => {
  const { pages, index, summary } = fixture();
  const bounds = { west: -0.1, east: 0.1, south: -0.1, north: 0.1 };
  const packet = await readOverlays(pages, index, summary, {
    bounds,
    season: 0,
    rivers: true,
    coasts: true,
    resources: true,
    resourceFilter: 'gold',
    maxSegments: 50,
  });
  assert.equal(packet.deposits.length, 1);
  for (const line of [packet.rivers, packet.coasts]) {
    for (let offset = 0; offset < line.positions.length; offset += 3) {
      const longitude = Math.atan2(line.positions[offset + 2], line.positions[offset]);
      const latitude = Math.asin(line.positions[offset + 1]);
      assert.ok(longitude >= bounds.west - 1e-7 && longitude <= bounds.east + 1e-7);
      assert.ok(latitude >= bounds.south - 1e-7 && latitude <= bounds.north + 1e-7);
    }
  }
  const filtered = await readOverlays(pages, index, summary, {
    bounds,
    season: 0,
    resources: true,
    resourceFilter: 'copper',
  });
  assert.deepEqual(filtered.deposits, []);
  const disabled = await readOverlays(pages, index, summary, { bounds, season: -1 });
  for (const name of ['rivers', 'coasts', 'boundaries', 'flow', 'grid', 'drift'] as const) {
    assert.equal((disabled[name] as OverlayLines).positions.length, 0);
  }
});

test('lake delta branches finish on the saved seasonal lake surface', async () => {
  const { pages, index, summary } = fixture(true);
  const packet = await readOverlays(pages, index, summary, {
    bounds: fullBounds,
    season: 2,
    rivers: true,
  });
  assert.equal(packet.rivers.heights[9], 83);
});

test('exhausted geometry budgets stop physical page reads and invalid drift is rejected', async () => {
  const { pages, index, summary } = fixture();
  const original = pages.readValues;
  pages.readValues = async (path, indices) => {
    assert.ok(
      !path.startsWith('world.'),
      'a full packet must not continue reading physical feature pages',
    );
    return original(path, indices);
  };
  const packet = await readOverlays(pages, index, summary, {
    bounds: fullBounds,
    season: -1,
    rivers: true,
    coasts: true,
    gridLines: true,
    maxSegments: 0,
  });
  assert.equal(
    packet.rivers.positions.length + packet.coasts.positions.length + packet.grid.positions.length,
    0,
  );
  assert.equal(packet.truncated, true);
  await assert.rejects(
    readOverlays(pages, index, summary, { bounds: fullBounds, season: -1, drift: NaN }),
    /finite/,
  );
});

function distributedRiverFixture(ranked = false, coursesPerRegion = 6, pointsPerCourse = 65) {
  const latitudes = [-1.2, -0.8, -0.3, 0.3, 0.8, 1.2];
  const courseCount = latitudes.length * coursesPerRegion;
  const bins: number[][] = Array.from({ length: 512 }, () => []);
  const courses = new Float32Array(courseCount * pointsPerCourse * 3);
  const flows = new Float32Array(courseCount * 2);
  for (let region = 0; region < latitudes.length; region++) {
    const bin = Math.floor(((latitudes[region] + Math.PI / 2) / Math.PI) * 16) * 32 + 16;
    for (let reach = 0; reach < coursesPerRegion; reach++) {
      const course = region * coursesPerRegion + reach;
      bins[bin].push(0, course);
      // The most important river is last in the old geographic index.
      flows[course] = reach === coursesPerRegion - 1 ? 10000 + region : 100 + course;
      for (let sample = 0; sample < pointsPerCourse; sample++) {
        courses.set(
          point(
            0.01 + (sample / (pointsPerCourse - 1)) * 0.1,
            latitudes[region] +
              (reach / Math.max(1, coursesPerRegion - 1)) * 0.015 +
              Math.sin((sample / (pointsPerCourse - 1)) * Math.PI * 4) * 0.001,
          ),
          (course * pointsPerCourse + sample) * 3,
        );
      }
    }
  }
  const offsets = new Uint32Array(513);
  const rankOffsets = new Uint32Array(513);
  const rankRefs: number[] = [];
  const rankScores: number[] = [];
  bins.forEach((refs, bin) => {
    offsets[bin + 1] = offsets[bin] + refs.length;
    const ids = refs
      .filter((_, offset) => offset % 2 === 1)
      .sort((first, second) => flows[second] - flows[first]);
    for (const id of ids) {
      rankRefs.push(0, id);
      rankScores.push(flows[id]);
    }
    rankOffsets[bin + 1] = rankScores.length;
  });
  const data = {
    sidecars: {
      view: {
        overlay: {
          offsets,
          refs: Uint32Array.from(bins.flat()),
          ...(ranked
            ? {
                riverRank: {
                  offsets: rankOffsets,
                  refs: Uint32Array.from(rankRefs),
                  scores: Float32Array.from(rankScores),
                },
              }
            : {}),
        },
      },
    },
    world: {
      rivers: {
        courses: {
          corner: Uint32Array.from({ length: courseCount }, (_, course) => course),
          offsets: Uint32Array.from(
            { length: courseCount + 1 },
            (_, course) => course * pointsPerCourse,
          ),
          points: courses,
        },
        seasonalDischarge: Array.from({ length: 4 }, () => flows.slice()),
      },
      drainage: {
        discharge: flows,
        height: Float32Array.from({ length: courseCount * 2 }, (_, corner) =>
          corner < courseCount ? 100 : 10,
        ),
        receiver: Int32Array.from({ length: courseCount * 2 }, (_, corner) =>
          corner < courseCount ? corner + courseCount : -1,
        ),
      },
    },
  };
  const valueAt = (path: string): unknown =>
    path
      .split('.')
      .reduce<unknown>((value, key) => (value as Record<string, unknown>)?.[key], data);
  let largestRead = 0;
  let numericReads = 0;
  let pointValuesRead = 0;
  const pages: PageValues = {
    async readValue(path) {
      return valueAt(path);
    },
    async readValues(path, indices) {
      numericReads++;
      if (path === 'world.rivers.courses.points') {
        pointValuesRead += indices.length;
      }
      largestRead = Math.max(largestRead, indices.length);
      const values = valueAt(path) as ArrayLike<number>;
      return Float64Array.from(indices, (index) => values[index]);
    },
    async readRange(path, start, count) {
      numericReads++;
      if (path === 'world.rivers.courses.points') {
        pointValuesRead += count;
      }
      largestRead = Math.max(largestRead, count);
      const values = valueAt(path) as ArrayLike<number>;
      return Float64Array.from({ length: count }, (_, offset) => values[start + offset]);
    },
  };
  return {
    pages,
    index: new PagedSpatialIndex(pages),
    summary: { surfaceCells: 2 } as WorldSummary,
    courses,
    flows,
    latitudes,
    pointsPerCourse,
    largestRead: () => largestRead,
    readCounts: () => ({ numericReads, pointValuesRead }),
  };
}

test('legacy and ranked global packets preserve major rivers in every region without cutting courses', async () => {
  for (const ranked of [false, true]) {
    const { pages, index, summary, courses, flows, pointsPerCourse, largestRead } =
      distributedRiverFixture(ranked);
    const packet = await readOverlays(pages, index, summary, {
      bounds: fullBounds,
      season: -1,
      rivers: true,
      riverThreshold: 20,
      maxSegments: 24,
    });
    assert.equal(
      packet.rivers.widths.length,
      24,
      'geometry remains within the requested packet budget',
    );
    assert.equal(packet.truncated, true, 'coarse bend/tributary detail is explicitly reported');
    for (let region = 0; region < 6; region++) {
      assert.ok(
        packet.rivers.discharge.includes(10000 + region),
        `major river in region ${region} survives global LOD`,
      );
    }
    for (const flow of new Set(packet.rivers.discharge)) {
      const course = flows.indexOf(flow);
      for (const endpoint of [0, pointsPerCourse - 1]) {
        const original = courses.subarray(
          (course * pointsPerCourse + endpoint) * 3,
          (course * pointsPerCourse + endpoint) * 3 + 3,
        );
        let found = false;
        for (let vertex = 0; vertex < packet.rivers.positions.length; vertex += 3) {
          if (
            original.every(
              (coordinate, axis) => coordinate === packet.rivers.positions[vertex + axis],
            )
          ) {
            found = true;
            break;
          }
        }
        assert.ok(found, `course ${course} retains endpoint ${endpoint}, not an arbitrary prefix`);
      }
    }
    assert.ok(largestRead() <= 2048, 'ranking reads metadata and course points in bounded chunks');
  }
});

test('zoomed regional packets recover complete saved bends instead of permanent global truncation', async () => {
  const { pages, index, summary, courses, flows, pointsPerCourse, latitudes } =
    distributedRiverFixture();
  const region = 4;
  const packet = await readOverlays(pages, index, summary, {
    bounds: {
      west: 0,
      east: 0.12,
      south: latitudes[region] - 0.01,
      north: latitudes[region] + 0.03,
    },
    season: 2,
    rivers: true,
    riverThreshold: 20,
    maxSegments: 400,
  });
  assert.equal(packet.rivers.widths.length, 6 * (pointsPerCourse - 1));
  assert.equal(packet.truncated, false);
  for (let course = region * 6; course < (region + 1) * 6; course++) {
    const segments = Array.from(packet.rivers.discharge.keys()).filter(
      (segment) => packet.rivers.discharge[segment] === flows[course],
    );
    assert.equal(segments.length, pointsPerCourse - 1);
    for (let sample = 0; sample < pointsPerCourse - 1; sample++) {
      const source = (course * pointsPerCourse + sample) * 3;
      assert.deepEqual(
        packet.rivers.positions.subarray(segments[sample] * 6, segments[sample] * 6 + 6),
        courses.subarray(source, source + 6),
      );
    }
  }
});

test('legacy ranking streams dense bins and finds major courses beyond the first metadata page', async () => {
  const { pages, index, summary, largestRead } = distributedRiverFixture(false, 1025, 2);
  const packet = await readOverlays(pages, index, summary, {
    bounds: fullBounds,
    season: -1,
    rivers: true,
    maxSegments: 12,
  });
  assert.equal(packet.rivers.widths.length, 12);
  for (let region = 0; region < 6; region++) {
    assert.ok(packet.rivers.discharge.includes(10000 + region));
  }
  assert.equal(
    largestRead(),
    2048,
    'metadata scans have a fixed chunk size, independent of bin density',
  );
});

test('thousands of ranked reaches use bounded bulk reads and never reread selected course points', async () => {
  const { pages, index, summary, courses, flows, largestRead, readCounts } =
    distributedRiverFixture(true, 1025, 65);
  const packet = await readOverlays(pages, index, summary, {
    bounds: fullBounds,
    season: -1,
    rivers: true,
    maxSegments: 8192,
  });
  assert.equal(packet.rivers.widths.length, 8192);
  assert.equal(
    new Set(packet.rivers.discharge).size,
    6150,
    'every selected reach retains complete endpoints',
  );
  for (let region = 0; region < 6; region++) {
    assert.ok(packet.rivers.discharge.includes(10000 + region));
  }
  const counts = readCounts();
  assert.ok(
    counts.numericReads < 1000,
    `${counts.numericReads} bulk calls replace tens of thousands of per-reach calls`,
  );
  assert.equal(
    counts.pointValuesRead,
    courses.length,
    'each saved course is read once across selection and output',
  );
  assert.ok(largestRead() <= 2048, 'larger packet budgets never enlarge an individual gather');
  assert.ok(flows.length > 10000, 'fixture exercises a broad physical array');
});
