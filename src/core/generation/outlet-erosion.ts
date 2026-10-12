import type { Grid, Terrain, WorldConfig } from '../model';
import { floodCorners } from './drainage-topology';

/** Incise erodible basin sills, using the same corner topology as river routing.
 * A complete escape path must fit both the depth and length budget before any
 * ground is changed. Deep/long barriers remain; no reservoir is hidden or deleted.
 */
export function erodeOutlets(
  grid: Grid,
  terrain: Terrain,
  erosionDepth: Float32Array,
  config: WorldConfig,
): number {
  const { height, filled, parent, rank, outlet } = floodCorners(grid, terrain);
  const cornerCount = height.length;
  const seen = new Uint8Array(cornerCount);
  const queue = new Uint32Array(cornerCount);
  const targetHeight = new Float32Array(terrain.height);
  const radius2 = config.radius ** 2;

  for (let cornerIndex = 0; cornerIndex < cornerCount; cornerIndex++) {
    if (
      outlet[cornerIndex] ||
      seen[cornerIndex] ||
      filled[cornerIndex] <= height[cornerIndex] + 0.1
    ) {
      continue;
    }

    const spill = filled[cornerIndex];
    let head = 0;
    let tail = 1;
    let lowestCorner = cornerIndex;
    let anchor = cornerIndex;
    queue[0] = cornerIndex;
    seen[cornerIndex] = 1;

    while (head < tail) {
      const basinCorner = queue[head++];

      if (height[basinCorner] < height[lowestCorner]) {
        lowestCorner = basinCorner;
      }

      if (rank[basinCorner] < rank[anchor]) {
        anchor = basinCorner;
      }

      for (let neighborSlot = 0; neighborSlot < 3; neighborSlot++) {
        const neighborCorner = grid.cornerNeighbors[basinCorner * 3 + neighborSlot];

        if (
          !outlet[neighborCorner] &&
          !seen[neighborCorner] &&
          filled[neighborCorner] > height[neighborCorner] + 0.1 &&
          Math.abs(filled[neighborCorner] - spill) < 0.05
        ) {
          seen[neighborCorner] = 1;
          queue[tail++] = neighborCorner;
        }
      }
    }

    let budget = 0;

    for (let neighborSlot = 0; neighborSlot < 3; neighborSlot++) {
      budget += erosionDepth[grid.triangles[anchor * 3 + neighborSlot]] / 3;
    }

    if (budget <= 0) {
      continue;
    }

    const level = Math.max(0.1, spill - budget, height[lowestCorner] - 0.25);
    const start = level > height[lowestCorner] ? anchor : lowestCorner;
    const path: { corner: number; level: number }[] = [];
    let basinCorner = start;
    let distance = 0;
    let escaped = false;

    while (basinCorner >= 0 && distance <= 750000) {
      const floor = Math.max(0.1, level - distance * 0.000001);

      if (
        outlet[basinCorner] ||
        (filled[basinCorner] < spill - 0.05 && height[basinCorner] <= floor)
      ) {
        escaped = true;
        break;
      }

      let erosionDepth = 0;

      for (let neighborSlot = 0; neighborSlot < 3; neighborSlot++) {
        erosionDepth = Math.max(
          erosionDepth,
          terrain.height[grid.triangles[basinCorner * 3 + neighborSlot]] - floor,
        );
      }

      if (erosionDepth > budget + 1) {
        break;
      }

      path.push({ corner: basinCorner, level: floor });
      const receiverCorner = parent[basinCorner];

      if (receiverCorner < 0) {
        break;
      }

      for (let neighborSlot = 0; neighborSlot < 3; neighborSlot++) {
        if (grid.cornerNeighbors[basinCorner * 3 + neighborSlot] === receiverCorner) {
          distance +=
            grid.edgeLength[grid.cornerEdges[basinCorner * 3 + neighborSlot]] * config.radius;
          break;
        }
      }

      basinCorner = receiverCorner;
    }

    if (!escaped) {
      continue;
    }

    for (const step of path) {
      for (let neighborSlot = 0; neighborSlot < 3; neighborSlot++) {
        const cellIndex = grid.triangles[step.corner * 3 + neighborSlot];

        if (!terrain.ocean[cellIndex]) {
          targetHeight[cellIndex] = Math.min(targetHeight[cellIndex], step.level);
        }
      }
    }
  }

  let exported = 0;

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    const depth = terrain.height[cellIndex] - targetHeight[cellIndex];
    const loose = Math.min(depth, terrain.sediment[cellIndex]);
    terrain.sediment[cellIndex] -= loose;
    terrain.bedrock[cellIndex] -= depth - loose;
    terrain.height[cellIndex] = targetHeight[cellIndex];
    exported += depth * grid.areas[cellIndex] * radius2;
  }

  return exported;
}
