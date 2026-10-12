import type {
  Drainage,
  Ecology,
  Floodplains,
  Grid,
  LandWater,
  Rivers,
  Terrain,
  WorldConfig,
} from '../model';
import { clamp } from '../math';
import { exposedLandFraction } from './lake-state';
import { riverbankHalfWidth } from './rivers';

export const RIVER_HABITATS = [
  'None',
  'Riparian meadow',
  'Riparian woodland',
  'Floodplain wetland',
];

// Keep a substantial productive core before fading into the regional vegetation.
// The integral of this smoothstep profile is (1 + start) / 2.
export const BANK_FADE_START = 0.3;

export const BANK_MEAN_ENHANCEMENT = (1 + BANK_FADE_START) / 2;

interface ReachShape {
  supply: number; // qualifying flow, m³/s
  peak: number; // seasonal excess above estimated bankfull, m³/s
  length: number; // reach length, m
  riverSlope: number;
  bankSlope: number;
  availableWidth: number; // resolved space on this side of the valley, m
  sediment: number; // modeled deposited thickness, m
  extent: number;
}

/** Distinguish the persistent alluvial habitat belt from this year's inundation.
 * A broad valley can remain productive between floods. Channel confinement still
 * limits both belts; these are heuristic landscape scales, not a hydraulic solve.
 */
export function floodplainWidths(shape: ReachShape): { bank: number; flood: number } {
  const { supply, peak, length, riverSlope, bankSlope, availableWidth, sediment, extent } = shape;
  const major = clamp(Math.log10(1 + supply / 20) / 2);
  const lowland = 1 / (1 + (riverSlope / 0.0015) ** 2);
  const alluvium = clamp(Math.log1p(Math.max(0, sediment)) / Math.log(51));
  const alluvialWidth =
    Math.min(
      30000,
      riverbankHalfWidth(supply) +
        350 * Math.sqrt(supply) * major * lowland * (0.7 + 0.3 * alluvium),
    ) * extent;
  // This is an accessible alluvial terrace range, not a claimed floodwater depth.
  const accessHeight = 2 + major * lowland * (10 + 6 * alluvium);
  // Floodplain water drains more slowly in low-gradient valleys than channel water.
  // Use a bounded fraction of that residence volume, rather than one fast channel transit.
  const drainageSpeed = clamp(0.04 + 3 * Math.sqrt(riverSlope), 0.05, 0.75);
  const residence = clamp(length / drainageSpeed, 3600, 14 * 86400);
  const floodVolume = 0.15 * peak * residence;
  // The extent control spreads the same volume more shallowly; it adds no water.
  const spreadDepth = 0.3 / extent;
  const floodWidth = Math.min(25000 * extent, floodVolume / (2 * length * spreadDepth));
  const stage = Math.min(6, 0.5 + 0.06 * Math.sqrt(peak));
  const slope = Math.max(1e-5, bankSlope);
  const flood = Math.min(availableWidth, floodWidth, stage / slope);
  const bank = Math.min(
    availableWidth,
    Math.max(Math.min(alluvialWidth, accessHeight / slope), flood),
  );

  return { bank, flood };
}

/** An intentionally small floodplain-potential model, not a hydraulic flood forecast.
 * Seasonal discharge includes upstream rain, snowmelt and soil drainage. Overbank
 * volume and valley slope limit inundation; persistent supply and lowland alluvium
 * support a broader habitat belt between floods. No extra rain or unbudgeted ET is added.
 */
export function buildFloodplains(
  grid: Grid,
  terrain: Terrain,
  water: LandWater,
  drainage: Drainage,
  rivers: Rivers,
  config: WorldConfig,
  ecology: Ecology,
): Floodplains {
  const corners: number[] = [];
  const widths: number[] = [];
  const cover: number[] = [];
  const habitats: number[] = [];
  const floods: number[][] = [[], [], [], []];
  let course = 0;

  for (let cornerIndex = 0; cornerIndex < rivers.channel.length; cornerIndex++) {
    if (!rivers.channel[cornerIndex]) {
      continue;
    }

    while (course < rivers.courses.corner.length && rivers.courses.corner[course] < cornerIndex) {
      course++;
    }

    const receiverCorner = drainage.receiver[cornerIndex];
    let edge = -1;

    for (let incidentIndex = 0; incidentIndex < 3; incidentIndex++) {
      if (grid.cornerNeighbors[cornerIndex * 3 + incidentIndex] === receiverCorner) {
        edge = grid.cornerEdges[cornerIndex * 3 + incidentIndex];
      }
    }

    if (edge < 0) {
      continue;
    }

    corners.push(cornerIndex);
    const sinuosity =
      rivers.courses.corner[course] === cornerIndex ? rivers.courses.sinuosity[course] : 1;
    const length = Math.max(1, grid.edgeLength[edge] * config.radius * sinuosity);
    const mean = drainage.discharge[cornerIndex];
    const supply = rivers.supportFlow[cornerIndex];
    const bankfull = Math.max(mean * 1.2, supply * 1.5, 1);
    const excess = rivers.seasonalDischarge.map((seasonalDischarge) =>
      Math.max(0, seasonalDischarge[cornerIndex] - bankfull),
    );
    const peak = Math.max(...excess);
    const level = (drainage.height[cornerIndex] + drainage.height[receiverCorner]) * 0.5;
    const riverSlope =
      Math.max(0, drainage.height[cornerIndex] - drainage.height[receiverCorner]) / length;

    for (let bank = 0; bank < 2; bank++) {
      const bankCell = grid.edgeCells[edge * 2 + bank];
      const landFraction = exposedLandFraction(terrain, drainage, bankCell);
      const unavailable = landFraction < 1e-6 || ecology.biome[bankCell] === 1;
      let warm = -Infinity;

      for (let seasonIndex = 0; seasonIndex < 4; seasonIndex++) {
        warm = Math.max(warm, water.seasonalTemperature[seasonIndex][bankCell]);
      }

      // Cell centres describe the rise across the valley, not the height of the bank
      // immediately beside the water. Steep banks narrow the strip instead of killing it.
      const distance = Math.max(1, (grid.areas[bankCell] * config.radius ** 2) / (2 * length));
      const slope = Math.max(0, terrain.height[bankCell] - level) / distance;
      const reach = floodplainWidths({
        supply,
        peak,
        length,
        riverSlope,
        bankSlope: slope,
        availableWidth: distance * 0.8 * landFraction,
        sediment: terrain.sediment[bankCell],
        extent: config.floodplainExtent,
      });
      const width = unavailable ? 0 : reach.bank;
      const growing = clamp((warm - 1) / 14);
      const background = ecology.vegetation[bankCell];
      const access = 1 - Math.exp(-supply / 5);
      const potential = width > 0 ? Math.max(background, growing * (0.75 + 0.24 * access)) : 0;
      const fraction = (length * width) / (grid.areas[bankCell] * config.radius ** 2);
      const floodFraction = width > 0 ? Math.min(width, reach.flood) / width : 0;
      const floodedSeasons = excess.filter((rainfall) => rainfall > 0).length;
      const habitat =
        width <= 0 || growing <= 0
          ? 0
          : floodFraction > 0.6 && floodedSeasons >= 2 && water.soil[bankCell] > 100
            ? 3
            : warm < 10 || potential < 0.65
              ? 1
              : 2;
      widths.push(width);
      cover.push(potential);
      habitats.push(habitat);

      for (let seasonIndex = 0; seasonIndex < 4; seasonIndex++) {
        floods[seasonIndex].push(
          peak > 0 && water.seasonalTemperature[seasonIndex][bankCell] > 0
            ? (floodFraction * excess[seasonIndex]) / peak
            : 0,
        );
      }

      ecology.riparian[bankCell] += potential * fraction;
      ecology.riparianFraction[bankCell] += fraction;
      ecology.floodplainFraction[bankCell] += fraction * floodFraction;
      ecology.riverbankVegetation[cornerIndex] += potential * 0.5;

      if (potential > 0 && habitat > ecology.riverHabitat[bankCell]) {
        ecology.riverHabitat[bankCell] = habitat;
      }
    }
  }

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    if (ecology.riparianFraction[cellIndex] > 0) {
      ecology.riparian[cellIndex] /= ecology.riparianFraction[cellIndex];
    }

    const landFraction = exposedLandFraction(terrain, drainage, cellIndex);
    ecology.riparianFraction[cellIndex] = clamp(
      ecology.riparianFraction[cellIndex],
      0,
      landFraction,
    );
    ecology.floodplainFraction[cellIndex] = clamp(
      ecology.floodplainFraction[cellIndex],
      0,
      landFraction,
    );
    // Average the same lateral fade used by the renderer; overlapping reaches are capped.
    ecology.vegetation[cellIndex] +=
      Math.max(0, ecology.riparian[cellIndex] - ecology.vegetation[cellIndex]) *
      ecology.riparianFraction[cellIndex] *
      BANK_MEAN_ENHANCEMENT;
  }

  return {
    corner: new Uint32Array(corners),
    width: new Float32Array(widths),
    vegetation: new Float32Array(cover),
    habitat: new Uint8Array(habitats),
    seasonalFlood: floods.map((values) => new Float32Array(values)),
  };
}
