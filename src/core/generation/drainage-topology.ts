import type { Grid, Terrain } from '../model';
import { MinHeap } from '../math';
import { reconstructCornerField } from '../operators/corner-fields';

/** Geometric escape topology shared by outlet erosion and the final water router. */
export function floodCorners(grid: Grid, terrain: Terrain) {
  const cornerCount = grid.corners.length / 3;
  const height = reconstructCornerField(grid, terrain.height);
  const filled = new Float32Array(cornerCount);
  const parent = new Int32Array(cornerCount).fill(-1);
  const rank = new Uint32Array(cornerCount);
  const order = new Uint32Array(cornerCount);
  const seen = new Uint8Array(cornerCount);
  const outlet = new Uint8Array(cornerCount);
  const heap = new MinHeap();

  for (let cornerIndex = 0; cornerIndex < cornerCount; cornerIndex++) {
    for (let neighborSlot = 0; neighborSlot < 3; neighborSlot++) {
      const cellIndex = grid.triangles[cornerIndex * 3 + neighborSlot];

      if (terrain.ocean[cellIndex]) {
        outlet[cornerIndex] = 1;
      }
    }

    if (outlet[cornerIndex]) {
      filled[cornerIndex] = 0;
      seen[cornerIndex] = 1;
      heap.push(cornerIndex, 0);
    }
  }

  // Configuration guarantees an ocean; the explicit all-land fallback is one global low outlet.
  if (!heap.size) {
    let lowestCorner = 0;

    for (let cornerIndex = 1; cornerIndex < cornerCount; cornerIndex++) {
      if (height[cornerIndex] < height[lowestCorner]) {
        lowestCorner = cornerIndex;
      }
    }

    seen[lowestCorner] = 1;
    outlet[lowestCorner] = 1;
    filled[lowestCorner] = height[lowestCorner];
    heap.push(lowestCorner, filled[lowestCorner]);
  }

  let count = 0;

  while (heap.size) {
    const [cornerIndex] = heap.pop();
    order[count] = cornerIndex;
    rank[cornerIndex] = count++;

    for (let neighborSlot = 0; neighborSlot < 3; neighborSlot++) {
      const neighborCorner = grid.cornerNeighbors[cornerIndex * 3 + neighborSlot];

      if (seen[neighborCorner]) {
        continue;
      }

      seen[neighborCorner] = 1;
      parent[neighborCorner] = cornerIndex;
      filled[neighborCorner] = Math.max(height[neighborCorner], filled[cornerIndex]);
      heap.push(neighborCorner, filled[neighborCorner]);
    }
  }

  return { height, filled, parent, rank, order, outlet };
}
