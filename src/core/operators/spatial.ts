import type { Grid } from '../model';
import { MinHeap } from '../math';
import { nearestCell } from '../grid/build';
import type { OverlapTransfer } from './transfer';

export function buildTransfer(processGrid: Grid, surfaceGrid: Grid): Uint32Array {
  const surfaceToProcess = new Uint32Array(surfaceGrid.count);

  if (processGrid === surfaceGrid) {
    for (let cellIndex = 0; cellIndex < surfaceToProcess.length; cellIndex++) {
      surfaceToProcess[cellIndex] = cellIndex;
    }

    return surfaceToProcess;
  }

  let start = 0;

  for (let cellIndex = 0; cellIndex < surfaceToProcess.length; cellIndex++) {
    start = nearestCell(
      processGrid,
      surfaceGrid.positions[3 * cellIndex],
      surfaceGrid.positions[3 * cellIndex + 1],
      surfaceGrid.positions[3 * cellIndex + 2],
      start,
    );
    surfaceToProcess[cellIndex] = start;
  }

  return surfaceToProcess;
}

/** Multi-source shortest distances, in metres. */
export function computeDistances(
  grid: Grid,
  seeds: ArrayLike<number>,
  radius: number,
  source?: Int32Array,
): Float32Array {
  const distance = new Float32Array(grid.count).fill(Infinity);
  const heap = new MinHeap();

  for (let cellIndex = 0; cellIndex < seeds.length; cellIndex++) {
    distance[seeds[cellIndex]] = 0;

    if (source) {
      source[seeds[cellIndex]] = seeds[cellIndex];
    }

    heap.push(seeds[cellIndex], 0);
  }

  while (heap.size) {
    const [cellIndex, currentDistance] = heap.pop();

    if (currentDistance > distance[cellIndex] + 0.1) {
      continue;
    }

    for (
      let neighborOffset = grid.offsets[cellIndex];
      neighborOffset < grid.offsets[cellIndex + 1];
      neighborOffset++
    ) {
      const neighborCell = grid.neighbors[neighborOffset];
      const candidateDistance =
        currentDistance + grid.edgeDistance[grid.arcEdges[neighborOffset]] * radius;

      if (candidateDistance < distance[neighborCell]) {
        distance[neighborCell] = candidateDistance;

        if (source) {
          source[neighborCell] = source[cellIndex];
        }

        heap.push(neighborCell, distance[neighborCell]);
      }
    }
  }

  return distance;
}

/** Restrict land and ocean separately; preserve a resolved ridge summary. */
export function restrictSurface(
  grid: Grid,
  processGrid: Grid,
  surfaceToProcess: Uint32Array,
  height: Float32Array,
  ocean: Uint8Array,
  overlaps?: OverlapTransfer,
) {
  const area = new Float64Array(processGrid.count);
  const landArea = new Float64Array(processGrid.count);
  const landHeight = new Float64Array(processGrid.count);
  const depth = new Float64Array(processGrid.count);
  const barrier = new Float32Array(processGrid.count);

  const accumulate = (cellIndex: number, processCell: number, cellArea: number) => {
    area[processCell] += cellArea;

    if (ocean[cellIndex]) {
      depth[processCell] += height[cellIndex] * cellArea;
    } else {
      landArea[processCell] += cellArea;
      landHeight[processCell] += height[cellIndex] * cellArea;
      barrier[processCell] = Math.max(barrier[processCell], height[cellIndex]);
    }
  };
  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    if (overlaps) {
      for (
        let overlap = overlaps.offsets[cellIndex];
        overlap < overlaps.offsets[cellIndex + 1];
        overlap++
      ) {
        accumulate(cellIndex, overlaps.sources[overlap], overlaps.areas[overlap]);
      }
    } else {
      accumulate(cellIndex, surfaceToProcess[cellIndex], grid.areas[cellIndex]);
    }
  }

  const meanHeight = new Float32Array(processGrid.count);
  const oceanMask = new Uint8Array(processGrid.count);
  const fraction = new Float32Array(processGrid.count);

  for (let processCell = 0; processCell < processGrid.count; processCell++) {
    fraction[processCell] = area[processCell] ? landArea[processCell] / area[processCell] : 0;
    oceanMask[processCell] = +(fraction[processCell] < 0.5);
    meanHeight[processCell] = oceanMask[processCell]
      ? depth[processCell] / Math.max(area[processCell] - landArea[processCell], 1e-20)
      : landHeight[processCell] / Math.max(landArea[processCell], 1e-20);
  }

  return { height: meanHeight, ocean: oceanMask, landFraction: fraction, barrier, childArea: area };
}

/** Inverse-distance weighted 2x2 least-squares fit in each cell's tangent plane.
 * A rank-deficient stencil uses the resolved direction's pseudoinverse; it does
 * not amplify an unconstrained transverse slope. Units are field units / metre.
 */
export function calculateHeightGradient(
  grid: Grid,
  height: ArrayLike<number>,
  radius: number,
): Float32Array {
  const heightGradient = new Float32Array(grid.count * 3);
  if (!(radius > 0) || !Number.isFinite(radius)) {
    throw new Error('Gradient radius must be positive and finite.');
  }
  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    const x = grid.positions[3 * cellIndex];
    const y = grid.positions[3 * cellIndex + 1];
    const z = grid.positions[3 * cellIndex + 2];
    const axisLength = Math.abs(y) < 0.9 ? Math.hypot(x, z) : Math.hypot(y, z);
    const firstX = Math.abs(y) < 0.9 ? -z / axisLength : 0;
    const firstY = Math.abs(y) < 0.9 ? 0 : z / axisLength;
    const firstZ = Math.abs(y) < 0.9 ? x / axisLength : -y / axisLength;
    const secondX = y * firstZ - z * firstY;
    const secondY = z * firstX - x * firstZ;
    const secondZ = x * firstY - y * firstX;
    let firstSquared = 0;
    let crossTerm = 0;
    let secondSquared = 0;
    let firstDifference = 0;
    let secondDifference = 0;
    for (let offset = grid.offsets[cellIndex]; offset < grid.offsets[cellIndex + 1]; offset++) {
      const neighbor = grid.neighbors[offset];
      const deltaX = grid.positions[3 * neighbor] - x;
      const deltaY = grid.positions[3 * neighbor + 1] - y;
      const deltaZ = grid.positions[3 * neighbor + 2] - z;
      const firstDistance = deltaX * firstX + deltaY * firstY + deltaZ * firstZ;
      const secondDistance = deltaX * secondX + deltaY * secondY + deltaZ * secondZ;
      const squaredDistance = firstDistance ** 2 + secondDistance ** 2;
      if (squaredDistance <= 1e-24) {
        continue;
      }
      const weight = 1 / squaredDistance;
      const difference = height[neighbor] - height[cellIndex];
      firstSquared += weight * firstDistance ** 2;
      crossTerm += weight * firstDistance * secondDistance;
      secondSquared += weight * secondDistance ** 2;
      firstDifference += weight * firstDistance * difference;
      secondDifference += weight * secondDistance * difference;
    }
    const trace = firstSquared + secondSquared;
    if (trace === 0) {
      continue;
    }
    const determinant = firstSquared * secondSquared - crossTerm ** 2;
    const firstSlope =
      determinant > 1e-12 * trace ** 2
        ? (secondSquared * firstDifference - crossTerm * secondDifference) / determinant
        : (firstSquared * firstDifference + crossTerm * secondDifference) / trace ** 2;
    const secondSlope =
      determinant > 1e-12 * trace ** 2
        ? (firstSquared * secondDifference - crossTerm * firstDifference) / determinant
        : (crossTerm * firstDifference + secondSquared * secondDifference) / trace ** 2;
    heightGradient[3 * cellIndex] = (firstSlope * firstX + secondSlope * secondX) / radius;
    heightGradient[3 * cellIndex + 1] = (firstSlope * firstY + secondSlope * secondY) / radius;
    heightGradient[3 * cellIndex + 2] = (firstSlope * firstZ + secondSlope * secondZ) / radius;
  }
  return heightGradient;
}
