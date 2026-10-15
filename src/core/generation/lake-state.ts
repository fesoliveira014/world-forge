import type { Drainage, Grid, Lake, Terrain } from '../model';
import { clamp } from '../math';
import { salinityClass, salinityFreshwaterSuitability } from './salinity';

/** A single wet fraction for land suitability and the surface material. */
export function lakeCoverageAt(drainage: Drainage, cell: number, season = -1): number {
  return clamp(
    season >= 0 && drainage.seasonalLakeCoverage
      ? drainage.seasonalLakeCoverage[season][cell]
      : drainage.lakeCoverage[cell],
  );
}

export function exposedLandFraction(terrain: Terrain, drainage: Drainage, cell: number): number {
  return terrain.ocean[cell] ? 0 : 1 - lakeCoverageAt(drainage, cell);
}

/** Dominant reservoir incident to a cell, including partially exposed shores. */
export function lakeAtCell(grid: Grid, drainage: Drainage, cell: number): Lake | undefined {
  let lake: Lake | undefined;
  let largestWetShare = 0;
  for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
    const corner = grid.cellCorners[offset];
    const share = drainage.lakeFraction[corner];
    const candidate = drainage.lakes[drainage.lakeId[corner]];
    if (
      candidate &&
      (share > largestWetShare ||
        (share > 0 && share === largestWetShare && candidate.area > (lake?.area ?? 0)))
    ) {
      lake = candidate;
      largestWetShare = share;
    }
  }
  return lake;
}

/** Modeled dissolved salts determine freshwater utility. Older worlds retain the
 * throughflow proxy; a closed basin alone does not establish its salt content.
 */
export function lakeFreshwaterSuitability(lake: Lake): number {
  if (lake.area <= 0) {
    return 0;
  }
  if (lake.salinity) {
    return salinityFreshwaterSuitability(lake.salinity.concentration);
  }
  const flushing = lake.outflow / Math.max(1e-20, lake.outflow + lake.evaporation);
  return 0.2 + 0.8 * Math.sqrt(clamp(flushing));
}

export function lakeWaterDescription(lake: Lake): string {
  if (lake.area <= 0) {
    return lake.salinity && lake.salinity.bedSalt > 0 ? 'Dry basin · salt deposits' : 'Dry basin';
  }
  if (lake.salinity) {
    const kind = salinityClass(lake.salinity.concentration);
    return `${kind[0].toUpperCase()}${kind.slice(1)} · modeled dissolved salts`;
  }
  if (lake.outflow <= 0) {
    return 'Freshwater uncertain · closed basin';
  }
  return lakeFreshwaterSuitability(lake) < 0.5
    ? 'Concentration risk · weak throughflow'
    : 'Freshwater potential · throughflow';
}

/** Broad ordinary-plant potential, not a crop-specific salinity threshold. Salt
 * tolerant habitat is outside this estimate. Concentration is kg/m³ (= g/L).
 */
export function soilSalinitySuitability(concentration: number): number {
  return Math.exp(-Math.max(0, concentration - 2) / 6);
}

/** A salt-affected shore cannot penalize every hectare of a coarse surface cell.
 * Fraction is a share of the entire cell; the result is a mean over exposed land.
 */
export function soilSalinityLimit(
  concentration: number,
  fraction: number,
  landFraction: number,
): number {
  return landFraction > 0
    ? 1 - clamp(fraction / landFraction) * (1 - soilSalinitySuitability(concentration))
    : 1;
}
