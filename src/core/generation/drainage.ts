import {
  YEAR,
  SEASON,
  type Drainage,
  type Grid,
  type Lake,
  type LandWater,
  type Terrain,
  type WorldConfig,
} from '../model';
import { floodCorners } from './drainage-topology';
import { balanceLake } from './reservoir';
import { resolveNestedLakes } from './nested-lakes';
import { resolveLakeSurfaces } from './lake-surfaces';
import { computeCornerSupport } from '../operators/corner-fields';

/** The corner graph is the only drainage authority. No cell receiver forest exists. */
export function routeWater(
  grid: Grid,
  terrain: Terrain,
  water: LandWater,
  config: WorldConfig,
): Drainage {
  const { height, filled, parent, rank, order, outlet } = floodCorners(grid, terrain);
  const cornerCount = height.length;
  const receiver = new Int32Array(cornerCount).fill(-1);
  const input = new Float64Array(cornerCount);
  const cornerArea = new Float64Array(cornerCount);
  const rainVolume = new Float64Array(cornerCount);
  const evapVolume = new Float64Array(cornerCount);
  const seasonalDischarge = Array.from({ length: 4 }, () => new Float64Array(cornerCount));
  const support = computeCornerSupport(grid);

  const seasonalFlux = (corner: number, season: number): [number, number, number] => {
    let rain = 0;
    let evaporation = 0;
    let runoff = 0;
    for (let incident = 0; incident < 3; incident++) {
      const cell = grid.triangles[corner * 3 + incident];
      const supportArea = support.cornerCellArea[corner * 3 + incident];
      const fraction = supportArea / grid.areas[cell];
      const volumePerMillimetre = (supportArea * config.radius ** 2 * 0.001) / SEASON;
      rain += water.seasonalLiquid[season][cell] * volumePerMillimetre;
      evaporation += water.seasonalPet[season][cell] * volumePerMillimetre;
      runoff += water.seasonalRunoff[season][cell] * fraction;
    }
    return [rain, evaporation, runoff];
  };

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    for (
      let neighborOffset = grid.offsets[cellIndex];
      neighborOffset < grid.offsets[cellIndex + 1];
      neighborOffset++
    ) {
      const cornerIndex = grid.cellCorners[neighborOffset];
      const fraction = support.cellCornerFraction[neighborOffset];
      const area = support.cellCornerArea[neighborOffset] * config.radius ** 2;
      input[cornerIndex] += water.runoff[cellIndex] * fraction;
      cornerArea[cornerIndex] += area;
      for (let season = 0; season < 4; season++) {
        rainVolume[cornerIndex] += (water.seasonalLiquid[season][cellIndex] * 0.001 * area) / YEAR;
        seasonalDischarge[season][cornerIndex] +=
          water.seasonalRunoff[season][cellIndex] * fraction;
      }
      evapVolume[cornerIndex] += (water.pet[cellIndex] * 0.001 * area) / YEAR;
    }
  }

  for (let cornerIndex = 0; cornerIndex < cornerCount; cornerIndex++) {
    if (!outlet[cornerIndex]) {
      receiver[cornerIndex] = parent[cornerIndex];
      let slope = 0;

      for (let neighborSlot = 0; neighborSlot < 3; neighborSlot++) {
        const neighborCorner = grid.cornerNeighbors[cornerIndex * 3 + neighborSlot];

        if (rank[neighborCorner] >= rank[cornerIndex]) {
          continue;
        }

        const drop = height[cornerIndex] - height[neighborCorner];
        const distance =
          grid.edgeLength[grid.cornerEdges[cornerIndex * 3 + neighborSlot]] * config.radius;

        if (drop > 0 && drop / Math.max(1, distance) > slope) {
          slope = drop / Math.max(1, distance);
          receiver[cornerIndex] = neighborCorner;
        }
      }
    }
  }

  // Connected flooded patches start as lumped reservoirs; stranded interior ponds are refined below.
  const lakeId = new Int32Array(cornerCount).fill(-1);
  const members: number[][] = [];
  const anchors: number[] = [];
  const queue = new Uint32Array(cornerCount);

  for (let cornerIndex = 0; cornerIndex < cornerCount; cornerIndex++) {
    if (
      !outlet[cornerIndex] &&
      filled[cornerIndex] > height[cornerIndex] + 0.1 &&
      lakeId[cornerIndex] < 0
    ) {
      const lakeIndex = members.length;
      const list: number[] = [];
      let head = 0;
      let tail = 1;
      let anchor = cornerIndex;
      queue[0] = cornerIndex;
      lakeId[cornerIndex] = lakeIndex;

      while (head < tail) {
        const basinCorner = queue[head++];
        list.push(basinCorner);

        if (rank[basinCorner] < rank[anchor]) {
          anchor = basinCorner;
        }

        for (let neighborSlot = 0; neighborSlot < 3; neighborSlot++) {
          const neighborCorner = grid.cornerNeighbors[basinCorner * 3 + neighborSlot];

          if (
            !outlet[neighborCorner] &&
            lakeId[neighborCorner] < 0 &&
            filled[neighborCorner] > height[neighborCorner] + 0.1 &&
            Math.abs(filled[neighborCorner] - filled[cornerIndex]) < 0.05
          ) {
            lakeId[neighborCorner] = lakeIndex;
            queue[tail++] = neighborCorner;
          }
        }
      }

      members.push(list);
      anchors.push(anchor);
    }
  }

  // Reservoir members terminate at their reservoir, irrespective of natural downhill alternatives.
  const discharge = new Float64Array(input);
  const accumulated = new Float64Array(members.length);
  const accumulatedSeasons = Array.from({ length: 4 }, () => new Float64Array(members.length));
  const lakes: Lake[] = [];
  const lakeDepth = new Float32Array(grid.count);
  const basin = new Uint32Array(cornerCount);
  let oceanDischarge = 0;
  let lakeExchange = 0;
  let nextLakeId = members.length;

  for (let orderIndex = cornerCount - 1; orderIndex >= 0; orderIndex--) {
    const cornerIndex = order[orderIndex];
    const lakeIndex = lakeId[cornerIndex];

    if (lakeIndex >= 0) {
      accumulated[lakeIndex] += discharge[cornerIndex];
      for (let season = 0; season < 4; season++) {
        accumulatedSeasons[season][lakeIndex] += seasonalDischarge[season][cornerIndex];
      }

      if (cornerIndex !== anchors[lakeIndex]) {
        continue;
      }

      const list = members[lakeIndex];
      const spill = filled[cornerIndex];
      const lake = balanceLake(
        lakeIndex,
        parent[cornerIndex],
        spill,
        list,
        height,
        cornerArea,
        input,
        rainVolume,
        evapVolume,
        accumulated[lakeIndex],
        { inflow: accumulatedSeasons.map((field) => field[lakeIndex]), at: seasonalFlux },
      );

      if (lake.kind === 'closed') {
        let first = true;
        const nested = resolveNestedLakes({
          grid,
          members: list,
          height,
          rank,
          input,
          discharge,
          seasonalDischarge,
          seasonalFlux,
          rain: rainVolume,
          evap: evapVolume,
          area: cornerArea,
          candidate: lake,
          escapeFrom: cornerIndex,
          receiver,
          lakeId,
          allocateId: () => {
            if (first) {
              first = false;

              return lakeIndex;
            }

            return nextLakeId++;
          },
        });

        if (nested) {
          lakes.push(...nested.lakes);
          lakeExchange += accumulated[lakeIndex] - nested.outflow;

          if (parent[cornerIndex] >= 0) {
            discharge[parent[cornerIndex]] += nested.outflow;
            for (let season = 0; season < 4; season++) {
              seasonalDischarge[season][parent[cornerIndex]] += nested.seasonalOutflow[season];
            }
          }

          for (const basinCorner of list) {
            const reservoir = nested.byCorner.get(basinCorner)!;

            if (reservoir.area <= 0 || height[basinCorner] > reservoir.level) {
              continue;
            }

            for (let neighborSlot = 0; neighborSlot < 3; neighborSlot++) {
              const cellIndex = grid.triangles[basinCorner * 3 + neighborSlot];

              if (!terrain.ocean[cellIndex]) {
                lakeDepth[cellIndex] = Math.max(
                  lakeDepth[cellIndex],
                  reservoir.level - terrain.height[cellIndex],
                );
              }
            }
          }

          continue;
        }
      }

      lakes.push(lake);
      lakeExchange += accumulated[lakeIndex] - lake.outflow;

      if (parent[cornerIndex] >= 0) {
        discharge[parent[cornerIndex]] += lake.outflow;
        for (let season = 0; season < 4; season++) {
          seasonalDischarge[season][parent[cornerIndex]] += lake.seasonal!.outflow[season];
        }
      }

      for (const basinCorner of list) {
        receiver[basinCorner] = -1;

        if (lake.area > 0 && height[basinCorner] <= lake.level) {
          for (let neighborSlot = 0; neighborSlot < 3; neighborSlot++) {
            const cellIndex = grid.triangles[basinCorner * 3 + neighborSlot];

            if (!terrain.ocean[cellIndex]) {
              lakeDepth[cellIndex] = Math.max(
                lakeDepth[cellIndex],
                lake.level - terrain.height[cellIndex],
              );
            }
          }
        }
      }

      // Dry parts retain downhill channels; wet portions terminate at the reservoir.
      // External injections were accumulated above; this pass only distributes the internal paths.
      const dryOrder = list
        .filter((basinCorner) => height[basinCorner] > lake.level)
        .sort((firstCorner, secondCorner) => height[secondCorner] - height[firstCorner]);

      for (const basinCorner of dryOrder) {
        let best = -1;
        let bestSlope = 0;

        for (let neighborSlot = 0; neighborSlot < 3; neighborSlot++) {
          const neighborCorner = grid.cornerNeighbors[basinCorner * 3 + neighborSlot];

          if (
            lakeId[neighborCorner] !== lakeIndex ||
            height[neighborCorner] >= height[basinCorner]
          ) {
            continue;
          }

          const slope =
            (height[basinCorner] - height[neighborCorner]) /
            Math.max(
              1,
              grid.edgeLength[grid.cornerEdges[basinCorner * 3 + neighborSlot]] * config.radius,
            );

          if (slope > bestSlope) {
            best = neighborCorner;
            bestSlope = slope;
          }
        }

        receiver[basinCorner] = best;

        if (best >= 0) {
          discharge[best] += discharge[basinCorner];
          for (let season = 0; season < 4; season++) {
            seasonalDischarge[season][best] += seasonalDischarge[season][basinCorner];
          }
        }
      }

      // Only actual spill is a channel, anchored at the geometric escape.
      if (lake.outflow > 0) {
        receiver[cornerIndex] = parent[cornerIndex];
        discharge[cornerIndex] = lake.outflow;
        for (let season = 0; season < 4; season++) {
          seasonalDischarge[season][cornerIndex] = lake.seasonal!.outflow[season];
        }
      }
    } else if (outlet[cornerIndex]) {
      oceanDischarge += discharge[cornerIndex];
    } else if (receiver[cornerIndex] >= 0) {
      discharge[receiver[cornerIndex]] += discharge[cornerIndex];
      for (let season = 0; season < 4; season++) {
        seasonalDischarge[season][receiver[cornerIndex]] += seasonalDischarge[season][cornerIndex];
      }
    }
  }

  // Follow the same ordered receiver graph for display basins; closed reservoirs are terminals.
  for (let orderIndex = 0; orderIndex < cornerCount; orderIndex++) {
    const cornerIndex = order[orderIndex];
    const lakeIndex = lakeId[cornerIndex];

    if (lakeIndex >= 0) {
      basin[cornerIndex] = cornerCount + lakeIndex;
    } else {
      basin[cornerIndex] = receiver[cornerIndex] < 0 ? cornerIndex : basin[receiver[cornerIndex]];
    }
  }

  lakes.sort((firstLake, secondLake) => firstLake.id - secondLake.id);
  // Retain one peak field for floodplain sediment access; the four temporary
  // seasonal routing arrays can be released after this solve.
  const seasonalPeak = new Float32Array(cornerCount);
  for (let corner = 0; corner < cornerCount; corner++) {
    seasonalPeak[corner] = Math.max(
      seasonalDischarge[0][corner],
      seasonalDischarge[1][corner],
      seasonalDischarge[2][corner],
      seasonalDischarge[3][corner],
    );
  }
  const result: Drainage = {
    height,
    filled,
    receiver,
    order,
    discharge,
    seasonalPeak,
    basin,
    lakeId,
    lakeDepth,
    lakeFraction: new Float32Array(cornerCount),
    lakeCoverage: new Float32Array(grid.count),
    lakes,
    runoffTotal: input.reduce((totalVolume, runoffVolume) => totalVolume + runoffVolume, 0),
    oceanDischarge,
    lakeExchange,
  };
  resolveLakeSurfaces(grid, result, cornerArea, input);

  return result;
}
