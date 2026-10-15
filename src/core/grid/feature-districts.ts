import type { Drainage, Grid, Terrain, WorldConfig } from '../model';
import { clamp } from '../math';

export interface LakeDistrictContext {
  grid: Grid;
  terrain: Terrain;
  drainage: Drainage;
  config: WorldConfig;
}

export interface LakeDistrictAnalysis {
  /** Positive throughout lake-rich districts, including the dry gaps between lakes. */
  strength: Float32Array;
  /** Area-weighted local shoreline evidence, independent of biome colouring. */
  density: Float32Array;
  candidates: { cell: number; score: number; radiusMetres: number }[];
}

interface DistrictBin {
  x: number;
  y: number;
  z: number;
  area: number;
  evidence: number;
  representative: number;
  nearest: number;
  density: number;
  strength: number;
}

/** Detect physical shoreline evidence separately in each season. A seasonally
 * wet/dry lake interior is not an unresolved shore merely because its annual
 * average is partial. This also excludes empty sinks and biome/wetland tints.
 */
export function lakeShoreEvidence({ grid, terrain, drainage }: LakeDistrictContext) {
  const evidence = new Float32Array(grid.count);
  const seasons = drainage.seasonalLakeCoverage ?? [drainage.lakeCoverage];
  for (let cell = 0; cell < grid.count; cell++) {
    if (terrain.ocean[cell]) {
      continue;
    }
    for (const coverage of seasons) {
      const wet = clamp(coverage[cell]);
      if (wet <= 1e-4) {
        continue;
      }
      evidence[cell] = Math.max(evidence[cell], 4 * wet * (1 - wet));
      for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
        const neighbor = grid.neighbors[offset];
        if (!terrain.ocean[neighbor] && coverage[neighbor] <= 1e-4) {
          evidence[cell] = Math.max(evidence[cell], 0.7);
          break;
        }
      }
    }
  }
  return evidence;
}

/** Area-weighted geographic aggregation uses 3D bins rather than latitude bands,
 * so districts cross the date line and poles normally. Bin width scales with
 * the requested radius; each occupied bin examines at most 125 neighbours.
 * The cost is O(cells + occupied bins), independent of how many fine cells lie
 * in a district. Several occupied shoreline bins are required: an isolated
 * tiny lake remains the fine lake detector's responsibility.
 */
export function analyzeLakeDistricts(context: LakeDistrictContext): LakeDistrictAnalysis {
  const { grid, terrain, config } = context;
  const strength = new Float32Array(grid.count);
  const density = new Float32Array(grid.count);
  const candidates: LakeDistrictAnalysis['candidates'] = [];
  if (!(config.featureDistrictStrength > 0)) {
    return { strength, density, candidates };
  }
  const radius = config.featureDistrictRadius;
  const threshold = config.featureDistrictThreshold / 100;
  if (!(radius > 0) || !Number.isFinite(radius) || !(threshold > 0 && threshold <= 1)) {
    throw Error('Lake district detection needs a positive radius and density threshold.');
  }
  const evidence = lakeShoreEvidence(context);
  const width = radius / (config.radius * Math.sqrt(3));
  const chord = 2 * Math.sin(Math.min(Math.PI, radius / config.radius) / 2);
  const cosine = Math.cos(Math.min(Math.PI, radius / config.radius));
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const coordinate = (value: number) => Math.floor((value + 1) / width);
  const bins = new Map<string, DistrictBin>();
  const cellBins: (DistrictBin | undefined)[] = new Array(grid.count);
  for (let cell = 0; cell < grid.count; cell++) {
    if (terrain.ocean[cell]) {
      continue;
    }
    const x = grid.positions[cell * 3];
    const y = grid.positions[cell * 3 + 1];
    const z = grid.positions[cell * 3 + 2];
    const binKey = key(coordinate(x), coordinate(y), coordinate(z));
    let bin = bins.get(binKey);
    if (!bin) {
      bin = {
        x: 0,
        y: 0,
        z: 0,
        area: 0,
        evidence: 0,
        representative: cell,
        nearest: Infinity,
        density: 0,
        strength: 0,
      };
      bins.set(binKey, bin);
    }
    const area = grid.areas[cell];
    bin.x += x * area;
    bin.y += y * area;
    bin.z += z * area;
    bin.area += area;
    bin.evidence += area * evidence[cell];
    cellBins[cell] = bin;
  }
  for (const bin of bins.values()) {
    const length = Math.hypot(bin.x, bin.y, bin.z);
    bin.x /= length;
    bin.y /= length;
    bin.z /= length;
  }
  // Stable geographic representatives allow dry cells within a district to
  // receive the same continuous target as the lakes around them.
  for (let cell = 0; cell < grid.count; cell++) {
    const bin = cellBins[cell];
    if (!bin) {
      continue;
    }
    const distance =
      (grid.positions[cell * 3] - bin.x) ** 2 +
      (grid.positions[cell * 3 + 1] - bin.y) ** 2 +
      (grid.positions[cell * 3 + 2] - bin.z) ** 2;
    if (distance < bin.nearest) {
      bin.nearest = distance;
      bin.representative = cell;
    }
  }
  for (const bin of bins.values()) {
    let area = 0;
    let water = 0;
    let occupied = 0;
    const maxX = coordinate(bin.x + chord);
    const maxY = coordinate(bin.y + chord);
    const maxZ = coordinate(bin.z + chord);
    for (let x = coordinate(bin.x - chord); x <= maxX; x++) {
      for (let y = coordinate(bin.y - chord); y <= maxY; y++) {
        for (let z = coordinate(bin.z - chord); z <= maxZ; z++) {
          const neighbor = bins.get(key(x, y, z));
          if (!neighbor || bin.x * neighbor.x + bin.y * neighbor.y + bin.z * neighbor.z < cosine) {
            continue;
          }
          area += neighbor.area;
          water += neighbor.evidence;
          if (neighbor.evidence > neighbor.area * 0.005) {
            occupied++;
          }
        }
      }
    }
    bin.density = area > 0 ? water / area : 0;
    if (occupied < 3 || bin.density < threshold) {
      continue;
    }
    bin.strength = clamp(bin.density / Math.max(threshold, 0.2));
    candidates.push({
      cell: bin.representative,
      score: 0.7 + 0.3 * bin.strength,
      radiusMetres: radius,
    });
  }
  for (let cell = 0; cell < grid.count; cell++) {
    const bin = cellBins[cell];
    if (bin) {
      strength[cell] = bin.strength;
      density[cell] = bin.density;
    }
  }
  return { strength, density, candidates };
}
