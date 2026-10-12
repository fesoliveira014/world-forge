import type { Grid, Terrain, WorldConfig } from '../model';
import { MinHeap } from '../math';

/** Temporary cell flood for geological sediment delivery, not river routing.
 * Detached material follows escape paths, fills downstream depressions from their
 * floors up, and exports the remainder. The final corner graph still owns water.
 */
export function depositInBasins(
  grid: Grid,
  terrain: Terrain,
  supply: Float64Array,
  config: WorldConfig,
): number {
  const { height, ocean } = terrain;
  const cellCount = grid.count;
  const filled = new Float32Array(cellCount);
  const seen = new Uint8Array(ocean);
  const parent = new Int32Array(cellCount).fill(-1);
  const order = new Uint32Array(cellCount);
  const rank = new Uint32Array(cellCount);
  const heap = new MinHeap();

  for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
    if (!ocean[cellIndex]) {
      for (
        let neighborOffset = grid.offsets[cellIndex];
        neighborOffset < grid.offsets[cellIndex + 1];
        neighborOffset++
      ) {
        const neighborCell = grid.neighbors[neighborOffset];

        if (ocean[neighborCell]) {
          seen[cellIndex] = 1;
          parent[cellIndex] = neighborCell;
          filled[cellIndex] = Math.max(0, height[cellIndex]);
          heap.push(cellIndex, filled[cellIndex]);
          break;
        }
      }
    }
  }

  let count = 0;

  while (heap.size) {
    const [cellIndex] = heap.pop();
    order[count] = cellIndex;
    rank[cellIndex] = count++;

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
      parent[neighborCell] = cellIndex;
      filled[neighborCell] = Math.max(height[neighborCell], filled[cellIndex]);
      heap.push(neighborCell, filled[neighborCell]);
    }
  }

  const basinId = new Int32Array(cellCount).fill(-1);
  const lists: number[][] = [];
  const anchors: number[] = [];

  for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
    if (
      !ocean[cellIndex] &&
      basinId[cellIndex] < 0 &&
      filled[cellIndex] > height[cellIndex] + 0.01
    ) {
      const index = lists.length;
      const list = [cellIndex];
      let anchor = cellIndex;
      basinId[cellIndex] = index;

      for (let memberIndex = 0; memberIndex < list.length; memberIndex++) {
        const basinCell = list[memberIndex];

        if (rank[basinCell] < rank[anchor]) {
          anchor = basinCell;
        }

        for (
          let neighborOffset = grid.offsets[basinCell];
          neighborOffset < grid.offsets[basinCell + 1];
          neighborOffset++
        ) {
          const neighborCell = grid.neighbors[neighborOffset];

          if (
            !ocean[neighborCell] &&
            basinId[neighborCell] < 0 &&
            filled[neighborCell] === filled[cellIndex] &&
            filled[neighborCell] > height[neighborCell] + 0.01
          ) {
            basinId[neighborCell] = index;
            list.push(neighborCell);
          }
        }
      }

      lists.push(list);
      anchors.push(anchor);
    }
  }

  const pending = new Float64Array(lists.length);
  const radius2 = config.radius ** 2;
  let exported = 0;

  for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
    if (ocean[cellIndex]) {
      exported += supply[cellIndex];
    }
  }

  for (let orderIndex = count - 1; orderIndex >= 0; orderIndex--) {
    const cellIndex = order[orderIndex];
    const basin = basinId[cellIndex];
    let outgoing = supply[cellIndex];

    if (basin >= 0) {
      pending[basin] += outgoing;

      if (anchors[basin] !== cellIndex) {
        continue;
      }

      outgoing = pending[basin];
      // Persistence stands for unmodelled accommodation (subsidence, young basins,
      // sediment bypass). It changes terrain infill, never the lake's water budget.
      const budget = outgoing * (1 - config.lakePersistence);
      const list = lists[basin];
      list.sort((firstCell, secondCell) => height[firstCell] - height[secondCell]);
      let level = height[list[0]];
      let area = 0;
      let remaining = budget;

      for (let memberIndex = 0; memberIndex < list.length; memberIndex++) {
        area += grid.areas[list[memberIndex]] * radius2;
        const next =
          memberIndex + 1 < list.length ? height[list[memberIndex + 1]] : filled[cellIndex];
        const volume = (next - level) * area;

        if (volume >= remaining) {
          level += remaining / area;
          break;
        }

        remaining -= volume;
        level = next;
      }

      for (const basinCell of list) {
        const depth = Math.max(0, level - height[basinCell]);
        terrain.sediment[basinCell] += depth;
        height[basinCell] = terrain.bedrock[basinCell] + terrain.sediment[basinCell];
        outgoing -= depth * grid.areas[basinCell] * radius2;
      }

      outgoing = Math.max(0, outgoing);
    }

    const receiverCell = parent[cellIndex];

    if (receiverCell < 0 || ocean[receiverCell]) {
      exported += outgoing;
    } else {
      supply[receiverCell] += outgoing;
    }
  }

  return exported;
}
