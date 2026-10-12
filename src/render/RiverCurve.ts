import * as THREE from 'three';

/** Round the routing grid's corners without moving its junctions. The strongest
 * upstream reach supplies the incoming guide; only that trunk follows the next
 * outgoing guide. Physical bend detail is retained over this smooth baseline.
 */
export function curveRiverPath(
  points: Float32Array,
  previous: THREE.Vector3 | null,
  next: THREE.Vector3 | null,
): Float32Array {
  const first = new THREE.Vector3().fromArray(points, 0);
  const last = new THREE.Vector3().fromArray(points, points.length - 3);
  const chord = last.clone().sub(first);
  const length = chord.length();
  if (length < 1e-7 || (!previous && !next)) {
    return points;
  }

  const firstControl = first.clone().addScaledVector(chord, 1 / 3);
  const lastControl = last.clone().addScaledVector(chord, -1 / 3);
  const tangent = new THREE.Vector3();
  if (previous) {
    tangent.copy(last).sub(previous).addScaledVector(first, -tangent.dot(first)).normalize();
    if (tangent.dot(chord) > 0) {
      firstControl
        .copy(first)
        .addScaledVector(tangent, Math.min(length, first.distanceTo(previous)) / 3);
    }
  }
  if (next) {
    tangent.copy(next).sub(first).addScaledVector(last, -tangent.dot(last)).normalize();
    if (tangent.dot(chord) > 0) {
      lastControl.copy(last).addScaledVector(tangent, -Math.min(length, last.distanceTo(next)) / 3);
    }
  }

  const count = points.length / 3;
  const distances = new Float64Array(count);
  const point = new THREE.Vector3();
  const before = new THREE.Vector3();
  for (let sample = 1; sample < count; sample++) {
    before.fromArray(points, (sample - 1) * 3);
    point.fromArray(points, sample * 3);
    distances[sample] = distances[sample - 1] + before.distanceTo(point);
  }
  const total = distances[count - 1];
  const segments = Math.max(12, (count - 1) * 2);
  const samples = new Float32Array((segments + 1) * 3);
  const baseline = new THREE.Vector3();
  const detail = new THREE.Vector3();
  let interval = 1;
  for (let sample = 0; sample <= segments; sample++) {
    const fraction = sample / segments;
    const remaining = 1 - fraction;
    const distance = fraction * total;
    while (interval < count - 1 && distances[interval] < distance) {
      interval++;
    }
    const span = distances[interval] - distances[interval - 1];
    const along = span > 0 ? (distance - distances[interval - 1]) / span : 0;
    before.fromArray(points, (interval - 1) * 3);
    point.fromArray(points, interval * 3);
    detail.copy(before).lerp(point, along);
    baseline.copy(first).lerp(last, fraction).normalize();
    detail.sub(baseline);

    // Fade only the ends of the per-reach meander so neighboring courses share
    // a tangent instead of starting an unrelated sine wave at every grid node.
    const fade =
      THREE.MathUtils.smoothstep(fraction, 0, 0.2) *
      (1 - THREE.MathUtils.smoothstep(fraction, 0.8, 1));
    point
      .copy(first)
      .multiplyScalar(remaining ** 3)
      .addScaledVector(firstControl, 3 * remaining ** 2 * fraction)
      .addScaledVector(lastControl, 3 * remaining * fraction ** 2)
      .addScaledVector(last, fraction ** 3)
      .addScaledVector(detail, fade)
      .normalize()
      .toArray(samples, sample * 3);
  }
  samples.set(points.subarray(0, 3), 0);
  samples.set(points.subarray(points.length - 3), samples.length - 3);
  const retained = simplifyRiverPath(samples, length * 0.0005);
  return Float32Array.from(
    retained.flatMap((sample) => Array.from(samples.subarray(sample * 3, sample * 3 + 3))),
  );
}

/** Retain the course to a geographic error bound, independent of stroke width. */
export function simplifyRiverPath(points: Float32Array, tolerance: number): number[] {
  const last = points.length / 3 - 1;
  const keep = new Uint8Array(last + 1);
  keep[0] = keep[last] = 1;
  const stack = [0, last];
  const startPosition = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const pointOffset = new THREE.Vector3();

  while (stack.length) {
    const end = stack.pop()!;
    const start = stack.pop()!;
    startPosition.fromArray(points, start * 3);
    direction.fromArray(points, end * 3).sub(startPosition);
    const segmentLengthSquared = direction.lengthSq();
    let farthest = -1;
    let maximumErrorSquared = tolerance * tolerance;

    for (let pointIndex = start + 1; pointIndex < end; pointIndex++) {
      pointOffset.fromArray(points, pointIndex * 3).sub(startPosition);
      const alongFraction =
        segmentLengthSquared > 0
          ? THREE.MathUtils.clamp(pointOffset.dot(direction) / segmentLengthSquared, 0, 1)
          : 0;
      const distanceSquared = pointOffset.addScaledVector(direction, -alongFraction).lengthSq();

      if (distanceSquared > maximumErrorSquared) {
        maximumErrorSquared = distanceSquared;
        farthest = pointIndex;
      }
    }

    if (farthest >= 0) {
      keep[farthest] = 1;
      stack.push(start, farthest, farthest, end);
    }
  }

  return Array.from(keep.keys()).filter((pointIndex) => keep[pointIndex]);
}
