import {
  YEAR,
  SEASON,
  type Grid,
  type Climate,
  type LandWater,
  type Terrain,
  type WorldConfig,
} from '../model';
import { clamp } from '../math';
import { prolongRainfall } from '../operators/prolongation';

/** Conservative rain prolongation and a seasonal soil/snow budget.
 * Four repeated years initialize storage; only the last year contributes annual fluxes.
 * Quickflow represents rainfall that runs off before entering the soil (storms/impermeable ground).
 */
export function solveLandWater(
  grid: Grid,
  processGrid: Grid,
  surfaceToProcess: Uint32Array,
  climate: Climate,
  terrain: Terrain,
  config: WorldConfig,
  processHeight: Float32Array,
): LandWater {
  const cellCount = grid.count;
  const rain = new Float32Array(cellCount);
  const temperature = new Float32Array(cellCount);
  const potentialEvapotranspiration = new Float32Array(cellCount);
  const actualEvapotranspiration = new Float32Array(cellCount);
  const runoff = new Float64Array(cellCount);
  const channelRunoff = new Float64Array(cellCount);
  const meltRunoff = new Float32Array(cellCount);
  const baseflowRunoff = new Float32Array(cellCount);
  const soil = new Float64Array(cellCount);
  const soilMelt = new Float64Array(cellCount);
  const snow = new Float64Array(cellCount);
  const saturatedSeasons = new Uint8Array(cellCount);
  const aridity = new Float32Array(cellCount);
  const seasonalRain = prolongRainfall(grid, processGrid, surfaceToProcess, climate.rain);
  const seasonalLiquid = Array.from({ length: 4 }, () => new Float32Array(cellCount));
  const seasonalTemperature: Float32Array[] = [];
  const seasonalPet: Float32Array[] = [];
  const seasonalRunoff = Array.from({ length: 4 }, () => new Float32Array(cellCount));
  const ponds = terrain.oxbows;
  const pondAt = new Int32Array(cellCount).fill(-1);
  const pondStorage = new Float64Array(ponds.length);
  const pondMelt = new Float64Array(ponds.length);
  const oxbowDepth = Array.from({ length: 4 }, () => new Float32Array(ponds.length));

  for (let pondIndex = 0; pondIndex < ponds.length; pondIndex++) {
    pondAt[ponds[pondIndex].cell] = pondIndex;
  }

  let residual = 0;

  for (let seasonIndex = 0; seasonIndex < 4; seasonIndex++) {
    const seasonRain = seasonalRain[seasonIndex];
    const seasonTemperature = new Float32Array(cellCount);
    const seasonPotentialEvapotranspiration = new Float32Array(cellCount);

    for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
      const processCell = surfaceToProcess[cellIndex];
      seasonTemperature[cellIndex] =
        climate.temperature[seasonIndex][processCell] -
        (terrain.ocean[cellIndex]
          ? 0
          : 0.006 *
            (Math.max(0, terrain.height[cellIndex]) - Math.max(0, processHeight[processCell])));
      const wind = climate.wind[seasonIndex];
      const speed = Math.hypot(
        wind[processCell * 3],
        wind[processCell * 3 + 1],
        wind[processCell * 3 + 2],
      );
      seasonPotentialEvapotranspiration[cellIndex] =
        (Math.max(0, seasonTemperature[cellIndex] + 5) * (0.075 + speed * 0.0015) * 365.25) / 4;
      rain[cellIndex] += seasonRain[cellIndex];
      temperature[cellIndex] += seasonTemperature[cellIndex] * 0.25;
      potentialEvapotranspiration[cellIndex] += seasonPotentialEvapotranspiration[cellIndex];
    }

    seasonalTemperature.push(seasonTemperature);
    seasonalPet.push(seasonPotentialEvapotranspiration);
  }

  for (let year = 0; year < 4; year++) {
    for (let seasonIndex = 0; seasonIndex < 4; seasonIndex++) {
      for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
        if (terrain.ocean[cellIndex]) {
          continue;
        }

        const precip = seasonalRain[seasonIndex][cellIndex];
        const temperature = seasonalTemperature[seasonIndex][cellIndex];
        const soilStart = soil[cellIndex];
        const start = soil[cellIndex] + snow[cellIndex];
        const snowfall = temperature < 0 ? precip : 0;
        snow[cellIndex] += snowfall;
        const melt = Math.min(snow[cellIndex], Math.max(0, temperature) * 12);
        snow[cellIndex] -= melt;
        const liquid = precip - snowfall + melt;
        const quickflow = liquid * (1 - config.infiltration);
        let available = soil[cellIndex] + liquid - quickflow;
        const meltShare =
          available > 0 ? (soilMelt[cellIndex] + melt * config.infiltration) / available : 0;
        const actual = Math.min(available, seasonalPet[seasonIndex][cellIndex]);
        available -= actual;
        const overflow = Math.max(0, available - config.soilCapacity);
        available -= overflow;
        // Slow drainage sustains tributaries after their wet season; it is deducted from storage.
        const baseflow = available * 0.08;
        soil[cellIndex] = available - baseflow;
        soilMelt[cellIndex] = soil[cellIndex] * meltShare;
        const pondIndex = pondAt[cellIndex];
        const fraction =
          pondIndex < 0 ? 0 : ponds[pondIndex].area / (grid.areas[cellIndex] * config.radius ** 2);
        const pondStart = pondIndex < 0 ? 0 : pondStorage[pondIndex];
        let pondEvap = 0;
        let pondOverflow = 0;
        let pondMeltShare = 0;

        if (pondIndex >= 0) {
          const availablePondWater = pondStorage[pondIndex] + liquid;
          pondMeltShare =
            availablePondWater > 0 ? (pondMelt[pondIndex] + melt) / availablePondWater : 0;
          pondEvap = Math.min(availablePondWater, seasonalPet[seasonIndex][cellIndex]);
          pondOverflow = Math.max(
            0,
            availablePondWater - pondEvap - ponds[pondIndex].capacity * 1000,
          );
          pondStorage[pondIndex] = availablePondWater - pondEvap - pondOverflow;
          pondMelt[pondIndex] = pondStorage[pondIndex] * pondMeltShare;
        }

        // A cutoff pond replaces its footprint's soil bucket. Rain, melt, evaporation,
        // storage and overflow use the same ledger; no ornamental water is added.
        const runoffDepth =
          (1 - fraction) * (quickflow + overflow + baseflow) + fraction * pondOverflow;
        const actualDepth = (1 - fraction) * actual + fraction * pondEvap;

        if (year === 3) {
          seasonalLiquid[seasonIndex][cellIndex] = liquid;
          residual += Math.abs(
            start +
              fraction * (pondStart - soilStart) +
              precip -
              snow[cellIndex] -
              (1 - fraction) * soil[cellIndex] -
              fraction * (pondIndex < 0 ? 0 : pondStorage[pondIndex]) -
              actualDepth -
              runoffDepth,
          );
          actualEvapotranspiration[cellIndex] += actualDepth;

          if (available >= config.soilCapacity * 0.85) {
            saturatedSeasons[cellIndex]++;
          }

          if (pondIndex >= 0) {
            oxbowDepth[seasonIndex][pondIndex] = pondStorage[pondIndex] * 0.001;
          }

          const toRate = (0.001 * grid.areas[cellIndex] * config.radius ** 2) / YEAR;
          meltRunoff[cellIndex] +=
            ((1 - fraction) * (melt * (1 - config.infiltration) + overflow * meltShare) +
              fraction * pondOverflow * pondMeltShare) *
            toRate;
          baseflowRunoff[cellIndex] += (1 - fraction) * baseflow * toRate;
          runoff[cellIndex] +=
            (runoffDepth * 0.001 * grid.areas[cellIndex] * config.radius ** 2) / YEAR;
          seasonalRunoff[seasonIndex][cellIndex] =
            (runoffDepth * 0.001 * grid.areas[cellIndex] * config.radius ** 2) / SEASON;
          // Retain the origin of existing runoff. Annual storm drainage alone does not
          // establish a continuously drawn channel; this does not add or remove water.
          channelRunoff[cellIndex] +=
            ((1 - fraction) * (overflow + baseflow) + fraction * pondOverflow) * toRate;
        }
      }
    }
  }

  for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
    aridity[cellIndex] = clamp(
      potentialEvapotranspiration[cellIndex] / Math.max(1, rain[cellIndex]),
      0,
      6,
    );
  }

  return {
    rain,
    temperature,
    pet: potentialEvapotranspiration,
    aet: actualEvapotranspiration,
    runoff,
    channelRunoff,
    soil: Float32Array.from(soil),
    snow: Float32Array.from(snow),
    aridity,
    seasonalRain,
    seasonalTemperature,
    seasonalLiquid,
    seasonalPet,
    seasonalRunoff,
    meltRunoff,
    baseflowRunoff,
    saturatedSeasons,
    oxbowDepth,
    residual,
  };
}

/** Area-weighted actual land evaporation for one bounded atmospheric feedback pass. */
export function restrictEvaporation(
  grid: Grid,
  processGrid: Grid,
  surfaceToProcess: Uint32Array,
  terrain: Terrain,
  water: LandWater,
): Float32Array {
  const volume = new Float64Array(processGrid.count);

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    if (!terrain.ocean[cellIndex]) {
      volume[surfaceToProcess[cellIndex]] += grid.areas[cellIndex] * water.aet[cellIndex];
    }
  }

  return Float32Array.from(
    volume,
    (evaporationVolume, processCell) => evaporationVolume / processGrid.areas[processCell],
  );
}
