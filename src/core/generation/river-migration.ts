import type { Drainage, Grid, RiverMigration, Terrain, WorldConfig } from '../model';
import {
  angle,
  clamp,
  createNoise,
  cross,
  dot,
  normalizeVector,
  readVector,
  type Vec3,
} from '../math';
import { nearestCell } from '../grid/build';
import { floodplainWidths } from './floodplains';
import { depositRiverSediment } from './river-sediment';
import { evolveBend } from './river-bend';
import { rebaseRiverCourse } from './river-course-anchors';

/** Original geographic reaches survive insertion and are indexed independently
 * of corner IDs. The index contains only sparse active reaches, not world cells. */
export function createMigrationLookup(records: readonly RiverMigration[], radius: number) {
  const buckets = new Map<string, RiverMigration[]>();
  const width = 0.04;
  const bucket = (value: number) => Math.floor(value / width);
  for (const record of records) {
    const center = normalizeVector(record.start.map((value, axis) => value + record.end[axis]));
    const cap = Math.min(
      2,
      angle(record.start, record.end) / 2 + Math.max(2000, record.space) / radius,
    );
    for (let x = bucket(center[0] - cap); x <= bucket(center[0] + cap); x++) {
      for (let y = bucket(center[1] - cap); y <= bucket(center[1] + cap); y++) {
        for (let z = bucket(center[2] - cap); z <= bucket(center[2] + cap); z++) {
          const key = `${x}/${y}/${z}`;
          const list = buckets.get(key);
          if (list) {
            list.push(record);
          } else {
            buckets.set(key, [record]);
          }
        }
      }
    }
  }
  return (start: Vec3, end: Vec3): RiverMigration | undefined => {
    const center = normalizeVector(start.map((value, axis) => value + end[axis]));
    const candidates =
      buckets.get(`${bucket(center[0])}/${bucket(center[1])}/${bucket(center[2])}`) ?? [];
    const direction = normalizeVector(cross(start, end));
    let best: RiverMigration | undefined;
    let bestDistance = Infinity;
    for (const record of candidates) {
      const normal = normalizeVector(cross(record.start, record.end));
      if (dot(normal, direction) < 0.7) {
        continue;
      }
      const length = angle(record.start, record.end);
      const along = Math.atan2(dot(center, cross(normal, record.start)), dot(center, record.start));
      if (along < 0 || along > length || angle(start, end) > length * 1.1) {
        continue;
      }
      const distance = Math.asin(clamp(Math.abs(dot(center, normal)), 0, 1)) * radius;
      if (distance <= Math.max(2000, record.space) && distance < bestDistance) {
        best = record;
        bestDistance = distance;
      }
    }
    return best;
  };
}

/** Sample the same original bend after a reach has been subdivided, then rebase
 * its chord to the new routing nodes. Refinement can move those nodes off the
 * inherited course; snapping only its endpoints would create sharp connectors.
 * The inherited bend parameter and migration clock are never restarted. */
export function sampleMigrationCourse(
  record: RiverMigration,
  start: Vec3,
  end: Vec3,
  radius: number,
): Vec3[] {
  const normal = normalizeVector(cross(record.start, record.end));
  const tangent = cross(normal, record.start);
  const angularLength = angle(record.start, record.end);
  const length = angularLength * radius;
  const fractionAt = (point: Vec3) =>
    clamp(Math.atan2(dot(point, tangent), dot(point, record.start)) / angularLength);
  const first = fractionAt(start);
  const last = fractionAt(end);
  const shape = evolveBend(
    length,
    record.space,
    record.elapsedMyr,
    record.mobility,
    record.variation,
  );
  const result: Vec3[] = [];
  for (let sample = 0; sample <= 16; sample++) {
    const fraction = first + ((last - first) * sample) / 16;
    const index = fraction * (shape.points.length - 1);
    const low = Math.floor(index);
    const high = Math.min(shape.points.length - 1, low + 1);
    const local = shape.points[low].map(
      (value, axis) => value + (shape.points[high][axis] - value) * (index - low),
    );
    result.push(
      normalizeVector(
        record.start.map(
          (value, axis) =>
            value +
            ((record.end[axis] - value) * local[0]) / length +
            (normal[axis] * local[1]) / radius,
        ),
      ),
    );
  }
  return rebaseRiverCourse(result, start, end);
}

/** Incremental bank exchange. The area swept by a growing sinusoidal bend is
 * integrated in metres; it is never treated as a full-cell incision depth.
 * Outer-bank removal funds point bars and the remaining downstream sediment.
 * The bounded exponential growth integrates exactly across split time intervals;
 * combined donor limits prevent overlapping reaches spending inventory twice.
 */
export function evolveRiverBanks(
  grid: Grid,
  terrain: Terrain,
  drainage: Drainage,
  config: WorldConfig,
): Float64Array {
  const remaining = new Float64Array(grid.count);
  if (config.fluvialDuration <= 0 || config.bankMobility <= 0 || config.erosion <= 0) {
    return remaining;
  }
  const existing = terrain.migration ?? [];
  const lookup = createMigrationLookup(existing, config.radius);
  const variationAt = createNoise(config.seed + '/river-migration');
  const active = new Map<RiverMigration, { discharge: number; level: number }>();
  for (let corner = 0; corner < drainage.receiver.length; corner++) {
    const receiver = drainage.receiver[corner];
    if (receiver < 0 || drainage.discharge[corner] < 100 || drainage.lakeFraction[corner] > 0) {
      continue;
    }
    let edge = -1;
    for (let slot = 0; slot < 3; slot++) {
      if (grid.cornerNeighbors[corner * 3 + slot] === receiver) {
        edge = grid.cornerEdges[corner * 3 + slot];
      }
    }
    if (edge < 0) {
      continue;
    }
    const first = grid.edgeCells[edge * 2];
    const second = grid.edgeCells[edge * 2 + 1];
    if (
      terrain.ocean[first] ||
      terrain.ocean[second] ||
      drainage.lakeCoverage[first] > 0 ||
      drainage.lakeCoverage[second] > 0
    ) {
      continue;
    }
    const start = readVector(grid.corners, corner);
    const end = readVector(grid.corners, receiver);
    const length = Math.max(1, angle(start, end) * config.radius);
    const level = (drainage.height[corner] + drainage.height[receiver]) / 2;
    const slope = Math.max(0, drainage.height[corner] - drainage.height[receiver]) / length;
    let space = Infinity;
    for (const cell of [first, second]) {
      const distance = (grid.areas[cell] * config.radius ** 2) / (2 * length);
      space = Math.min(
        space,
        floodplainWidths({
          supply: drainage.discharge[corner] * 0.6,
          peak: 0,
          length,
          riverSlope: slope,
          bankSlope: Math.max(0, terrain.height[cell] - level) / Math.max(1, distance),
          availableWidth: distance * 0.6,
          sediment: terrain.sediment[cell],
          extent: config.floodplainExtent,
        }).bank,
      );
    }
    if (space < 1) {
      continue;
    }
    const center = normalizeVector(start.map((value, axis) => value + end[axis]));
    const record = lookup(start, end) ?? {
      start,
      end,
      space,
      mobility: (config.bankMobility * config.erosion) / (1 + (slope / 0.002) ** 2),
      variation: clamp(0.5 + variationAt(center[0] * 31, center[1] * 31, center[2] * 31) * 0.5),
      elapsedMyr: 0,
    };
    const previous = active.get(record);
    if (!previous || previous.discharge < drainage.discharge[corner]) {
      active.set(record, { discharge: drainage.discharge[corner], level });
    }
  }
  const requests: { donor: number; recipient: number; volume: number; level: number }[] = [];
  const outgoing = new Float64Array(grid.count);
  const samples = 16;
  for (const [record, flow] of active) {
    const length = angle(record.start, record.end) * config.radius;
    const amplitudeAt = (elapsed: number) => {
      const growth =
        (1 - Math.exp(-elapsed / 0.4)) *
        clamp(record.mobility * (0.35 + record.variation * 0.65), 0, 1.3);
      return Math.min(record.space * 0.65, length * 0.22, 20000) * Math.min(1, growth);
    };
    const before = amplitudeAt(record.elapsedMyr);
    record.elapsedMyr += config.fluvialDuration;
    const after = amplitudeAt(record.elapsedMyr);
    const side = normalizeVector(cross(record.start, record.end));
    const sign = record.variation > 0.5 ? 1 : -1;
    const bankDepth = Math.min(6, 0.3 + 0.12 * Math.sqrt(flow.discharge));
    const reachTransfers = new Map<string, { donor: number; recipient: number; volume: number }>();
    let guess = 0;
    for (let sample = 0; sample < samples; sample++) {
      const fraction = (sample + 0.5) / samples;
      const bend = sign * Math.sin(2 * Math.PI * fraction);
      const base = record.start.map(
        (value, axis) => value * (1 - fraction) + record.end[axis] * fraction,
      );
      const position = (offset: number) =>
        normalizeVector(base.map((value, axis) => value + (side[axis] * offset) / config.radius));
      const direction = Math.sign(bend);
      const donorPosition = position(after * bend + direction * 10);
      const recipientPosition = position(before * bend - direction * 10);
      const donor = nearestCell(grid, ...donorPosition, guess);
      guess = donor;
      const recipient = nearestCell(grid, ...recipientPosition, donor);
      if (
        terrain.ocean[donor] ||
        terrain.ocean[recipient] ||
        drainage.lakeCoverage[donor] > 0 ||
        drainage.lakeCoverage[recipient] > 0
      ) {
        continue;
      }
      const volume = (length / samples) * (after - before) * Math.abs(bend) * bankDepth;
      if (volume > 0) {
        const key = `${donor}/${recipient}`;
        const previous = reachTransfers.get(key);
        if (previous) {
          previous.volume += volume;
        } else {
          reachTransfers.set(key, { donor, recipient, volume });
        }
      }
    }
    for (const transfer of reachTransfers.values()) {
      requests.push({ ...transfer, level: flow.level });
      outgoing[transfer.donor] += transfer.volume;
    }
  }
  const scales = new Float64Array(grid.count);
  for (let cell = 0; cell < grid.count; cell++) {
    if (!(outgoing[cell] > 0)) {
      continue;
    }
    const area = grid.areas[cell] * config.radius ** 2;
    const depth = Math.min(outgoing[cell] / area, Math.max(0, terrain.height[cell] - 1));
    const before = terrain.height[cell];
    const loose = Math.min(depth, terrain.sediment[cell]);
    terrain.sediment[cell] -= loose;
    terrain.bedrock[cell] -= depth - loose;
    terrain.height[cell] = terrain.bedrock[cell] + terrain.sediment[cell];
    const actual = Math.max(0, before - terrain.height[cell]);
    terrain.fluvialIncision[cell] += actual;
    remaining[cell] = actual * area;
    scales[cell] = remaining[cell] / outgoing[cell];
  }
  for (const request of requests) {
    const capacity =
      Math.max(0, request.level + 2 - terrain.height[request.recipient]) *
      grid.areas[request.recipient] *
      config.radius ** 2;
    const allocation = Math.min(
      capacity,
      request.volume * scales[request.donor] * 0.65,
      remaining[request.donor],
    );
    remaining[request.donor] -= depositRiverSediment(
      grid,
      terrain,
      request.recipient,
      allocation,
      config.radius,
    );
  }
  terrain.migration = [...active.keys()];
  return remaining;
}
