import { normalizeVector, readVector, type Vec3 } from '../math';

/** Carry a geographic bend onto new routing junctions without inserting a
 * one-sample connector at either end. The inherited bend remains relative to
 * its own chord; only that chord is moved to the authoritative routed reach.
 */
export function rebaseRiverCourse(points: readonly Vec3[], start: Vec3, end: Vec3): Vec3[] {
  if (points.length < 2) {
    return [start, end];
  }
  const first = points[0];
  const last = points[points.length - 1];
  const result = points.map((point, index) => {
    const fraction = index / (points.length - 1);
    return normalizeVector(
      point.map(
        (value, axis) =>
          value +
          (start[axis] - first[axis]) * (1 - fraction) +
          (end[axis] - last[axis]) * fraction,
      ),
    );
  });
  result[0] = start;
  result[result.length - 1] = end;
  return result;
}

/** Older refined snapshots can contain inherited points whose chord never
 * reached their routing nodes. Leave ordinary saved courses byte-for-byte
 * intact; their Float32 normalization error is smaller than this tolerance.
 */
export function rebaseSavedRiverCourse(points: Float32Array, start: Vec3, end: Vec3): Float32Array {
  const first = readVector(points, 0);
  const last = readVector(points, points.length / 3 - 1);
  const distance = (a: Vec3, b: Vec3) => Math.hypot(...a.map((value, axis) => value - b[axis]));
  if (distance(first, start) <= 2e-7 && distance(last, end) <= 2e-7) {
    return points;
  }
  return Float32Array.from(
    rebaseRiverCourse(
      Array.from({ length: points.length / 3 }, (_, point) => readVector(points, point)),
      start,
      end,
    ).flat(),
  );
}
