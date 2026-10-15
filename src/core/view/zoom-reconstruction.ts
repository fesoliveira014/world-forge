import type { PhysicalMeshPacket } from './physical-mesh-types';

type Triple = readonly [number, number, number];
type ZoomSurfaceFields = Pick<
  PhysicalMeshPacket,
  'mode' | 'directions' | 'heights' | 'normals' | 'materials'
>;

/** Immutable, small per-face controls. No world state or packet buffers are retained. */
export interface ZoomTriangle {
  readonly heights: Triple;
  /** Quadratic correction coefficients for edges 01, 12, 20. */
  readonly edgeCorrections: Triple;
  readonly reconstructable: boolean;
}

/** A correction never exceeds this fraction of the original face's height range. */
export const MAX_ZOOM_HEIGHT_FRACTION = 0.2;

/** Decode the same signed oct16 physical slope normal used by FixedSurface. */
export function decodeZoomNormal(normals: Int16Array, vertex: number): Triple {
  let x = Math.max(-1, normals[vertex * 2] / 32767);
  let y = Math.max(-1, normals[vertex * 2 + 1] / 32767);
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
    const previousX = x;
    x = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
    y = (1 - Math.abs(previousX)) * (y >= 0 ? 1 : -1);
  }
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}

/**
 * Recover a modest land-only shape from the saved one-ring slope normals.
 * Each edge's quadratic Hermite control is limited to its endpoint heights;
 * their Bernstein surface is consequently inside the original height range.
 * Sampling blends that surface with the original linear face through a C1
 * interior bubble, leaving every original edge and its correction derivative
 * exactly unchanged. This deliberately does not promise C1 terrain across an
 * original physical edge, or add terrain information absent from the snapshot.
 *
 * Radius and heights are metres. Missing world fields, any wet coverage, sea
 * level crossings, and flat faces disable reconstruction conservatively.
 */
export function prepareZoomTriangle(
  packet: ZoomSurfaceFields,
  vertices: readonly [number, number, number],
  radius: number,
): ZoomTriangle {
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new RangeError('Invalid planet radius');
  }
  for (const vertex of vertices) {
    if (!Number.isInteger(vertex) || vertex < 0 || vertex >= packet.heights.length) {
      throw new RangeError('Invalid zoom triangle vertex');
    }
  }
  const heights = vertices.map((vertex) => packet.heights[vertex]) as unknown as Triple;
  const disabled: ZoomTriangle = {
    heights,
    edgeCorrections: [0, 0, 0],
    reconstructable: false,
  };
  const water = packet.materials[4];
  const minimum = Math.min(...heights);
  const maximum = Math.max(...heights);
  if (
    packet.mode !== 'primal' ||
    !water ||
    !Number.isFinite(minimum + maximum) ||
    minimum <= 0 ||
    maximum === minimum ||
    vertices.some(
      (vertex) =>
        packet.normals.length < vertex * 2 + 2 ||
        packet.directions.length < vertex * 3 + 3 ||
        water.length < vertex * 4 + 4 ||
        water[vertex * 4 + 2] > 0 ||
        water[vertex * 4 + 3] > 0,
    )
  ) {
    return disabled;
  }

  const directions: Triple[] = [];
  const gradients: Triple[] = [];
  for (let point = 0; point < 3; point++) {
    const vertex = vertices[point];
    const offset = vertex * 3;
    const length = Math.hypot(...packet.directions.subarray(offset, offset + 3));
    if (!Number.isFinite(length) || length === 0) {
      return disabled;
    }
    const direction: Triple = [
      packet.directions[offset] / length,
      packet.directions[offset + 1] / length,
      packet.directions[offset + 2] / length,
    ];
    const normal = decodeZoomNormal(packet.normals, vertex);
    const radial = normal[0] * direction[0] + normal[1] * direction[1] + normal[2] * direction[2];
    if (!Number.isFinite(radial) || radial < 0.05) {
      return disabled;
    }
    // For a radial height field n ∝ d - grad(h)/(R+h). Remove the
    // radial component to recover a gradient in metres per unit direction.
    const scale = radius + heights[point];
    gradients.push([
      scale * (direction[0] - normal[0] / radial),
      scale * (direction[1] - normal[1] / radial),
      scale * (direction[2] - normal[2] / radial),
    ]);
    directions.push(direction);
  }

  const limit = 3 * MAX_ZOOM_HEIGHT_FRACTION * (maximum - minimum);
  const coefficients: number[] = [];
  for (let first = 0; first < 3; first++) {
    const second = (first + 1) % 3;
    let difference = 0;
    for (let axis = 0; axis < 3; axis++) {
      difference +=
        (gradients[first][axis] - gradients[second][axis]) *
        (directions[second][axis] - directions[first][axis]);
    }
    // 2 * (Hermite edge control - linear edge midpoint). Limiting this
    // coefficient by the endpoint difference keeps that control bounded.
    const edgeRange = Math.abs(heights[first] - heights[second]);
    const bound = Math.min(limit, edgeRange);
    coefficients.push(Math.max(-bound, Math.min(bound, difference * 0.5)));
  }
  return {
    heights,
    edgeCorrections: coefficients as unknown as Triple,
    reconstructable: coefficients.some((value) => value !== 0),
  };
}

/**
 * Metres to add along the sample direction to the ORIGINAL world-space chord.
 * Never reconstruct a radial sphere from the interpolated height: that would
 * bulge even a protected lake or river face. Barycentrics must sum to one.
 * attenuation is a geographic protection factor, 0 protected / 1 unprotected;
 * using one conservative value for an entire face is supported.
 */
export function sampleZoomHeightCorrection(
  triangle: ZoomTriangle,
  barycentric: ArrayLike<number>,
  attenuation = 1,
): number {
  const a = barycentric[0];
  const b = barycentric[1];
  const c = barycentric[2];
  if (
    !triangle.reconstructable ||
    !(a > 0 && b > 0 && c > 0) ||
    !Number.isFinite(attenuation) ||
    attenuation <= 0
  ) {
    return 0;
  }
  const product = a * b * c;
  // Maximum one at the centroid; both the value and its first derivative
  // vanish on every edge, including the unrefined neighbour's boundary.
  const bubble = 729 * product * product;
  const [ab, bc, ca] = triangle.edgeCorrections;
  return Math.min(1, attenuation) * bubble * (a * b * ab + b * c * bc + c * a * ca);
}

/** Physical height attribute; geometry must use sampleZoomHeightCorrection. */
export function sampleZoomHeight(
  triangle: ZoomTriangle,
  barycentric: ArrayLike<number>,
  attenuation = 1,
): number {
  return (
    triangle.heights[0] * barycentric[0] +
    triangle.heights[1] * barycentric[1] +
    triangle.heights[2] * barycentric[2] +
    sampleZoomHeightCorrection(triangle, barycentric, attenuation)
  );
}
