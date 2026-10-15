import type { Grid } from '../model';
import { cross, dot, normalizeVector, readVector, subtractVectors, type Vec3 } from '../math';

/** Mutable primal mesh. Array capacity may exceed the active counts during refinement. */
export interface SphericalMesh {
  count: number;
  level: number;
  positions: Float64Array;
  triangles: Uint32Array;
  halfEdges: Int32Array;
  triangleCount: number;
  flips: number;
  insertedCount?: number;
}

export const nextHalfEdge = (halfEdgeIndex: number) =>
  halfEdgeIndex - (halfEdgeIndex % 3) + ((halfEdgeIndex + 1) % 3);

export const previousHalfEdge = (halfEdgeIndex: number) =>
  halfEdgeIndex - (halfEdgeIndex % 3) + ((halfEdgeIndex + 2) % 3);

/** Triangular-number pairing stays stable when the number of sites grows. */
export function undirectedEdgeKey(firstVertex: number, secondVertex: number): number {
  const smaller = Math.min(firstVertex, secondVertex);
  const larger = Math.max(firstVertex, secondVertex);
  const key = (larger * (larger - 1)) / 2 + smaller;

  if (!Number.isSafeInteger(key)) {
    throw Error('Mesh edge key exceeds exact integer capacity.');
  }

  return key;
}

export function pairHalfEdges(triangles: Uint32Array): Int32Array {
  const halfEdges = new Int32Array(triangles.length).fill(-1);
  const edgeMap = new Map<number, number>();

  for (let halfEdgeIndex = 0; halfEdgeIndex < triangles.length; halfEdgeIndex++) {
    const firstVertex = triangles[halfEdgeIndex];
    const secondVertex = triangles[nextHalfEdge(halfEdgeIndex)];
    const key = undirectedEdgeKey(firstVertex, secondVertex);
    const twin = edgeMap.get(key);

    if (twin === undefined) {
      edgeMap.set(key, halfEdgeIndex);
    } else {
      halfEdges[halfEdgeIndex] = twin;
      halfEdges[twin] = halfEdgeIndex;
      edgeMap.delete(key);
    }
  }

  if (edgeMap.size) {
    throw Error('Spherical mesh has an unpaired boundary edge.');
  }

  return halfEdges;
}

/** Clone ownership before refining a grid that may also be the process grid. */
export function mutableMeshFromGrid(grid: Grid): SphericalMesh {
  const triangles = grid.triangles.slice();

  return {
    count: grid.count,
    level: grid.level,
    positions: grid.positions.slice(),
    triangles,
    halfEdges: pairHalfEdges(triangles),
    triangleCount: triangles.length / 3,
    flips: grid.flips,
    insertedCount: grid.refinement?.insertedCount,
  };
}

export function faceCircumcenter(mesh: SphericalMesh, face: number): Vec3 {
  const first = readVector(mesh.positions, mesh.triangles[face * 3]);
  const second = readVector(mesh.positions, mesh.triangles[face * 3 + 1]);
  const third = readVector(mesh.positions, mesh.triangles[face * 3 + 2]);

  return normalizeVector(cross(subtractVectors(second, first), subtractVectors(third, first)));
}

export function faceCircumradius(mesh: SphericalMesh, face: number): number {
  const center = faceCircumcenter(mesh, face);
  const vertex = readVector(mesh.positions, mesh.triangles[face * 3]);

  return Math.atan2(Math.hypot(...cross(center, vertex)), dot(center, vertex));
}

function reserveMesh(mesh: SphericalMesh, count: number, triangleCount: number) {
  if (count * 3 > mesh.positions.length) {
    const positions = new Float64Array(Math.max(count * 3, Math.ceil(mesh.positions.length * 1.5)));
    positions.set(mesh.positions);
    mesh.positions = positions;
  }

  if (triangleCount * 3 > mesh.triangles.length) {
    const capacity = Math.max(triangleCount, Math.ceil((mesh.triangles.length / 3) * 1.5)) * 3;
    const triangles = new Uint32Array(capacity);
    const halfEdges = new Int32Array(capacity).fill(-1);
    triangles.set(mesh.triangles);
    halfEdges.set(mesh.halfEdges);
    mesh.triangles = triangles;
    mesh.halfEdges = halfEdges;
  }
}

/** Insert inside a face, leaving legalization to the caller. Site IDs never change. */
export function splitFace(mesh: SphericalMesh, face: number, position: Vec3): number[] {
  reserveMesh(mesh, mesh.count + 1, mesh.triangleCount + 2);
  const triangles = mesh.triangles;
  const halfEdges = mesh.halfEdges;
  const firstOffset = face * 3;
  const secondOffset = mesh.triangleCount++ * 3;
  const thirdOffset = mesh.triangleCount++ * 3;
  const firstVertex = triangles[firstOffset];
  const secondVertex = triangles[firstOffset + 1];
  const thirdVertex = triangles[firstOffset + 2];
  const firstTwin = halfEdges[firstOffset];
  const secondTwin = halfEdges[firstOffset + 1];
  const thirdTwin = halfEdges[firstOffset + 2];
  const newVertex = mesh.count++;
  mesh.insertedCount = (mesh.insertedCount ?? 0) + 1;
  mesh.positions.set(position, newVertex * 3);
  triangles.set([firstVertex, secondVertex, newVertex], firstOffset);
  triangles.set([secondVertex, thirdVertex, newVertex], secondOffset);
  triangles.set([thirdVertex, firstVertex, newVertex], thirdOffset);

  const link = (first: number, second: number) => {
    halfEdges[first] = second;
    halfEdges[second] = first;
  };
  link(firstOffset, firstTwin);
  link(secondOffset, secondTwin);
  link(thirdOffset, thirdTwin);
  link(firstOffset + 1, secondOffset + 2);
  link(secondOffset + 1, thirdOffset + 2);
  link(thirdOffset + 1, firstOffset + 2);

  return [firstOffset, secondOffset, thirdOffset];
}

/** Walk through spherical triangle boundaries; zero margins include shared edges. */
export function locateFace(mesh: SphericalMesh, position: Vec3, startFace: number): number {
  let face = startFace;

  for (let step = 0; step <= mesh.triangleCount; step++) {
    let crossing = -1;
    let minimum = -1e-14;

    for (let side = 0; side < 3; side++) {
      const halfEdge = face * 3 + side;
      const first = readVector(mesh.positions, mesh.triangles[halfEdge]);
      const second = readVector(mesh.positions, mesh.triangles[nextHalfEdge(halfEdge)]);
      const margin = dot(cross(first, second), position);

      if (margin < minimum) {
        minimum = margin;
        crossing = halfEdge;
      }
    }

    if (crossing < 0) {
      return face;
    }

    face = Math.floor(mesh.halfEdges[crossing] / 3);
  }

  throw Error('Could not locate a refinement site in the spherical mesh.');
}

/** Restore the outward convex hull, equivalently the spherical empty-circle condition. */
export function legalizeEdges(
  mesh: SphericalMesh,
  initialEdges?: number[],
  changedFace?: (face: number) => void,
): number {
  const positions = mesh.positions;
  const triangles = mesh.triangles;
  const halfEdges = mesh.halfEdges;
  const queue: number[] = initialEdges ?? [];

  if (!initialEdges) {
    for (let halfEdgeIndex = 0; halfEdgeIndex < mesh.triangleCount * 3; halfEdgeIndex++) {
      if (halfEdgeIndex < halfEdges[halfEdgeIndex]) {
        queue.push(halfEdgeIndex);
      }
    }
  }

  const linkHalfEdges = (firstHalfEdge: number, secondHalfEdge: number) => {
    halfEdges[firstHalfEdge] = secondHalfEdge;
    halfEdges[secondHalfEdge] = firstHalfEdge;
  };
  let flips = 0;

  while (queue.length) {
    const firstHalfEdge = queue.pop()!;
    const secondHalfEdge = halfEdges[firstHalfEdge];
    const firstNext = nextHalfEdge(firstHalfEdge);
    const firstPrevious = previousHalfEdge(firstHalfEdge);
    const secondNext = nextHalfEdge(secondHalfEdge);
    const secondPrevious = previousHalfEdge(secondHalfEdge);
    const firstVertex = triangles[firstHalfEdge];
    const secondVertex = triangles[firstNext];
    const thirdVertex = triangles[firstPrevious];
    const oppositeVertex = triangles[secondPrevious];
    const firstPosition = readVector(positions, firstVertex);
    const secondPosition = readVector(positions, secondVertex);
    const thirdPosition = readVector(positions, thirdVertex);
    const oppositePosition = readVector(positions, oppositeVertex);
    const faceNormal = cross(
      subtractVectors(secondPosition, firstPosition),
      subtractVectors(thirdPosition, firstPosition),
    );
    const tolerance = (mesh.insertedCount ? 1e-14 : 1e-12) * Math.hypot(...faceNormal);

    if (dot(faceNormal, subtractVectors(oppositePosition, firstPosition)) <= tolerance) {
      continue;
    }

    const firstNextTwin = halfEdges[firstNext];
    const firstPreviousTwin = halfEdges[firstPrevious];
    const secondNextTwin = halfEdges[secondNext];
    const secondPreviousTwin = halfEdges[secondPrevious];
    triangles[firstHalfEdge] = thirdVertex;
    triangles[firstNext] = oppositeVertex;
    triangles[firstPrevious] = secondVertex;
    triangles[secondHalfEdge] = oppositeVertex;
    triangles[secondNext] = thirdVertex;
    triangles[secondPrevious] = firstVertex;
    linkHalfEdges(firstHalfEdge, secondHalfEdge);
    linkHalfEdges(firstNext, secondPreviousTwin);
    linkHalfEdges(firstPrevious, firstNextTwin);
    linkHalfEdges(secondNext, firstPreviousTwin);
    linkHalfEdges(secondPrevious, secondNextTwin);
    queue.push(firstNext, firstPrevious, secondNext, secondPrevious);
    changedFace?.(Math.floor(firstHalfEdge / 3));
    changedFace?.(Math.floor(secondHalfEdge / 3));
    flips++;
  }

  return flips;
}
