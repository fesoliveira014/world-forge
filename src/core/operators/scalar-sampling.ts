import type { Grid } from '../model';
import { nearestCell } from '../grid/build';

export interface ScalarStencil {
  cells: Uint32Array;
  weights: Float64Array;
}

/** Piecewise linear values on radial projections of the spherical Delaunay faces.
 * Adjacent faces share their edge interpolation, independent of Voronoi ownership.
 * The returned stencil is reused by the next call; consume it before sampling again.
 */
export function createScalarStencilSampler(grid: Grid) {
  const cells = new Uint32Array(3);
  const weights = new Float64Array(3);
  const stencil = { cells, weights };
  let previousCell = 0;

  return (x: number, y: number, z: number, startCell = previousCell): ScalarStencil => {
    previousCell = nearestCell(grid, x, y, z, startCell);
    let corner = grid.cellCorners[grid.offsets[previousCell]];

    // Walking across a negative barycentric coordinate finds the containing face.
    // Start at the nearest site's star, so ordinary lookups cross only a few edges.
    for (let visited = 0; visited < grid.triangles.length / 3; visited++) {
      const triangleOffset = corner * 3;

      for (let vertex = 0; vertex < 3; vertex++) {
        cells[vertex] = grid.triangles[triangleOffset + vertex];
        const first = grid.triangles[triangleOffset + ((vertex + 1) % 3)] * 3;
        const second = grid.triangles[triangleOffset + ((vertex + 2) % 3)] * 3;
        // Subtract the query before the cross product to avoid cancellation on
        // tiny refined faces, and to reproduce exact site values at every scale.
        const firstX = grid.positions[first] - x;
        const firstY = grid.positions[first + 1] - y;
        const firstZ = grid.positions[first + 2] - z;
        const secondX = grid.positions[second] - x;
        const secondY = grid.positions[second + 1] - y;
        const secondZ = grid.positions[second + 2] - z;
        weights[vertex] =
          x * (firstY * secondZ - firstZ * secondY) +
          y * (firstZ * secondX - firstX * secondZ) +
          z * (firstX * secondY - firstY * secondX);
      }

      let smallest = 0;

      for (let vertex = 1; vertex < 3; vertex++) {
        if (weights[vertex] < weights[smallest]) {
          smallest = vertex;
        }
      }

      const sum = weights[0] + weights[1] + weights[2];

      if (sum > 0 && weights[smallest] >= -1e-12 * sum) {
        const positiveSum =
          Math.max(0, weights[0]) + Math.max(0, weights[1]) + Math.max(0, weights[2]);

        for (let vertex = 0; vertex < 3; vertex++) {
          weights[vertex] = Math.max(0, weights[vertex]) / positiveSum;
        }

        return stencil;
      }

      corner = grid.cornerNeighbors[triangleOffset + ((smallest + 1) % 3)];
    }

    throw Error('Scalar sampling could not locate a containing spherical triangle.');
  };
}

export function sampleScalarStencil(stencil: ScalarStencil, values: ArrayLike<number>): number {
  return (
    values[stencil.cells[0]] * stencil.weights[0] +
    values[stencil.cells[1]] * stencil.weights[1] +
    values[stencil.cells[2]] * stencil.weights[2]
  );
}

/** Bounded intensive interpolation; categorical ownership remains nearest-cell. */
export function createScalarSampler(grid: Grid, values: ArrayLike<number>) {
  const locate = createScalarStencilSampler(grid);

  return (x: number, y: number, z: number, startCell?: number): number =>
    sampleScalarStencil(locate(x, y, z, startCell), values);
}
