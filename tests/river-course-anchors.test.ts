import assert from 'node:assert/strict';
import test from 'node:test';
import { evolveBend } from '../src/core/generation/river-bend';
import { rebaseSavedRiverCourse } from '../src/core/generation/river-course-anchors';
import { sampleMigrationCourse } from '../src/core/generation/river-migration';
import { angle, cross, normalizeVector, type Vec3 } from '../src/core/math';
import type { RiverMigration } from '../src/core/model';

const radius = 6371000;
const position = (metres: number, offset = 0): Vec3 =>
  normalizeVector([Math.cos(metres / radius), Math.sin(metres / radius), offset / radius]);
const record: RiverMigration = {
  start: position(0),
  end: position(150000),
  space: 30000,
  mobility: 1,
  variation: 0.65,
  elapsedMyr: 1,
};
const distance = (a: Vec3, b: Vec3) =>
  Math.hypot(...a.map((value, axis) => value - b[axis])) * radius;

test('an unchanged routing reach retains its inherited bend and migration history', () => {
  const before = structuredClone(record);
  const length = angle(record.start, record.end) * radius;
  const normal = normalizeVector(cross(record.start, record.end));
  const original = evolveBend(
    length,
    record.space,
    record.elapsedMyr,
    record.mobility,
    record.variation,
  ).points.map(([along, across]) =>
    normalizeVector(
      record.start.map(
        (value, axis) =>
          value + ((record.end[axis] - value) * along) / length + (normal[axis] * across) / radius,
      ),
    ),
  );
  const sampled = sampleMigrationCourse(record, record.start, record.end, radius);
  assert.equal(sampled.length, original.length);
  sampled.forEach((point, index) => assert.ok(distance(point, original[index]) < 1e-6));
  assert.deepEqual(record, before, 'sampling does not advance or replace migration history');
});

test('off-course refined junctions are exact and short inherited pieces do not grow connectors', () => {
  const first = position(35000, 8000);
  const shared = position(35037, 8000);
  const last = position(35100, 8000);
  const upstream = sampleMigrationCourse(record, first, shared, radius);
  const downstream = sampleMigrationCourse(record, shared, last, radius);
  assert.deepEqual(upstream[0], first);
  assert.deepEqual(upstream.at(-1), shared);
  assert.deepEqual(downstream[0], shared);
  assert.deepEqual(downstream.at(-1), last);
  for (const [points, start, end] of [
    [upstream, first, shared],
    [downstream, shared, last],
  ] as const) {
    const direction = end.map((value, axis) => value - start[axis]);
    let length = 0;
    points.forEach((point, index) => {
      const fraction = index / (points.length - 1);
      const baseline = normalizeVector(
        start.map((value, axis) => value * (1 - fraction) + end[axis] * fraction),
      );
      assert.ok(distance(point, baseline) < 0.01, 'no kilometre-scale inherited displacement');
      if (!index) {
        return;
      }
      assert.ok(
        point.reduce(
          (sum, value, axis) => sum + (value - points[index - 1][axis]) * direction[axis],
          0,
        ) > 0,
        'each short sample progresses toward its receiver',
      );
      length += distance(point, points[index - 1]);
    });
    assert.ok(length < distance(start, end) * 1.001);
  }
});

test('saved-course repair ignores Float32 noise and corrects the whole malformed curve', () => {
  const inherited = sampleMigrationCourse(record, record.start, record.end, radius);
  const original = Float32Array.from(inherited.flat());
  assert.equal(rebaseSavedRiverCourse(original, record.start, record.end), original);
  const start = position(0, 25000);
  const end = position(150000, 25000);
  const saved = rebaseSavedRiverCourse(original, start, end);
  assert.notEqual(saved, original);
  assert.deepEqual(Array.from(saved.slice(0, 3)), start.map(Math.fround));
  assert.deepEqual(Array.from(saved.slice(-3)), end.map(Math.fround));
  const expected = sampleMigrationCourse(record, start, end, radius);
  expected.forEach((point, index) =>
    assert.ok(distance(point, Array.from(saved.slice(index * 3, index * 3 + 3)) as Vec3) < 1),
  );
  assert.deepEqual(original, Float32Array.from(inherited.flat()), 'saved input remains immutable');
});
