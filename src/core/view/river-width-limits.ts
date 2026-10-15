/** Camera-independent safety limits for cartographic water strokes.
 * A stroke wider than the centerline's local bend radius folds over itself.
 * Tangential circumcircles distinguish actual river bends from the curvature
 * of the planet, while a distance-based envelope avoids abrupt width changes.
 */
export function riverCurvatureLimits(
  positions: Float32Array,
  start = 0,
  end = positions.length / 3,
  incoming?: ArrayLike<number>,
): Float32Array {
  const halo = incoming && Math.hypot(incoming[0], incoming[1], incoming[2]) > 0 ? 1 : 0;
  const count = end - start + halo;
  const points = new Float64Array(count * 3);
  for (let point = 0; point < count; point++) {
    const source = point < halo ? incoming! : positions;
    const offset = point < halo ? 0 : (start + point - halo) * 3;
    const length = Math.hypot(source[offset], source[offset + 1], source[offset + 2]);
    for (let component = 0; component < 3; component++) {
      points[point * 3 + component] = source[offset + component] / length;
    }
  }
  // One radian is effectively unbounded relative to allowed display widths,
  // and keeps render-only packets finite and serializable.
  const limits = new Float64Array(count).fill(1);
  const distances = new Float64Array(count);
  const along = new Float64Array(count);
  for (let point = 1; point < count; point++) {
    const a = (point - 1) * 3;
    const b = point * 3;
    const chord = Math.hypot(
      points[b] - points[a],
      points[b + 1] - points[a + 1],
      points[b + 2] - points[a + 2],
    );
    distances[point] = 2 * Math.asin(Math.min(1, chord / 2));
    along[point] = along[point - 1] + distances[point];
  }
  let firstSupport = 0;
  let lastSupport = 0;
  for (let point = 1; point + 1 < count; point++) {
    // Expand only unresolved turns. A fixed geographic support ceiling avoids
    // reaching unrelated distant meanders on a densely subdivided straight.
    // The immediate neighbors always remain available on coarse paths.
    while (along[point] - along[firstSupport] > 0.001) {
      firstSupport++;
    }
    while (lastSupport + 1 < count && along[lastSupport + 1] - along[point] <= 0.001) {
      lastSupport++;
    }
    const first = Math.min(point - 1, firstSupport);
    const last = Math.max(point + 1, lastSupport);
    let span = 1;
    while (true) {
      const before = Math.max(first, point - span);
      const after = Math.min(last, point + span);
      const a = before * 3;
      const b = point * 3;
      const c = after * 3;
      const abx = points[b] - points[a];
      const aby = points[b + 1] - points[a + 1];
      const abz = points[b + 2] - points[a + 2];
      const bcx = points[c] - points[b];
      const bcy = points[c + 1] - points[b + 1];
      const bcz = points[c + 2] - points[b + 2];
      const acx = points[c] - points[a];
      const acy = points[c + 1] - points[a + 1];
      const acz = points[c + 2] - points[a + 2];
      const ab = Math.hypot(abx, aby, abz);
      const bc = Math.hypot(bcx, bcy, bcz);
      const ac = Math.hypot(acx, acy, acz);
      const bend = Math.abs(
        (aby * acz - abz * acy) * points[b] +
          (abz * acx - abx * acz) * points[b + 1] +
          (abx * acy - aby * acx) * points[b + 2],
      );
      // Float32 samples perturb straight great circles. When a local turn is
      // below positional precision, wider samples resolve real dense curves
      // instead of incorrectly treating them as infinitely wide-safe strokes.
      if (bend > 4 * 2 ** -24 * Math.max(ab, bc, ac)) {
        const radius = (ab * bc * ac) / (2 * bend);
        limits[point] = Math.min(1, 0.4 * radius);
        break;
      }
      if (before === first && after === last) {
        break;
      }
      span *= 2;
    }
  }
  // A shallow world-space recovery preserves an approximately uniform stroke
  // through successive bends, rather than widening at every inflection. The
  // restriction fades with geographic distance; it is not a path-wide minimum.
  for (let point = 1; point < count; point++) {
    limits[point] = Math.min(limits[point], limits[point - 1] + 0.03 * distances[point]);
  }
  for (let point = count - 2; point >= 0; point--) {
    limits[point] = Math.min(limits[point], limits[point + 1] + 0.03 * distances[point + 1]);
  }
  return Float32Array.from(limits.subarray(halo));
}
