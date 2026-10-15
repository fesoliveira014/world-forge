import type { PhysicalMeshPacket } from './physical-mesh-types';

export type ZoomSegments = 2 | 4 | 8 | 16;

export interface ZoomFaceSelection {
  /** Triangle ordinal within the immutable source packet. */
  face: number;
  segments: ZoomSegments;
}

export interface ZoomTopology {
  /** Only these original triangles are replaced. Order follows the caller's priorities. */
  selectedFaces: Uint32Array;
  /** Source triangle ordinal for every temporary vertex. */
  sourceFaces: Uint32Array;
  /** Three source-corner weights per vertex, in the original index order. */
  barycentrics: Float64Array;
  indices: Uint16Array;
  vertexCount: number;
  interiorVertexCount: number;
  triangleCount: number;
  /** Whole faces omitted when their requested level exceeded the remaining budget. */
  skippedFaces: number;
}

interface Template {
  barycentrics: Float64Array;
  indices: Uint16Array;
}

// Four small immutable internal templates; no camera, world, or packet cache.
const templates = new Map<ZoomSegments, Template>();

function template(segments: ZoomSegments): Template {
  const cached = templates.get(segments);
  if (cached) {
    return cached;
  }
  const weights = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const indices: number[] = [];
  if (segments === 2) {
    weights.push(1 / 3, 1 / 3, 1 / 3);
    indices.push(0, 1, 3, 1, 2, 3, 2, 0, 3);
  } else {
    // A regular triangular lattice strictly inside the original triangle. The
    // inset is one lattice interval: b_i >= 1/segments. Original edges remain
    // single segments, so patches never need to subdivide a neighbouring face.
    const ids = new Map<number, number>();
    const key = (b: number, c: number) => b * (segments + 1) + c;
    const id = (b: number, c: number) => ids.get(key(b, c))!;
    for (let b = 1; b <= segments - 2; b++) {
      for (let c = 1; c <= segments - b - 1; c++) {
        ids.set(key(b, c), weights.length / 3);
        weights.push((segments - b - c) / segments, b / segments, c / segments);
      }
    }
    for (let b = 1; b <= segments - 3; b++) {
      for (let c = 1; c <= segments - b - 2; c++) {
        indices.push(id(b, c), id(b + 1, c), id(b, c + 1));
        if (b + c <= segments - 3) {
          indices.push(id(b + 1, c), id(b + 1, c + 1), id(b, c + 1));
        }
      }
    }
    // Three non-overlapping collars connect the inner lattice to the original
    // corners. Each collar is a fan from its first original corner, preserving
    // winding and the complete original boundary without T-junction vertices.
    for (let edge = 0; edge < 3; edge++) {
      const next = (edge + 1) % 3;
      const inner = (step: number) => {
        const coordinate = [1, 1, 1];
        coordinate[edge] = segments - 2 - step;
        coordinate[next] = 1 + step;
        return id(coordinate[1], coordinate[2]);
      };
      indices.push(edge, next, inner(segments - 3));
      for (let step = segments - 3; step > 0; step--) {
        indices.push(edge, inner(step), inner(step - 1));
      }
    }
  }
  const result = {
    barycentrics: Float64Array.from(weights),
    indices: Uint16Array.from(indices),
  };
  templates.set(segments, result);
  return result;
}

/**
 * Build bounded render-only replacement triangles from selected physical faces.
 *
 * The first three vertices of each accepted face are its exact original corners;
 * every other vertex is strictly interior. Interpolate the existing displayed
 * corner positions with these weights, then apply any height reconstruction only
 * in the interior. In particular, renormalizing the original boundary or adding
 * new boundary vertices would defeat the unsplit-edge guarantee.
 *
 * maxVertices includes the copied original corners, not only inserted points.
 * One result fits a Uint16 render packet; a caller with a larger total working
 * budget can build multiple results. Request order determines priority. This
 * function never scans unselected faces, samples storage, or mutates source data.
 */
export function buildZoomTopology(
  packet: Pick<PhysicalMeshPacket, 'indices'>,
  selections: readonly ZoomFaceSelection[],
  maxVertices: number,
): ZoomTopology {
  if (!Number.isInteger(maxVertices) || maxVertices < 0 || maxVertices > 65535) {
    throw new RangeError('Zoom patch vertex budget must be an integer from 0 to 65535.');
  }
  if (packet.indices.length % 3) {
    throw new RangeError('Zoom subdivision requires complete source triangles.');
  }
  const accepted: { face: number; shape: Template }[] = [];
  const seen = new Set<number>();
  let vertexCount = 0;
  let indexCount = 0;
  let skippedFaces = 0;
  for (const selection of selections) {
    const { face, segments } = selection;
    if (!Number.isInteger(face) || face < 0 || face >= packet.indices.length / 3) {
      throw new RangeError('Zoom subdivision selected a face outside its source packet.');
    }
    if (seen.has(face)) {
      throw new RangeError('A zoom patch cannot replace the same face twice.');
    }
    seen.add(face);
    if (segments !== 2 && segments !== 4 && segments !== 8 && segments !== 16) {
      throw new RangeError('Zoom subdivision supports 2, 4, 8, or 16 segments.');
    }
    const shape = template(segments);
    const count = shape.barycentrics.length / 3;
    if (vertexCount + count > maxVertices) {
      skippedFaces++;
      continue;
    }
    accepted.push({ face, shape });
    vertexCount += count;
    indexCount += shape.indices.length;
  }
  const selectedFaces = new Uint32Array(accepted.length);
  const sourceFaces = new Uint32Array(vertexCount);
  const barycentrics = new Float64Array(vertexCount * 3);
  const indices = new Uint16Array(indexCount);
  let vertexOffset = 0;
  let indexOffset = 0;
  for (let selected = 0; selected < accepted.length; selected++) {
    const { face, shape } = accepted[selected];
    const count = shape.barycentrics.length / 3;
    selectedFaces[selected] = face;
    sourceFaces.fill(face, vertexOffset, vertexOffset + count);
    barycentrics.set(shape.barycentrics, vertexOffset * 3);
    for (let index = 0; index < shape.indices.length; index++) {
      indices[indexOffset + index] = vertexOffset + shape.indices[index];
    }
    vertexOffset += count;
    indexOffset += shape.indices.length;
  }
  return {
    selectedFaces,
    sourceFaces,
    barycentrics,
    indices,
    vertexCount,
    interiorVertexCount: vertexCount - accepted.length * 3,
    triangleCount: indexCount / 3,
    skippedFaces,
  };
}
