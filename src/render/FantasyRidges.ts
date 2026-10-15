import type { PhysicalMeshPacket } from '../core/view/physical-mesh-types';
import { FANTASY_MOUNTAIN_INK_FOOTPRINTS } from './FantasySymbolAtlas';

const PI = Math.PI;
const STEP = PI / 180;
const COLUMNS = 360;
const ROWS = 180;
const COUNT = COLUMNS * ROWS;
const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v));
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: readonly number[], b: readonly number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (p: readonly number[]) => {
  const length = Math.hypot(...p);
  return p.map((v) => v / length);
};
const distance = (a: readonly number[], b: readonly number[]) =>
  Math.atan2(Math.hypot(...cross(a, b)), dot(a, b));

export interface FantasyRidgeSymbol {
  direction: [number, number, number];
  height: number;
  width: number;
  sizeY: number;
  rotation: number;
  tile: number;
  kind: 'mountain';
  /** A traced connected path; separate/isolated paths always have distinct IDs. */
  chain: number;
}

/** A fixed geographic support field, sampled from authoritative physical
 * triangles. It stores no packets and never depends on camera or arrival order.
 * Its one-degree scale controls cartographic ridge placement, not world detail. */
export class FantasyRidgeField {
  private readonly heights = new Float32Array(COUNT).fill(-Infinity);
  private readonly state = new Uint8Array(COUNT);
  private readonly directions = new Float64Array(COUNT * 3);
  constructor(
    _radius: number,
    private readonly minimumHeight: number,
  ) {
    for (let row = 0; row < ROWS; row++) {
      const lat = -PI / 2 + (row + 0.5) * STEP;
      for (let col = 0; col < COLUMNS; col++) {
        const lon = -PI + (col + 0.5) * STEP;
        this.directions.set(
          [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)],
          (row * COLUMNS + col) * 3,
        );
      }
    }
  }
  get bytes() {
    return this.heights.byteLength + this.state.byteLength + this.directions.byteLength;
  }
  private direction(id: number): [number, number, number] {
    return [this.directions[id * 3], this.directions[id * 3 + 1], this.directions[id * 3 + 2]];
  }
  private index(p: readonly number[]) {
    const row = clamp(
      Math.floor((Math.atan2(p[1], Math.hypot(p[0], p[2])) + PI / 2) / STEP),
      0,
      ROWS - 1,
    );
    const col = ((Math.floor((Math.atan2(p[2], p[0]) + PI) / STEP) % COLUMNS) + COLUMNS) % COLUMNS;
    return row * COLUMNS + col;
  }
  private offset(p: readonly number[], east: number, north: number) {
    const lon = Math.atan2(p[2], p[0]);
    const e = [-Math.sin(lon), 0, Math.cos(lon)];
    const n = [-p[1] * Math.cos(lon), Math.hypot(p[0], p[2]), -p[1] * Math.sin(lon)];
    return normalize(p.map((v, axis) => v + e[axis] * east + n[axis] * north));
  }
  addPacket(packet: PhysicalMeshPacket) {
    const water = packet.materials[4];
    const terrain = packet.materials[0];
    if (packet.mode !== 'primal' || !water || !terrain) {
      return;
    }
    for (let face = 0; face < packet.indices.length; face += 3) {
      const ids = [packet.indices[face], packet.indices[face + 1], packet.indices[face + 2]];
      const p = ids.map((id) =>
        normalize(Array.from(packet.directions.subarray(id * 3, id * 3 + 3))),
      );
      const center = normalize([0, 1, 2].map((axis) => p[0][axis] + p[1][axis] + p[2][axis]));
      const radius = Math.max(...p.map((v) => distance(v, center))) + 1e-7;
      const lat = Math.atan2(center[1], Math.hypot(center[0], center[2]));
      const lon = Math.atan2(center[2], center[0]);
      const longitudeRadius =
        Math.abs(lat) + radius >= PI / 2
          ? PI
          : Math.asin(clamp(Math.sin(radius) / Math.cos(lat), -1, 1));
      const lowRow = clamp(Math.ceil((lat - radius + PI / 2) / STEP - 0.5), 0, ROWS - 1);
      const highRow = clamp(Math.floor((lat + radius + PI / 2) / STEP - 0.5), 0, ROWS - 1);
      const lowCol = Math.ceil((lon - longitudeRadius + PI) / STEP - 0.5);
      const highCol = Math.floor((lon + longitudeRadius + PI) / STEP - 0.5);
      if (lowRow > highRow || lowCol > highCol) {
        continue;
      }
      const a = cross(p[1], p[2]);
      const b = cross(p[2], p[0]);
      const c = cross(p[0], p[1]);
      const determinant = dot(p[0], a);
      if (Math.abs(determinant) < 1e-20) {
        continue;
      }
      for (let row = lowRow; row <= highRow; row++) {
        for (let col = lowCol; col <= highCol; col++) {
          const id = row * COLUMNS + (((col % COLUMNS) + COLUMNS) % COLUMNS);
          const direction = this.direction(id);
          const weights = [
            dot(direction, a) / determinant,
            dot(direction, b) / determinant,
            dot(direction, c) / determinant,
          ];
          if (weights.some((w) => w < -1e-8)) {
            continue;
          }
          const total = weights[0] + weights[1] + weights[2];
          const height =
            (weights[0] * packet.heights[ids[0]] +
              weights[1] * packet.heights[ids[1]] +
              weights[2] * packet.heights[ids[2]]) /
            total;
          // A coastal triangle can be mostly mountain. Classify its sampled
          // location using the same half-coverage boundary as the surface;
          // one wet corner must not remove the whole physical triangle.
          const coverage = (values: Uint8Array, channel: number) =>
            weights.reduce((sum, weight, i) => sum + weight * values[ids[i] * 4 + channel], 0) /
            total;
          const wet =
            coverage(water, 2) >= 127.5 ||
            coverage(water, 3) >= 127.5 ||
            coverage(terrain, 2) < 127.5;
          this.heights[id] = Math.max(this.heights[id], Math.fround(height));
          this.state[id] = Math.max(this.state[id], wet || height <= 0 ? 2 : 1);
        }
      }
    }
  }
  finish(): FantasyRidgeSymbol[] {
    const prominence = new Float32Array(COUNT);
    const tangent = new Float32Array(COUNT);
    const summit = new Uint8Array(COUNT);
    const eligible: number[] = [];
    const sample = (p: readonly number[], profile = false) => {
      const row = clamp(
        (Math.atan2(p[1], Math.hypot(p[0], p[2])) + PI / 2) / STEP - 0.5,
        0,
        ROWS - 1,
      );
      const column = (Math.atan2(p[2], p[0]) + PI) / STEP - 0.5;
      const lowRow = Math.floor(row);
      const lowCol = Math.floor(column);
      let height = 0;
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const weight =
            (dy ? row - lowRow : 1 - row + lowRow) * (dx ? column - lowCol : 1 - column + lowCol);
          if (weight <= 1e-10) {
            continue;
          }
          const id =
            Math.min(ROWS - 1, lowRow + dy) * COLUMNS + ((lowCol + dx + COLUMNS) % COLUMNS);
          if (!this.state[id] || (!profile && this.state[id] !== 1)) {
            return NaN;
          }
          height += this.heights[id] * weight;
        }
      }
      return height;
    };
    for (let id = 0; id < COUNT; id++) {
      const h = this.heights[id];
      if (this.state[id] !== 1 || h < this.minimumHeight) {
        continue;
      }
      const p = this.direction(id);
      let best = 0;
      let axis = 0;
      let profileScale = 2;
      // Broad mountain belts have high saddles and rounded crests. Looking
      // only two degrees away detects their individual tips but misses most
      // of the actual belt. Prefer the nearest supported cross-section, then
      // extend to wider ones when the local terrain remains mountainous.
      for (const scale of [2, 4, 6]) {
        for (let angle = 0; angle < PI; angle += PI / 8) {
          const east = Math.cos(angle) * scale * STEP;
          const north = Math.sin(angle) * scale * STEP;
          const positive = sample(this.offset(p, east, north), true);
          const negative = sample(this.offset(p, -east, -north), true);
          if (!Number.isFinite(positive + negative)) {
            continue;
          }
          const drop = Math.min(h - positive, h - negative);
          if (drop > best) {
            best = drop;
            axis = angle;
          }
        }
        if (best >= Math.max(55, h * 0.025)) {
          profileScale = scale;
          break;
        }
      }
      if (best < Math.max(55, h * 0.025)) {
        continue;
      }
      const crossCurvature =
        2 * h -
        sample(this.offset(p, Math.cos(axis) * STEP, Math.sin(axis) * STEP), true) -
        sample(this.offset(p, -Math.cos(axis) * STEP, -Math.sin(axis) * STEP), true);
      // A finite, high cap can have a nearly flat summit between steep walls.
      // Keep that supported massif, while excluding concave valley flanks and
      // broad unbounded plateaus whose distant cross-section has no relief.
      const highCap =
        profileScale >= 4 && Math.abs(crossCurvature) < 8 && best > Math.max(350, h * 0.18);
      if (!(crossCurvature > Math.max(8, best * 0.02)) && !highCap) {
        continue;
      }
      prominence[id] = best;
      tangent[id] = axis + PI / 2;
      const along = Math.min(
        h - sample(this.offset(p, -Math.sin(axis) * 2 * STEP, Math.cos(axis) * 2 * STEP)),
        h - sample(this.offset(p, Math.sin(axis) * 2 * STEP, -Math.cos(axis) * 2 * STEP)),
      );
      let minimumRadialDrop = Infinity;
      let localMaximum = true;
      for (let angle = 0; angle < PI * 2; angle += PI / 4) {
        const east = Math.cos(angle);
        const north = Math.sin(angle);
        localMaximum &&= sample(this.offset(p, east * STEP, north * STEP)) <= h;
        const outer = sample(this.offset(p, east * 2 * STEP, north * 2 * STEP));
        minimumRadialDrop = Math.min(minimumRadialDrop, h - outer);
      }
      const alongCurvature =
        2 * h -
        sample(this.offset(p, -Math.sin(axis) * STEP, Math.cos(axis) * STEP)) -
        sample(this.offset(p, Math.sin(axis) * STEP, -Math.cos(axis) * STEP));
      let highContinuation = false;
      for (let angle = 0; angle < PI * 2; angle += PI / 8) {
        const outer = sample(
          this.offset(p, Math.cos(angle) * 4 * STEP, Math.sin(angle) * 4 * STEP),
        );
        highContinuation ||= outer >= Math.max(this.minimumHeight, h * 0.35);
      }
      // Local peaks along a narrow ridge must not terminate the entire range.
      // A standalone dome curves downward substantially in both directions.
      summit[id] = Number(
        localMaximum &&
          !highContinuation &&
          minimumRadialDrop > Math.max(100, best * 0.35) &&
          along > 0 &&
          alongCurvature > crossCurvature * 0.65,
      );
      eligible.push(id);
    }
    eligible.sort(
      (a, b) =>
        summit[b] - summit[a] ||
        prominence[b] + this.heights[b] * 0.15 - prominence[a] - this.heights[a] * 0.15 ||
        a - b,
    );
    const occupied = new Uint8Array(COUNT);
    const traced = new Uint8Array(COUNT);
    const output: FantasyRidgeSymbol[] = [];
    let chain = 0;
    const neighborhood = (id: number, range: number) => {
      const p = this.direction(id);
      const lat = Math.atan2(p[1], Math.hypot(p[0], p[2]));
      const row = Math.floor(id / COLUMNS);
      const col = id % COLUMNS;
      const rowRange = Math.ceil(range / STEP);
      const colRange = Math.min(
        180,
        Math.ceil(range / STEP / Math.max(0.01, Math.cos(Math.min(PI / 2, Math.abs(lat) + range)))),
      );
      const result: number[] = [];
      for (let r = Math.max(0, row - rowRange); r <= Math.min(ROWS - 1, row + rowRange); r++) {
        for (let c = col - colRange; c <= col + colRange; c++) {
          const other = r * COLUMNS + (((c % COLUMNS) + COLUMNS) % COLUMNS);
          if (distance(p, this.direction(other)) <= range) {
            result.push(other);
          }
        }
      }
      return result;
    };
    const grow = (start: number, sign: number, own: Set<number>) => {
      const path: number[] = [];
      let current = start;
      const startPoint = this.direction(start);
      let forward = normalize(
        this.offset(
          startPoint,
          Math.cos(tangent[start]) * sign * STEP,
          Math.sin(tangent[start]) * sign * STEP,
        ).map((v, i) => v - startPoint[i]),
      );
      for (let step = 0; step < 96; step++) {
        const p = this.direction(current);
        let next = -1;
        let best = -Infinity;
        for (const candidate of neighborhood(current, 1.8 * STEP)) {
          if (
            candidate === current ||
            occupied[candidate] ||
            traced[candidate] ||
            own.has(candidate) ||
            prominence[candidate] <= 0
          ) {
            continue;
          }
          const q = this.direction(candidate);
          if (distance(p, q) < 0.65 * STEP) {
            continue;
          }
          const motion = normalize(q.map((v, axis) => v - p[axis]));
          const advance = dot(motion, forward);
          if (advance < 0.35) {
            continue;
          }
          const orientation = normalize(
            this.offset(
              q,
              Math.cos(tangent[candidate]) * STEP,
              Math.sin(tangent[candidate]) * STEP,
            ).map((v, axis) => v - q[axis]),
          );
          const alignment = Math.abs(dot(orientation, motion));
          if (alignment < 0.45) {
            continue;
          }
          const floor =
            Math.min(this.heights[current], this.heights[candidate]) -
            Math.min(180, prominence[current] * 0.25, prominence[candidate] * 0.25);
          let connected = true;
          for (const fraction of [0.25, 0.5, 0.75]) {
            const height = sample(
              normalize(p.map((v, axis) => v * (1 - fraction) + q[axis] * fraction)),
            );
            if (!Number.isFinite(height) || height < floor) {
              connected = false;
              break;
            }
          }
          if (!connected) {
            continue;
          }
          const score =
            advance * 0.9 +
            alignment * 0.3 +
            Math.min(1, prominence[candidate] / Math.max(1, prominence[current])) * 0.25;
          if (score > best || (score === best && candidate < next)) {
            best = score;
            next = candidate;
          }
        }
        if (next < 0) {
          break;
        }
        const q = this.direction(next);
        forward = normalize(q.map((v, axis) => v - p[axis]));
        path.push(next);
        own.add(next);
        current = next;
      }
      return path;
    };
    for (const seed of eligible) {
      if (occupied[seed] || traced[seed]) {
        continue;
      }
      const own = new Set([seed]);
      const previous = summit[seed] ? [] : grow(seed, -1, own);
      const following = summit[seed] ? [] : grow(seed, 1, own);
      const path = [...previous.reverse(), seed, ...following];
      if (path.length <= 2) {
        // Cross-slope curvature also occurs on a dome's flanks. An isolated
        // mark must be an actual local summit, not just a curved slope fragment.
        const localMaximum = neighborhood(seed, 1.8 * STEP).every(
          (id) => this.state[id] !== 1 || this.heights[id] <= this.heights[seed] + 0.01,
        );
        if (!localMaximum || prominence[seed] < Math.max(250, this.heights[seed] * 0.12)) {
          continue;
        }
      }
      // Move each guide off the sampling lattice toward its measured crest.
      // This quadratic correction is clamped inside half a support cell and is
      // accepted only over the same high, dry physical terrain.
      const guide = path.map((id) => {
        traced[id] = 1;
        const p = this.direction(id);
        const axis = tangent[id] - PI / 2;
        const east = Math.cos(axis);
        const north = Math.sin(axis);
        const h = this.heights[id];
        const negative = sample(this.offset(p, -east * STEP, -north * STEP));
        const positive = sample(this.offset(p, east * STEP, north * STEP));
        const curve = negative - 2 * h + positive;
        if (!Number.isFinite(curve) || curve >= -1) {
          return p;
        }
        const shift = clamp((0.5 * (negative - positive)) / curve, -0.45, 0.45) * STEP;
        const moved = this.offset(p, east * shift, north * shift);
        return sample(moved) >= h - 100 ? moved : p;
      });
      const smooth = guide.map((p, i) => {
        if (!i || i === guide.length - 1) {
          return p;
        }
        const q = normalize(
          p.map((v, axis) => v * 0.6 + guide[i - 1][axis] * 0.2 + guide[i + 1][axis] * 0.2),
        );
        const floor = Math.min(sample(p), sample(guide[i - 1]), sample(guide[i + 1])) - 100;
        return sample(q) >= floor ? q : p;
      });
      const cumulative = new Float64Array(smooth.length);
      for (let i = 1; i < smooth.length; i++) {
        cumulative[i] = cumulative[i - 1] + distance(smooth[i - 1], smooth[i]);
      }
      const total = cumulative[cumulative.length - 1];
      let along = 0;
      let segment = 0;
      let mark = 0;
      do {
        while (segment + 1 < cumulative.length - 1 && cumulative[segment + 1] < along) {
          segment++;
        }
        const next = Math.min(segment + 1, smooth.length - 1);
        const fraction =
          cumulative[next] > cumulative[segment]
            ? (along - cumulative[segment]) / (cumulative[next] - cumulative[segment])
            : 0;
        const direction = normalize(
          smooth[segment].map((v, axis) => v * (1 - fraction) + smooth[next][axis] * fraction),
        ) as [number, number, number];
        const h = sample(direction);
        if (!Number.isFinite(h) || h < this.minimumHeight) {
          break;
        }
        const interior = along > 0.5 * STEP && total - along > 0.5 * STEP;
        const paired = interior && mark % 3 === 1;
        const strength = clamp((h - this.minimumHeight) / 4500, 0, 1);
        const width = (paired ? 2.9 : 2.4) * (0.88 + strength * 0.3) * STEP;
        const sizeY = width * (paired ? 0.75 : 1.08);
        output.push({
          direction,
          height: h,
          width,
          sizeY,
          rotation: 0,
          tile: paired ? 1 : 0,
          kind: 'mountain',
          chain,
        });
        if (interior && next !== segment) {
          const motion = normalize(smooth[next].map((v, axis) => v - smooth[segment][axis]));
          const normal = normalize(cross(direction, motion));
          const shoulders = [-1, 1].map(
            (sign) =>
              normalize(direction.map((v, axis) => v + normal[axis] * sign * 1.35 * STEP)) as [
                number,
                number,
                number,
              ],
          );
          const heights = shoulders.map((point) => sample(point));
          // A wide, high shoulder belongs to the mountain massif, even when
          // its local prominence is small. Layer subsidiary peaks on both
          // sides of broad crests; narrow ranges keep only occasional foothills.
          const broad = heights.every((height) => height > Math.max(this.minimumHeight, h * 0.78));
          const sides = broad && mark % 2 === 0 ? [0, 1] : [];
          if (!broad && mark % 3 === 2) {
            const side = heights[0] >= heights[1] ? 0 : 1;
            shoulders[side] = normalize(
              direction.map((v, axis) => v + normal[axis] * (side ? 1 : -1) * 0.7 * STEP),
            ) as [number, number, number];
            heights[side] = sample(shoulders[side]);
            if (
              heights[side] > Math.max(this.minimumHeight, h * 0.65) &&
              heights[side] < h * 0.98
            ) {
              sides.push(side);
            }
          }
          for (const side of sides) {
            output.push({
              direction: shoulders[side],
              height: heights[side],
              width: width * (broad ? 0.78 : 0.68),
              sizeY: sizeY * (broad ? 0.76 : 0.45),
              rotation: 0,
              tile: heights[side] < 1400 ? 4 + side : 0,
              kind: 'mountain',
              chain,
            });
          }
        }

        // Space by measured ink dimensions, not transparent atlas padding.
        // Geographic overlap stays intact as the user zooms the map or globe.
        const ink = FANTASY_MOUNTAIN_INK_FOOTPRINTS[paired ? 1 : 0];
        const motion =
          next === segment
            ? [1, 0, 0]
            : normalize(smooth[next].map((v, axis) => v - smooth[segment][axis]));
        const longitude = Math.atan2(direction[2], direction[0]);
        const east = -motion[0] * Math.sin(longitude) + motion[2] * Math.cos(longitude);
        const north =
          -motion[0] * direction[1] * Math.cos(longitude) +
          motion[1] * Math.hypot(direction[0], direction[2]) -
          motion[2] * direction[1] * Math.sin(longitude);
        const visibleLength =
          1 / Math.hypot(east / (width * ink.width), north / (sizeY * ink.height));
        along += Math.max(0.3 * STEP, visibleLength * 0.4);
        mark++;
      } while (along <= total && mark < 512);
      for (const id of path) {
        for (const other of neighborhood(id, (summit[seed] ? 3.2 : 1.6) * STEP)) {
          occupied[other] = 1;
        }
      }
      chain++;
    }
    return output;
  }
}
