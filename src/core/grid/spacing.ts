import type { Grid } from '../model';

export interface GridSpacing {
  min: number;
  p10: number;
  median: number;
  p90: number;
  max: number;
  mean: number;
}

/** Per-cell nearest adjacent center distance, in metres. Quantiles count cells,
 * so refinement remains visible instead of being hidden by large coarse areas.
 * Keep this diagnostic separate from generation and cache it in UI consumers.
 */
export function gridSpacing(grid: Grid, radius: number): GridSpacing {
  const distances = new Float64Array(grid.count).fill(Infinity);

  for (let edge = 0; edge < grid.edgeDistance.length; edge++) {
    const firstCell = grid.edgeCells[edge * 2];
    const secondCell = grid.edgeCells[edge * 2 + 1];
    const distance = grid.edgeDistance[edge] * radius;
    distances[firstCell] = Math.min(distances[firstCell], distance);
    distances[secondCell] = Math.min(distances[secondCell], distance);
  }

  distances.sort();
  let total = 0;

  for (const distance of distances) {
    total += distance;
  }

  const quantile = (fraction: number) => {
    const index = fraction * (distances.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    return distances[lower] + (distances[upper] - distances[lower]) * (index - lower);
  };

  return {
    min: distances[0],
    p10: quantile(0.1),
    median: quantile(0.5),
    p90: quantile(0.9),
    max: distances[distances.length - 1],
    mean: total / distances.length,
  };
}
