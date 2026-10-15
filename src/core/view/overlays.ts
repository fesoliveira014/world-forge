import type { Deposit, Delta, Lake, Oxbow, Plate } from '../model';
import type { Vec3 } from '../math';
import { MissingSnapshotFieldError } from '../storage';
import type { PageValues, PagedSpatialIndex } from './spatial-index';
import { readCoastOverlays } from './coast-overlays';
import { readFlowPaths } from './flow-paths';
import type {
  OverlayLines,
  OverlayPacket,
  OverlayRequest,
  GlobeGridFootprint,
  ViewBounds,
  WorldSummary,
} from './types';

const TAU = Math.PI * 2;
const COLUMNS = 32;
const ROWS = 16;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const sphere = (longitude: number, latitude: number): Vec3 => [
  Math.cos(latitude) * Math.cos(longitude),
  Math.sin(latitude),
  Math.cos(latitude) * Math.sin(longitude),
];
const normalize = (point: Vec3): Vec3 => {
  const length = Math.hypot(...point);
  return point.map((value) => value / length) as Vec3;
};
const longitudeIntervals = (bounds: ViewBounds): [number, number][] =>
  bounds.west <= bounds.east
    ? [[bounds.west, bounds.east]]
    : [
        [bounds.west, Math.PI],
        [-Math.PI, bounds.east],
      ];

/** Clip short resolved segments in longitude/latitude, including wrapped viewports. */
export function clipOverlaySegment(
  first: Vec3,
  second: Vec3,
  bounds: ViewBounds,
): { first: Vec3; second: Vec3; start: number; end: number }[] {
  const a = normalize(first);
  const b = normalize(second);
  const x = Math.atan2(a[2], a[0]);
  const y = Math.asin(clamp(a[1], -1, 1));
  let dx = Math.atan2(b[2], b[0]) - x;
  if (dx > Math.PI) {
    dx -= TAU;
  }
  if (dx < -Math.PI) {
    dx += TAU;
  }
  const dy = Math.asin(clamp(b[1], -1, 1)) - y;
  const result: ReturnType<typeof clipOverlaySegment> = [];
  for (const [west, east] of longitudeIntervals(bounds)) {
    for (const shift of [-TAU, 0, TAU]) {
      let start = 0;
      let end = 1;
      const origin = x + shift;
      const constraints = [
        [-dx, origin - west],
        [dx, east - origin],
        [-dy, y - bounds.south],
        [dy, bounds.north - y],
      ];
      let visible = true;
      for (const [direction, distance] of constraints) {
        if (Math.abs(direction) < 1e-15) {
          if (distance < -1e-12) {
            visible = false;
          }
        } else if (direction < 0) {
          start = Math.max(start, distance / direction);
        } else {
          end = Math.min(end, distance / direction);
        }
      }
      if (!visible || end - start < 1e-12) {
        continue;
      }
      if (
        result.some(
          (part) => Math.abs(part.start - start) < 1e-12 && Math.abs(part.end - end) < 1e-12,
        )
      ) {
        continue;
      }
      result.push({
        first: start === 0 ? first : sphere(origin + dx * start, y + dy * start),
        second: end === 1 ? second : sphere(origin + dx * end, y + dy * end),
        start,
        end,
      });
    }
  }
  return result;
}

/** Clip the actual spherical directions along a Cartesian edge chord. Longitude
 * and latitude are not linear along it, particularly when it passes a pole.
 * Solve cap intersections in the edge's great-circle plane; a segment with both
 * endpoints outside may still cross the footprint. The returned fractions refer
 * to the original chord, so routing heights retain their existing interpolation.
 */
export function clipGlobeGridSegment(
  first: Vec3,
  second: Vec3,
  footprint: GlobeGridFootprint,
): ReturnType<typeof clipOverlaySegment> {
  if (footprint.radius === 0) {
    return [];
  }
  const a = normalize(first);
  const b = normalize(second);
  const center = normalize(footprint.center);
  const dot = (left: Vec3, right: Vec3) =>
    left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
  const cosine = clamp(dot(a, b), -1, 1);
  const tangent = b.map((value, axis) => value - a[axis] * cosine) as Vec3;
  const sine = Math.hypot(...tangent);
  const angle = Math.atan2(sine, cosine);
  const threshold = Math.cos(footprint.radius);
  if (sine < 1e-15) {
    return dot(a, center) >= threshold ? [{ first, second, start: 0, end: 1 }] : [];
  }
  for (let axis = 0; axis < 3; axis++) {
    tangent[axis] /= sine;
  }
  const u = dot(center, a);
  const v = dot(center, tangent);
  const amplitude = Math.hypot(u, v);
  if (threshold > amplitude) {
    return [];
  }
  if (threshold <= -amplitude) {
    return [{ first, second, start: 0, end: 1 }];
  }
  const phase = Math.atan2(v, u);
  const crossing = Math.acos(clamp(threshold / amplitude, -1, 1));
  const cuts = [0, angle];
  for (const root of [phase - crossing, phase + crossing]) {
    for (const shift of [-TAU, 0, TAU]) {
      const value = root + shift;
      if (value > 0 && value < angle) {
        cuts.push(value);
      }
    }
  }
  cuts.sort((left, right) => left - right);
  const fraction = (value: number) =>
    value === 0
      ? 0
      : value === angle
        ? 1
        : Math.sin(value) / (Math.sin(value) + Math.sin(angle - value));
  const point = (value: number): Vec3 =>
    value === 0
      ? first
      : value === 1
        ? second
        : normalize(a.map((component, axis) => component + (b[axis] - component) * value) as Vec3);
  const result: ReturnType<typeof clipOverlaySegment> = [];
  for (let cut = 1; cut < cuts.length; cut++) {
    const midpoint = (cuts[cut - 1] + cuts[cut]) / 2;
    if (
      cuts[cut] - cuts[cut - 1] <= 1e-14 ||
      u * Math.cos(midpoint) + v * Math.sin(midpoint) < threshold
    ) {
      continue;
    }
    const start = fraction(cuts[cut - 1]);
    const end = fraction(cuts[cut]);
    result.push({ first: point(start), second: point(end), start, end });
  }
  return result;
}

class Lines {
  positions: number[] = [];
  heights: number[] = [];
  widths: number[] = [];
  discharge: number[] = [];
  truncated = false;
  constructor(
    private bounds: ViewBounds,
    readonly limit: number,
  ) {}
  get count() {
    return this.widths.length;
  }
  visible(
    first: Vec3,
    second: Vec3,
    firstHeight: number,
    secondHeight: number,
    width: number,
    flow: number,
  ) {
    if (this.count >= this.limit) {
      this.truncated = true;
      return;
    }
    this.positions.push(...first, ...second);
    this.heights.push(firstHeight, secondHeight);
    this.widths.push(width);
    this.discharge.push(flow);
  }
  add(first: Vec3, second: Vec3, firstHeight = 0, secondHeight = firstHeight, width = 1, flow = 0) {
    for (const clipped of clipOverlaySegment(first, second, this.bounds)) {
      if (this.count >= this.limit) {
        this.truncated = true;
        return;
      }
      this.positions.push(...clipped.first, ...clipped.second);
      this.heights.push(
        firstHeight + (secondHeight - firstHeight) * clipped.start,
        firstHeight + (secondHeight - firstHeight) * clipped.end,
      );
      this.widths.push(width);
      this.discharge.push(flow);
    }
  }
  packet(): OverlayLines {
    return {
      positions: Float32Array.from(this.positions),
      heights: Float32Array.from(this.heights),
      widths: Float32Array.from(this.widths),
      discharge: Float32Array.from(this.discharge),
    };
  }
}

interface RankedRiver {
  kind: number;
  id: number;
  score: number;
}
interface RiverPath {
  points: Float64Array;
  heights: Float64Array;
  width: number;
  flow: number;
}

const RIVER_CANDIDATES = 32768;
const RIVER_POINTS = 257;
const LEGACY_RANK_CACHE = 65536;
const riverRankOffsets = new WeakMap<PageValues, Promise<Uint32Array | null>>();
const legacyRiverRanks = new WeakMap<PageValues, Map<string, RankedRiver[]>>();
const compareRivers = (first: RankedRiver, second: RankedRiver) =>
  second.score - first.score || first.kind - second.kind || first.id - second.id;

async function savedRiverOffsets(pages: PageValues) {
  let result = riverRankOffsets.get(pages);
  if (!result) {
    result = pages.readValue('sidecars.view.overlay.riverRank.offsets').then(
      (value) => {
        if (value === undefined) {
          return null;
        }
        if (!(value instanceof Uint32Array) || value.length !== COLUMNS * ROWS + 1) {
          throw new Error('Invalid saved river ranking.');
        }
        return value;
      },
      (error) => {
        if (error instanceof MissingSnapshotFieldError) {
          return null;
        }
        throw error;
      },
    );
    riverRankOffsets.set(pages, result);
  }
  return result;
}

/** Older saved worlds have no ranked sidecar. Stream only small reference/flow
 * pages, retaining the strongest bounded prefix; never restore the river graph.
 * The bounded cache also avoids rescanning old bins on ordinary camera motion. */
async function legacyRiverRank(
  pages: PageValues,
  bin: number,
  start: number,
  end: number,
  limit: number,
) {
  if (start >= end) {
    return [];
  }
  let cache = legacyRiverRanks.get(pages);
  if (!cache) {
    cache = new Map();
    legacyRiverRanks.set(pages, cache);
  }
  const key = `${bin}:${limit}`;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  let best: RankedRiver[] = [];
  for (let offset = start; offset < end; offset += 2048) {
    const refs = await pages.readRange(
      'sidecars.view.overlay.refs',
      offset,
      Math.min(2048, end - offset),
    );
    const candidates: RankedRiver[] = [];
    for (let pair = 0; pair < refs.length; pair += 2) {
      if ([0, 3, 4].includes(refs[pair])) {
        candidates.push({ kind: refs[pair], id: refs[pair + 1], score: 0 });
      }
    }
    if (!candidates.length) {
      continue;
    }
    const courses = candidates.filter((candidate) => candidate.kind === 0);
    const courseCorners = await pages.readValues(
      'world.rivers.courses.corner',
      courses.map((course) => course.id),
    );
    const corners: number[] = [];
    let course = 0;
    for (const candidate of candidates) {
      if (candidate.kind === 0) {
        corners.push(courseCorners[course++]);
      } else if (candidate.kind === 3) {
        corners.push(
          (await pages.readValue(`world.rivers.deltas.${candidate.id}.corner`)) as number,
        );
      } else {
        corners.push(-1);
        const width = (await pages.readValue(
          `world.terrain.oxbows.${candidate.id}.width`,
        )) as number;
        candidate.score = (width / 8) ** 2;
      }
    }
    const flowing = corners.filter((corner) => corner >= 0);
    const amounts = await Promise.all([
      pages.readValues('world.drainage.discharge', flowing),
      ...[0, 1, 2, 3].map((season) =>
        pages.readValues(`world.rivers.seasonalDischarge.${season}`, flowing),
      ),
    ]);
    let flow = 0;
    for (let candidate = 0; candidate < candidates.length; candidate++) {
      if (corners[candidate] >= 0) {
        candidates[candidate].score = Math.max(...amounts.map((values) => values[flow]));
        flow++;
      }
    }
    const unique = new Map<string, RankedRiver>();
    for (const candidate of [...best, ...candidates]) {
      unique.set(`${candidate.kind}:${candidate.id}`, candidate);
    }
    best = [...unique.values()].sort(compareRivers).slice(0, limit);
  }
  cache.set(key, best);
  let retained = [...cache.values()].reduce((sum, entries) => sum + entries.length, 0);
  while (retained > LEGACY_RANK_CACHE || cache.size > 512) {
    const first = cache.keys().next().value!;
    retained -= cache.get(first)!.length;
    cache.delete(first);
  }
  return best;
}

function clipRiverPath(
  points: ArrayLike<number>,
  firstHeight: number,
  lastHeight: number,
  width: number,
  flow: number,
  bounds: ViewBounds,
) {
  const result: { points: number[]; heights: number[]; width: number; flow: number }[] = [];
  const count = points.length / 3;
  let previous: (typeof result)[number] | undefined;
  for (let point = 1; point < count; point++) {
    const first = Array.from({ length: 3 }, (_, axis) => points[(point - 1) * 3 + axis]) as Vec3;
    const second = Array.from({ length: 3 }, (_, axis) => points[point * 3 + axis]) as Vec3;
    const parts = clipOverlaySegment(first, second, bounds);
    if (!parts.length) {
      previous = undefined;
    }
    for (const clipped of parts) {
      const startHeight =
        firstHeight + ((lastHeight - firstHeight) * (point - 1 + clipped.start)) / (count - 1);
      const endHeight =
        firstHeight + ((lastHeight - firstHeight) * (point - 1 + clipped.end)) / (count - 1);
      const tail = previous?.points.slice(-3);
      if (!tail || tail.some((value, axis) => Math.abs(value - clipped.first[axis]) > 1e-10)) {
        previous = { points: [...clipped.first], heights: [startHeight], width, flow };
        result.push(previous);
      }
      previous!.points.push(...clipped.second);
      previous!.heights.push(endHeight);
    }
  }
  return result.map((path) => ({
    ...path,
    points: Float64Array.from(path.points),
    heights: Float64Array.from(path.heights),
  }));
}

/** Keep both reach endpoints, adding the largest unresolved bend first. A coarse
 * packet reduces curve detail instead of cutting rivers off halfway downstream. */
function riverPathIndices(path: RiverPath, segments: number) {
  const count = path.heights.length;
  const selected = [0, count - 1];
  while (selected.length <= segments && selected.length < count) {
    let largest = -1;
    let split = -1;
    let at = -1;
    for (let edge = 1; edge < selected.length; edge++) {
      const first = selected[edge - 1];
      const last = selected[edge];
      const a = path.points.subarray(first * 3, first * 3 + 3);
      const b = path.points.subarray(last * 3, last * 3 + 3);
      const direction = b.map((value, axis) => value - a[axis]);
      const length = direction.reduce((sum, value) => sum + value * value, 0);
      for (let point = first + 1; point < last; point++) {
        const value = path.points.subarray(point * 3, point * 3 + 3);
        const fraction =
          length > 0
            ? clamp(
                value.reduce(
                  (sum, coordinate, axis) => sum + (coordinate - a[axis]) * direction[axis],
                  0,
                ) / length,
                0,
                1,
              )
            : 0;
        const error = value.reduce(
          (sum, coordinate, axis) => sum + (coordinate - a[axis] - fraction * direction[axis]) ** 2,
          0,
        );
        if (error > largest) {
          largest = error;
          split = point;
          at = edge;
        }
      }
    }
    if (split < 0) {
      break;
    }
    selected.splice(at, 0, split);
  }
  return selected;
}

/** Keep gathers spatially ordered and bounded. One scalar call per reach would
 * repeatedly resolve graph metadata and evict pages during regional round-robin. */
async function riverValues(pages: PageValues, path: string, indices: readonly number[]) {
  const unique = [...new Set(indices)].sort((first, second) => first - second);
  const values = new Map<number, number>();
  for (let start = 0; start < unique.length; start += 2048) {
    const chunk = unique.slice(start, start + 2048);
    const batch = await pages.readValues(path, chunk);
    for (let index = 0; index < chunk.length; index++) {
      values.set(chunk[index], batch[index]);
    }
  }
  return Float64Array.from(indices, (index) => values.get(index)!);
}

async function riverRange(pages: PageValues, path: string, start: number, count: number) {
  const result = new Float64Array(count);
  for (let offset = 0; offset < count; offset += 2048) {
    result.set(await pages.readRange(path, start + offset, Math.min(2048, count - offset)), offset);
  }
  return result;
}

async function addRiverOverlays(
  pages: PageValues,
  bins: number[],
  offsets: Float64Array,
  output: Lines,
  request: OverlayRequest,
) {
  if (output.limit <= 0) {
    return;
  }
  const savedOffsets = await savedRiverOffsets(pages);
  const populated = bins.filter((bin, slot) =>
    savedOffsets
      ? savedOffsets[bin + 1] > savedOffsets[bin]
      : offsets[slot * 2 + 1] > offsets[slot * 2],
  ).length;
  const quota = Math.max(1, Math.floor(RIVER_CANDIDATES / Math.max(1, populated)));
  const buckets: RankedRiver[][] = [];
  const seen = new Set<string>();
  for (let slot = 0; slot < bins.length; slot++) {
    const bin = bins[slot];
    let ranked: RankedRiver[];
    if (savedOffsets) {
      const start = savedOffsets[bin];
      const count = Math.min(quota, savedOffsets[bin + 1] - start);
      const refs = await riverRange(
        pages,
        'sidecars.view.overlay.riverRank.refs',
        start * 2,
        count * 2,
      );
      const scores = await riverRange(
        pages,
        'sidecars.view.overlay.riverRank.scores',
        start,
        count,
      );
      ranked = Array.from(scores, (score, index) => ({
        kind: refs[index * 2],
        id: refs[index * 2 + 1],
        score,
      }));
      output.truncated ||= count < savedOffsets[bin + 1] - start;
    } else {
      ranked = await legacyRiverRank(pages, bin, offsets[slot * 2], offsets[slot * 2 + 1], quota);
      output.truncated ||= ranked.length === quota;
    }
    buckets.push(
      ranked.filter((candidate) => {
        const key = `${candidate.kind}:${candidate.id}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      }),
    );
  }

  const scalar = async (path: string, id: number) =>
    (await pages.readValues(`world.${path}`, [id]))[0];
  const discharge = (corner: number) =>
    scalar(
      request.season < 0 ? 'drainage.discharge' : `rivers.seasonalDischarge.${request.season}`,
      corner,
    );
  const width = (amount: number) => clamp(8 * Math.sqrt(Math.max(0, amount)), 5, 3000);
  interface CourseMetadata {
    id: number;
    corner: number;
    amount: number;
    start: number;
    end: number;
    firstHeight: number;
    lastHeight: number;
  }
  const courseIds = buckets
    .flat()
    .filter((candidate) => candidate.kind === 0)
    .map((candidate) => candidate.id)
    .sort((a, b) => a - b);
  const courseCorners = await riverValues(pages, 'world.rivers.courses.corner', courseIds);
  const amounts = await riverValues(
    pages,
    request.season < 0
      ? 'world.drainage.discharge'
      : `world.rivers.seasonalDischarge.${request.season}`,
    Array.from(courseCorners),
  );
  const visibleCourses = courseIds
    .map((id, index) => ({ id, corner: courseCorners[index], amount: amounts[index] }))
    .filter((course) => course.amount > 0 && course.amount >= (request.riverThreshold ?? 0));
  const courseOffsets = await riverValues(
    pages,
    'world.rivers.courses.offsets',
    visibleCourses.flatMap((course) => [course.id, course.id + 1]),
  );
  const receivers = await riverValues(
    pages,
    'world.drainage.receiver',
    visibleCourses.map((course) => course.corner),
  );
  const courseHeights = await riverValues(
    pages,
    'world.drainage.height',
    visibleCourses.flatMap((course, index) => [
      course.corner,
      receivers[index] < 0 ? course.corner : receivers[index],
    ]),
  );
  const metadata = new Map<number, CourseMetadata>();
  visibleCourses.forEach((course, index) =>
    metadata.set(course.id, {
      ...course,
      start: courseOffsets[index * 2],
      end: courseOffsets[index * 2 + 1],
      firstHeight: courseHeights[index * 2],
      lastHeight: courseHeights[index * 2 + 1],
    }),
  );
  const pathCache = new Map<string, RiverPath[]>();
  const candidateKey = (candidate: RankedRiver) => `${candidate.kind}:${candidate.id}`;
  const cursors = new Uint32Array(buckets.length);

  const readSparsePaths = async (candidate: RankedRiver): Promise<RiverPath[]> => {
    if (candidate.kind === 3) {
      const delta = (await pages.readValue(`world.rivers.deltas.${candidate.id}`)) as Delta;
      const amount = await discharge(delta.corner);
      if (amount < (request.riverThreshold ?? 0) || amount <= 0) {
        return [];
      }
      const height = await scalar('drainage.height', delta.corner);
      const lake =
        delta.lake < 0
          ? null
          : ((await pages.readValue(`world.drainage.lakes.${delta.lake}`)) as Lake);
      const receivingLevel = lake
        ? request.season >= 0 && lake.seasonal
          ? lake.seasonal.level[request.season]
          : lake.level
        : 0;
      return delta.branches.flatMap((branch) =>
        clipRiverPath(
          branch.points,
          height,
          receivingLevel,
          width(amount * branch.fraction),
          amount * branch.fraction,
          request.bounds,
        ),
      );
    }
    const pond = (await pages.readValue(`world.terrain.oxbows.${candidate.id}`)) as Oxbow;
    const seasons = request.season < 0 ? [0, 1, 2, 3] : [request.season];
    const depths = await Promise.all(
      seasons.map((season) => scalar(`water.oxbowDepth.${season}`, candidate.id)),
    );
    const depth = depths.reduce((sum, value) => sum + value, 0) / depths.length;
    if (!(depth > 0)) {
      return [];
    }
    const height = (await scalar('terrain.height', pond.cell)) + depth;
    return clipRiverPath(pond.points, height, height, pond.width, 0, request.bounds);
  };

  const readPaths = async (candidate: RankedRiver): Promise<RiverPath[]> => {
    const key = candidateKey(candidate);
    if (!pathCache.has(key)) {
      // Prefetch only the current head of each geographic queue. This preserves
      // exact coverage/priority while coalescing nearby physical-array reads.
      const frontier = [
        candidate,
        ...buckets.flatMap((bucket, bin) => (bucket[cursors[bin]] ? [bucket[cursors[bin]]] : [])),
      ];
      const pending = new Map<string, RankedRiver>();
      for (const entry of frontier) {
        const entryKey = candidateKey(entry);
        if (!pathCache.has(entryKey)) {
          pending.set(entryKey, entry);
        }
        if (pending.size >= 128) {
          break;
        }
      }
      const courses = [...pending.values()].filter((entry) => entry.kind === 0);
      const pointIndices: number[] = [];
      const spans: {
        candidate: RankedRiver;
        metadata: CourseMetadata;
        start: number;
        count: number;
      }[] = [];
      for (const entry of courses) {
        const course = metadata.get(entry.id);
        if (!course || course.end - course.start < 2) {
          pathCache.set(candidateKey(entry), []);
          continue;
        }
        const count = Math.min(RIVER_POINTS, course.end - course.start);
        spans.push({ candidate: entry, metadata: course, start: pointIndices.length, count });
        for (let point = 0; point < count; point++) {
          const index =
            course.start + Math.round((point * (course.end - course.start - 1)) / (count - 1));
          pointIndices.push(index * 3, index * 3 + 1, index * 3 + 2);
        }
      }
      const points = await riverValues(pages, 'world.rivers.courses.points', pointIndices);
      for (const span of spans) {
        pathCache.set(
          candidateKey(span.candidate),
          clipRiverPath(
            points.subarray(span.start, span.start + span.count * 3),
            span.metadata.firstHeight,
            span.metadata.lastHeight,
            width(span.metadata.amount),
            span.metadata.amount,
            request.bounds,
          ),
        );
      }
      // Sparse branch/pond records have different shapes. They stay individually
      // bounded; ordinary course arrays account for the large-world hot path.
      for (const entry of pending.values()) {
        if (entry.kind !== 0) {
          pathCache.set(candidateKey(entry), await readSparsePaths(entry));
        }
      }
    }
    const paths = pathCache.get(key)!;
    pathCache.delete(key);
    return paths;
  };

  // At most one stored path per final segment. Ordinary reaches contain at most
  // 257 samples: the 8,192-segment packet cap bounds these typed coordinates and
  // heights to about 64 MiB, plus at most one prefetched head per 512 bins.
  const selected: { paths: RiverPath[]; minimum: number; desired: number; budget: number }[] = [];
  let remaining = output.limit;
  let pending = true;
  // One complete visible reach from every region before another from any region.
  // Flow ranking within a region gives major trunks precedence over minor reaches.
  while (pending && remaining > 0) {
    pending = false;
    for (let bin = 0; bin < buckets.length && remaining > 0; bin++) {
      while (cursors[bin] < buckets[bin].length) {
        const candidate = buckets[bin][cursors[bin]++];
        const paths = await readPaths(candidate);
        if (!paths.length) {
          continue;
        }
        pending = true;
        if (paths.length > remaining) {
          output.truncated = true;
          break;
        }
        const desired = paths.reduce((sum, path) => sum + path.heights.length - 1, 0);
        selected.push({ paths, minimum: paths.length, desired, budget: paths.length });
        remaining -= paths.length;
        break;
      }
    }
  }
  output.truncated ||= buckets.some((bucket, bin) => cursors[bin] < bucket.length);
  while (remaining > 0 && selected.some((entry) => entry.budget < entry.desired)) {
    for (const entry of selected) {
      if (remaining > 0 && entry.budget < entry.desired) {
        entry.budget++;
        remaining--;
      }
    }
  }
  for (const entry of selected) {
    const paths = entry.paths;
    const budgets = paths.map(() => 1);
    let remaining = entry.budget - paths.length;
    while (remaining > 0) {
      for (let path = 0; path < paths.length && remaining > 0; path++) {
        if (budgets[path] < paths[path].heights.length - 1) {
          budgets[path]++;
          remaining--;
        }
      }
    }
    for (let path = 0; path < paths.length; path++) {
      const line = paths[path];
      const indices = riverPathIndices(line, budgets[path]);
      output.truncated ||= indices.length < line.heights.length;
      for (let point = 1; point < indices.length; point++) {
        const first = indices[point - 1];
        const second = indices[point];
        output.visible(
          Array.from(line.points.subarray(first * 3, first * 3 + 3)) as Vec3,
          Array.from(line.points.subarray(second * 3, second * 3 + 3)) as Vec3,
          line.heights[first],
          line.heights[second],
          line.width,
          line.flow,
        );
      }
    }
  }
}

function contains(point: Vec3, bounds: ViewBounds) {
  const latitude = Math.asin(clamp(point[1] / Math.hypot(...point), -1, 1));
  const longitude = Math.atan2(point[2], point[0]);
  return (
    latitude >= bounds.south &&
    latitude <= bounds.north &&
    longitudeIntervals(bounds).some(([west, east]) => longitude >= west && longitude <= east)
  );
}

function viewBins(bounds: ViewBounds): number[] {
  const bins = new Set<number>();
  const south = clamp(Math.floor(((bounds.south + Math.PI / 2) / Math.PI) * ROWS), 0, ROWS - 1);
  const north = clamp(Math.floor(((bounds.north + Math.PI / 2) / Math.PI) * ROWS), 0, ROWS - 1);
  for (const [west, east] of longitudeIntervals(bounds)) {
    const first = clamp(Math.floor(((west + Math.PI) / TAU) * COLUMNS), 0, COLUMNS - 1);
    const last = clamp(Math.floor(((east + Math.PI) / TAU) * COLUMNS), 0, COLUMNS - 1);
    for (let row = south; row <= north; row++) {
      for (let column = first; column <= last; column++) {
        bins.add(row * COLUMNS + column);
      }
    }
  }
  return [...bins];
}

function viewPoints(bounds: ViewBounds, count: number): Vec3[] {
  const width =
    bounds.east >= bounds.west ? bounds.east - bounds.west : bounds.east + TAU - bounds.west;
  const height = bounds.north - bounds.south;
  const columns = Math.min(
    Math.max(1, count),
    Math.max(1, Math.ceil(Math.sqrt((count * width) / Math.max(1e-8, height)))),
  );
  const rows = Math.max(1, Math.ceil(count / columns));
  const points: Vec3[] = [];
  for (let row = 0; row < rows && points.length < count; row++) {
    for (let column = 0; column < columns && points.length < count; column++) {
      points.push(
        sphere(
          bounds.west + ((column + 0.5) / columns) * width,
          bounds.south + ((row + 0.5) / rows) * height,
        ),
      );
    }
  }
  return points;
}

function globeGridPoints(footprint: GlobeGridFootprint): Vec3[] {
  const center = normalize(footprint.center);
  const reference: Vec3 = Math.abs(center[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const east = normalize([
    reference[1] * center[2] - reference[2] * center[1],
    reference[2] * center[0] - reference[0] * center[2],
    reference[0] * center[1] - reference[1] * center[0],
  ]);
  const north: Vec3 = [
    center[1] * east[2] - center[2] * east[1],
    center[2] * east[0] - center[0] * east[2],
    center[0] * east[1] - center[1] * east[0],
  ];
  const radius = footprint.radius * 0.7;
  return [
    center,
    ...Array.from({ length: 8 }, (_, index) => {
      const bearing = (index * TAU) / 8;
      return center.map(
        (value, axis) =>
          value * Math.cos(radius) +
          (east[axis] * Math.cos(bearing) + north[axis] * Math.sin(bearing)) * Math.sin(radius),
      ) as Vec3;
    }),
  ];
}

/** Follow the actual connected cells in the viewport. Sampling isolated cells
 * creates almost invisible islands on large worlds and drops most local edges.
 * If the whole visible grid cannot fit, ask for a closer view instead of drawing
 * a misleading random subset. Work and output stay bounded by the packet limit. */
async function addGridOverlay(
  pages: PageValues,
  index: PagedSpatialIndex,
  summary: WorldSummary,
  request: OverlayRequest,
  output: Lines,
): Promise<'visible' | 'zoom-in'> {
  const tooDense = () => {
    output.positions.length = 0;
    output.heights.length = 0;
    output.widths.length = 0;
    output.discharge.length = 0;
    output.truncated = true;
    return 'zoom-in' as const;
  };
  if (!output.limit) {
    return tooDense();
  }
  const footprint = request.gridGlobeFootprint;
  const capCenter = footprint ? normalize(footprint.center) : undefined;
  const capCosine = footprint ? Math.cos(footprint.radius) : 0;
  const includes = (point: Vec3) =>
    capCenter
      ? capCenter.reduce((sum, value, axis) => sum + value * point[axis], 0) /
          Math.hypot(...point) >=
        capCosine
      : contains(point, request.bounds);
  const seeds = new Set<number>();
  for (const point of footprint ? globeGridPoints(footprint) : viewPoints(request.bounds, 9)) {
    seeds.add(await index.nearest(point));
  }
  const queue = [...seeds];
  const queued = new Set(queue);
  const touchedEdges = new Map<number, boolean>();
  const maximumCells = Math.min(summary.surfaceCells, Math.max(64, output.limit * 2 + 64));
  for (let start = 0; start < queue.length;) {
    if (start >= maximumCells) {
      return tooDense();
    }
    const cells = queue.slice(start, start + 32);
    start += cells.length;
    const offsets = await pages.readValues(
      'world.grid.offsets',
      cells.flatMap((cell) => [cell, cell + 1]),
    );
    const arcs = Array.from(cells, (_, slot) =>
      Array.from(
        { length: offsets[slot * 2 + 1] - offsets[slot * 2] },
        (_, offset) => offsets[slot * 2] + offset,
      ),
    );
    const flatArcs = arcs.flat();
    const [edges, neighbors] = await Promise.all([
      pages.readValues('world.grid.arcEdges', flatArcs),
      pages.readValues('world.grid.neighbors', flatArcs),
    ]);
    const pendingEdges = [...new Set(edges)].filter((edge) => !touchedEdges.has(edge));
    const cornerIds = await pages.readValues(
      'world.grid.edgeCorners',
      pendingEdges.flatMap((edge) => [edge * 2, edge * 2 + 1]),
    );
    const corners = Array.from(cornerIds);
    const [points, heights] = await Promise.all([
      pages.readValues(
        'world.grid.corners',
        corners.flatMap((corner) => [corner * 3, corner * 3 + 1, corner * 3 + 2]),
      ),
      pages.readValues('world.drainage.height', corners),
    ]);
    for (let edge = 0; edge < pendingEdges.length; edge++) {
      const first = Array.from(points.subarray(edge * 6, edge * 6 + 3)) as Vec3;
      const second = Array.from(points.subarray(edge * 6 + 3, edge * 6 + 6)) as Vec3;
      const clipped = footprint
        ? clipGlobeGridSegment(first, second, footprint)
        : clipOverlaySegment(first, second, request.bounds);
      touchedEdges.set(
        pendingEdges[edge],
        clipped.length > 0 || includes(first) || includes(second),
      );
      for (const part of clipped) {
        if (output.count >= output.limit) {
          return tooDense();
        }
        const firstHeight = heights[edge * 2];
        const difference = heights[edge * 2 + 1] - firstHeight;
        output.visible(
          part.first,
          part.second,
          firstHeight + difference * part.start,
          firstHeight + difference * part.end,
          1,
          0,
        );
      }
    }
    let arc = 0;
    for (let slot = 0; slot < cells.length; slot++) {
      const count = arcs[slot].length;
      const intersects =
        seeds.has(cells[slot]) ||
        edges.subarray(arc, arc + count).some((edge) => touchedEdges.get(edge));
      if (intersects) {
        for (let offset = arc; offset < arc + count; offset++) {
          const cell = neighbors[offset];
          if (!queued.has(cell)) {
            if (queued.size >= maximumCells) {
              return tooDense();
            }
            queued.add(cell);
            queue.push(cell);
          }
        }
      }
      arc += count;
    }
  }
  return 'visible';
}

/** Each packet has a fixed geometry budget; all lines come from saved physical state. */
export async function readOverlays(
  pages: PageValues,
  index: PagedSpatialIndex,
  summary: WorldSummary,
  request: OverlayRequest,
): Promise<OverlayPacket> {
  const { bounds } = request;
  const footprint = request.gridGlobeFootprint;
  if (
    footprint !== undefined &&
    (footprint === null ||
      !Array.isArray(footprint.center) ||
      footprint.center.length !== 3 ||
      !footprint.center.every(Number.isFinite) ||
      Math.abs(Math.hypot(...footprint.center) - 1) > 1e-6 ||
      !Number.isFinite(footprint.radius) ||
      footprint.radius < 0 ||
      footprint.radius > Math.PI)
  ) {
    throw new Error(
      'Invalid globe grid footprint: expected a unit center and an angle in [0, pi].',
    );
  }
  if (request.drift !== undefined && !Number.isFinite(request.drift)) {
    throw new Error('Plate preview rotation must be finite.');
  }
  if (
    !Object.values(bounds).every(Number.isFinite) ||
    bounds.south < -Math.PI / 2 ||
    bounds.north > Math.PI / 2 ||
    bounds.south > bounds.north ||
    Math.abs(bounds.west) > Math.PI ||
    Math.abs(bounds.east) > Math.PI
  ) {
    throw new Error('Invalid overlay viewport bounds.');
  }
  const total = clamp(Math.floor(request.maxSegments ?? 8192), 0, 8192);
  const resourcesLimit = clamp(Math.floor(request.maxResources ?? 200), 0, 200);
  if (!Number.isFinite(total) || !Number.isFinite(resourcesLimit)) {
    throw new Error('Invalid overlay packet budget.');
  }
  const active = [
    request.rivers,
    request.coasts,
    request.boundaries,
    request.vectors,
    request.gridLines,
    !!request.drift,
  ].filter(Boolean).length;
  const limit = Math.floor(total / Math.max(1, active));
  const rivers = new Lines(bounds, request.rivers ? limit : 0);
  const coasts = new Lines(bounds, request.coasts ? limit : 0);
  const boundaries = new Lines(bounds, request.boundaries ? limit : 0);
  const flow = new Lines(bounds, request.vectors ? limit : 0);
  const grid = new Lines(bounds, request.gridLines ? limit : 0);
  const drift = new Lines(bounds, request.drift ? limit : 0);
  const deposits: Deposit[] = [];
  const coastResult = request.coasts ? await readCoastOverlays(pages, bounds, limit) : undefined;
  let truncated = coastResult?.truncated ?? false;
  const gridStatus = request.gridLines
    ? await addGridOverlay(pages, index, summary, request, grid)
    : undefined;
  const edge = async (id: number, output: Lines) => {
    const corners = await pages.readValues('world.grid.edgeCorners', [id * 2, id * 2 + 1]);
    const points = await pages.readValues(
      'world.grid.corners',
      Array.from(corners).flatMap((corner) => [corner * 3, corner * 3 + 1, corner * 3 + 2]),
    );
    const heights = await pages.readValues('world.drainage.height', Array.from(corners));
    output.add(
      Array.from(points.subarray(0, 3)) as Vec3,
      Array.from(points.subarray(3, 6)) as Vec3,
      heights[0],
      heights[1],
    );
  };

  if (request.rivers || request.boundaries || request.resources) {
    const bins = viewBins(bounds);
    const offsets = await pages.readValues(
      'sidecars.view.overlay.offsets',
      bins.flatMap((bin) => [bin, bin + 1]),
    );
    if (request.rivers) {
      await addRiverOverlays(pages, bins, offsets, rivers, request);
    }
    const populatedBins = bins.filter((_, bin) => offsets[bin * 2 + 1] > offsets[bin * 2]).length;
    const quota = Math.max(
      1,
      Math.floor(
        Math.min(32768, Math.max(2048, total * 4 + resourcesLimit * 4)) /
          Math.max(1, populatedBins),
      ),
    );
    const seen = new Set<string>();
    const mixedFeatures = request.boundaries || request.resources || limit === 0;
    for (let bin = 0; mixedFeatures && bin < bins.length; bin++) {
      const count = (offsets[bin * 2 + 1] - offsets[bin * 2]) / 2;
      const sampled = Math.min(count, quota);
      if (sampled < count) {
        truncated = true;
      }
      const refs = await pages.readValues(
        'sidecars.view.overlay.refs',
        Array.from(
          { length: sampled },
          (_, sample) => offsets[bin * 2] + Math.floor((sample * count) / sampled) * 2,
        ).flatMap((offset) => [offset, offset + 1]),
      );
      for (let item = 0; item < refs.length; item += 2) {
        const kind = refs[item];
        const id = refs[item + 1];
        const key = `${kind}:${id}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const output = kind === 2 && request.boundaries ? boundaries : null;
        if (request.rivers && rivers.limit === 0 && [0, 3, 4].includes(kind)) {
          truncated = true;
        }
        if (output && output.count >= output.limit) {
          truncated = true;
          continue;
        }
        if (kind === 5 && request.resources && deposits.length >= resourcesLimit) {
          truncated = true;
          continue;
        }
        if (kind === 5 && request.resources) {
          const deposit = (await pages.readValue(`world.resources.deposits.${id}`)) as Deposit;
          if (
            !contains(deposit.anchor, bounds) ||
            (request.resourceFilter &&
              request.resourceFilter !== 'all' &&
              request.resourceFilter !== deposit.resourceType)
          ) {
            continue;
          }
          if (deposits.length < resourcesLimit) {
            deposits.push(deposit);
          } else {
            truncated = true;
          }
        } else if (kind === 2 && request.boundaries) {
          await edge(id, boundaries);
        }
      }
    }
  }

  const vectorCount = clamp(Math.floor(request.maxVectors ?? 256), 0, 512);
  if (!Number.isFinite(vectorCount)) {
    throw new Error('Invalid vector budget.');
  }
  const flowPacket =
    request.vectors && vectorCount && limit > 0
      ? (
          await readFlowPaths(pages, index, {
            bounds,
            kind: request.layer === 'currents' || request.layer === 'sst' ? 'current' : 'wind',
            season: request.season,
            maxPaths: vectorCount,
            maxSegments: limit,
          })
        ).lines
      : flow.packet();
  if (limit > 0 && request.drift) {
    const points = viewPoints(bounds, Math.min(64, Math.max(1, Math.floor(drift.limit / 3))));
    const cells: number[] = [];
    for (const point of points) {
      cells.push(await index.nearest(point));
    }
    const processes = await pages.readValues('world.transfer', cells);
    const heights = await pages.readValues('world.terrain.height', cells);
    if (request.drift) {
      const plates = await pages.readValues('world.geology.plate', Array.from(processes));
      const rotations = new Map<number, Vec3>();
      for (let sample = 0; sample < points.length; sample++) {
        const id = plates[sample];
        let axis = rotations.get(id);
        if (!axis) {
          axis = ((await pages.readValue(`world.geology.plates.${id}`)) as Plate).omega;
          rotations.set(id, axis);
        }
        if (!(Math.hypot(...axis) > 0)) {
          continue;
        }
        const unit = normalize(axis);
        const angle = (request.drift * Math.PI) / 180;
        const start = points[sample];
        const cross: Vec3 = [
          unit[1] * start[2] - unit[2] * start[1],
          unit[2] * start[0] - unit[0] * start[2],
          unit[0] * start[1] - unit[1] * start[0],
        ];
        const dot = unit.reduce((sum, value, component) => sum + value * start[component], 0);
        const end = normalize(
          start.map(
            (value, component) =>
              value * Math.cos(angle) +
              cross[component] * Math.sin(angle) +
              unit![component] * dot * (1 - Math.cos(angle)),
          ) as Vec3,
        );
        drift.add(start, end, heights[sample], heights[sample]);
        const separation = Math.acos(
          clamp(
            start.reduce((sum, value, component) => sum + value * end[component], 0),
            -1,
            1,
          ),
        );
        if (separation > 1e-8) {
          const backward = normalize(
            start.map((value, component) => value - Math.cos(separation) * end[component]) as Vec3,
          );
          const sideways: Vec3 = [
            end[1] * backward[2] - end[2] * backward[1],
            end[2] * backward[0] - end[0] * backward[2],
            end[0] * backward[1] - end[1] * backward[0],
          ];
          const size = Math.min(0.025, separation * 0.25);
          for (const sign of [-1, 1]) {
            const wing = normalize(
              end.map(
                (value, component) =>
                  value + size * (backward[component] + sign * sideways[component] * 0.5),
              ) as Vec3,
            );
            drift.add(end, wing, heights[sample], heights[sample]);
          }
        }
      }
    }
  }
  return {
    rivers: rivers.packet(),
    coasts: coastResult?.lines ?? coasts.packet(),
    coastStatus: coastResult?.status,
    boundaries: boundaries.packet(),
    flow: flowPacket,
    grid: grid.packet(),
    gridStatus,
    drift: drift.packet(),
    deposits,
    truncated:
      truncated || [rivers, coasts, boundaries, flow, grid, drift].some((lines) => lines.truncated),
  };
}
