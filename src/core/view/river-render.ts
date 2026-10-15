import * as THREE from 'three';
import type { PageValues } from './spatial-index';
import type { WorldSummary } from './types';
import type { FixedRiverBatch, FixedRiverRequest } from './river-render-types';
import type { Oxbow } from '../model';
import { PagedSurfaceStencils } from './surface-stencils';
import { MissingSnapshotFieldError } from '../storage';
import { riverCurvatureLimits } from './river-width-limits';
import { curveRiverPath } from '../../render/RiverCurve';
import { riverHalfWidth } from '../../render/RiverGeometry';
import { rebaseSavedRiverCourse } from '../generation/river-course-anchors';

const BATCH_POINTS = 16384;
const READ_VALUES = 8192;
const BANK_COLORS = ['#344b4b', '#87a260', '#306c49', '#429183'];
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const vector = (values: ArrayLike<number>, index: number) =>
  new THREE.Vector3(values[index * 3], values[index * 3 + 1], values[index * 3 + 2]);

async function gather(pages: PageValues, path: string, indices: readonly number[]) {
  const order = [...new Set(indices)].sort((a, b) => a - b);
  const lookup = new Map<number, number>();
  for (let start = 0; start < order.length; start += READ_VALUES) {
    const chunk = order.slice(start, start + READ_VALUES);
    const values = await pages.readValues(path, chunk);
    chunk.forEach((index, offset) => lookup.set(index, values[offset]));
  }
  return Float64Array.from(indices, (index) => lookup.get(index)!);
}
const components = (indices: readonly number[]) =>
  indices.flatMap((index) => [index * 3, index * 3 + 1, index * 3 + 2]);

interface DisplayPoint {
  position: THREE.Vector3;
  width: number;
  phase: number;
  activity: number;
  source: number;
  hint: number;
  floor: number;
  bankWidths: [number, number];
  bankColors: number[];
}
interface PreparedBatch {
  packet: FixedRiverBatch;
  hints: Uint32Array;
  draped: boolean;
}

/** Session-local immutable river assets. Only the current season/threshold is
 * retained. Queries do not restore World, rerun physics, or depend on camera LOD. */
export class RiverRenderReader {
  private variant = '';
  private preparing: Promise<void> | null = null;
  private batches: PreparedBatch[] = [];
  private stencils: PagedSurfaceStencils;
  private spatialCells: Uint32Array | null = null;
  private spatialRows: Uint32Array | null = null;
  private surfaceHeight: Float32Array | null = null;
  constructor(
    private pages: PageValues,
    private summary: WorldSummary,
  ) {
    this.stencils = new PagedSurfaceStencils(pages, summary.surfaceCells);
  }
  async read(request: FixedRiverRequest): Promise<FixedRiverBatch> {
    if (
      !Number.isInteger(request.season) ||
      request.season < -1 ||
      request.season > 3 ||
      !Number.isFinite(request.threshold) ||
      request.threshold < 0 ||
      !Number.isInteger(request.batch) ||
      request.batch < 0
    ) {
      throw new Error('Invalid fixed river request.');
    }
    const key = `${request.season}:${request.threshold}`;
    // Reader workers serialize requests. Keep this guard for direct callers too.
    if (this.preparing) {
      await this.preparing;
    }
    if (this.variant !== key) {
      this.batches = [];
      this.variant = '';
      this.preparing = this.prepare(request)
        .then(() => {
          this.variant = key;
        })
        .finally(() => {
          this.preparing = null;
        });
      await this.preparing;
    }
    const entry = this.batches[request.batch];
    if (!entry) {
      throw new RangeError('Fixed river batch is outside the prepared asset.');
    }
    if (!entry.draped && entry.packet.positions.length) {
      await this.drape(entry);
    }
    return entry.packet;
  }
  get bytes() {
    return (
      (this.batches[0]?.packet.totalBytes ?? 0) +
      this.batches.reduce((sum, entry) => sum + entry.hints.byteLength, 0) +
      (this.spatialCells?.byteLength ?? 0) +
      (this.spatialRows?.byteLength ?? 0) +
      (this.surfaceHeight?.byteLength ?? 0)
    );
  }

  private async geometryIndex() {
    if (this.spatialCells) {
      return;
    }
    const cells = (await this.pages.readValue('sidecars.view.index.cells')) as Uint32Array;
    const rows = new Uint32Array(this.summary.surfaceCells);
    cells.forEach((cell, row) => {
      rows[cell] = row;
    });
    const terrain = (await this.pages.readValue('world.terrain.height')) as ArrayLike<number>;
    const height = Float32Array.from(terrain, (value) => Math.fround(value));
    const lakes = (await this.pages.readValue('world.drainage.lakeDepth')) as ArrayLike<number>;
    for (let cell = 0; cell < height.length; cell++) {
      height[cell] += Math.fround(lakes[cell]);
    }
    this.spatialCells = cells;
    this.spatialRows = rows;
    this.surfaceHeight = height;
  }
  private async drape(entry: PreparedBatch) {
    const packet = entry.packet;
    // The routing corner already identifies a nearby primal vertex. Its exact
    // face walk avoids a second global nearest-center search for every bend.
    const waterPoints: number[] = [];
    for (let path = 0; path < packet.kinds.length; path++) {
      if (packet.kinds[path] === 4) {
        continue;
      }
      for (let point = packet.offsets[path]; point < packet.offsets[path + 1]; point++) {
        waterPoints.push(point);
      }
    }
    if (!waterPoints.length) {
      entry.draped = true;
      return;
    }
    await this.geometryIndex();
    const order = waterPoints.sort(
      (a, b) => this.spatialRows![entry.hints[a]] - this.spatialRows![entry.hints[b]] || a - b,
    );
    for (const point of order) {
      const stencil = await this.stencils.locate(
        [
          packet.positions[point * 3],
          packet.positions[point * 3 + 1],
          packet.positions[point * 3 + 2],
        ],
        this.spatialRows![entry.hints[point]],
      );
      let height = 0;
      for (let vertex = 0; vertex < 3; vertex++) {
        height +=
          this.surfaceHeight![this.spatialCells![stencil.rows[vertex]]] * stencil.weights[vertex];
      }
      packet.heights[point] = Math.max(packet.heights[point], Math.fround(height));
    }
    entry.draped = true;
  }

  private async prepare(request: FixedRiverRequest) {
    const pages = this.pages;
    const courseCorners = (await pages.readValue('world.rivers.courses.corner')) as Uint32Array;
    const courseOffsets = (await pages.readValue('world.rivers.courses.offsets')) as Uint32Array;
    const sinuosity = (await pages.readValue('world.rivers.courses.sinuosity')) as Float32Array;
    const receiver = (await pages.readValue('world.drainage.receiver')) as Int32Array;
    const bankCorners = (await pages.readValue('world.ecology.floodplains.corner')) as Uint32Array;
    const needed = new Set<number>(courseCorners);
    for (const corner of bankCorners) {
      needed.add(corner);
    }
    // Follow sparse downstream connections through reservoirs too. The original
    // shared animation phase includes those reaches even when no channel is drawn.
    for (const corner of needed) {
      if (receiver[corner] >= 0) {
        needed.add(receiver[corner]);
      }
    }
    const ids = [...needed].sort((a, b) => a - b);
    const at = new Map(ids.map((id, index) => [id, index]));
    const courseAt = new Map(Array.from(courseCorners, (corner, course) => [corner, course]));
    const positions = await gather(pages, 'world.grid.corners', components(ids));
    const triangles = await gather(pages, 'world.grid.triangles', components(ids));
    const amounts = await gather(pages, 'world.drainage.discharge', ids);
    const selectedFlow =
      request.season < 0
        ? amounts
        : await gather(pages, `world.rivers.seasonalDischarge.${request.season}`, ids);
    const sources = await gather(pages, 'world.rivers.source', ids);
    const lakeFraction = await gather(pages, 'world.drainage.lakeFraction', ids);
    const lakeIds = await gather(pages, 'world.drainage.lakeId', ids);
    const lakeLevels = new Map<number, number>();
    for (const lake of new Set(Array.from(lakeIds).filter((id) => id >= 0))) {
      lakeLevels.set(lake, (await pages.readValue(`world.drainage.lakes.${lake}.level`)) as number);
    }
    const warmest = new Float32Array(ids.length).fill(-Infinity);
    const temperature = new Float64Array(ids.length);
    for (let season = -1; season < 4; season++) {
      const field = (await pages.readValue(
        season < 0 ? 'world.water.temperature' : `world.water.seasonalTemperature.${season}`,
      )) as ArrayLike<number>;
      for (let node = 0; node < ids.length; node++) {
        const value =
          field[triangles[node * 3]] / 3 +
          field[triangles[node * 3 + 1]] / 3 +
          field[triangles[node * 3 + 2]] / 3;
        if (season >= 0) {
          warmest[node] = Math.max(warmest[node], value);
        }
        if (season === request.season) {
          temperature[node] = value;
        }
      }
    }
    const ocean = (await pages.readValue('world.terrain.ocean')) as Uint8Array;
    const coverage = (await pages.readValue('world.drainage.lakeCoverage')) as ArrayLike<number>;
    const anchorCells = [
      ...new Set(
        Array.from(triangles).filter(
          (cell, index) => lakeFraction[Math.floor(index / 3)] > 0 || ocean[cell],
        ),
      ),
    ];
    const anchorPositions = await gather(pages, 'world.grid.positions', components(anchorCells));
    const anchorAt = new Map(anchorCells.map((cell, index) => [cell, index]));
    const anchors = positions.slice();
    // Continuation guides use the physical lake/corner anchor. The seaward
    // mouth extension belongs only to a terminal reach's rendered endpoint.
    const guides = positions.slice();
    const terminalOcean = new Uint8Array(ids.length);
    for (let node = 0; node < ids.length; node++) {
      const point = new THREE.Vector3();
      if (lakeFraction[node] > 0) {
        for (let incident = 0; incident < 3; incident++) {
          const cell = triangles[node * 3 + incident];
          point.addScaledVector(
            vector(anchorPositions, anchorAt.get(cell)!),
            clamp(coverage[cell]),
          );
        }
        if (point.lengthSq() > 0) {
          point.normalize().toArray(anchors, node * 3);
          point.toArray(guides, node * 3);
        }
      } else if (receiver[ids[node]] < 0) {
        for (let incident = 0; incident < 3; incident++) {
          const cell = triangles[node * 3 + incident];
          if (!ocean[cell]) {
            continue;
          }
          vector(anchors, node)
            .lerp(vector(anchorPositions, anchorAt.get(cell)!), 0.4)
            .normalize()
            .toArray(anchors, node * 3);
          terminalOcean[node] = 1;
          break;
        }
      }
    }
    const activity = Float32Array.from(ids, (_, node) =>
      request.season < 0
        ? 1
        : clamp((temperature[node] + 1) / 3) *
          clamp(selectedFlow[node] / Math.max(1, amounts[node])),
    );
    const strongest = new Int32Array(ids.length).fill(-1);
    const visibleStrongest = new Int32Array(ids.length).fill(-1);
    const visible = new Uint8Array(ids.length);
    const lengths = new Float64Array(ids.length);
    for (let node = 0; node < ids.length; node++) {
      const downstream = at.get(receiver[ids[node]]);
      if (downstream === undefined) {
        continue;
      }
      lengths[node] =
        vector(positions, node).angleTo(vector(positions, downstream)) *
        (sinuosity[courseAt.get(ids[node]) ?? -1] || 1);
      if (!courseAt.has(ids[node])) {
        continue;
      }
      if (strongest[downstream] < 0 || amounts[node] > amounts[strongest[downstream]]) {
        strongest[downstream] = node;
      }
      if (
        amounts[node] < request.threshold ||
        (warmest[node] <= 0 && warmest[downstream] <= 0) ||
        [0, 1, 2].every((incident) => ocean[triangles[node * 3 + incident]])
      ) {
        continue;
      }
      visible[node] = 1;
      if (
        visibleStrongest[downstream] < 0 ||
        amounts[node] > amounts[visibleStrongest[downstream]]
      ) {
        visibleStrongest[downstream] = node;
      }
    }
    const distances = new Float64Array(ids.length).fill(-1);
    for (let node = 0; node < ids.length; node++) {
      if (distances[node] >= 0) {
        continue;
      }
      const chain: number[] = [];
      let next: number | undefined = node;
      while (next !== undefined && distances[next] === -1) {
        distances[next] = -2;
        chain.push(next);
        next = at.get(receiver[ids[next]]);
      }
      let total = next === undefined ? 0 : Math.max(0, distances[next]);
      while (chain.length) {
        const value = chain.pop()!;
        total += lengths[value];
        distances[value] = total;
      }
    }

    // Resolve bank sides using the same physical edge-cell ordering as the old
    // surface texture. Only these sparse bank records are needed, never Ecology.
    const bankAt = new Map(Array.from(bankCorners, (corner, slot) => [corner, slot]));
    const bankWidths = (await pages.readValue('world.ecology.floodplains.width')) as Float32Array;
    const bankVegetation = (await pages.readValue(
      'world.ecology.floodplains.vegetation',
    )) as Float32Array;
    const bankHabitat = (await pages.readValue('world.ecology.floodplains.habitat')) as Uint8Array;
    const bankFlood = new Float32Array(bankWidths.length);
    for (const season of request.season < 0 ? [0, 1, 2, 3] : [request.season]) {
      const values = (await pages.readValue(
        `world.ecology.floodplains.seasonalFlood.${season}`,
      )) as Float32Array;
      values.forEach((value, slot) => {
        bankFlood[slot] = Math.max(bankFlood[slot], value);
      });
    }
    const neighbors = await gather(
      pages,
      'world.grid.cornerNeighbors',
      components(Array.from(bankCorners)),
    );
    const edges = await gather(
      pages,
      'world.grid.cornerEdges',
      components(Array.from(bankCorners)),
    );
    const bankEdges = Array.from(bankCorners, (corner, slot) => {
      for (let side = 0; side < 3; side++) {
        if (neighbors[slot * 3 + side] === receiver[corner]) {
          return edges[slot * 3 + side];
        }
      }
      return 0;
    });
    const firstBankCell = await gather(
      pages,
      'world.grid.edgeCells',
      bankEdges.map((edge) => edge * 2),
    );
    const firstBankPosition = await gather(
      pages,
      'world.grid.positions',
      components(Array.from(firstBankCell)),
    );
    const bankInfo = (node: number) => {
      const slot = bankAt.get(ids[node]);
      const widths: [number, number] = [0, 0];
      const colors = Array<number>(8).fill(0);
      if (slot === undefined) {
        return { widths, colors };
      }
      const downstream = at.get(receiver[ids[node]])!;
      const sign =
        vector(positions, node)
          .cross(vector(positions, downstream))
          .dot(vector(firstBankPosition, slot)) < 0
          ? -1
          : 1;
      for (let side = 0; side < 2; side++) {
        const bank = slot * 2 + (sign === (side === 0 ? 1 : -1) ? 0 : 1);
        if (!(bankWidths[bank] > 0)) {
          continue;
        }
        widths[side] =
          bankWidths[bank] / this.summary.config.radius + riverHalfWidth(amounts[node], 1);
        const color = new THREE.Color(BANK_COLORS[bankHabitat[bank]])
          .multiplyScalar(0.75 + bankVegetation[bank] * 0.25)
          .lerp(new THREE.Color('#65aabd'), bankFlood[bank] * 0.3)
          .lerp(new THREE.Color('#a9b9ae'), clamp((2 - temperature[node]) / 12) * 0.8);
        colors.splice(side * 4, 4, color.r, color.g, color.b, 220 / 255);
      }
      return { widths, colors };
    };

    let positionsOut: number[] = [];
    let widthsOut: number[] = [];
    let curvatureLimitsOut: number[] = [];
    let phaseOut: number[] = [];
    let activityOut: number[] = [];
    let sourceOut: number[] = [];
    let hintsOut: number[] = [];
    let floorOut: number[] = [];
    let bankWidthsOut: number[] = [];
    let bankColorsOut: number[] = [];
    let offsetsOut = [0];
    let kindsOut: number[] = [];
    let incomingOut: number[] = [];
    let outgoingOut: number[] = [];
    const flush = () => {
      if (!widthsOut.length && this.batches.length) {
        return;
      }
      const packet: FixedRiverBatch = {
        batch: this.batches.length,
        totalBatches: 0,
        totalBytes: 0,
        totalPaths: 0,
        totalPoints: 0,
        offsets: Uint32Array.from(offsetsOut),
        incoming: Float32Array.from(incomingOut),
        outgoing: Float32Array.from(outgoingOut),
        positions: Float32Array.from(positionsOut),
        heights: Float32Array.from(floorOut),
        halfWidths: Float32Array.from(widthsOut),
        curvatureLimits: Float32Array.from(curvatureLimitsOut),
        phase: Float32Array.from(phaseOut),
        activity: Float32Array.from(activityOut),
        sources: Uint8Array.from(sourceOut),
        kinds: Uint8Array.from(kindsOut),
        bankWidths: Float32Array.from(bankWidthsOut),
        bankColors: Float32Array.from(bankColorsOut),
      };
      this.batches.push({ packet, hints: Uint32Array.from(hintsOut), draped: false });
      positionsOut = [];
      widthsOut = [];
      curvatureLimitsOut = [];
      phaseOut = [];
      activityOut = [];
      sourceOut = [];
      hintsOut = [];
      floorOut = [];
      bankWidthsOut = [];
      bankColorsOut = [];
      offsetsOut = [0];
      kindsOut = [];
      incomingOut = [];
      outgoingOut = [];
    };
    const append = (point: DisplayPoint, curvatureLimit: number) => {
      positionsOut.push(point.position.x, point.position.y, point.position.z);
      widthsOut.push(point.width);
      curvatureLimitsOut.push(curvatureLimit);
      phaseOut.push(point.phase);
      activityOut.push(point.activity);
      sourceOut.push(point.source);
      hintsOut.push(point.hint);
      floorOut.push(point.floor);
      bankWidthsOut.push(...point.bankWidths);
      bankColorsOut.push(...point.bankColors);
    };
    const addPath = (path: DisplayPoint[], kind = 0) => {
      if (path.length < 2) {
        return;
      }
      let limits: Float32Array | undefined;
      if (kind === 0) {
        const positions = new Float32Array(path.length * 3);
        path.forEach((point, index) => point.position.toArray(positions, index * 3));
        limits = riverCurvatureLimits(positions);
      }
      let start = 0;
      while (start < path.length - 1) {
        if (widthsOut.length > BATCH_POINTS - 2) {
          flush();
        }
        const end = Math.min(path.length, start + BATCH_POINTS - widthsOut.length);
        kindsOut.push(kind);
        incomingOut.push(...(start ? path[start - 1].position.toArray() : [0, 0, 0]));
        outgoingOut.push(...(end < path.length ? path[end].position.toArray() : [0, 0, 0]));
        for (let point = start; point < end; point++) {
          append(path[point], limits?.[point] ?? 1);
        }
        offsetsOut.push(widthsOut.length);
        start = end - 1;
        if (start < path.length - 1) {
          flush();
        }
      }
    };
    // Course points are contiguous on disk. Cache a fixed small block while
    // following connected trunks, avoiding one full physical course-array load.
    const courseCache = new Map<number, Float64Array>();
    const coursePoints = async (course: number) => {
      const first = courseOffsets[course] * 3;
      const end = courseOffsets[course + 1] * 3;
      const result = new Float32Array(end - first);
      for (let offset = first; offset < end;) {
        const block = Math.floor(offset / 65536);
        let values = courseCache.get(block);
        if (!values) {
          values = await pages.readRange(
            'world.rivers.courses.points',
            block * 65536,
            Math.min(65536, courseOffsets[courseOffsets.length - 1] * 3 - block * 65536),
          );
          courseCache.set(block, values);
          if (courseCache.size > 16) {
            courseCache.delete(courseCache.keys().next().value!);
          }
        }
        const count = Math.min(end - offset, values.length - (offset % 65536));
        result.set(values.subarray(offset % 65536, (offset % 65536) + count), offset - first);
        offset += count;
      }
      return result;
    };
    const displayCourse = async (node: number) => {
      const downstream = at.get(receiver[ids[node]])!;
      const course = courseAt.get(ids[node]);
      let points: Float32Array =
        course === undefined
          ? Float32Array.from([
              ...vector(positions, node).toArray(),
              ...vector(positions, downstream).toArray(),
            ])
          : await coursePoints(course);
      points = rebaseSavedRiverCourse(
        points,
        vector(positions, node).toArray(),
        vector(positions, downstream).toArray(),
      );
      vector(anchors, node).toArray(points, 0);
      vector(anchors, downstream).toArray(points, points.length - 3);
      if (lakeFraction[node] > 0 || lakeFraction[downstream] > 0 || terminalOcean[downstream]) {
        points = Float32Array.from([
          ...points.subarray(0, 3),
          ...points.subarray(points.length - 3),
        ]);
      } else {
        const previous = strongest[node] < 0 ? null : vector(guides, strongest[node]);
        const next =
          strongest[downstream] === node &&
          courseAt.has(ids[downstream]) &&
          at.has(receiver[ids[downstream]])
            ? vector(guides, at.get(receiver[ids[downstream]])!)
            : null;
        points = curveRiverPath(points, previous, next);
      }
      return points;
    };
    for (let start = 0; start < ids.length; start++) {
      if (!visible[start] || visibleStrongest[start] >= 0) {
        continue;
      }
      const chain: DisplayPoint[] = [];
      let node = start;
      while (true) {
        const downstream = at.get(receiver[ids[node]])!;
        const continuing = visible[downstream] && visibleStrongest[downstream] === node;
        const points = await displayCourse(node);
        const count = points.length / 3;
        const along = new Float64Array(count);
        for (let point = 1; point < count; point++) {
          along[point] =
            along[point - 1] + vector(points, point - 1).angleTo(vector(points, point));
        }
        const downstreamFlow =
          visibleStrongest[downstream] === node ? amounts[downstream] : amounts[node];
        for (let point = 0; point < count; point++) {
          const fraction = along[count - 1] > 0 ? along[point] / along[count - 1] : 1;
          const value: DisplayPoint = {
            position: vector(points, point).normalize(),
            width: riverHalfWidth(amounts[node] + (downstreamFlow - amounts[node]) * fraction, 1),
            phase: -distances[node] + (distances[node] - distances[downstream]) * fraction,
            activity: activity[node] + (activity[downstream] - activity[node]) * fraction,
            source: sources[node],
            hint: triangles[(fraction < 0.5 ? node : downstream) * 3],
            floor:
              (lakeFraction[node] > 0 ? (lakeLevels.get(lakeIds[node]) ?? 0) : 0) * (1 - fraction) +
              (lakeFraction[downstream] > 0 ? (lakeLevels.get(lakeIds[downstream]) ?? 0) : 0) *
                fraction,
            bankWidths: [0, 0],
            bankColors: Array(8).fill(0),
          };
          if (
            chain.length &&
            value.position.distanceToSquared(chain[chain.length - 1].position) < 1e-14
          ) {
            chain[chain.length - 1] = value;
          } else {
            chain.push(value);
          }
        }
        if (!continuing) {
          break;
        }
        node = downstream;
      }
      addPath(chain);
    }

    // The original pigment atlas includes every saved floodplain corridor,
    // independently of visible-water threshold or frozen-channel suppression.
    // Keep each reach separate so junctions retain its own constant bank record.
    for (const corner of bankCorners) {
      const node = at.get(corner)!;
      const banks = bankInfo(node);
      if (!banks.widths.some((width) => width > 0)) {
        continue;
      }
      const points = await displayCourse(node);
      addPath(
        Array.from({ length: points.length / 3 }, (_, point) => ({
          position: vector(points, point),
          width: 0,
          phase: 0,
          activity: 0,
          source: 0,
          hint: triangles[node * 3],
          floor: 0,
          bankWidths: banks.widths,
          bankColors: banks.colors,
        })),
        4,
      );
    }

    // Oxbow state is separate from live flow: dry scars and frozen ponds remain
    // visible, and surrounding ocean/lake water suppresses the duplicate footprint.
    const pondTemperature = (await pages.readValue(
      request.season < 0
        ? 'world.water.temperature'
        : `world.water.seasonalTemperature.${request.season}`,
    )) as ArrayLike<number>;
    let seasonalCoverage = coverage;
    if (request.season >= 0 && this.summary.oxbowCount) {
      try {
        seasonalCoverage =
          ((await pages.readValue(`world.drainage.seasonalLakeCoverage.${request.season}`)) as
            ArrayLike<number> | undefined) ?? coverage;
      } catch (error) {
        if (!(error instanceof MissingSnapshotFieldError)) {
          throw error;
        }
      }
    }
    const pondDepths = new Float32Array(this.summary.oxbowCount);
    for (const season of request.season < 0 ? [0, 1, 2, 3] : [request.season]) {
      const values = (await pages.readValue(
        `world.water.oxbowDepth.${season}`,
      )) as ArrayLike<number>;
      for (let pond = 0; pond < pondDepths.length; pond++) {
        pondDepths[pond] += values[pond] / (request.season < 0 ? 4 : 1);
      }
    }
    for (let id = 0; id < this.summary.oxbowCount; id++) {
      const pond = (await pages.readValue(`world.terrain.oxbows.${id}`)) as Oxbow;
      if (ocean[pond.cell] || seasonalCoverage[pond.cell] >= 0.5) {
        continue;
      }
      const path: DisplayPoint[] = [];
      for (let point = 0; point < pond.points.length / 3; point++) {
        path.push({
          position: vector(pond.points, point).normalize(),
          width: (pond.width * 2.5) / this.summary.config.radius,
          phase: 0,
          activity: 1,
          source: 0,
          hint: pond.cell,
          floor: 0,
          bankWidths: [0, 0],
          bankColors: Array(8).fill(0),
        });
      }
      addPath(path, pondDepths[id] < 0.02 ? 2 : pondTemperature[pond.cell] < 0 ? 3 : 1);
    }
    flush();
    const bytes = this.batches.reduce(
      (sum, entry) =>
        sum +
        Object.values(entry.packet).reduce(
          (size, value) => size + (ArrayBuffer.isView(value) ? value.byteLength : 0),
          0,
        ),
      0,
    );
    const paths = this.batches.reduce((sum, entry) => sum + entry.packet.kinds.length, 0);
    const points = this.batches.reduce((sum, entry) => sum + entry.packet.heights.length, 0);
    for (const entry of this.batches) {
      entry.packet.totalBatches = this.batches.length;
      entry.packet.totalBytes = bytes;
      entry.packet.totalPaths = paths;
      entry.packet.totalPoints = points;
    }
  }
}
