import type { Grid } from '../model';
import { MinHeap } from '../math';
import { nearestCell } from '../grid/build';

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
) {
  const area = new Float64Array(processGrid.count);
  const landArea = new Float64Array(processGrid.count);
  const landHeight = new Float64Array(processGrid.count);
  const depth = new Float64Array(processGrid.count);
  const barrier = new Float32Array(processGrid.count);

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    const processCell = surfaceToProcess[cellIndex];
    const cellArea = grid.areas[cellIndex];
    area[processCell] += cellArea;

    if (ocean[cellIndex]) {
      depth[processCell] += height[cellIndex] * cellArea;
    } else {
      landArea[processCell] += cellArea;
      landHeight[processCell] += height[cellIndex] * cellArea;
      barrier[processCell] = Math.max(barrier[processCell], height[cellIndex]);
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

/** Scalar least-squares tangent gradient, metres / metre. */
export function calculateHeightGradient(
  grid: Grid,
  height: Float32Array,
  radius: number,
): Float32Array {
  const heightGradient = new Float32Array(grid.count * 3);

  for (let edgeIndex = 0; edgeIndex < grid.edgeLength.length; edgeIndex++) {
    const firstCell = grid.edgeCells[2 * edgeIndex];
    const secondCell = grid.edgeCells[2 * edgeIndex + 1];
    const edgeSlope =
      (height[secondCell] - height[firstCell]) / (radius * grid.edgeDistance[edgeIndex]);

    for (let axisIndex = 0; axisIndex < 3; axisIndex++) {
      const value = grid.edgeNormal[edgeIndex * 3 + axisIndex] * edgeSlope;
      heightGradient[firstCell * 3 + axisIndex] += value;
      heightGradient[secondCell * 3 + axisIndex] += value;
    }
  }

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    const gradientScale = 2 / (grid.offsets[cellIndex + 1] - grid.offsets[cellIndex]);
    let radial = 0;

    for (let axisIndex = 0; axisIndex < 3; axisIndex++) {
      radial +=
        heightGradient[cellIndex * 3 + axisIndex] * grid.positions[cellIndex * 3 + axisIndex];
    }

    for (let axisIndex = 0; axisIndex < 3; axisIndex++) {
      heightGradient[cellIndex * 3 + axisIndex] =
        (heightGradient[cellIndex * 3 + axisIndex] -
          radial * grid.positions[cellIndex * 3 + axisIndex]) *
        gradientScale;
    }
  }

  return heightGradient;
}
