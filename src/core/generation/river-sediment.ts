import type { Drainage, Grid, Terrain, WorldConfig } from '../model';
import { angle, readVector } from '../math';

/** Settling is integrated over physical reach length, so inserting sites does not
 * repeatedly charge a fixed percentage of the same downstream sediment load. */
export function riverSettlingFraction(length: number, slope: number): number {
  const settlingLength = 120000 * (1 + (Math.max(0, slope) / 0.001) ** 2);
  return -Math.expm1(-Math.max(0, length) / settlingLength);
}

/** Add actual material and return its stored volume, including Float32 rounding. */
export function depositRiverSediment(
  grid: Grid,
  terrain: Terrain,
  cell: number,
  volume: number,
  radius: number,
  delta = false,
): number {
  if (!(volume > 0)) {
    return 0;
  }
  const area = grid.areas[cell] * radius ** 2;
  const previous = terrain.sediment[cell];
  terrain.sediment[cell] += volume / area;
  const depth = terrain.sediment[cell] - previous;
  terrain.height[cell] = terrain.bedrock[cell] + terrain.sediment[cell];
  if (delta) {
    terrain.deltaSediment[cell] += depth;
  }
  return depth * area;
}

/** A connected physical mouth fan, with finite accommodation. Saturated cells
 * surrender their unused share to the remaining fan; only the unretained load
 * or material beyond the resolved receiving footprint is counted as export.
 * The caller supplies ONE delivery, already partitioned by upstream routing.
 */
export function depositRiverMouth(
  grid: Grid,
  terrain: Terrain,
  drainage: Drainage,
  corner: number,
  volume: number,
  lake: number,
  config: WorldConfig,
): number {
  if (!(volume > 0)) {
    return 0;
  }
  const level = lake < 0 ? 0 : drainage.lakes[lake].level;
  const center = readVector(grid.corners, corner);
  const reach = Math.min(160000, 40000 + 40000 * Math.sqrt(drainage.discharge[corner] / 1000));
  const seen = new Set<number>();
  const queue: number[] = [];
  const candidates: { cell: number; weight: number; capacity: number }[] = [];
  const sameWater = (cell: number) => {
    if (lake < 0) {
      return terrain.ocean[cell] && drainage.lakeCoverage[cell] <= 0;
    }
    if (terrain.ocean[cell]) {
      return false;
    }
    for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
      if (drainage.lakeId[grid.cellCorners[offset]] === lake) {
        return true;
      }
    }
    return false;
  };
  const accessible = (cell: number) => {
    if (sameWater(cell)) {
      return true;
    }
    if (terrain.height[cell] > level + 3 || drainage.lakeCoverage[cell] > 0) {
      return false;
    }
    for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
      if (sameWater(grid.neighbors[offset])) {
        return true;
      }
    }
    return false;
  };
  for (let incident = 0; incident < 3; incident++) {
    const cell = grid.triangles[corner * 3 + incident];
    seen.add(cell);
    if (accessible(cell)) {
      queue.push(cell);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head];
    const distance = angle(center, readVector(grid.positions, cell)) * config.radius;
    const depth = level - terrain.height[cell];
    if (depth >= -3 && depth <= 350) {
      const area = grid.areas[cell] * config.radius ** 2;
      candidates.push({
        cell,
        weight: (area * Math.exp(-distance / (reach * 0.4))) / (20 + Math.max(0, depth)),
        capacity: Math.max(0, (level + 3 - terrain.height[cell]) * area),
      });
    }
    for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
      const next = grid.neighbors[offset];
      if (seen.has(next)) {
        continue;
      }
      seen.add(next);
      if (
        angle(center, readVector(grid.positions, next)) * config.radius <= reach &&
        accessible(next)
      ) {
        queue.push(next);
      }
    }
  }
  // Weighted water filling: sorting capacities avoids a quadratic series of
  // retries when many tiny adaptive cells fill before their larger neighbors.
  candidates.sort(
    (first, second) => first.capacity / first.weight - second.capacity / second.weight,
  );
  let weight = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  let remaining = volume * (lake < 0 ? 0.7 / (1 + config.waveErosion * 0.5) : 0.85);
  let deposited = 0;
  for (const candidate of candidates) {
    const allocation = Math.min(
      candidate.capacity,
      (remaining * candidate.weight) / Math.max(1e-30, weight),
    );
    const actual = depositRiverSediment(
      grid,
      terrain,
      candidate.cell,
      allocation,
      config.radius,
      true,
    );
    deposited += actual;
    remaining = Math.max(0, remaining - actual);
    weight = Math.max(0, weight - candidate.weight);
  }
  return Math.max(0, volume - deposited);
}
