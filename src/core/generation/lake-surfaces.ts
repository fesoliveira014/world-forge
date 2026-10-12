import type { Drainage, Grid } from '../model';
import { clamp } from '../math';

/** Give the annual height/area model an explicit shoreline on unresolved flat floors.
 * Lower samples are fully wet. The remaining area grows contiguously across the level
 * terrace, starting at existing water or its strongest inlet. This is a subcell footprint
 * approximation; it does not invent storage depth or change the annual reservoir budget.
 */
export function resolveLakeSurfaces(
  grid: Grid,
  drainage: Drainage,
  area: Float64Array,
  input: Float64Array,
): void {
  const cornerCount = drainage.receiver.length;
  const members: number[][] = drainage.lakes.map(() => []);

  for (let cornerIndex = 0; cornerIndex < cornerCount; cornerIndex++) {
    const lakeIndex = drainage.lakeId[cornerIndex];

    if (lakeIndex >= 0 && drainage.height[cornerIndex] <= drainage.lakes[lakeIndex].level) {
      members[lakeIndex].push(cornerIndex);
    }
  }

  const fraction = drainage.lakeFraction;
  const seen = new Uint8Array(cornerCount);
  const queue = new Uint32Array(cornerCount);
  const spillFrom = new Int32Array(drainage.lakes.length).fill(-1);

  for (const lake of drainage.lakes) {
    const list = members[lake.id];

    if (!list.length || (lake.area <= 0 && lake.outflow <= 0)) {
      continue;
    }

    let remaining = lake.seasonal
      ? lake.outflow > 0
        ? list.reduce((sum, corner) => sum + area[corner], 0)
        : Math.max(...lake.seasonal.area)
      : lake.area;
    let head = 0;
    let tail = 0;
    let seed = list[0];

    for (const cornerIndex of list) {
      if (drainage.discharge[cornerIndex] > drainage.discharge[seed]) {
        seed = cornerIndex;
      }

      if (lake.outflow > 0 && drainage.receiver[cornerIndex] === lake.outlet) {
        spillFrom[lake.id] = cornerIndex;
      }

      if (drainage.height[cornerIndex] < lake.level || lake.outflow > 0) {
        fraction[cornerIndex] = 1;
        remaining -= area[cornerIndex];
        seen[cornerIndex] = 1;
        queue[tail++] = cornerIndex;
      }
    }

    if (!tail) {
      seen[seed] = 1;
      queue[tail++] = seed;
    }

    // A queue, rather than sorting equal elevations by cell ID, gives a connected shore.
    let scan = 0;

    while (remaining > 0) {
      if (head === tail) {
        while (scan < list.length && seen[list[scan]]) {
          scan++;
        }

        if (scan === list.length) {
          break;
        }

        seen[list[scan]] = 1;
        queue[tail++] = list[scan++];
      }

      const cornerIndex = queue[head++];

      if (!fraction[cornerIndex]) {
        fraction[cornerIndex] = clamp(remaining / Math.max(1, area[cornerIndex]));
        remaining -= area[cornerIndex] * fraction[cornerIndex];
      }

      for (let neighborSlot = 0; neighborSlot < 3; neighborSlot++) {
        const downstreamNode = grid.cornerNeighbors[cornerIndex * 3 + neighborSlot];

        if (
          !seen[downstreamNode] &&
          drainage.lakeId[downstreamNode] === lake.id &&
          drainage.height[downstreamNode] <= lake.level
        ) {
          seen[downstreamNode] = 1;
          queue[tail++] = downstreamNode;
        }
      }
    }

    // Route exposed level ground to the new shore. Previously every point on the
    // terrace terminated independently, even when the wet area occupied only part of it.
    head = tail = 0;

    for (const cornerIndex of list) {
      seen[cornerIndex] = 0;
    }

    for (const cornerIndex of list) {
      if (fraction[cornerIndex] > 0) {
        seen[cornerIndex] = 1;
        queue[tail++] = cornerIndex;
        drainage.receiver[cornerIndex] = -1;
      }
    }

    while (head < tail) {
      const cornerIndex = queue[head++];

      for (let neighborSlot = 0; neighborSlot < 3; neighborSlot++) {
        const from = grid.cornerNeighbors[cornerIndex * 3 + neighborSlot];

        if (seen[from] || drainage.lakeId[from] !== lake.id || drainage.height[from] > lake.level) {
          continue;
        }

        seen[from] = 1;
        drainage.receiver[from] = cornerIndex;
        queue[tail++] = from;
      }
    }

    const spill = spillFrom[lake.id];

    if (spill >= 0) {
      drainage.receiver[spill] = lake.outlet;
    }
  }

  // Re-accumulate once after changing flat-ground paths. Virtual lake nodes consume
  // their recorded annual balance and release only actual outflow. No water is lost at
  // an arbitrary dry corner, and tributaries continue to merge before reaching a shore.
  const size = cornerCount + drainage.lakes.length;
  const next = new Int32Array(size).fill(-1);
  const incoming = new Uint32Array(size);
  const accumulatedFlow = new Float64Array(size);
  const order = new Uint32Array(size);
  accumulatedFlow.set(input);

  for (let nodeIndex = 0; nodeIndex < cornerCount; nodeIndex++) {
    next[nodeIndex] =
      fraction[nodeIndex] > 0
        ? cornerCount + drainage.lakeId[nodeIndex]
        : drainage.receiver[nodeIndex];
  }

  for (const lake of drainage.lakes) {
    if (lake.outflow > 0) {
      next[cornerCount + lake.id] = lake.outlet;
    }
  }

  for (const downstreamNode of next) {
    if (downstreamNode >= 0) {
      incoming[downstreamNode]++;
    }
  }

  let head = 0;
  let tail = 0;

  for (let nodeIndex = 0; nodeIndex < size; nodeIndex++) {
    if (!incoming[nodeIndex]) {
      order[tail++] = nodeIndex;
    }
  }

  while (head < tail) {
    const nodeIndex = order[head++];
    const downstreamNode = next[nodeIndex];

    if (nodeIndex >= cornerCount) {
      accumulatedFlow[nodeIndex] = drainage.lakes[nodeIndex - cornerCount].outflow;
    }

    if (downstreamNode >= 0) {
      accumulatedFlow[downstreamNode] += accumulatedFlow[nodeIndex];

      if (--incoming[downstreamNode] === 0) {
        order[tail++] = downstreamNode;
      }
    }
  }

  if (tail !== size) {
    throw Error('Lake shoreline routing contains a cycle.');
  }

  drainage.discharge.set(accumulatedFlow.subarray(0, cornerCount));

  for (const lake of drainage.lakes) {
    const cornerIndex = spillFrom[lake.id];

    if (cornerIndex >= 0) {
      drainage.discharge[cornerIndex] = lake.outflow;
    }
  }

  updateLakeCoverage(grid, drainage, area);
}

/** Rasterize the recorded seasonal areas, not a second depth threshold. Equal-height
 * samples share the unresolved edge fraction. This avoids adding/removing a whole
 * sill terrace when floating-point water level differs by a few billionths of a metre.
 */
export function updateLakeCoverage(grid: Grid, drainage: Drainage, area: Float64Array): void {
  drainage.lakeCoverage.fill(0);
  const seasonalCoverage = Array.from({ length: 4 }, () => new Float32Array(grid.count));
  drainage.seasonalLakeCoverage = seasonalCoverage;
  if (drainage.lakes.some((lake) => !lake.seasonal)) {
    for (let cell = 0; cell < grid.count; cell++) {
      const degree = grid.offsets[cell + 1] - grid.offsets[cell];
      for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
        const corner = grid.cellCorners[offset];
        const lake = drainage.lakes[drainage.lakeId[corner]];
        if (lake && !lake.seasonal) {
          for (const field of seasonalCoverage) {
            field[cell] += drainage.lakeFraction[corner] / degree;
          }
        }
      }
    }
  }
  const members: number[][] = drainage.lakes.map(() => []);
  for (let corner = 0; corner < drainage.lakeId.length; corner++) {
    const lake = drainage.lakes[drainage.lakeId[corner]];
    if (lake?.seasonal && drainage.height[corner] <= lake.spill) {
      members[lake.id].push(corner);
    }
  }
  for (const lake of drainage.lakes) {
    const sorted = members[lake.id].sort(
      (first, second) => drainage.height[first] - drainage.height[second],
    );
    const remaining = lake.seasonal?.area.slice() ?? [lake.area, lake.area, lake.area, lake.area];
    let first = 0;
    while (first < sorted.length) {
      let end = first + 1;
      let groupArea = area[sorted[first]];
      while (
        end < sorted.length &&
        drainage.height[sorted[end]] === drainage.height[sorted[first]]
      ) {
        groupArea += area[sorted[end++]];
      }
      for (let season = 0; season < 4; season++) {
        const share = clamp(remaining[season] / Math.max(1, groupArea));
        for (let index = first; index < end; index++) {
          const corner = sorted[index];
          for (let incident = 0; incident < 3; incident++) {
            const cell = grid.triangles[corner * 3 + incident];
            const degree = grid.offsets[cell + 1] - grid.offsets[cell];
            seasonalCoverage[season][cell] += share / degree;
          }
        }
        remaining[season] = Math.max(0, remaining[season] - groupArea);
      }
      first = end;
    }
  }
  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    drainage.lakeCoverage[cellIndex] =
      seasonalCoverage.reduce((sum, field) => sum + field[cellIndex], 0) / 4;
  }
}

/** A naming convention for this atlas. Size alone does not establish salinity. */
export function classifyLakeSize(area: number): string {
  const areaSquareKilometers = area / 1e6;

  return areaSquareKilometers >= 100000
    ? 'Inland sea'
    : areaSquareKilometers >= 10000
      ? 'Great lake'
      : 'Lake';
}

export function riverDestination(drainage: Drainage, terminal: number): string {
  const lakeIndex = terminal - drainage.receiver.length;

  if (lakeIndex >= 0 && drainage.lakes[lakeIndex]) {
    return `${classifyLakeSize(drainage.lakes[lakeIndex].area)} ${lakeIndex + 1}`;
  }

  return 'Ocean';
}
