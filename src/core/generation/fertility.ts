import type { World } from '../model';
import { clamp } from '../math';
import { FERTILITY_PRESET } from '../resource-presets';
import { BANK_MEAN_ENHANCEMENT } from './floodplains';
import {
  exposedLandFraction,
  lakeAtCell,
  lakeCoverageAt,
  lakeFreshwaterSuitability,
  soilSalinityLimit,
} from './lake-state';
import { salinityFreshwaterSuitability } from './salinity';

export type FertilityEnvironment = Pick<
  World,
  | 'grid'
  | 'transfer'
  | 'geology'
  | 'terrain'
  | 'water'
  | 'drainage'
  | 'rivers'
  | 'ecology'
  | 'config'
>;

export interface FertilityEvaluation {
  score: number;
  landFraction: number;
  regionalScore: number;
  corridorScore: number;
  meanCorridorScore: number;
  corridorFraction: number;
  sediment: number;
  corridorSediment: number;
  freshwater: number;
  rain: number;
  volcanic: number;
  growingSeason: number;
  slopeLimit: number;
  wetnessLimit: number;
  freshCoverLimit: number;
  soilSalinity: number;
  salineFraction: number;
  salinityLimit: number;
  limitations: string[];
}

export function createFertilityEvaluation(): FertilityEvaluation {
  return {
    score: 0,
    landFraction: 0,
    regionalScore: 0,
    corridorScore: 0,
    meanCorridorScore: 0,
    corridorFraction: 0,
    sediment: 0,
    corridorSediment: 0,
    freshwater: 0,
    rain: 0,
    volcanic: 0,
    growingSeason: 0,
    slopeLimit: 1,
    wetnessLimit: 1,
    freshCoverLimit: 1,
    soilSalinity: 0,
    salineFraction: 0,
    salinityLimit: 1,
    limitations: [],
  };
}

function isStandingWater(environment: FertilityEnvironment, cell: number): boolean {
  return exposedLandFraction(environment.terrain, environment.drainage, cell) < 1e-6;
}

/** The sparse floodplain records are sorted by corner in buildFloodplains. */
function findReach(corners: Uint32Array, corner: number): number {
  let lower = 0;
  let upper = corners.length;
  while (lower < upper) {
    const middle = (lower + upper) >>> 1;
    if (corners[middle] < corner) {
      lower = middle + 1;
    } else {
      upper = middle;
    }
  }
  return corners[lower] === corner ? lower : -1;
}

function potential(
  sediment: number,
  freshwater: number,
  rain: number,
  volcanic: number,
  suitability: number,
): number {
  const preset = FERTILITY_PRESET;
  const ground = clamp(
    preset.baselineGround + preset.sedimentWeight * sediment + preset.volcanicWeight * volcanic,
  );
  const water = 1 - (1 - rain) * (1 - freshwater);
  return 100 * ground * water * suitability;
}

/** Shared by generation and inspection. Local water access is potential, not irrigation.
 * A reusable result avoids retaining contributor arrays at full surface resolution.
 */
export function evaluateFertilityCell(
  environment: FertilityEnvironment,
  cell: number,
  result: FertilityEvaluation = createFertilityEvaluation(),
): FertilityEvaluation {
  result.score = 0;
  result.regionalScore = 0;
  result.corridorScore = 0;
  result.meanCorridorScore = 0;
  result.landFraction = 0;
  result.corridorFraction = 0;
  result.sediment = 0;
  result.corridorSediment = 0;
  result.freshwater = 0;
  result.rain = 0;
  result.volcanic = 0;
  result.growingSeason = 0;
  result.slopeLimit = 1;
  result.wetnessLimit = 1;
  result.freshCoverLimit = 1;
  result.soilSalinity = 0;
  result.salineFraction = 0;
  result.salinityLimit = 1;
  result.limitations.length = 0;

  if (isStandingWater(environment, cell)) {
    result.limitations.push('Standing water');
    return result;
  }
  if (environment.ecology.biome[cell] === 1) {
    result.limitations.push('Permanent ice');
    return result;
  }

  const { grid, terrain, drainage, rivers, ecology, water, config } = environment;
  const preset = FERTILITY_PRESET;
  const area = grid.areas[cell] * config.radius ** 2;
  const landFraction = exposedLandFraction(terrain, drainage, cell);
  result.landFraction = landFraction;
  result.soilSalinity = drainage.soilSalinity?.[cell] ?? 0;
  result.salineFraction = clamp(drainage.soilSalinityFraction?.[cell] ?? 0, 0, landFraction);
  result.salinityLimit = soilSalinityLimit(
    result.soilSalinity,
    result.salineFraction,
    landFraction,
  );
  const floodplains = ecology.floodplains;
  let slope = 0;
  let corridorSlope = 0;
  let shoreFraction = 0;
  let shoreWater = 0;
  let riverAccess = 0;
  const ownLake = lakeAtCell(grid, drainage, cell);
  if (ownLake && landFraction < 1) {
    // A mixed cell contains a shoreline even when no neighbor is entirely water.
    shoreFraction = Math.min(landFraction, (2 * preset.shoreWidthMetres) / Math.sqrt(area));
    shoreWater = shoreFraction * lakeFreshwaterSuitability(ownLake);
  }

  for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
    const neighbor = grid.neighbors[offset];
    const edge = grid.arcEdges[offset];
    const distance = Math.max(1, grid.edgeDistance[edge] * config.radius);
    const edgeLength = grid.edgeLength[edge] * config.radius;

    if (!isStandingWater(environment, neighbor)) {
      slope = Math.max(slope, Math.abs(terrain.height[cell] - terrain.height[neighbor]) / distance);
    }
    const neighborLake = !terrain.ocean[neighbor] && lakeAtCell(grid, drainage, neighbor);
    if (neighborLake && lakeCoverageAt(drainage, neighbor) > 0) {
      const lakeLevel = neighborLake.level;
      const bankSlope = Math.max(0, terrain.height[cell] - lakeLevel) / (distance * 0.5);
      const width = Math.min(
        preset.shoreWidthMetres,
        distance * 0.4,
        preset.shoreAccessHeightMetres / Math.max(1e-5, bankSlope),
      );
      const fraction = (edgeLength * width * lakeCoverageAt(drainage, neighbor)) / area;
      shoreFraction += fraction;
      shoreWater += fraction * lakeFreshwaterSuitability(neighborLake);
    }

    const firstCorner = grid.edgeCorners[edge * 2];
    const secondCorner = grid.edgeCorners[edge * 2 + 1];
    const channelCorner =
      rivers.channel[firstCorner] && drainage.receiver[firstCorner] === secondCorner
        ? firstCorner
        : rivers.channel[secondCorner] && drainage.receiver[secondCorner] === firstCorner
          ? secondCorner
          : -1;
    if (channelCorner < 0) {
      continue;
    }
    const reach = findReach(floodplains.corner, channelCorner);
    const bank = grid.edgeCells[edge * 2] === cell ? 0 : 1;
    if (reach < 0 || floodplains.width[reach * 2 + bank] <= 0) {
      continue;
    }
    riverAccess = Math.max(
      riverAccess,
      (1 - Math.exp(-rivers.supportFlow[channelCorner] / 5)) *
        salinityFreshwaterSuitability(drainage.riverSalinity?.[channelCorner] ?? 0),
    );
    const receiver = drainage.receiver[channelCorner];
    corridorSlope = Math.max(
      corridorSlope,
      Math.max(0, drainage.height[channelCorner] - drainage.height[receiver]) /
        Math.max(1, edgeLength),
    );
  }

  const riverFraction = clamp(ecology.riparianFraction[cell]);
  result.corridorFraction = Math.min(landFraction, Math.max(riverFraction, clamp(shoreFraction)));
  result.freshwater =
    result.corridorFraction > 0
      ? Math.max(riverAccess, shoreFraction > 0 ? shoreWater / shoreFraction : 0)
      : 0;
  if (shoreFraction > 0 && shoreWater / shoreFraction < 0.5 && riverAccess < 0.5) {
    result.limitations.push('Limited lake freshwater');
  }
  result.sediment = 1 - Math.exp(-Math.max(0, terrain.sediment[cell]) / preset.sedimentScaleMetres);
  // Seasonal alluvial context is a capped benefit inside the existing footprint.
  // deltaSediment is already represented in sediment; it is not added again.
  const seasonalAlluvium =
    riverFraction > 0 ? clamp(ecology.floodplainFraction[cell] / riverFraction) : 0;
  result.corridorSediment = Math.max(result.sediment, 0.6 * seasonalAlluvium);
  result.rain = clamp(
    water.rain[cell] / Math.max(1, water.pet[cell]) / preset.adequateRainPetRatio,
  );
  let warmest = -Infinity;
  for (const temperatures of water.seasonalTemperature) {
    warmest = Math.max(warmest, temperatures[cell]);
  }
  result.growingSeason = clamp((warmest - 1) / 14);
  result.slopeLimit = 1 / (1 + (slope / preset.slopeScale) ** 2);
  result.wetnessLimit =
    1 -
    ((preset.maximumWetnessPenalty * water.saturatedSeasons[cell]) / 4) *
      Math.max(0.2, ecology.wetlandFraction[cell]);

  const crust = environment.geology.crust;
  const processCell = environment.transfer[cell];
  const construction = Math.max(0, crust?.volcanic[processCell] ?? 0);
  const age = Math.max(0, crust?.volcanicAge[processCell] ?? 0);
  const maturation = 1 - Math.exp(-age / preset.volcanicMaturationMyr);
  result.volcanic = (1 - Math.exp(-construction / preset.volcanicScaleMetres)) * maturation;
  const exposedCover =
    (1 - Math.exp(-construction / preset.freshCoverScaleMetres)) *
    Math.exp(-Math.max(0, terrain.sediment[cell]) / 5);
  result.freshCoverLimit = 1 - 0.9 * exposedCover * (1 - maturation);

  // Soil stress is independent of the freshwater bonus: even rainy ground can
  // lose fertility, but only in proportion to the exposed salt-affected footprint.
  const sharedSuitability =
    result.growingSeason * result.wetnessLimit * result.freshCoverLimit * result.salinityLimit;
  result.regionalScore = potential(
    result.sediment,
    0,
    result.rain,
    result.volcanic,
    sharedSuitability * result.slopeLimit,
  );
  const corridorSuitability = sharedSuitability / (1 + (corridorSlope / 0.02) ** 2);
  result.corridorScore =
    result.corridorFraction > 0
      ? potential(
          result.corridorSediment,
          result.freshwater,
          result.rain,
          result.volcanic,
          corridorSuitability,
        )
      : result.regionalScore;
  result.meanCorridorScore =
    result.regionalScore +
    BANK_MEAN_ENHANCEMENT * Math.max(0, result.corridorScore - result.regionalScore);
  result.score = clamp(
    (landFraction - result.corridorFraction) * result.regionalScore +
      result.corridorFraction * result.meanCorridorScore,
    0,
    100,
  );

  if (result.rain < 0.35) {
    result.limitations.push('Limited rainfall');
  }
  if (result.growingSeason < 0.85) {
    result.limitations.push('Cold growing season');
  }
  if (result.slopeLimit < 0.85) {
    result.limitations.push('Steep surrounding terrain');
  }
  if (result.wetnessLimit < 0.9) {
    result.limitations.push('Persistent saturation');
  }
  if (result.freshCoverLimit < 0.85) {
    result.limitations.push('Fresh volcanic cover');
  }
  if (result.salinityLimit < 0.98) {
    result.limitations.push('Saline soil');
  }
  return result;
}

export function buildFertility(environment: FertilityEnvironment): Float32Array {
  const fertility = new Float32Array(environment.grid.count);
  const evaluation = createFertilityEvaluation();
  for (let cell = 0; cell < fertility.length; cell++) {
    fertility[cell] = evaluateFertilityCell(environment, cell, evaluation).score;
  }
  return fertility;
}
