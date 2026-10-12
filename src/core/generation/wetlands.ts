import type { Grid, Terrain, LandWater, Drainage, Rivers, Ecology, WorldConfig } from '../model';
import { clamp } from '../math';
import { YEAR } from '../model';
import { exposedLandFraction, lakeCoverageAt } from './lake-state';

export const WETLANDS = ['None', 'Marsh', 'Swamp', 'Fen', 'Bog'];

/** Habitat fractions from saturation and water access, not a replacement climate biome.
 * Bogs are rain-fed, relatively isolated peatland potential; river-fed wet ground
 * is a marsh, swamp or fen. Chemistry and accumulated peat are not simulated.
 */
export function classifyWetlands(
  grid: Grid,
  terrain: Terrain,
  water: LandWater,
  drainage: Drainage,
  rivers: Rivers,
  config: WorldConfig,
  ecology: Ecology,
) {
  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    const landFraction = exposedLandFraction(terrain, drainage, cellIndex);
    if (terrain.ocean[cellIndex] || ecology.biome[cellIndex] === 1 || landFraction < 1e-6) {
      continue;
    }

    const warm = Math.max(
      ...water.seasonalTemperature.map((seasonalSaturation) => seasonalSaturation[cellIndex]),
    );

    if (warm <= 1) {
      continue;
    }

    let slope = 0;
    let shore = drainage.lakeCoverage[cellIndex];

    for (
      let neighborOffset = grid.offsets[cellIndex];
      neighborOffset < grid.offsets[cellIndex + 1];
      neighborOffset++
    ) {
      const neighborCell = grid.neighbors[neighborOffset];
      const edge = grid.arcEdges[neighborOffset];
      slope = Math.max(
        slope,
        Math.abs(terrain.height[cellIndex] - terrain.height[neighborCell]) /
          Math.max(1, grid.edgeDistance[edge] * config.radius),
      );

      if (!terrain.ocean[neighborCell]) {
        shore = Math.max(shore, drainage.lakeCoverage[neighborCell] * 0.25);
      }
    }

    const flat = 1 / (1 + (slope / 0.003) ** 2);
    const saturated = water.saturatedSeasons[cellIndex] / 4;
    const riparianCoverage = ecology.riparianFraction[cellIndex];
    const flood = ecology.floodplainFraction[cellIndex];
    const humid = clamp((water.rain[cellIndex] / Math.max(1, water.pet[cellIndex]) - 0.8) / 0.8);
    const delta =
      clamp(terrain.deltaSediment[cellIndex] / 8) * clamp((20 - terrain.height[cellIndex]) / 20);
    const localWet = flat * saturated * humid;
    const wetSeasons = Array.from({ length: 4 }, (_, season) =>
      lakeCoverageAt(drainage, cellIndex, season),
    );
    const seasonalShore = Math.max(...wetSeasons) - Math.min(...wetSeasons);
    const fraction = Math.max(
      flood * 0.85,
      shore * flat,
      localWet * 0.45,
      delta * Math.max(saturated, flood) * 0.55,
      seasonalShore * flat,
    );

    if (fraction < 0.025) {
      continue;
    }

    let kind = 1;

    if (
      localWet > 0.45 &&
      riparianCoverage < 0.02 &&
      shore < 0.02 &&
      delta < 0.02 &&
      water.temperature[cellIndex] < 16
    ) {
      kind = 4;
    } else if (
      water.temperature[cellIndex] < 14 &&
      saturated >= 0.5 &&
      riparianCoverage > 0.01 &&
      water.baseflowRunoff[cellIndex] > water.runoff[cellIndex] * 0.15
    ) {
      kind = 3;
    } else if (
      water.temperature[cellIndex] > 12 &&
      ecology.vegetation[cellIndex] > 0.78 &&
      saturated >= 0.75
    ) {
      kind = 2;
    }

    ecology.wetland[cellIndex] = kind;
    ecology.wetlandFraction[cellIndex] = Math.min(landFraction, clamp(fraction, 0, 0.85));
  }

  // Fresh deposited delta flats have river access even in an arid catchment.
  // This bounded habitat credit changes potential cover, never rainfall or AET.
  for (const delta of rivers.deltas) {
    const cells = new Set<number>();

    for (const cornerIndex of [delta.corner, drainage.receiver[delta.corner]]) {
      for (let incidentIndex = 0; incidentIndex < 3; incidentIndex++) {
        const cellIndex = grid.triangles[cornerIndex * 3 + incidentIndex];

        if (
          !terrain.ocean[cellIndex] &&
          terrain.deltaSediment[cellIndex] > 0 &&
          exposedLandFraction(terrain, drainage, cellIndex) > 0
        ) {
          cells.add(cellIndex);
        }
      }
    }

    const access = (rivers.supportFlow[delta.corner] * YEAR * 0.02) / Math.max(1, cells.size);

    for (const cellIndex of cells) {
      const fraction = clamp(
        access /
          Math.max(1, water.pet[cellIndex] * 0.001 * grid.areas[cellIndex] * config.radius ** 2),
        0,
        0.45,
      );

      if (fraction < 0.025 || ecology.biome[cellIndex] === 1) {
        continue;
      }

      if (!ecology.wetland[cellIndex]) {
        ecology.wetland[cellIndex] = 1;
      }

      ecology.wetlandFraction[cellIndex] = Math.min(
        exposedLandFraction(terrain, drainage, cellIndex),
        Math.max(ecology.wetlandFraction[cellIndex], fraction),
      );
      ecology.vegetation[cellIndex] += Math.max(0, 0.8 - ecology.vegetation[cellIndex]) * fraction;
    }
  }

  for (let cornerIndex = 0; cornerIndex < rivers.headwater.length; cornerIndex++) {
    if (
      !rivers.headwater[cornerIndex] ||
      rivers.source[cornerIndex] === 2 ||
      rivers.source[cornerIndex] === 4
    ) {
      continue;
    }

    if (
      [0, 1, 2].some(
        (incidentIndex) =>
          ecology.wetlandFraction[grid.triangles[cornerIndex * 3 + incidentIndex]] >= 0.1,
      )
    ) {
      rivers.source[cornerIndex] = 5;
    }
  }
}
