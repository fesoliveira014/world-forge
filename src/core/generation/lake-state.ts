import type { Drainage, Grid, Lake, Terrain } from '../model';
import { clamp } from '../math';

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

/** Flushing is a suitability proxy, not a salinity or drinking-water prediction.
 * A closed basin remains uncertain; incoming river water keeps its own suitability.
 */
export function lakeFreshwaterSuitability(lake: Lake): number {
  if (lake.area <= 0) {
    return 0;
  }
  const flushing = lake.outflow / Math.max(1e-20, lake.outflow + lake.evaporation);
  return 0.2 + 0.8 * Math.sqrt(clamp(flushing));
}

export function lakeWaterDescription(lake: Lake): string {
  if (lake.area <= 0) {
    return 'Dry basin';
  }
  if (lake.outflow <= 0) {
    return 'Freshwater uncertain · closed basin';
  }
  return lakeFreshwaterSuitability(lake) < 0.5
    ? 'Concentration risk · weak throughflow'
    : 'Freshwater potential · throughflow';
}
