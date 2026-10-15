import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_COAST_INDEX_VALUES, readCoastOverlays } from '../src/core/view/coast-overlays';
import type { PageValues } from '../src/core/view/spatial-index';
import type { OverlayLines, ViewBounds } from '../src/core/view/types';

const whole = { west: -Math.PI, east: Math.PI, south: -Math.PI / 2, north: Math.PI / 2 };
const sphere = (longitude: number, latitude: number) => [
  Math.cos(latitude) * Math.cos(longitude),
  Math.sin(latitude),
  Math.cos(latitude) * Math.sin(longitude),
];

function fixture(count = 1200, longitude = 0, filler = 19) {
  const corners = Float64Array.from(
    Array.from({ length: count }, (_, i) => {
      const angle = (i / count) * Math.PI * 2;
      return sphere(longitude + Math.cos(angle) * 0.25, Math.sin(angle) * 0.2);
    }).flat(),
  );
  const edgeCorners = Uint32Array.from(
    Array.from({ length: count }, (_, i) => [i, (i + 1) % count]).flat(),
  );
  const refs: number[] = [];
  for (let i = count - 1; i >= 0; i--) {
    for (let river = 0; river < filler; river++) {
      refs.push(0, i * filler + river);
    }
    refs.push(1, i);
  }
  // One old-format mixed bin is enough to reproduce river-dominated sampling.
  const bin = longitude === 0 ? 272 : 256;
  const data = {
    sidecars: {
      view: {
        overlay: {
          offsets: Uint32Array.from({ length: 513 }, (_, i) => (i > bin ? refs.length : 0)),
          refs: Uint32Array.from(refs),
        },
      },
    },
    world: {
      grid: { corners, edgeCorners },
      drainage: { height: Float32Array.from({ length: count }, (_, i) => 10 + i / count) },
    },
  };
  let indexReads = 0;
  let largestRead = 0;
  const value = (path: string): ArrayLike<number> =>
    path
      .split('.')
      .reduce<unknown>(
        (node, key) => (node as Record<string, unknown>)[key],
        data,
      ) as ArrayLike<number>;
  const pages: PageValues = {
    async readValue() {
      throw Error('The connected coast must never restore an entire field.');
    },
    async readValues(path, indices) {
      largestRead = Math.max(largestRead, indices.length);
      return Float64Array.from(indices, (i) => value(path)[i]);
    },
    async readRange(path, start, count) {
      if (path.endsWith('.refs')) {
        indexReads++;
      }
      largestRead = Math.max(largestRead, count);
      return Float64Array.from({ length: count }, (_, i) => value(path)[start + i]);
    },
  };
  return { pages, corners, reads: () => ({ indexReads, largestRead }) };
}

function endpoints(lines: OverlayLines) {
  const degree = new Map<string, number>();
  for (let i = 0; i < lines.positions.length; i += 3) {
    const key = Array.from(lines.positions.subarray(i, i + 3)).join(',');
    degree.set(key, (degree.get(key) ?? 0) + 1);
  }
  return degree;
}

test('river-dominated legacy bins produce a complete simplified coastline rather than dispersed edges', async () => {
  const { pages, reads } = fixture();
  const result = await readCoastOverlays(pages, whole, 64);
  assert.equal(result.status, 'visible');
  assert.ok(result.truncated);
  assert.equal(result.lines.widths.length, 64);
  assert.ok(
    [...endpoints(result.lines).values()].every((degree) => degree === 2),
    'every retained coastline vertex belongs to a closed connected loop',
  );
  const positions = result.lines.positions;
  for (let edge = 1; edge < 64; edge++) {
    assert.deepEqual(
      positions.subarray(edge * 6, edge * 6 + 3),
      positions.subarray(edge * 6 - 3, edge * 6),
    );
  }
  assert.deepEqual(positions.subarray(0, 3), positions.subarray(-3));
  const firstReads = reads().indexReads;
  assert.ok(firstReads > 1 && reads().largestRead <= 8192);
  const repeated = await readCoastOverlays(pages, whole, 64);
  assert.deepEqual(repeated, result);
  assert.equal(
    reads().indexReads,
    firstReads,
    'bounded per-bin IDs avoid a second scan of river references',
  );
});

test('clipped cyclic coast keeps only viewport endpoints open and preserves the entire visible arc', async () => {
  const { pages } = fixture();
  const bounds: ViewBounds = { west: -0.1, east: 0.3, south: -0.3, north: 0.3 };
  const result = await readCoastOverlays(pages, bounds, 32);
  assert.equal(result.lines.widths.length, 32);
  const degree = endpoints(result.lines);
  const ends = [...degree].filter(([, count]) => count === 1);
  assert.equal(ends.length, 2, 'cyclic trace start is joined after viewport clipping');
  for (const [key] of ends) {
    const [x, , z] = key.split(',').map(Number);
    assert.ok(Math.abs(Math.atan2(z, x) - bounds.west) < 1e-7);
  }
  for (let i = 0; i < result.lines.positions.length; i += 3) {
    const longitude = Math.atan2(result.lines.positions[i + 2], result.lines.positions[i]);
    assert.ok(longitude >= bounds.west - 1e-7 && longitude <= bounds.east + 1e-7);
  }
});

test('dateline coast stays closed and very small budgets never cut a loop into isolated fragments', async () => {
  const { pages } = fixture(1200, Math.PI);
  const complete = await readCoastOverlays(pages, whole, 48);
  assert.ok([...endpoints(complete.lines).values()].every((degree) => degree === 2));
  assert.equal(complete.lines.widths.length, 48);
  const minimum = await readCoastOverlays(pages, whole, 3);
  assert.equal(minimum.lines.widths.length, 3);
  assert.ok([...endpoints(minimum.lines).values()].every((degree) => degree === 2));
  const insufficient = await readCoastOverlays(pages, whole, 2);
  assert.equal(insufficient.lines.widths.length, 0);
  assert.ok(insufficient.truncated);
  assert.equal(insufficient.status, 'zoom-in');
  const wrapped = await readCoastOverlays(pages, { ...whole, west: 3, east: -3 }, 48);
  assert.equal([...endpoints(wrapped.lines).values()].filter((degree) => degree === 1).length, 4);
  for (let offset = 0; offset < wrapped.lines.positions.length; offset += 3) {
    const longitude = Math.atan2(
      wrapped.lines.positions[offset + 2],
      wrapped.lines.positions[offset],
    );
    assert.ok(
      Math.abs(longitude) >= 3 - 1e-7,
      'a wrapped viewport does not become a globe-spanning path',
    );
  }
});

test('the cold index work cap returns an explicit closer-view status before restoring topology', async () => {
  let requested = 0;
  const pages: PageValues = {
    async readValue() {
      throw Error('Unexpected whole-field read');
    },
    async readValues(path, indices) {
      assert.equal(path, 'sidecars.view.overlay.offsets');
      return Float64Array.from(indices, (i) => (i > 272 ? MAX_COAST_INDEX_VALUES + 2 : 0));
    },
    async readRange(path, _start, count) {
      assert.equal(path, 'sidecars.view.overlay.refs');
      requested += count;
      return new Float64Array(count);
    },
  };
  const result = await readCoastOverlays(pages, whole, 64);
  assert.equal(result.status, 'zoom-in');
  assert.ok(result.truncated);
  assert.equal(result.lines.positions.length, 0);
  assert.equal(requested, MAX_COAST_INDEX_VALUES);
});
