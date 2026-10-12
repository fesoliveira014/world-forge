import type { Grid } from '../model';
import { calculateHeightGradient } from './spatial';

/** Limited linear reconstruction around each child-area centroid. The deviation
 * integrates to zero within every parent, so rainfall volume is conserved without
 * a second rescaling that would restore constant patches. The limiter preserves
 * positivity and neighboring coarse extrema.
 */
export function prolongRainfall(
  surface: Grid,
  process: Grid,
  parent: Uint32Array,
  fields: Float32Array[],
): Float32Array[] {
  const childArea = new Float64Array(process.count);
  const centroid = new Float64Array(process.count * 3);
  for (let cell = 0; cell < surface.count; cell++) {
    const coarse = parent[cell];
    const area = surface.areas[cell];
    childArea[coarse] += area;
    for (let axis = 0; axis < 3; axis++) {
      centroid[coarse * 3 + axis] += area * surface.positions[cell * 3 + axis];
    }
  }
  for (let coarse = 0; coarse < process.count; coarse++) {
    for (let axis = 0; axis < 3; axis++) {
      centroid[coarse * 3 + axis] /= childArea[coarse] || 1;
    }
  }

  return fields.map((field) => {
    const mean = Float32Array.from(field, (value, coarse) =>
      childArea[coarse] ? (value * process.areas[coarse]) / childArea[coarse] : 0,
    );
    const gradient = calculateHeightGradient(process, mean, 1);
    const lower = new Float32Array(mean);
    const upper = new Float32Array(mean);
    const limiter = new Float64Array(process.count).fill(1);
    const deviation = new Float64Array(surface.count);
    for (let coarse = 0; coarse < process.count; coarse++) {
      for (let offset = process.offsets[coarse]; offset < process.offsets[coarse + 1]; offset++) {
        const neighbor = process.neighbors[offset];
        lower[coarse] = Math.min(lower[coarse], mean[neighbor]);
        upper[coarse] = Math.max(upper[coarse], mean[neighbor]);
      }
    }
    for (let cell = 0; cell < surface.count; cell++) {
      const coarse = parent[cell];
      let delta = 0;
      for (let axis = 0; axis < 3; axis++) {
        delta +=
          gradient[coarse * 3 + axis] *
          (surface.positions[cell * 3 + axis] - centroid[coarse * 3 + axis]);
      }
      deviation[cell] = delta;
      if (delta !== 0) {
        const limit = delta > 0 ? upper[coarse] - mean[coarse] : lower[coarse] - mean[coarse];
        limiter[coarse] = Math.min(limiter[coarse], Math.max(0, limit / delta));
      }
    }
    return Float32Array.from(parent, (coarse, cell) =>
      Math.max(0, mean[coarse] + limiter[coarse] * deviation[cell]),
    );
  });
}
