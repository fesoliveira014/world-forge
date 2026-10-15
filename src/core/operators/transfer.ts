import type { Grid } from '../model';
import { nearestCell } from '../grid/build';

/** Sparse intersections of two spherical Voronoi meshes, grouped by target cell.
 * Areas are steradians; centroids are area means of the unit-sphere position,
 * rather than normalized directions. Ownership IDs are deliberately separate.
 */
export interface OverlapTransfer {
  sourceCount: number;
  targetCount: number;
  offsets: Uint32Array;
  sources: Uint32Array;
  areas: Float64Array;
  centroids: Float64Array;
  sourceAreas: Float64Array;
  targetAreas: Float64Array;
}

type Point = [number, number, number];

function polygonForCell(grid: Grid, cell: number): Point[] {
  const polygon: Point[] = [];
  for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
    const corner = grid.cellCorners[offset];
    polygon.push([
      grid.corners[3 * corner],
      grid.corners[3 * corner + 1],
      grid.corners[3 * corner + 2],
    ]);
  }
  return polygon;
}

/** Great-circle clipping. The normalized chord intersection lies on both the
 * segment's great circle and the clipping plane, without a planar projection.
 */
function clipPolygon(polygon: Point[], x: number, y: number, z: number): Point[] {
  if (polygon.length === 0) {
    return polygon;
  }
  const clipped: Point[] = [];
  let previous = polygon[polygon.length - 1];
  let previousDistance = previous[0] * x + previous[1] * y + previous[2] * z;
  for (const point of polygon) {
    const distance = point[0] * x + point[1] * y + point[2] * z;
    if (previousDistance < 0 !== distance < 0) {
      const previousWeight = Math.abs(distance);
      const pointWeight = Math.abs(previousDistance);
      const intersectionX = previous[0] * previousWeight + point[0] * pointWeight;
      const intersectionY = previous[1] * previousWeight + point[1] * pointWeight;
      const intersectionZ = previous[2] * previousWeight + point[2] * pointWeight;
      const length = Math.hypot(intersectionX, intersectionY, intersectionZ);
      if (length > 0) {
        clipped.push([intersectionX / length, intersectionY / length, intersectionZ / length]);
      }
    }
    if (distance >= 0) {
      clipped.push(point);
    }
    previous = point;
    previousDistance = distance;
  }
  return clipped;
}

function intersectCell(polygon: Point[], grid: Grid, cell: number): Point[] {
  let intersection = polygon;
  const x = grid.positions[3 * cell];
  const y = grid.positions[3 * cell + 1];
  const z = grid.positions[3 * cell + 2];
  for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
    const neighbor = grid.neighbors[offset];
    intersection = clipPolygon(
      intersection,
      x - grid.positions[3 * neighbor],
      y - grid.positions[3 * neighbor + 1],
      z - grid.positions[3 * neighbor + 2],
    );
    if (intersection.length < 3) {
      return [];
    }
  }
  return intersection;
}

function polygonMoments(polygon: Point[]): { area: number; centroid: Point } {
  if (polygon.length < 3) {
    return { area: 0, centroid: [0, 0, 0] };
  }
  let centerX = 0;
  let centerY = 0;
  let centerZ = 0;
  for (const point of polygon) {
    centerX += point[0];
    centerY += point[1];
    centerZ += point[2];
  }
  const centerLength = Math.hypot(centerX, centerY, centerZ);
  centerX /= centerLength;
  centerY /= centerLength;
  centerZ /= centerLength;

  let area = 0;
  let momentX = 0;
  let momentY = 0;
  let momentZ = 0;
  for (let vertex = 0; vertex < polygon.length; vertex++) {
    const first = polygon[vertex];
    const second = polygon[(vertex + 1) % polygon.length];
    const crossX = first[1] * second[2] - first[2] * second[1];
    const crossY = first[2] * second[0] - first[0] * second[2];
    const crossZ = first[0] * second[1] - first[1] * second[0];
    const dot = first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
    // Subtraction before the determinant avoids cancellation on small cells.
    const firstX = first[0] - centerX;
    const firstY = first[1] - centerY;
    const firstZ = first[2] - centerZ;
    const secondX = second[0] - centerX;
    const secondY = second[1] - centerY;
    const secondZ = second[2] - centerZ;
    const determinant =
      centerX * (firstY * secondZ - firstZ * secondY) +
      centerY * (firstZ * secondX - firstX * secondZ) +
      centerZ * (firstX * secondY - firstY * secondX);
    area +=
      2 *
      Math.atan2(
        determinant,
        1 +
          dot +
          centerX * (first[0] + second[0]) +
          centerY * (first[1] + second[1]) +
          centerZ * (first[2] + second[2]),
      );
    const crossLength = Math.hypot(crossX, crossY, crossZ);
    if (crossLength > 0) {
      // The edge first moments are 1/2 * angle * unit edge normal.
      // Their leading center-cross-edge terms telescope. Cancel those
      // symbolically to retain precision for small or narrow intersections.
      const correction = Math.atan2(crossLength, dot) / crossLength - 1;
      momentX += 0.5 * (firstY * secondZ - firstZ * secondY + correction * crossX);
      momentY += 0.5 * (firstZ * secondX - firstX * secondZ + correction * crossY);
      momentZ += 0.5 * (firstX * secondY - firstY * secondX + correction * crossZ);
    }
  }
  if (Math.abs(area) < 1e-24) {
    return { area: 0, centroid: [0, 0, 0] };
  }
  return {
    area: Math.abs(area),
    centroid: [momentX / area, momentY / area, momentZ / area],
  };
}

/** Visit only the connected source cells intersecting each target and their
 * immediate neighbors. A nearest-cell walk seeds traversal; it never assigns
 * an overlap's area. This remains sparse for unrelated or locally refined grids.
 */
export function buildOverlapTransfer(source: Grid, target: Grid): OverlapTransfer {
  const offsets = new Uint32Array(target.count + 1);
  const sources: number[] = [];
  const areas: number[] = [];
  const centroids: number[] = [];
  const visited = new Uint32Array(source.count);
  let start = 0;
  for (let targetCell = 0; targetCell < target.count; targetCell++) {
    const polygon = polygonForCell(target, targetCell);
    if (source === target) {
      const moments = polygonMoments(polygon);
      sources.push(targetCell);
      areas.push(target.areas[targetCell]);
      centroids.push(...moments.centroid);
    } else {
      start = nearestCell(
        source,
        target.positions[3 * targetCell],
        target.positions[3 * targetCell + 1],
        target.positions[3 * targetCell + 2],
        start,
      );
      const queue = [start];
      visited[start] = targetCell + 1;
      for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
        const sourceCell = queue[queueIndex];
        const intersection = intersectCell(polygon, source, sourceCell);
        const moments = polygonMoments(intersection);
        // Identical boundaries can leave floating-point slivers after clipping.
        // Their area is below the geometric precision of the incident cells.
        if (moments.area <= 1e-13 * Math.min(source.areas[sourceCell], target.areas[targetCell])) {
          continue;
        }
        sources.push(sourceCell);
        areas.push(moments.area);
        centroids.push(...moments.centroid);
        for (
          let offset = source.offsets[sourceCell];
          offset < source.offsets[sourceCell + 1];
          offset++
        ) {
          const neighbor = source.neighbors[offset];
          if (visited[neighbor] !== targetCell + 1) {
            visited[neighbor] = targetCell + 1;
            queue.push(neighbor);
          }
        }
      }
    }
    offsets[targetCell + 1] = sources.length;
  }
  return {
    sourceCount: source.count,
    targetCount: target.count,
    offsets,
    sources: Uint32Array.from(sources),
    areas: Float64Array.from(areas),
    centroids: Float64Array.from(centroids),
    sourceAreas: source.areas,
    targetAreas: target.areas,
  };
}

/** Area-mean density transfer, preserving constants and the integrated field. */
export function transferDensity(mapping: OverlapTransfer, values: ArrayLike<number>): Float64Array {
  const result = new Float64Array(mapping.targetCount);
  for (let target = 0; target < mapping.targetCount; target++) {
    for (let overlap = mapping.offsets[target]; overlap < mapping.offsets[target + 1]; overlap++) {
      result[target] += mapping.areas[overlap] * values[mapping.sources[overlap]];
    }
    result[target] /= mapping.targetAreas[target];
  }
  return result;
}

/** Extensive inventory transfer: divide by source area before distributing. */
export function transferInventory(
  mapping: OverlapTransfer,
  values: ArrayLike<number>,
): Float64Array {
  const result = new Float64Array(mapping.targetCount);
  for (let target = 0; target < mapping.targetCount; target++) {
    for (let overlap = mapping.offsets[target]; overlap < mapping.offsets[target + 1]; overlap++) {
      const source = mapping.sources[overlap];
      result[target] += (mapping.areas[overlap] * values[source]) / mapping.sourceAreas[source];
    }
  }
  return result;
}

/** Apply the same intersections in reverse without constructing another map. */
export function restrictDensity(mapping: OverlapTransfer, values: ArrayLike<number>): Float64Array {
  const result = new Float64Array(mapping.sourceCount);
  for (let target = 0; target < mapping.targetCount; target++) {
    for (let overlap = mapping.offsets[target]; overlap < mapping.offsets[target + 1]; overlap++) {
      result[mapping.sources[overlap]] += mapping.areas[overlap] * values[target];
    }
  }
  for (let source = 0; source < mapping.sourceCount; source++) {
    result[source] /= mapping.sourceAreas[source];
  }
  return result;
}
