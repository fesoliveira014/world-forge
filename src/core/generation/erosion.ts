import type { Drainage, Grid, Terrain, WorldConfig } from '../model';
import {
  computeCornerSupport,
  distributeCellInventory,
  reconstructCornerField,
} from '../operators/corner-fields';
import { depositRiverMouth, depositRiverSediment, riverSettlingFraction } from './river-sediment';
import { evolveRiverBanks } from './river-migration';
import { floodplainWidths } from './floodplains';

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
  const removed = evolveRiverBanks(grid, terrain, drainage, config);
  const support = computeCornerSupport(grid);

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
    reconstructCornerField(grid, terrain.height, height);

    for (let cornerIndex = 0; cornerIndex < cornerCount; cornerIndex++) {
      const lake = drainage.lakeId[cornerIndex];
      incisionDepth[cornerIndex] =
        lake >= 0 && drainage.lakeFraction[cornerIndex] > 0
          ? Math.max(height[cornerIndex], drainage.lakes[lake].level)
          : height[cornerIndex];
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
          request[cellIndex] +=
            (lowering * support.cornerCellArea[cornerIndex * 3 + incidentIndex]) /
            grid.areas[cellIndex];
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

  const flux = distributeCellInventory(grid, removed);

  let exported = 0;

  for (let orderIndex = 0; orderIndex < cornerCount; orderIndex++) {
    const cornerIndex = order[orderIndex];
    const receiverCorner = drainage.receiver[cornerIndex];
    let volume = flux[cornerIndex];

    if (volume <= 0) {
      continue;
    }

    if (receiverCorner < 0 || drainage.lakeFraction[cornerIndex] > 0) {
      volume = depositRiverMouth(
        grid,
        terrain,
        drainage,
        cornerIndex,
        volume,
        drainage.lakeFraction[cornerIndex] > 0 ? drainage.lakeId[cornerIndex] : -1,
        config,
      );
      // Fine sediment not resolved in the mouth fan enters the receiving water.
      exported += volume;
      continue;
    }

    const slope =
      Math.max(0, height[cornerIndex] - height[receiverCorner]) / Math.max(1, lengths[cornerIndex]);
    const mean = drainage.discharge[cornerIndex];
    const peak = drainage.seasonalPeak?.[cornerIndex] ?? mean;
    const excess = Math.max(0, peak - mean * 1.2);
    const overbankShare = excess / Math.max(1, peak);
    const settling = riverSettlingFraction(lengths[cornerIndex], slope);
    // Overflow exposes additional suspended load to slow floodplain water.
    // Both channel settling and overbank trapping draw from this same load.
    const settle = volume * (settling + (1 - settling) * overbankShare * settling);

    for (let incidentIndex = 0; incidentIndex < 3; incidentIndex++) {
      const cellIndex = grid.triangles[cornerIndex * 3 + incidentIndex];

      if (!terrain.ocean[cellIndex]) {
        const fraction =
          support.cornerCellArea[cornerIndex * 3 + incidentIndex] / support.cornerArea[cornerIndex];
        const length = Math.max(1, lengths[cornerIndex]);
        const distance = Math.max(1, (grid.areas[cellIndex] * radius2) / (2 * length));
        const riverLevel = (height[cornerIndex] + height[receiverCorner]) * 0.5;
        const widths = floodplainWidths({
          supply: drainage.discharge[cornerIndex] * 0.6,
          peak: excess,
          length,
          riverSlope: slope,
          bankSlope: Math.max(0, terrain.height[cellIndex] - riverLevel) / distance,
          availableWidth: distance * 0.8,
          sediment: terrain.sediment[cellIndex],
          extent: config.floodplainExtent,
        });
        const channelWidth = Math.min(distance * 0.8, 4 * Math.sqrt(mean));
        const width = Math.min(widths.bank, channelWidth + widths.flood);
        const stage = Math.max(2, Math.min(6, 0.5 + 0.06 * Math.sqrt(excess)));
        // Alluvial deposition is limited to the accessible bank footprint and
        // low terrace accommodation. Incoming load is the only material source.
        const capacity =
          Math.max(0, riverLevel + stage - terrain.height[cellIndex]) *
          Math.min(grid.areas[cellIndex] * radius2 * fraction, length * width);
        volume -= depositRiverSediment(
          grid,
          terrain,
          cellIndex,
          Math.min(capacity, settle * fraction, volume),
          config.radius,
        );
      }
    }

    flux[receiverCorner] += Math.max(0, volume);
  }

  return exported;
}
