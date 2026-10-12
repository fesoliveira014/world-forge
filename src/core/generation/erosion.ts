import type { Drainage, Grid, Terrain, WorldConfig } from '../model';

/** Recent fluvial evolution on a fixed provisional water graph. An implicit,
 * downstream-first update lets lowering propagate up a valley without tiny time
 * steps. Final climate and drainage are rebuilt after the terrain changes.
 * All removed volume becomes local deposition, mouth deposits, or named export.
 */
export function erodeRiverLandscape(
  grid: Grid,
  terrain: Terrain,
  drainage: Drainage,
  config: WorldConfig,
): number {
  if (config.fluvialDuration <= 0 || config.erosion <= 0) {
    return 0;
  }

  const cornerCount = drainage.receiver.length;
  const radius2 = config.radius ** 2;
  const incoming = new Uint8Array(cornerCount);
  const order = new Uint32Array(cornerCount);
  const lengths = new Float32Array(cornerCount);
  const height = new Float32Array(cornerCount);
  const incisionDepth = new Float32Array(cornerCount);
  const request = new Float64Array(grid.count);
  const removed = new Float64Array(grid.count);

  for (let cornerIndex = 0; cornerIndex < cornerCount; cornerIndex++) {
    const receiverCorner = drainage.receiver[cornerIndex];

    if (receiverCorner < 0) {
      continue;
    }

    incoming[receiverCorner]++;

    for (let incidentIndex = 0; incidentIndex < 3; incidentIndex++) {
      if (grid.cornerNeighbors[cornerIndex * 3 + incidentIndex] === receiverCorner) {
        lengths[cornerIndex] =
          grid.edgeLength[grid.cornerEdges[cornerIndex * 3 + incidentIndex]] * config.radius;
      }
    }
  }

  let head = 0;
  let tail = 0;

  for (let cornerIndex = 0; cornerIndex < cornerCount; cornerIndex++) {
    if (!incoming[cornerIndex]) {
      order[tail++] = cornerIndex;
    }
  }

  while (head < tail) {
    const receiverCorner = drainage.receiver[order[head++]];

    if (receiverCorner >= 0 && --incoming[receiverCorner] === 0) {
      order[tail++] = receiverCorner;
    }
  }

  if (tail !== cornerCount) {
    throw Error('Fluvial evolution requires acyclic drainage.');
  }

  const steps = Math.min(12, Math.max(1, Math.ceil(config.fluvialDuration * 4)));
  const years = (config.fluvialDuration * 1e6) / steps;

  for (let step = 0; step < steps; step++) {
    request.fill(0);

    for (let cornerIndex = 0; cornerIndex < cornerCount; cornerIndex++) {
      let meanHeight = 0;

      for (let incidentIndex = 0; incidentIndex < 3; incidentIndex++) {
        meanHeight += terrain.height[grid.triangles[cornerIndex * 3 + incidentIndex]] / 3;
      }

      height[cornerIndex] = meanHeight;
      const lake = drainage.lakeId[cornerIndex];
      incisionDepth[cornerIndex] =
        lake >= 0 && drainage.lakeFraction[cornerIndex] > 0
          ? Math.max(meanHeight, drainage.lakes[lake].level)
          : meanHeight;
    }

    for (let orderIndex = cornerCount - 1; orderIndex >= 0; orderIndex--) {
      const cornerIndex = order[orderIndex];
      const receiverCorner = drainage.receiver[cornerIndex];

      if (
        receiverCorner < 0 ||
        drainage.discharge[cornerIndex] < 20 ||
        drainage.lakeFraction[cornerIndex] > 0
      ) {
        continue;
      }

      // 0.6 m/year is a prototype response speed, not a claimed erosion rate.
      const response =
        (0.6 * config.erosion * Math.pow(drainage.discharge[cornerIndex] / 1000, 0.45) * years) /
        Math.max(1, lengths[cornerIndex]);
      const lowering = Math.min(
        250,
        (Math.max(0, height[cornerIndex] - Math.max(0, incisionDepth[receiverCorner])) * response) /
          (1 + response),
      );
      incisionDepth[cornerIndex] = height[cornerIndex] - lowering;

      for (let incidentIndex = 0; incidentIndex < 3; incidentIndex++) {
        const cellIndex = grid.triangles[cornerIndex * 3 + incidentIndex];

        if (!terrain.ocean[cellIndex] && drainage.lakeDepth[cellIndex] <= 0) {
          request[cellIndex] += lowering / (grid.offsets[cellIndex + 1] - grid.offsets[cellIndex]);
        }
      }
    }

    for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
      const heightBeforeIncision = terrain.height[cellIndex];
      const depth = Math.min(request[cellIndex], Math.max(0, heightBeforeIncision - 1));

      if (depth <= 0) {
        continue;
      }

      const loose = Math.min(terrain.sediment[cellIndex], depth);
      terrain.sediment[cellIndex] -= loose;
      terrain.bedrock[cellIndex] -= depth - loose;
      terrain.height[cellIndex] = terrain.bedrock[cellIndex] + terrain.sediment[cellIndex];
      const actual = Math.max(0, heightBeforeIncision - terrain.height[cellIndex]);
      terrain.fluvialIncision[cellIndex] += actual;
      removed[cellIndex] += actual * grid.areas[cellIndex] * radius2;
    }
  }

  const flux = new Float64Array(cornerCount);

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    const share = removed[cellIndex] / (grid.offsets[cellIndex + 1] - grid.offsets[cellIndex]);

    for (
      let neighborOffset = grid.offsets[cellIndex];
      neighborOffset < grid.offsets[cellIndex + 1];
      neighborOffset++
    ) {
      flux[grid.cellCorners[neighborOffset]] += share;
    }
  }

  const depositSediment = (cellIndex: number, volume: number, delta = false) => {
    const heightBeforeDeposit = terrain.height[cellIndex];
    terrain.sediment[cellIndex] += volume / (grid.areas[cellIndex] * radius2);
    terrain.height[cellIndex] = terrain.bedrock[cellIndex] + terrain.sediment[cellIndex];
    const depth = Math.max(0, terrain.height[cellIndex] - heightBeforeDeposit);

    if (delta) {
      terrain.deltaSediment[cellIndex] += depth;
    }

    return depth * grid.areas[cellIndex] * radius2;
  };

  // One local fan per receiving corner; never a global search per river mouth.
  const depositAtMouth = (cornerIndex: number, volume: number, lake: number) => {
    const level = lake < 0 ? 0 : drainage.lakes[lake].level;
    const candidates = new Set<number>();

    for (let incidentIndex = 0; incidentIndex < 3; incidentIndex++) {
      const cellIndex = grid.triangles[cornerIndex * 3 + incidentIndex];
      candidates.add(cellIndex);

      for (
        let neighborOffset = grid.offsets[cellIndex];
        neighborOffset < grid.offsets[cellIndex + 1];
        neighborOffset++
      ) {
        candidates.add(grid.neighbors[neighborOffset]);
      }
    }

    const cells: number[] = [];
    const weights: number[] = [];
    let weight = 0;

    for (const cellIndex of candidates) {
      if (terrain.height[cellIndex] > level + 3 || terrain.height[cellIndex] < level - 350) {
        continue;
      }

      if (lake < 0 && drainage.lakeCoverage[cellIndex] > 0) {
        continue;
      }

      if (lake >= 0 && terrain.ocean[cellIndex]) {
        continue;
      }

      if (
        lake >= 0 &&
        drainage.lakeCoverage[cellIndex] > 0 &&
        !Array.from(
          grid.cellCorners.subarray(grid.offsets[cellIndex], grid.offsets[cellIndex + 1]),
        ).some((adjacentCorner) => drainage.lakeId[adjacentCorner] === lake)
      ) {
        continue;
      }

      const depositionWeight = 1 / (20 + Math.max(0, level - terrain.height[cellIndex]));
      cells.push(cellIndex);
      weights.push(depositionWeight);
      weight += depositionWeight;
    }

    const retained = volume * (lake < 0 ? 0.7 / (1 + config.waveErosion * 0.5) : 0.85);
    let deposited = 0;

    for (let candidateIndex = 0; candidateIndex < cells.length; candidateIndex++) {
      const cellIndex = cells[candidateIndex];
      const depositCapacity =
        (level + 3 - terrain.height[cellIndex]) * grid.areas[cellIndex] * radius2;
      deposited += depositSediment(
        cellIndex,
        Math.min(depositCapacity, (retained * weights[candidateIndex]) / weight),
        true,
      );
    }

    return Math.max(0, volume - deposited);
  };

  let exported = 0;

  for (let orderIndex = 0; orderIndex < cornerCount; orderIndex++) {
    const cornerIndex = order[orderIndex];
    const receiverCorner = drainage.receiver[cornerIndex];
    let volume = flux[cornerIndex];

    if (volume <= 0) {
      continue;
    }

    if (receiverCorner < 0 || drainage.lakeFraction[cornerIndex] > 0) {
      volume = depositAtMouth(
        cornerIndex,
        volume,
        drainage.lakeFraction[cornerIndex] > 0 ? drainage.lakeId[cornerIndex] : -1,
      );
      // Fine sediment not resolved in the mouth fan enters the receiving water.
      exported += volume;
      continue;
    }

    const slope =
      Math.max(0, height[cornerIndex] - height[receiverCorner]) / Math.max(1, lengths[cornerIndex]);
    const settle = (volume * 0.035) / (1 + (slope / 0.001) ** 2);

    for (let incidentIndex = 0; incidentIndex < 3; incidentIndex++) {
      const cellIndex = grid.triangles[cornerIndex * 3 + incidentIndex];

      if (!terrain.ocean[cellIndex]) {
        volume -= depositSediment(cellIndex, settle / 3);
      }
    }

    flux[receiverCorner] += Math.max(0, volume);
  }

  return exported;
}
