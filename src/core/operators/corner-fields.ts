import type { Grid } from '../model';
import { cross, dot, normalizeVector, readVector, type Vec3 } from '../math';

export interface CornerSupport {
  /** Steradians associated with each cell/corner pair, indexed like cellCorners. */
  cellCornerArea: Float64Array;
  /** Fraction of a cell assigned to each of its corners, indexed like cellCorners. */
  cellCornerFraction: Float64Array;
  /** The same support areas indexed like triangles, for corner-to-cell traversal. */
  cornerCellArea: Float64Array;
  /** Sum of the three incident cell support areas, in steradians. */
  cornerArea: Float64Array;
}

const supportCache = new WeakMap<Grid, CornerSupport>();
const reconstructionCache = new WeakMap<Grid, Float64Array>();

function sphericalTriangleArea(first: Vec3, second: Vec3, third: Vec3) {
  return (
    2 *
    Math.atan2(
      Math.abs(dot(first, cross(second, third))),
      1 + dot(first, second) + dot(second, third) + dot(third, first),
    )
  );
}

/** Partition each spherical cell at the midpoints of its polygon edges. These
 * sectors are geometric support volumes, distinct from interpolation weights.
 * Normalize per cell so integrated rain, runoff and sediment remain conservative.
 * Geometry is immutable for a Grid; rebuilding a mesh creates a new cache entry.
 */
export function computeCornerSupport(grid: Grid): CornerSupport {
  const cached = supportCache.get(grid);

  if (cached) {
    return cached;
  }

  const cellCornerArea = new Float64Array(grid.cellCorners.length);
  const cellCornerFraction = new Float64Array(grid.cellCorners.length);
  const cornerCellArea = new Float64Array(grid.triangles.length);
  const cornerArea = new Float64Array(grid.corners.length / 3);

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    const firstOffset = grid.offsets[cellIndex];
    const endOffset = grid.offsets[cellIndex + 1];
    const position = readVector(grid.positions, cellIndex);

    for (let offset = firstOffset; offset < endOffset; offset++) {
      const nextOffset = offset + 1 === endOffset ? firstOffset : offset + 1;
      const corner = readVector(grid.corners, grid.cellCorners[offset]);
      const nextCorner = readVector(grid.corners, grid.cellCorners[nextOffset]);
      const midpoint = normalizeVector([
        corner[0] + nextCorner[0],
        corner[1] + nextCorner[1],
        corner[2] + nextCorner[2],
      ]);
      cellCornerArea[offset] += sphericalTriangleArea(position, corner, midpoint);
      cellCornerArea[nextOffset] += sphericalTriangleArea(position, midpoint, nextCorner);
    }

    let totalArea = 0;

    for (let offset = firstOffset; offset < endOffset; offset++) {
      totalArea += cellCornerArea[offset];
    }

    for (let offset = firstOffset; offset < endOffset; offset++) {
      const fraction =
        totalArea > 0 ? cellCornerArea[offset] / totalArea : 1 / (endOffset - firstOffset);
      const supportArea = fraction * grid.areas[cellIndex];
      const cornerIndex = grid.cellCorners[offset];
      cellCornerFraction[offset] = fraction;
      cellCornerArea[offset] = supportArea;
      cornerArea[cornerIndex] += supportArea;

      for (let incidentIndex = 0; incidentIndex < 3; incidentIndex++) {
        const incidence = cornerIndex * 3 + incidentIndex;

        if (grid.triangles[incidence] === cellIndex) {
          cornerCellArea[incidence] = supportArea;
          break;
        }
      }
    }
  }

  const result = { cellCornerArea, cellCornerFraction, cornerCellArea, cornerArea };
  supportCache.set(grid, result);

  return result;
}

function reconstructionWeights(grid: Grid): Float64Array {
  const cached = reconstructionCache.get(grid);

  if (cached) {
    return cached;
  }

  const weights = new Float64Array(grid.triangles.length);

  for (let cornerIndex = 0; cornerIndex < grid.corners.length / 3; cornerIndex++) {
    const normal = readVector(grid.corners, cornerIndex);
    const tangent: Vec3[] = [];

    for (let incidentIndex = 0; incidentIndex < 3; incidentIndex++) {
      const position = readVector(grid.positions, grid.triangles[cornerIndex * 3 + incidentIndex]);
      const radial = dot(position, normal);
      tangent.push([
        position[0] - radial * normal[0],
        position[1] - radial * normal[1],
        position[2] - radial * normal[2],
      ]);
    }

    const firstWeight = dot(normal, cross(tangent[1], tangent[2]));
    const secondWeight = dot(normal, cross(tangent[2], tangent[0]));
    const thirdWeight = dot(normal, cross(tangent[0], tangent[1]));
    const determinant = firstWeight + secondWeight + thirdWeight;
    const scale = Math.max(...tangent.map((position) => dot(position, position)));
    const singular = Math.abs(determinant) <= scale * 1e-12;
    weights[cornerIndex * 3] = singular ? 1 / 3 : firstWeight / determinant;
    weights[cornerIndex * 3 + 1] = singular ? 1 / 3 : secondWeight / determinant;
    weights[cornerIndex * 3 + 2] = singular ? 1 / 3 : thirdWeight / determinant;
  }

  reconstructionCache.set(grid, weights);

  return weights;
}

/** Reconstruct a scalar at the actual dual corner in its tangent plane. On an
 * obtuse triangle the circumcenter can lie outside the incident centers, so bound
 * the result to their extrema. Constants survive exactly; no new extrema appear.
 * Routing, incision and rendered terrain all use this same corner field.
 */
export function reconstructCornerField(
  grid: Grid,
  values: ArrayLike<number>,
  result = new Float32Array(grid.corners.length / 3),
): Float32Array {
  const weights = reconstructionWeights(grid);

  for (let cornerIndex = 0; cornerIndex < result.length; cornerIndex++) {
    const offset = cornerIndex * 3;
    const first = values[grid.triangles[offset]];
    const second = values[grid.triangles[offset + 1]];
    const third = values[grid.triangles[offset + 2]];
    const reconstructed =
      first + weights[offset + 1] * (second - first) + weights[offset + 2] * (third - first);
    result[cornerIndex] = Math.max(
      Math.min(first, second, third),
      Math.min(Math.max(first, second, third), reconstructed),
    );
  }

  return result;
}

/** Split an extensive cell inventory using its associated corner support areas. */
export function distributeCellInventory(
  grid: Grid,
  inventory: ArrayLike<number>,
  result = new Float64Array(grid.corners.length / 3),
): Float64Array {
  const { cellCornerFraction } = computeCornerSupport(grid);
  result.fill(0);

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    for (let offset = grid.offsets[cellIndex]; offset < grid.offsets[cellIndex + 1]; offset++) {
      result[grid.cellCorners[offset]] += inventory[cellIndex] * cellCornerFraction[offset];
    }
  }

  return result;
}
