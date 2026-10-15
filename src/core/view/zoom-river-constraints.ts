import type { FixedRiverBatch } from './river-render-types';

const LEAF_SEGMENTS = 32;
const NODE_FIELDS = 7;
const NODE_LINKS = 4;
const ANGULAR_PADDING = 1e-7;

export interface ZoomRiverConstraints {
  /** Zero throughout the water corridor, one beyond its smooth outer feather.
   * A face's angular bounding radius times the planet radius can be passed as
   * marginMetres to protect every face intersected by the corridor. Using the
   * maximum supported display width avoids rebuilding terrain on slider edits.
   */
  attenuation(direction: ArrayLike<number>, marginMetres?: number, widthScale?: number): number;
  readonly segmentCount: number;
  readonly nodeCount: number;
  /** Additional typed-array storage; source packets remain shared and immutable. */
  readonly bytes: number;
  readonly lastVisitedSegments: number;
}

export interface ZoomRiverConstraintBuildOptions {
  signal?: AbortSignal;
  /** Defaults to a task yield, allowing browser input and rendering to proceed. */
  yieldControl?: () => Promise<void>;
}

class RiverConstraints implements ZoomRiverConstraints {
  references = new Uint32Array();
  bounds = new Float64Array();
  links = new Uint32Array();
  nodeCount = 0;
  lastVisitedSegments = 0;
  private readonly pending: number[] = [];

  constructor(
    readonly packets: readonly FixedRiverBatch[],
    readonly radius: number,
  ) {
    if (!(radius > 0) || !Number.isFinite(radius)) {
      throw Error('A finite positive planet radius is required.');
    }
  }

  get segmentCount() {
    return this.references.length / 2;
  }

  get bytes() {
    return this.references.byteLength + this.bounds.byteLength + this.links.byteLength;
  }

  attenuation(direction: ArrayLike<number>, marginMetres = 0, widthScale = 1) {
    const length = Math.hypot(direction[0], direction[1], direction[2]);
    if (!(length > 0) || !Number.isFinite(length)) {
      throw Error('A finite nonzero direction is required.');
    }
    if (!(marginMetres >= 0) || !Number.isFinite(marginMetres)) {
      throw Error('A finite nonnegative river margin is required.');
    }
    if (!(widthScale >= 0) || !Number.isFinite(widthScale)) {
      throw Error('A finite nonnegative river width scale is required.');
    }
    const x = direction[0] / length;
    const y = direction[1] / length;
    const z = direction[2] / length;
    const margin = marginMetres / this.radius + ANGULAR_PADDING;
    let result = 1;
    this.lastVisitedSegments = 0;
    this.pending.length = 0;
    if (this.nodeCount) {
      this.pending.push(0);
    }

    while (this.pending.length) {
      const node = this.pending.pop()!;
      const row = node * NODE_FIELDS;
      // Arc bounds exclude width, so any slider value can reuse the same tree.
      // Chord distance is at most angular distance, making this pruning bound
      // conservative for both the protected core and its outer feather.
      const reach = 2 * (this.bounds[row + 6] * Math.max(1, widthScale) + margin);
      const dx = Math.max(0, this.bounds[row] - x, x - this.bounds[row + 3]);
      const dy = Math.max(0, this.bounds[row + 1] - y, y - this.bounds[row + 4]);
      const dz = Math.max(0, this.bounds[row + 2] - z, z - this.bounds[row + 5]);
      if (dx * dx + dy * dy + dz * dz > reach * reach) {
        continue;
      }
      const link = node * NODE_LINKS;
      if (this.links[link + 2]) {
        this.pending.push(this.links[link + 2], this.links[link + 3]);
        continue;
      }
      for (let segment = this.links[link]; segment < this.links[link + 1]; segment++) {
        this.lastVisitedSegments++;
        const reference = this.references[segment * 2];
        const packet = this.packets[reference >>> 1];
        const end = this.references[segment * 2 + 1];
        const start = end - 1;
        const scale = reference & 1 ? widthScale : 1;
        const limits = reference & 1 ? packet.curvatureLimits : undefined;
        const width = Math.max(
          Math.min(packet.halfWidths[start] * scale, limits?.[start] ?? Infinity),
          Math.min(packet.halfWidths[end] * scale, limits?.[end] ?? Infinity),
        );
        const distance = arcDistance(packet.positions, start, end, x, y, z);
        const core = width + margin;
        if (distance <= core) {
          this.pending.length = 0;
          return 0;
        }
        const fraction = Math.min(1, (distance - core) / Math.max(width, margin));
        result = Math.min(result, fraction * fraction * (3 - 2 * fraction));
      }
    }
    return result;
  }
}

/** Angular distance to the minor great-circle arc, including its end caps.
 * Normalizing the stored Float32 directions avoids false distances caused by
 * their small radial rounding errors. No longitude seam or polar chart exists.
 */
function arcDistance(
  positions: Float32Array,
  start: number,
  end: number,
  x: number,
  y: number,
  z: number,
) {
  const first = start * 3;
  const last = end * 3;
  const firstLength = Math.hypot(positions[first], positions[first + 1], positions[first + 2]);
  const lastLength = Math.hypot(positions[last], positions[last + 1], positions[last + 2]);
  const ax = positions[first] / firstLength;
  const ay = positions[first + 1] / firstLength;
  const az = positions[first + 2] / firstLength;
  const bx = positions[last] / lastLength;
  const by = positions[last + 1] / lastLength;
  const bz = positions[last + 2] / lastLength;
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  const normalSquared = nx * nx + ny * ny + nz * nz;
  const dot = x * nx + y * ny + z * nz;
  if (normalSquared > 1e-20) {
    // The projection need not be normalized to test its position along the arc.
    const qx = x - (nx * dot) / normalSquared;
    const qy = y - (ny * dot) / normalSquared;
    const qz = z - (nz * dot) / normalSquared;
    const fromStart =
      (ay * qz - az * qy) * nx + (az * qx - ax * qz) * ny + (ax * qy - ay * qx) * nz;
    const toEnd = (qy * bz - qz * by) * nx + (qz * bx - qx * bz) * ny + (qx * by - qy * bx) * nz;
    if (fromStart >= 0 && toEnd >= 0) {
      return Math.asin(Math.min(1, Math.abs(dot) / Math.sqrt(normalSquared)));
    }
  } else if (ax * bx + ay * by + az * bz < 0) {
    // An exactly antipodal segment has no unique arc. Protect conservatively.
    return 0;
  }
  const firstChord = Math.hypot(x - ax, y - ay, z - az);
  const lastChord = Math.hypot(x - bx, y - by, z - bz);
  return 2 * Math.asin(Math.min(1, Math.min(firstChord, lastChord) / 2));
}

/** Construction yields by elapsed time, not by network size. The same generator
 * supports deterministic synchronous tests and cooperative browser assembly.
 */
function* assemble(index: RiverConstraints): Generator<void, RiverConstraints> {
  let work = 0;
  let deadline = performance.now() + 5;
  const pause = () => {
    work++;
    if (work % 32768 === 0 || (work % 1024 === 0 && performance.now() >= deadline)) {
      deadline = performance.now() + 5;
      return true;
    }
    return false;
  };
  let count = 0;
  for (const packet of index.packets) {
    for (let path = 0; path < packet.kinds.length; path++) {
      if (packet.kinds[path] !== 4) {
        count += Math.max(0, packet.offsets[path + 1] - packet.offsets[path] - 1);
      }
      if (pause()) {
        yield;
      }
    }
  }
  index.references = new Uint32Array(count * 2);
  if (!count) {
    return index;
  }
  let segment = 0;
  for (let batch = 0; batch < index.packets.length; batch++) {
    const packet = index.packets[batch];
    for (let path = 0; path < packet.kinds.length; path++) {
      if (packet.kinds[path] === 4) {
        continue;
      }
      for (let end = packet.offsets[path] + 1; end < packet.offsets[path + 1]; end++) {
        index.references[segment * 2] = batch * 2 + Number(packet.kinds[path] === 0);
        index.references[segment * 2 + 1] = end;
        segment++;
        if (pause()) {
          yield;
        }
      }
    }
  }
  const maximumNodes = 2 ** (Math.ceil(Math.log2(Math.ceil(count / LEAF_SEGMENTS))) + 1) - 1;
  index.bounds = new Float64Array(maximumNodes * NODE_FIELDS);
  index.links = new Uint32Array(maximumNodes * NODE_LINKS);
  const coordinate = (offset: number, axis: number) => {
    const packet = index.packets[index.references[offset * 2] >>> 1];
    const point = index.references[offset * 2 + 1] * 3 + axis;
    return packet.positions[point - 3] + packet.positions[point];
  };
  function* build(start: number, end: number): Generator<void, number> {
    const node = index.nodeCount++;
    const row = node * NODE_FIELDS;
    const link = node * NODE_LINKS;
    index.bounds.fill(Infinity, row, row + 3);
    index.bounds.fill(-Infinity, row + 3, row + 6);
    for (let offset = start; offset < end; offset++) {
      const packet = index.packets[index.references[offset * 2] >>> 1];
      const point = index.references[offset * 2 + 1];
      const first = (point - 1) * 3;
      const last = point * 3;
      const positions = packet.positions;
      const firstLength = Math.hypot(positions[first], positions[first + 1], positions[first + 2]);
      const lastLength = Math.hypot(positions[last], positions[last + 1], positions[last + 2]);
      const dot =
        (positions[first] * positions[last] +
          positions[first + 1] * positions[last + 1] +
          positions[first + 2] * positions[last + 2]) /
        (firstLength * lastLength);
      const sagitta = 1 - Math.sqrt(Math.max(0, Math.min(1, (1 + dot) / 2)));
      for (let axis = 0; axis < 3; axis++) {
        const a = positions[first + axis] / firstLength;
        const b = positions[last + axis] / lastLength;
        index.bounds[row + axis] = Math.min(index.bounds[row + axis], a - sagitta, b - sagitta);
        index.bounds[row + axis + 3] = Math.max(
          index.bounds[row + axis + 3],
          a + sagitta,
          b + sagitta,
        );
      }
      index.bounds[row + 6] = Math.max(
        index.bounds[row + 6],
        packet.halfWidths[point - 1],
        packet.halfWidths[point],
      );
      if (pause()) {
        yield;
      }
    }
    index.links[link] = start;
    index.links[link + 1] = end;
    if (end - start <= LEAF_SEGMENTS) {
      return node;
    }
    let axis = 0;
    for (let candidate = 1; candidate < 3; candidate++) {
      if (
        index.bounds[row + candidate + 3] - index.bounds[row + candidate] >
        index.bounds[row + axis + 3] - index.bounds[row + axis]
      ) {
        axis = candidate;
      }
    }
    const middle = (start + end) >>> 1;
    let lower = start;
    let upper = end - 1;
    while (lower < upper) {
      const pivot = coordinate((lower + upper) >>> 1, axis);
      let left = lower;
      let right = upper;
      while (left <= right) {
        while (coordinate(left, axis) < pivot) {
          left++;
          if (pause()) {
            yield;
          }
        }
        while (coordinate(right, axis) > pivot) {
          right--;
          if (pause()) {
            yield;
          }
        }
        if (left <= right) {
          const reference = index.references[left * 2];
          const point = index.references[left * 2 + 1];
          index.references[left * 2] = index.references[right * 2];
          index.references[left * 2 + 1] = index.references[right * 2 + 1];
          index.references[right * 2] = reference;
          index.references[right * 2 + 1] = point;
          left++;
          right--;
          if (pause()) {
            yield;
          }
        }
      }
      if (middle <= right) {
        upper = right;
      } else if (middle >= left) {
        lower = left;
      } else {
        break;
      }
    }
    index.links[link + 2] = yield* build(start, middle);
    index.links[link + 3] = yield* build(middle, end);
    return node;
  }
  yield* build(0, count);
  return index;
}

/** Synchronous construction for small/offline callers. Browser callers should
 * use buildZoomRiverConstraints so a large retained network cannot block input.
 */
export function createZoomRiverConstraints(
  packets: readonly FixedRiverBatch[],
  radius: number,
): ZoomRiverConstraints {
  const builder = assemble(new RiverConstraints(packets.slice(), radius));
  let step = builder.next();
  while (!step.done) {
    step = builder.next();
  }
  return step.value;
}

export async function buildZoomRiverConstraints(
  packets: readonly FixedRiverBatch[],
  radius: number,
  options: ZoomRiverConstraintBuildOptions = {},
): Promise<ZoomRiverConstraints> {
  const yieldControl =
    options.yieldControl ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const builder = assemble(new RiverConstraints(packets.slice(), radius));
  while (true) {
    options.signal?.throwIfAborted();
    const step = builder.next();
    if (step.done) {
      return step.value;
    }
    await yieldControl();
  }
}
