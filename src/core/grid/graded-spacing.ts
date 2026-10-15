import type { Grid } from '../model';
import type { SpacingField } from './refine';

interface SpacingNode {
  minimum: [number, number, number];
  maximum: [number, number, number];
  minimumSpacing: number;
  maximumRadius: number;
  start: number;
  end: number;
  left: number;
  right: number;
}

/** Exact lower envelope of geodesic spacing cones, hence globally gradient-bounded.
 * Optional physical cap radii keep a sampled region at its target throughout its footprint.
 * A spatial tree bounds each cone group by its coordinate box and smallest target.
 * This avoids the excessive gradients possible with interpolation on skew triangles.
 */
export function createGradedSpacingField(
  grid: Pick<Grid, 'count' | 'positions'>,
  targetSpacing: Float64Array,
  radius: number,
  backgroundSpacing: number,
  gradient = 0.35,
  sourceRadii?: Float64Array,
): SpacingField {
  if (
    targetSpacing.length !== grid.count ||
    (sourceRadii !== undefined && sourceRadii.length !== grid.count) ||
    !(radius > 0) ||
    !Number.isFinite(radius) ||
    !(backgroundSpacing > 0) ||
    !Number.isFinite(backgroundSpacing) ||
    !(gradient > 0 && gradient <= 0.5)
  ) {
    throw Error('Graded spacing needs valid site targets, radius, background, and gradient.');
  }

  const active: number[] = [];

  for (let cell = 0; cell < grid.count; cell++) {
    if (!(targetSpacing[cell] > 0) || !Number.isFinite(targetSpacing[cell])) {
      throw Error('Every spacing target must be finite and positive.');
    }

    if (sourceRadii && (!Number.isFinite(sourceRadii[cell]) || sourceRadii[cell] < 0)) {
      throw Error('Spacing source radii must be finite and nonnegative.');
    }

    if (targetSpacing[cell] < backgroundSpacing) {
      active.push(cell);
    }
  }

  if (!active.length) {
    return () => backgroundSpacing;
  }

  const sites = Uint32Array.from(active);
  const nodes: SpacingNode[] = [];
  const build = (start: number, end: number): number => {
    const index = nodes.length;
    const node: SpacingNode = {
      minimum: [Infinity, Infinity, Infinity],
      maximum: [-Infinity, -Infinity, -Infinity],
      minimumSpacing: Infinity,
      maximumRadius: 0,
      start,
      end,
      left: -1,
      right: -1,
    };
    nodes.push(node);

    for (let entry = start; entry < end; entry++) {
      const cell = sites[entry];
      node.minimumSpacing = Math.min(node.minimumSpacing, targetSpacing[cell]);
      node.maximumRadius = Math.max(node.maximumRadius, sourceRadii?.[cell] ?? 0);

      for (let axis = 0; axis < 3; axis++) {
        const coordinate = grid.positions[cell * 3 + axis];
        node.minimum[axis] = Math.min(node.minimum[axis], coordinate);
        node.maximum[axis] = Math.max(node.maximum[axis], coordinate);
      }
    }

    if (end - start > 16) {
      let axis = 0;

      for (let candidate = 1; candidate < 3; candidate++) {
        if (
          node.maximum[candidate] - node.minimum[candidate] >
          node.maximum[axis] - node.minimum[axis]
        ) {
          axis = candidate;
        }
      }

      sites
        .subarray(start, end)
        .sort(
          (first, second) =>
            grid.positions[first * 3 + axis] - grid.positions[second * 3 + axis] || first - second,
        );
      const middle = (start + end) >>> 1;
      node.left = build(start, middle);
      node.right = build(middle, end);
    }

    return index;
  };
  build(0, sites.length);

  return (x, y, z) => {
    let best = backgroundSpacing;
    const lowerBound = (node: SpacingNode) => {
      const distanceX = Math.max(node.minimum[0] - x, 0, x - node.maximum[0]);
      const distanceY = Math.max(node.minimum[1] - y, 0, y - node.maximum[1]);
      const distanceZ = Math.max(node.minimum[2] - z, 0, z - node.maximum[2]);
      const angularDistance =
        2 * Math.asin(Math.min(1, Math.hypot(distanceX, distanceY, distanceZ) / 2));

      return (
        node.minimumSpacing + gradient * Math.max(0, radius * angularDistance - node.maximumRadius)
      );
    };
    const visit = (node: SpacingNode) => {
      if (lowerBound(node) >= best) {
        return;
      }

      if (node.left >= 0) {
        const left = nodes[node.left];
        const right = nodes[node.right];

        if (lowerBound(left) < lowerBound(right)) {
          visit(left);
          visit(right);
        } else {
          visit(right);
          visit(left);
        }

        return;
      }

      for (let entry = node.start; entry < node.end; entry++) {
        const cell = sites[entry];
        const siteX = grid.positions[cell * 3];
        const siteY = grid.positions[cell * 3 + 1];
        const siteZ = grid.positions[cell * 3 + 2];
        const distance = Math.atan2(
          Math.hypot(y * siteZ - z * siteY, z * siteX - x * siteZ, x * siteY - y * siteX),
          x * siteX + y * siteY + z * siteZ,
        );
        best = Math.min(
          best,
          targetSpacing[cell] +
            gradient * Math.max(0, radius * distance - (sourceRadii?.[cell] ?? 0)),
        );
      }
    };
    visit(nodes[0]);

    return best;
  };
}
