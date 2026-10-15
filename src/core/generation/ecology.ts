import type { Grid, LandWater, Terrain, Drainage, Ecology, Rivers, WorldConfig } from '../model';
import { clamp } from '../math';
import { buildFloodplains } from './floodplains';
import { classifyWetlands } from './wetlands';
import { exposedLandFraction, soilSalinityLimit } from './lake-state';

export const BIOMES = [
  'Ocean',
  'Ice sheet',
  'Tundra',
  'Boreal forest',
  'Temperate forest',
  'Grassland',
  'Desert',
  'Savanna',
  'Tropical forest',
  'Rainforest',
  'Mediterranean',
  'Wetland',
  'Lake',
];

/** Köppen-style dry-climate boundary, in annual mm. Four seasons approximate
 * warm-half-year rainfall; this is not a full monthly Köppen classification.
 */
export function desertRainThreshold(
  temperature: number,
  warmHalfRain: number,
  annualRain: number,
): number {
  const summerShare = warmHalfRain / Math.max(1, annualRain);
  const seasonalAdjustment = summerShare >= 0.7 ? 280 : summerShare <= 0.3 ? 0 : 140;

  return Math.max(0, 20 * temperature + seasonalAdjustment) * 0.5;
}

export function classifyEcology(
  grid: Grid,
  terrain: Terrain,
  water: LandWater,
  drainage: Drainage,
  rivers: Rivers,
  config: WorldConfig,
): Ecology {
  const biome = new Uint8Array(grid.count);
  const vegetation = new Float32Array(grid.count);
  const riparian = new Float32Array(grid.count);
  const riparianFraction = new Float32Array(grid.count);
  const riverbankVegetation = new Float32Array(drainage.receiver.length);
  const ice = new Float32Array(grid.count);

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    const temperature = water.temperature[cellIndex];
    const rainfall = water.rain[cellIndex];
    const aridity = water.aridity[cellIndex];
    let warm = -Infinity;
    let cold = Infinity;
    let summer = 0;
    let winter = 0;

    for (let seasonIndex = 0; seasonIndex < 4; seasonIndex++) {
      const temp = water.seasonalTemperature[seasonIndex][cellIndex];

      if (temp > warm) {
        warm = temp;
        summer = seasonIndex;
      }

      if (temp < cold) {
        cold = temp;
        winter = seasonIndex;
      }
    }

    const warmHalfRain =
      water.seasonalRain[summer][cellIndex] +
      0.5 *
        (water.seasonalRain[(summer + 1) % 4][cellIndex] +
          water.seasonalRain[(summer + 3) % 4][cellIndex]);
    let biomeIndex = 0;

    if (terrain.ocean[cellIndex]) {
      ice[cellIndex] = clamp(-temperature / 12);
    } else if (exposedLandFraction(terrain, drainage, cellIndex) < 1e-6) {
      biomeIndex = 12;
    } else if (warm < 1 && water.snow[cellIndex] > 70) {
      biomeIndex = 1;
      ice[cellIndex] = clamp(water.snow[cellIndex] / 500);
    } else if (warm < 10) {
      biomeIndex = 2;
    }
    // Apply dryness before assigning tropical savanna. Temperature and timing of
    // rain matter; the simplified PET estimate alone missed warm dry climates.
    else if (aridity > 5 || rainfall < desertRainThreshold(temperature, warmHalfRain, rainfall)) {
      biomeIndex = 6;
    } else if (temperature < 6 || (cold < -3 && warm < 22)) {
      biomeIndex = aridity < 1.65 && rainfall > 250 ? 3 : 5;
    } else if (
      cold < 15 &&
      warm - cold > 7 &&
      warm > 18 &&
      water.seasonalRain[summer][cellIndex] < water.seasonalRain[winter][cellIndex] * 0.4 &&
      water.seasonalRain[winter][cellIndex] > 100
    ) {
      biomeIndex = 10;
    } else if (cold >= 18) {
      let driest = Infinity;

      for (let seasonIndex = 0; seasonIndex < 4; seasonIndex++) {
        driest = Math.min(driest, water.seasonalRain[seasonIndex][cellIndex]);
      }

      biomeIndex =
        rainfall > 1500 && driest >= 180 && aridity < 0.9
          ? 9
          : rainfall > 700 && aridity < 1.25
            ? 8
            : 7;
    } else {
      biomeIndex = aridity < 1.35 && rainfall > 300 ? 4 : 5;
    }

    biome[cellIndex] = biomeIndex;
    // The soil budget already accounts for rain, demand, storage, and snowmelt.
    // Use its fulfilled demand once, instead of multiplying two drought penalties.
    // Annual potential describes growing-season cover, including short cool summers.
    const waterAvailability = clamp(water.aet[cellIndex] / Math.max(1, water.pet[cellIndex]));
    const growingSeason = clamp((warm - 1) / 14);
    vegetation[cellIndex] =
      biomeIndex === 0 || biomeIndex === 1 || biomeIndex === 12
        ? 0
        : (1 - Math.exp(-3 * waterAvailability)) *
          growingSeason *
          soilSalinityLimit(
            drainage.soilSalinity?.[cellIndex] ?? 0,
            drainage.soilSalinityFraction?.[cellIndex] ?? 0,
            exposedLandFraction(terrain, drainage, cellIndex),
          );
  }

  const ecology: Ecology = {
    biome,
    vegetation,
    riparian,
    riparianFraction,
    riverbankVegetation,
    ice,
    wetland: new Uint8Array(grid.count),
    wetlandFraction: new Float32Array(grid.count),
    riverHabitat: new Uint8Array(grid.count),
    floodplainFraction: new Float32Array(grid.count),
    floodplains: {
      corner: new Uint32Array(0),
      width: new Float32Array(0),
      vegetation: new Float32Array(0),
      habitat: new Uint8Array(0),
      seasonalFlood: [],
    },
  };
  ecology.floodplains = buildFloodplains(grid, terrain, water, drainage, rivers, config, ecology);
  classifyWetlands(grid, terrain, water, drainage, rivers, config, ecology);

  return ecology;
}
