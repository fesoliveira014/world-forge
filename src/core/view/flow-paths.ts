import type { Vec3 } from '../math';
import type { PageValues, PagedSpatialIndex } from './spatial-index';
import type { OverlayLines, ViewBounds } from './types';

export const FLOW_PATH_LIMIT = 256;
export const FLOW_PATH_STEP_LIMIT = 48;
export const FLOW_SAMPLE_CACHE_LIMIT = 4096;
export const FLOW_OCEAN_PROBE_LIMIT = 512;
const TAU = Math.PI * 2;
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const normalize = (v: Vec3): Vec3 => {
  const length = Math.hypot(...v);
  return v.map((x) => x / length) as Vec3;
};
const sphere = (lon: number, lat: number): Vec3 => [
  Math.cos(lat) * Math.cos(lon),
  Math.sin(lat),
  Math.cos(lat) * Math.sin(lon),
];
const wrap = (x: number) => ((((x + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
const hash = (a: number, b: number) => {
  let x = Math.imul(a + 1, 73856093) ^ Math.imul(b + 1, 19349663);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return (x ^ (x >>> 16)) >>> 0;
};

/** A world-anchored lattice changes only when the density scale changes. Small
 * pans add/remove border seeds instead of relocating every existing streamline. */
export function flowPathSeeds(bounds: ViewBounds, limit: number) {
  if (!limit) {
    return { points: [] as Vec3[], spacing: 0 };
  }
  const width =
    bounds.east >= bounds.west ? bounds.east - bounds.west : bounds.east + TAU - bounds.west;
  const height = bounds.north - bounds.south;
  const area = Math.max(1e-14, width * (Math.sin(bounds.north) - Math.sin(bounds.south)));
  const spacing =
    Math.PI / 2 ** clamp(Math.ceil(Math.log2(Math.PI / Math.sqrt(area / limit))), 1, 22);
  const firstRow = Math.max(0, Math.floor((bounds.south + Math.PI / 2) / spacing));
  const lastRow = Math.min(
    Math.round(Math.PI / spacing) - 1,
    Math.floor((bounds.north + Math.PI / 2) / spacing),
  );
  const candidates: { point: Vec3; rank: number }[] = [];
  // The latitude/longitude lattice has O(limit) candidates for ordinary views.
  // A very narrow sliver can span many lattice rows: bound that work too.
  const rowStride = Math.max(1, Math.ceil((lastRow - firstRow + 1) / (limit * 4)));
  for (let row = firstRow; row <= lastRow; row += rowStride) {
    const lat = -Math.PI / 2 + (row + 0.5) * spacing;
    if (lat < bounds.south || lat > bounds.north) {
      continue;
    }
    const columns = Math.max(1, Math.round((TAU * Math.cos(lat)) / spacing));
    const first = Math.floor(((bounds.west + Math.PI) / TAU) * columns);
    const end = Math.ceil(((bounds.west + Math.PI + width) / TAU) * columns);
    const stride = Math.max(1, Math.ceil((end - first) / (limit * 4)));
    for (let column = first; column < end; column += stride) {
      const canonical = ((column % columns) + columns) % columns;
      const lon = -Math.PI + ((canonical + 0.5) / columns) * TAU;
      const delta = (((lon - bounds.west) % TAU) + TAU) % TAU;
      if (delta > width + 1e-12) {
        continue;
      }
      candidates.push({ point: sphere(wrap(lon), lat), rank: hash(row, canonical) });
    }
  }
  candidates.sort((a, b) => a.rank - b.rank);
  // Tiny views may not contain a lattice center. Their center remains a useful
  // fallback; the ordinary lattice still governs all wider views.
  const points = candidates.slice(0, limit).map((item) => item.point);
  if (!points.length && height > 0 && width > 0) {
    points.push(sphere(wrap(bounds.west + width / 2), (bounds.south + bounds.north) / 2));
  }
  return { points, spacing };
}

interface SurfaceSample {
  process: number;
  height: number;
  ocean: boolean;
  spacing: number;
}
interface ProcessSample {
  positions: Float64Array;
  velocity: Float64Array;
}
interface FieldSample extends SurfaceSample {
  velocity: Vec3;
  speed: number;
}

/** Bounded, lazy samples of the saved field. The surface index supplies a nearby
 * climate cell; its saved process one-ring smooths the vector before each step.
 * Paths are followed locally so the spatial reader's leaf cache stays useful. */
class FlowField {
  private surfaces = new Map<number, SurfaceSample>();
  private processes = new Map<number, ProcessSample>();
  readonly stats = {
    samples: 0,
    surfaceReads: 0,
    processReads: 0,
    peakSurfaceCache: 0,
    peakProcessCache: 0,
    oceanProbes: 0,
  };
  constructor(
    private pages: PageValues,
    private index: Pick<PagedSpatialIndex, 'nearest'>,
    private kind: 'wind' | 'current',
    private season: number,
  ) {}
  private remember<T>(cache: Map<number, T>, key: number, value: T) {
    cache.set(key, value);
    if (cache.size > FLOW_SAMPLE_CACHE_LIMIT) {
      cache.delete(cache.keys().next().value!);
    }
    return value;
  }
  private async surface(point: Vec3): Promise<SurfaceSample> {
    const cell = await this.index.nearest(point);
    const cached = this.surfaces.get(cell);
    if (cached) {
      return cached;
    }
    const [process, height, areas, ocean] = await Promise.all([
      this.pages.readValues('world.transfer', [cell]),
      this.pages.readValues('world.terrain.height', [cell]),
      this.pages.readValues('world.grid.areas', [cell]),
      this.kind === 'current'
        ? this.pages.readValues('world.terrain.ocean', [cell])
        : Promise.resolve(new Float64Array([1])),
    ]);
    this.stats.surfaceReads++;
    const result = this.remember(this.surfaces, cell, {
      process: process[0],
      height: height[0],
      ocean: !!ocean[0],
      spacing: Math.sqrt(Math.max(1e-14, areas[0])),
    });
    this.stats.peakSurfaceCache = Math.max(this.stats.peakSurfaceCache, this.surfaces.size);
    return result;
  }
  private async process(cell: number): Promise<ProcessSample> {
    const cached = this.processes.get(cell);
    if (cached) {
      return cached;
    }
    const offsets = await this.pages.readValues('world.process.offsets', [cell, cell + 1]);
    const neighbors = await this.pages.readRange(
      'world.process.neighbors',
      offsets[0],
      offsets[1] - offsets[0],
    );
    const ids = [cell, ...neighbors];
    const indices = ids.flatMap((id) => [id * 3, id * 3 + 1, id * 3 + 2]);
    const seasons = this.season < 0 ? [0, 1, 2, 3] : [this.season];
    const [positions, ...fields] = await Promise.all([
      this.pages.readValues('world.process.positions', indices),
      ...seasons.map((season) =>
        this.pages.readValues(`world.climate.${this.kind}.${season}`, indices),
      ),
    ]);
    const velocity = new Float64Array(indices.length);
    for (const field of fields) {
      for (let i = 0; i < field.length; i++) {
        velocity[i] += field[i] / fields.length;
      }
    }
    this.stats.processReads++;
    const result = this.remember(this.processes, cell, { positions, velocity });
    this.stats.peakProcessCache = Math.max(this.stats.peakProcessCache, this.processes.size);
    return result;
  }
  async sample(point: Vec3, field = true): Promise<FieldSample> {
    this.stats.samples++;
    const surface = await this.surface(point);
    const velocity: Vec3 = [0, 0, 0];
    if (!field || (this.kind === 'current' && !surface.ocean)) {
      return { ...surface, velocity, speed: 0 };
    }
    const process = await this.process(surface.process);
    let weight = 0;
    for (let offset = 0; offset < process.positions.length; offset += 3) {
      let distance = 0;
      for (let axis = 0; axis < 3; axis++) {
        distance += (point[axis] - process.positions[offset + axis]) ** 2;
      }
      const w = 1 / Math.max(1e-10, distance);
      weight += w;
      for (let axis = 0; axis < 3; axis++) {
        velocity[axis] += process.velocity[offset + axis] * w;
      }
    }
    for (let axis = 0; axis < 3; axis++) {
      velocity[axis] /= weight;
    }
    const radial = point.reduce((sum, x, axis) => sum + x * velocity[axis], 0);
    for (let axis = 0; axis < 3; axis++) {
      velocity[axis] -= point[axis] * radial;
    }
    return { ...surface, velocity, speed: Math.hypot(...velocity) };
  }
}

/** Read continuous forward streamlines, with no full climate/world restoration
 * and no per-frame storage reads. Segments and sample caches have fixed bounds. */
export async function readFlowPaths(
  pages: PageValues,
  index: Pick<PagedSpatialIndex, 'nearest'>,
  request: {
    bounds: ViewBounds;
    kind: 'wind' | 'current';
    season: number;
    maxPaths: number;
    maxSegments: number;
  },
) {
  const budget = clamp(Math.floor(request.maxSegments), 0, 8192);
  const pathLimit = Math.min(FLOW_PATH_LIMIT, Math.max(0, Math.floor(request.maxPaths)), budget);
  const { points: seeds, spacing } = flowPathSeeds(request.bounds, pathLimit);
  const field = new FlowField(pages, index, request.kind, request.season);
  const positions: number[] = [];
  const heights: number[] = [];
  const widths: number[] = [];
  const discharge: number[] = [];
  const offsets = [0];
  const speeds: number[] = [];
  const calm = request.kind === 'wind' ? 0.08 : 0.0006;
  const nominal = request.kind === 'wind' ? 15 : 0.5;
  const steps = Math.min(FLOW_PATH_STEP_LIMIT, Math.floor(budget / Math.max(1, seeds.length)));
  const targetLength = Math.min(0.6, spacing * 5);
  for (const seed of seeds) {
    let point = seed;
    let sample = await field.sample(point);
    let speedSum = 0;
    let accepted = 0;
    let oceanProbes = 0;
    for (let step = 0; step < steps && widths.length < budget; step++) {
      if (!Number.isFinite(sample.speed) || sample.speed < calm) {
        break;
      }
      // Draw length is independent of physical mesh density. Probe the water
      // mask more often on a fine mesh instead of shrinking every current into
      // a tiny dash as terrain resolution increases.
      const angle = Math.min(
        targetLength / Math.max(1, steps),
        0.02,
        request.kind === 'current' ? 32 * 0.45 * sample.spacing : Infinity,
      );
      const mid = normalize(
        point.map((x, axis) => x + ((sample.velocity[axis] / sample.speed) * angle) / 2) as Vec3,
      );
      const midpoint = await field.sample(mid);
      if (
        !Number.isFinite(midpoint.speed) ||
        midpoint.speed < calm ||
        (request.kind === 'current' && !midpoint.ocean)
      ) {
        break;
      }
      const end = normalize(
        point.map((x, axis) => x + (midpoint.velocity[axis] / midpoint.speed) * angle) as Vec3,
      );
      const next = await field.sample(end);
      if (
        !Number.isFinite(next.speed) ||
        next.speed < calm ||
        (request.kind === 'current' && !next.ocean)
      ) {
        break;
      }
      if (request.kind === 'current') {
        const spacing = Math.min(sample.spacing, midpoint.spacing, next.spacing);
        const probes = Math.max(2, Math.ceil(angle / (spacing * 0.6)));
        // Pathological tiny cells cannot cause unbounded reads. End the path
        // before an unchecked reach rather than jumping across possible land.
        if (probes > 32 || oceanProbes + probes - 1 > FLOW_OCEAN_PROBE_LIMIT) {
          break;
        }
        let blocked = false;
        for (let probe = 1; probe < probes; probe++) {
          const position = normalize(
            point.map((x, axis) => x + ((end[axis] - x) * probe) / probes) as Vec3,
          );
          const check = await field.sample(position, false);
          oceanProbes++;
          field.stats.oceanProbes++;
          if (!check.ocean) {
            blocked = true;
            break;
          }
        }
        if (blocked) {
          break;
        }
      }
      // A field discontinuity can reverse the midpoint tangent. Stop instead of
      // drawing a backwards kink or cycling over a zero-speed separatrix.
      if (sample.velocity.reduce((sum, x, axis) => sum + x * midpoint.velocity[axis], 0) <= 0) {
        break;
      }
      positions.push(...point, ...end);
      heights.push(Math.max(0, sample.height), Math.max(0, next.height));
      widths.push(1);
      discharge.push(0);
      speedSum += midpoint.speed;
      accepted++;
      point = end;
      sample = next;
    }
    if (accepted) {
      offsets.push(widths.length);
      speeds.push(clamp(speedSum / accepted / nominal, 0, 1));
    }
  }
  const lines: OverlayLines = {
    positions: Float32Array.from(positions),
    heights: Float32Array.from(heights),
    widths: Float32Array.from(widths),
    discharge: Float32Array.from(discharge),
    pathOffsets: Uint32Array.from(offsets),
    pathSpeeds: Float32Array.from(speeds),
  };
  return { lines, stats: field.stats };
}
