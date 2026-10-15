import type { PhysicalMeshPacket } from '../core/view/physical-mesh-types';

const PI = Math.PI;
const TAU = PI * 2;
const DEGREE = PI / 180;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: readonly number[], b: readonly number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (p: readonly number[]) => {
  const length = Math.hypot(...p);
  return p.map((value) => value / length);
};
const hash = (id: number, salt: number) => {
  let value = Math.imul(id ^ salt, 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
};
const wrapColumn = (column: number, columns: number) => ((column % columns) + columns) % columns;

function cap(points: readonly (readonly number[])[], padding = 0) {
  const center = normalize([0, 1, 2].map((axis) => points.reduce((sum, p) => sum + p[axis], 0)));
  const radius =
    Math.max(...points.map((p) => Math.atan2(Math.hypot(...cross(center, p)), dot(center, p)))) +
    padding +
    1e-7;
  const latitude = Math.atan2(center[1], Math.hypot(center[0], center[2]));
  const longitude = Math.atan2(center[2], center[0]);
  return {
    latitude,
    longitude,
    radius,
    longitudeRadius:
      Math.abs(latitude) + radius >= PI / 2
        ? PI
        : Math.asin(clamp(Math.sin(radius) / Math.cos(latitude), -1, 1)),
  };
}

/** Stable near-equal-area canopy anchors sample triangle interiors, rather than
 * competing source vertices. Dense forest fills an area even on a coarse mesh.
 * The jitter and density ranks are geographic and survive source refinement. */
export class FantasyForestField {
  readonly rows = 240;
  readonly step = PI / this.rows;
  readonly offsets = new Uint32Array(this.rows + 1);
  readonly columns = new Uint16Array(this.rows);
  private readonly directions: Float64Array;
  private readonly heights: Float32Array;
  private readonly cover: Uint8Array;
  private readonly vegetation: Uint8Array;
  constructor() {
    for (let row = 0; row < this.rows; row++) {
      this.columns[row] = Math.max(
        1,
        Math.round(this.rows * 2 * Math.cos(-PI / 2 + (row + 0.5) * this.step)),
      );
      this.offsets[row + 1] = this.offsets[row] + this.columns[row];
    }
    const count = this.offsets[this.rows];
    this.directions = new Float64Array(count * 3);
    this.heights = new Float32Array(count).fill(-Infinity);
    this.cover = new Uint8Array(count);
    this.vegetation = new Uint8Array(count);
    for (let row = 0; row < this.rows; row++) {
      for (let column = 0; column < this.columns[row]; column++) {
        const id = this.offsets[row] + column;
        const lat = -PI / 2 + (row + 0.5 + (hash(id, 713) - 0.5) * 0.36) * this.step;
        const lon = -PI + ((column + 0.5 + (hash(id, 937) - 0.5) * 0.36) * TAU) / this.columns[row];
        this.directions.set(
          [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)],
          id * 3,
        );
      }
    }
  }
  get bytes() {
    return (
      this.directions.byteLength +
      this.heights.byteLength +
      this.cover.byteLength +
      this.vegetation.byteLength +
      this.columns.byteLength +
      this.offsets.byteLength
    );
  }
  addTriangle(
    packet: PhysicalMeshPacket,
    ids: readonly number[],
    points: readonly (readonly number[])[],
  ) {
    const forest = packet.materials[1];
    const terrain = packet.materials[0];
    if (ids.every((id) => forest[id * 4] < 96) || ids.every((id) => terrain[id * 4 + 3] < 88)) {
      return;
    }
    const bounds = cap(points);
    const lowRow = clamp(
      Math.floor((bounds.latitude - bounds.radius + PI / 2) / this.step),
      0,
      this.rows - 1,
    );
    const highRow = clamp(
      Math.floor((bounds.latitude + bounds.radius + PI / 2) / this.step),
      0,
      this.rows - 1,
    );
    const a = cross(points[1], points[2]);
    const b = cross(points[2], points[0]);
    const c = cross(points[0], points[1]);
    const determinant = dot(points[0], a);
    if (Math.abs(determinant) < 1e-20) {
      return;
    }
    for (let row = lowRow; row <= highRow; row++) {
      const columns = this.columns[row];
      const lowColumn = Math.floor(
        ((bounds.longitude - bounds.longitudeRadius + PI) / TAU) * columns,
      );
      const highColumn = Math.floor(
        ((bounds.longitude + bounds.longitudeRadius + PI) / TAU) * columns,
      );
      for (let column = lowColumn; column <= highColumn; column++) {
        const id = this.offsets[row] + wrapColumn(column, columns);
        const offset = id * 3;
        const x = this.directions[offset];
        const y = this.directions[offset + 1];
        const z = this.directions[offset + 2];
        const w0 = (x * a[0] + y * a[1] + z * a[2]) / determinant;
        const w1 = (x * b[0] + y * b[1] + z * b[2]) / determinant;
        const w2 = (x * c[0] + y * c[1] + z * c[2]) / determinant;
        if (Math.min(w0, w1, w2) < -1e-8) {
          continue;
        }
        const total = w0 + w1 + w2;
        const sample = (values: ArrayLike<number>, stride: number, channel: number) =>
          (w0 * values[ids[0] * stride + channel] +
            w1 * values[ids[1] * stride + channel] +
            w2 * values[ids[2] * stride + channel]) /
          total;
        this.heights[id] = Math.max(this.heights[id], Math.fround(sample(packet.heights, 1, 0)));
        this.cover[id] = Math.max(this.cover[id], Math.round(sample(forest, 4, 0)));
        this.vegetation[id] = Math.max(this.vegetation[id], Math.round(sample(terrain, 4, 3)));
      }
    }
  }
  *finish() {
    for (let id = 0; id < this.heights.length; id++) {
      const height = this.heights[id];
      const cover = this.cover[id] / 255;
      const vegetation = this.vegetation[id] / 255;
      if (!(height > 0) || cover < 0.42 || vegetation < 0.35) {
        continue;
      }
      // A closed rainforest canopy keeps every anchor. Sparse woodland thins
      // deterministically instead of shifting a single winner between bins.
      const density = clamp((cover - 0.3) / 0.5, 0, 1) * clamp((vegetation - 0.25) / 0.5, 0, 1);
      if (hash(id, 1231) > density) {
        continue;
      }
      const offset = id * 3;
      yield {
        direction: [
          this.directions[offset],
          this.directions[offset + 1],
          this.directions[offset + 2],
        ] as [number, number, number],
        height,
        width: (1.7 + hash(id, 2029) * 0.3) * DEGREE,
        variant: hash(id, 3691),
      };
    }
  }
}

/** Quarter-degree conservative water coverage. Clip the actual rendered 50%
 * ocean/lake boundary first; a mostly dry triangle must not become a wet cap. */
export class FantasyWaterMask {
  readonly columns = 1440;
  readonly rows = 720;
  readonly step = TAU / this.columns;
  private readonly wet = new Uint8Array(this.columns * this.rows);
  private readonly sinLat = Float64Array.from({ length: this.rows }, (_, row) =>
    Math.sin(-PI / 2 + (row + 0.5) * this.step),
  );
  private readonly cosLat = Float64Array.from({ length: this.rows }, (_, row) =>
    Math.cos(-PI / 2 + (row + 0.5) * this.step),
  );
  private readonly sinLon = Float64Array.from({ length: this.columns }, (_, column) =>
    Math.sin(-PI + (column + 0.5) * this.step),
  );
  private readonly cosLon = Float64Array.from({ length: this.columns }, (_, column) =>
    Math.cos(-PI + (column + 0.5) * this.step),
  );
  get bytes() {
    return (
      this.wet.byteLength +
      this.sinLat.byteLength +
      this.cosLat.byteLength +
      this.sinLon.byteLength +
      this.cosLon.byteLength
    );
  }
  addTriangle(
    packet: PhysicalMeshPacket,
    ids: readonly number[],
    points: readonly (readonly number[])[],
  ) {
    for (const channel of [2, 3]) {
      const values = ids.map((id) => packet.materials[4][id * 4 + channel]);
      if (Math.max(...values) < 127.5) {
        continue;
      }
      const clipped: number[][] = [];
      for (let index = 0; index < 3; index++) {
        const next = (index + 1) % 3;
        const inside = values[index] >= 127.5;
        if (inside) {
          clipped.push([...points[index]]);
        }
        if (inside !== values[next] >= 127.5) {
          const t = (127.5 - values[index]) / (values[next] - values[index]);
          clipped.push(normalize(points[index].map((v, axis) => v + (points[next][axis] - v) * t)));
        }
      }
      for (let index = 1; index + 1 < clipped.length; index++) {
        this.markTriangle([clipped[0], clipped[index], clipped[index + 1]]);
      }
    }
  }
  private markTriangle(points: readonly (readonly number[])[]) {
    const padding = this.step * 0.72;
    const bounds = cap(points, padding);
    const lowRow = clamp(
      Math.floor((bounds.latitude - bounds.radius + PI / 2) / this.step),
      0,
      this.rows - 1,
    );
    const highRow = clamp(
      Math.floor((bounds.latitude + bounds.radius + PI / 2) / this.step),
      0,
      this.rows - 1,
    );
    const lowColumn = Math.floor((bounds.longitude - bounds.longitudeRadius + PI) / this.step);
    const highColumn = Math.floor((bounds.longitude + bounds.longitudeRadius + PI) / this.step);
    const edges = [
      cross(points[0], points[1]),
      cross(points[1], points[2]),
      cross(points[2], points[0]),
    ];
    const determinant = dot(edges[0], points[2]);
    if (Math.abs(determinant) < 1e-20) {
      return;
    }
    const sign = Math.sign(determinant);
    const expanded = edges.map((edge) => -Math.hypot(...edge) * Math.sin(padding));
    for (let row = lowRow; row <= highRow; row++) {
      for (let column = lowColumn; column <= highColumn; column++) {
        const col = wrapColumn(column, this.columns);
        const id = row * this.columns + col;
        if (this.wet[id]) {
          continue;
        }
        const x = this.cosLat[row] * this.cosLon[col];
        const y = this.sinLat[row];
        const z = this.cosLat[row] * this.sinLon[col];
        if (
          edges.every((edge, i) => (edge[0] * x + edge[1] * y + edge[2] * z) * sign >= expanded[i])
        ) {
          this.wet[id] = 1;
        }
      }
    }
  }
  /** Fit the visible mountain ink, not an enclosing circle. Centering its
   * drawing around the crest and shrinking across a nearby shore preserves
   * the long dimension of coastal ranges. The box includes every atlas style. */
  fitMountain(direction: readonly number[], width: number, height: number, rotation: number) {
    const maximum = Math.hypot(width * 0.44, height * 0.54) + this.step;
    const lat = Math.atan2(direction[1], Math.hypot(direction[0], direction[2]));
    const lon = Math.atan2(direction[2], direction[0]);
    const row0 = clamp(Math.floor((lat - maximum + PI / 2) / this.step), 0, this.rows - 1);
    const row1 = clamp(Math.ceil((lat + maximum + PI / 2) / this.step), 0, this.rows - 1);
    const longitudeRange = Math.min(
      PI,
      maximum / Math.max(0.005, Math.cos(Math.min(PI / 2, Math.abs(lat) + maximum))),
    );
    const column0 = Math.floor((lon - longitudeRange + PI) / this.step);
    const column1 = Math.ceil((lon + longitudeRange + PI) / this.step);
    const limits: number[] = [];
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    let scale = 1;
    const eastAxis = [-Math.sin(lon), 0, Math.cos(lon)];
    const northAxis = [
      -direction[1] * Math.cos(lon),
      Math.hypot(direction[0], direction[2]),
      -direction[1] * Math.sin(lon),
    ];
    const constrain = (east: number, north: number) => {
      const x = cos * east + sin * north;
      const y = -sin * east + cos * north;
      // Include the complete marked cell and the tangent projection's small
      // local stretch; the raster already protects curved triangle edges.
      const margin = this.step * 0.72 * 1.01;
      const horizontal = Math.max(0, (Math.abs(x) - margin) / (width * 0.44));
      const vertical = Math.max(0, (Math.abs(y) - margin) / (height * (y >= 0 ? 0.54 : 0.33)));
      if (horizontal >= 1 || vertical >= 1) {
        return;
      }
      limits.push(horizontal, vertical);
      scale = Math.min(scale, Math.max(horizontal, vertical));
    };
    for (let row = row0; row <= row1; row++) {
      const north = -PI / 2 + (row + 0.5) * this.step - lat;
      for (let column = column0; column <= column1; column++) {
        const col = wrapColumn(column, this.columns);
        if (!this.wet[row * this.columns + col]) {
          continue;
        }
        const longitude = -PI + (col + 0.5) * this.step;
        const delta = ((longitude - lon + PI + TAU) % TAU) - PI;
        constrain(delta * Math.max(0.12, Math.cos(lat)), north);
        // Reused placements must fit both projections. Near a pole, a flat
        // map's latitude metric differs from the globe's tangent quad.
        const x = this.cosLat[row] * this.cosLon[col];
        const y = this.sinLat[row];
        const z = this.cosLat[row] * this.sinLon[col];
        const denominator = x * direction[0] + y * direction[1] + z * direction[2];
        if (denominator > 0) {
          constrain(
            (x * eastAxis[0] + z * eastAxis[2]) / denominator,
            (x * northAxis[0] + y * northAxis[1] + z * northAxis[2]) / denominator,
          );
        }
      }
    }
    // Start from a safe aspect-preserving fit, then recover whichever dimension
    // the coast leaves free. Choose the largest safe rectangular footprint.
    let wide = 1;
    let tall = 1;
    for (let index = 0; index < limits.length; index += 2) {
      if (scale > limits[index + 1] + 1e-10) {
        wide = Math.min(wide, limits[index]);
      }
      if (scale > limits[index] + 1e-10) {
        tall = Math.min(tall, limits[index + 1]);
      }
    }
    return wide >= tall ? ([wide, scale] as const) : ([scale, tall] as const);
  }
  clearance(direction: readonly number[], maximum: number) {
    const lat = Math.atan2(direction[1], Math.hypot(direction[0], direction[2]));
    const lon = Math.atan2(direction[2], direction[0]);
    const row0 = clamp(Math.floor((lat - maximum + PI / 2) / this.step), 0, this.rows - 1);
    const row1 = clamp(Math.ceil((lat + maximum + PI / 2) / this.step), 0, this.rows - 1);
    const latitudeLimit = Math.min(PI / 2, Math.abs(lat) + maximum);
    const longitudeRange = Math.min(PI, maximum / Math.max(0.005, Math.cos(latitudeLimit)));
    const column0 = Math.floor((lon - longitudeRange + PI) / this.step);
    const column1 = Math.ceil((lon + longitudeRange + PI) / this.step);
    let closest = maximum;
    for (let row = row0; row <= row1; row++) {
      for (let column = column0; column <= column1; column++) {
        const col = wrapColumn(column, this.columns);
        if (!this.wet[row * this.columns + col]) {
          continue;
        }
        const cosine =
          direction[0] * this.cosLat[row] * this.cosLon[col] +
          direction[1] * this.sinLat[row] +
          direction[2] * this.cosLat[row] * this.sinLon[col];
        closest = Math.min(
          closest,
          Math.max(0, Math.acos(clamp(cosine, -1, 1)) - this.step * 0.72),
        );
        if (closest === 0) {
          return 0;
        }
      }
    }
    return closest;
  }
}
