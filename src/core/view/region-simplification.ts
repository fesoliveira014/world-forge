import type { PhysicalMeshPacket } from './physical-mesh-types';

export interface RegionSimplificationOptions {
  triangleRegions?: Int32Array | Uint32Array;
  protectedVertices?: Uint8Array;
  maxEdgeAngle: number;
  /** Undefined selects the existing height-independent tectonic path. */
  maxHeightRange?: number;
}

/** Internal deterministic edge-collapse engine. Packet/category boundaries stay
 * exact. Height-aware callers additionally constrain accumulated scalar ranges. */
export function simplifyRegionPacket(
  packet: PhysicalMeshPacket,
  options: RegionSimplificationOptions,
): PhysicalMeshPacket {
  const count = packet.directions.length / 3;
  const faceCount = packet.indices.length / 3;
  const maxAngle = options.maxEdgeAngle;
  const heightBound = options.maxHeightRange;
  const preserveHeights = heightBound !== undefined;
  if (
    packet.mode !== 'dual' ||
    !Number.isInteger(count) ||
    !Number.isInteger(faceCount) ||
    count > 65535 ||
    packet.colors.length !== count * 4 ||
    (preserveHeights && packet.heights.length !== count) ||
    (options.protectedVertices && options.protectedVertices.length !== count) ||
    (preserveHeights && (!Number.isFinite(heightBound) || heightBound < 0)) ||
    (options.triangleRegions && options.triangleRegions.length !== faceCount) ||
    !Number.isFinite(maxAngle) ||
    maxAngle <= 0 ||
    maxAngle > Math.PI / 4
  ) {
    throw new RangeError('Invalid region simplification packet or bounds.');
  }
  const triangles = Uint32Array.from(packet.indices);
  const active = new Uint8Array(faceCount).fill(1);
  const incident = Array.from({ length: count }, () => new Set<number>());
  const locked = options.protectedVertices?.slice() ?? new Uint8Array(count);
  const minimumHeight = preserveHeights ? new Float64Array(faceCount) : undefined;
  const maximumHeight = preserveHeights ? new Float64Array(faceCount) : undefined;
  const regions = new Float64Array(faceCount);
  const colors = new Uint32Array(faceCount);
  const firstFace = new Int32Array(count).fill(-1);
  const edgeCounts = new Map<number, number>();
  const unit = new Float64Array(packet.directions.length);
  const edgeKey = (a: number, b: number) => Math.min(a, b) * count + Math.max(a, b);
  for (let vertex = 0; vertex < count; vertex++) {
    const offset = vertex * 3;
    const length = Math.hypot(...packet.directions.subarray(offset, offset + 3));
    if (!(length > 0) || !Number.isFinite(length)) {
      throw new RangeError('Region directions must be finite and nonzero.');
    }
    if (preserveHeights && !Number.isFinite(packet.heights[vertex])) {
      throw new RangeError('Categorical heights must be finite.');
    }
    for (let axis = 0; axis < 3; axis++) {
      unit[offset + axis] = packet.directions[offset + axis] / length;
    }
  }
  for (let face = 0; face < faceCount; face++) {
    if (preserveHeights) {
      const a = Math.max(0, packet.heights[triangles[face * 3]]);
      const b = Math.max(0, packet.heights[triangles[face * 3 + 1]]);
      const c = Math.max(0, packet.heights[triangles[face * 3 + 2]]);
      minimumHeight![face] = Math.min(a, b, c);
      maximumHeight![face] = Math.max(a, b, c);
    }
    const owner = triangles[face * 3 + 2];
    const offset = owner * 4;
    colors[face] =
      (packet.colors[offset] |
        (packet.colors[offset + 1] << 8) |
        (packet.colors[offset + 2] << 16) |
        (packet.colors[offset + 3] << 24)) >>>
      0;
    regions[face] = options.triangleRegions?.[face] ?? colors[face];
    for (let slot = 0; slot < 3; slot++) {
      const vertex = triangles[face * 3 + slot];
      const next = triangles[face * 3 + ((slot + 1) % 3)];
      if (vertex >= count) {
        throw new RangeError('Region triangle exceeds its vertex array.');
      }
      incident[vertex].add(face);
      const first = firstFace[vertex];
      if (first < 0) {
        firstFace[vertex] = face;
      } else if (regions[first] !== regions[face] || colors[first] !== colors[face]) {
        locked[vertex] = 1;
      }
      const edge = edgeKey(vertex, next);
      edgeCounts.set(edge, (edgeCounts.get(edge) ?? 0) + 1);
    }
  }
  for (const [edge, occurrences] of edgeCounts) {
    if (occurrences !== 2) {
      locked[Math.floor(edge / count)] = 1;
      locked[edge % count] = 1;
    }
  }
  const neighbors = (vertex: number) => {
    const result = new Set<number>();
    for (const face of incident[vertex]) {
      for (let slot = 0; slot < 3; slot++) {
        const other = triangles[face * 3 + slot];
        if (other !== vertex) {
          result.add(other);
        }
      }
    }
    return result;
  };
  const distanceSquared = (a: number, b: number) =>
    (unit[a * 3] - unit[b * 3]) ** 2 +
    (unit[a * 3 + 1] - unit[b * 3 + 1]) ** 2 +
    (unit[a * 3 + 2] - unit[b * 3 + 2]) ** 2;
  const maxEdgeSquared = 4 * Math.sin(maxAngle / 2) ** 2;
  const outward = (a: number, b: number, c: number) => {
    const ax = unit[a * 3];
    const ay = unit[a * 3 + 1];
    const az = unit[a * 3 + 2];
    const bx = unit[b * 3] - ax;
    const by = unit[b * 3 + 1] - ay;
    const bz = unit[b * 3 + 2] - az;
    const cx = unit[c * 3] - ax;
    const cy = unit[c * 3 + 1] - ay;
    const cz = unit[c * 3 + 2] - az;
    const determinant =
      ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
    return determinant > 1e-8 * Math.hypot(bx, by, bz) * Math.hypot(cx, cy, cz);
  };
  const validCollapse = (from: number, to: number, fromNeighbors: Set<number>) => {
    const toNeighbors = neighbors(to);
    const sharedFaces: number[] = [];
    for (const face of incident[from]) {
      if (incident[to].has(face)) {
        sharedFaces.push(face);
      }
    }
    if (sharedFaces.length !== 2) {
      return false;
    }
    const opposite = new Set<number>();
    for (const face of sharedFaces) {
      for (let slot = 0; slot < 3; slot++) {
        const vertex = triangles[face * 3 + slot];
        if (vertex !== from && vertex !== to) {
          opposite.add(vertex);
        }
      }
    }
    let common = 0;
    for (const vertex of fromNeighbors) {
      if (toNeighbors.has(vertex)) {
        if (!opposite.has(vertex)) {
          return false;
        }
        common++;
      }
      if (
        vertex !== to &&
        !toNeighbors.has(vertex) &&
        distanceSquared(to, vertex) > maxEdgeSquared
      ) {
        return false;
      }
    }
    // The manifold link condition prevents holes, duplicate triangles and the
    // loss of small region components when the remaining ring is already tight.
    if (common !== 2 || opposite.size !== 2) {
      return false;
    }
    for (const face of incident[from]) {
      if (incident[to].has(face)) {
        continue;
      }
      const a = triangles[face * 3] === from ? to : triangles[face * 3];
      const b = triangles[face * 3 + 1] === from ? to : triangles[face * 3 + 1];
      const c = triangles[face * 3 + 2] === from ? to : triangles[face * 3 + 2];
      if (!outward(a, b, c)) {
        return false;
      }
    }
    return true;
  };
  // A bounded number of deterministic passes avoids repeatedly rebuilding a
  // priority heap for every neighbor of each successful collapse. Geometry is
  // fixed by saved vertex order, independent of view or worker timing.
  let removedFaces = 0;
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (let vertex = 0; vertex < count; vertex++) {
      if (locked[vertex] || incident[vertex].size < 3) {
        continue;
      }
      // Carry the original scalar range of the entire replaced fan, including
      // faces deleted by earlier collapses. Recomputing this range only from
      // surviving vertices would allow arbitrarily large cumulative drift.
      let low = Infinity;
      let high = -Infinity;
      if (preserveHeights) {
        for (const face of incident[vertex]) {
          low = Math.min(low, minimumHeight![face]);
          high = Math.max(high, maximumHeight![face]);
        }
        if (high - low > heightBound!) {
          continue;
        }
      }
      const adjacent = neighbors(vertex);
      const candidates = [...adjacent].sort(
        (a, b) => distanceSquared(vertex, a) - distanceSquared(vertex, b) || a - b,
      );
      let target = -1;
      for (const candidate of candidates) {
        if (
          distanceSquared(vertex, candidate) <= maxEdgeSquared &&
          validCollapse(vertex, candidate, adjacent)
        ) {
          target = candidate;
          break;
        }
      }
      if (target < 0) {
        continue;
      }
      for (const face of incident[vertex]) {
        const shared = incident[target].has(face);
        for (let slot = 0; slot < 3; slot++) {
          const offset = face * 3 + slot;
          if (shared) {
            incident[triangles[offset]].delete(face);
          } else if (triangles[offset] === vertex) {
            triangles[offset] = target;
          }
        }
        if (shared) {
          active[face] = 0;
          removedFaces++;
        } else {
          incident[target].add(face);
          if (preserveHeights) {
            minimumHeight![face] = low;
            maximumHeight![face] = high;
          }
        }
      }
      incident[vertex].clear();
      changed = true;
    }
    if (!changed) {
      break;
    }
  }
  // Category-rich or steep packets often cannot simplify. Keep their original
  // buffers and provoking-vertex colors rather than expanding boundary vertices.
  if (preserveHeights && removedFaces < Math.max(2, faceCount * 0.02)) {
    return packet;
  }
  const remap = new Map<string, number>();
  const directions: number[] = [];
  const outputColors: number[] = [];
  const outputHeights: number[] = [];
  const indices: number[] = [];
  for (let face = 0; face < faceCount; face++) {
    if (!active[face]) {
      continue;
    }
    for (let slot = 0; slot < 3; slot++) {
      const vertex = triangles[face * 3 + slot];
      const key = `${vertex}:${regions[face]}:${colors[face]}`;
      let index = remap.get(key);
      if (index === undefined) {
        index = remap.size;
        remap.set(key, index);
        directions.push(...packet.directions.subarray(vertex * 3, vertex * 3 + 3));
        if (preserveHeights) {
          outputHeights.push(packet.heights[vertex]);
        }
        for (let channel = 0; channel < 4; channel++) {
          outputColors.push((colors[face] >>> (channel * 8)) & 255);
        }
      }
      indices.push(index);
    }
  }
  if (remap.size > 65535) {
    throw new RangeError('Simplified region packet exceeds Uint16 capacity.');
  }
  const result: PhysicalMeshPacket = {
    batch: packet.batch,
    mode: 'dual',
    directions: Float32Array.from(directions),
    heights: preserveHeights ? Float32Array.from(outputHeights) : new Float32Array(remap.size),
    normals: new Int16Array(),
    colors: Uint8Array.from(outputColors),
    materials: [],
    indices: Uint16Array.from(indices),
    bytes: 0,
  };
  result.bytes =
    result.directions.byteLength +
    result.heights.byteLength +
    result.colors.byteLength +
    result.indices.byteLength;
  return preserveHeights && result.bytes >= packet.bytes ? packet : result;
}
