import type { Grid } from '../model';
import { MinHeap } from '../math';

/** Fit enclosed continental depressions above sea level, below their escape sill.
 * This is terrain construction, before climate or erosion; it does not fill a lake
 * with water. The later corner drainage graph remains the sole routing authority.
 */
export function shapeContinentalBasins(grid: Grid, height: Float32Array, ocean: Uint8Array) {
  if (!height.some((elevation, cellIndex) => !ocean[cellIndex] && elevation < 0)) {
    return;
  }

  const spill = new Float32Array(grid.count);
  const seen = new Uint8Array(ocean);
  const heap = new MinHeap();

  // Priority flood from the coast finds each depression's lowest escape elevation.
  // Start at coastal land so the heap does not need to visit the ocean floor.
  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    if (ocean[cellIndex]) {
      continue;
    }

    for (
      let neighborOffset = grid.offsets[cellIndex];
      neighborOffset < grid.offsets[cellIndex + 1];
      neighborOffset++
    ) {
      if (ocean[grid.neighbors[neighborOffset]]) {
        seen[cellIndex] = 1;
        spill[cellIndex] = Math.max(0, height[cellIndex]);
        heap.push(cellIndex, spill[cellIndex]);
        break;
      }
    }
  }

  while (heap.size) {
    const [cellIndex] = heap.pop();

    for (
      let neighborOffset = grid.offsets[cellIndex];
      neighborOffset < grid.offsets[cellIndex + 1];
      neighborOffset++
    ) {
      const neighborCell = grid.neighbors[neighborOffset];

      if (seen[neighborCell]) {
        continue;
      }

      seen[neighborCell] = 1;
      spill[neighborCell] = Math.max(height[neighborCell], spill[cellIndex]);
      heap.push(neighborCell, spill[neighborCell]);
    }
  }

  // Reshape the whole affected depression, including its positive slopes. Changing
  // only negative cells would leave an artificial ridge along the old zero contour.
  seen.fill(0);
  const queue = new Uint32Array(grid.count);

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    if (ocean[cellIndex] || seen[cellIndex] || height[cellIndex] >= spill[cellIndex]) {
      continue;
    }

    const spillElevation = spill[cellIndex];
    let head = 0;
    let tail = 1;
    let belowSea = false;
    queue[0] = cellIndex;
    seen[cellIndex] = 1;

    while (head < tail) {
      const basinCell = queue[head++];
      belowSea ||= height[basinCell] < 0;

      for (
        let neighborOffset = grid.offsets[basinCell];
        neighborOffset < grid.offsets[basinCell + 1];
        neighborOffset++
      ) {
        const neighborCell = grid.neighbors[neighborOffset];

        if (
          !ocean[neighborCell] &&
          !seen[neighborCell] &&
          height[neighborCell] < spillElevation &&
          spill[neighborCell] === spillElevation
        ) {
          seen[neighborCell] = 1;
          queue[tail++] = neighborCell;
        }
      }
    }

    if (!belowSea) {
      continue;
    }

    for (let queueIndex = 0; queueIndex < tail; queueIndex++) {
      const basinCell = queue[queueIndex];
      // Positive and monotone, with a matching height and slope at the rim.
      // The local spill elevation supplies the depth scale; no fixed depth cap.
      height[basinCell] =
        spillElevation > 0
          ? (spillElevation * spillElevation) / (2 * spillElevation - height[basinCell])
          : 0;
    }
  }
}
