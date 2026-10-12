import type { Grid } from '../model';
import {
  readVector,
  normalizeVector,
  cross,
  subtractVectors,
  dot,
  angle,
  createSeededRandom,
} from '../math';

const nextHalfEdge = (halfEdgeIndex: number) =>
  halfEdgeIndex - (halfEdgeIndex % 3) + ((halfEdgeIndex + 1) % 3);

const previousHalfEdge = (halfEdgeIndex: number) =>
  halfEdgeIndex - (halfEdgeIndex % 3) + ((halfEdgeIndex + 2) % 3);

/** Jittered icosphere -> locally legalized spherical Delaunay -> circumcentric dual. */
export function buildGrid(level: number, seed: string, irregularity: number): Grid {
  const goldenRatio = (1 + Math.sqrt(5)) / 2;
  const initialPoints = [
    -1,
    goldenRatio,
    0,
    1,
    goldenRatio,
    0,
    -1,
    -goldenRatio,
    0,
    1,
    -goldenRatio,
    0,
    0,
    -1,
    goldenRatio,
    0,
    1,
    goldenRatio,
    0,
    -1,
    -goldenRatio,
    0,
    1,
    -goldenRatio,
    goldenRatio,
    0,
    -1,
    goldenRatio,
    0,
    1,
    -goldenRatio,
    0,
    -1,
    -goldenRatio,
    0,
    1,
  ];

  // Preallocate the final cell coordinates. Large JS number arrays otherwise
  // coexist with their typed copies and cause expensive garbage collections.
  const count = 10 * 4 ** level + 2;
  const positions = new Float64Array(count * 3);
  let pointCount = 12;
  for (let cellIndex = 0; cellIndex < pointCount; cellIndex++) {
    positions.set(normalizeVector(readVector(initialPoints, cellIndex)), cellIndex * 3);
  }

  let triangles = new Uint32Array([
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1,
    8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
  ]);

  for (let subdivisionLevel = 0; subdivisionLevel < level; subdivisionLevel++) {
    const mids = new Map<number, number>();
    const result = new Uint32Array(triangles.length * 4);
    const base = pointCount;

    const midpoint = (firstVertex: number, secondVertex: number) => {
      const key = Math.min(firstVertex, secondVertex) * base + Math.max(firstVertex, secondVertex);
      let midpointIndex = mids.get(key);

      if (midpointIndex !== undefined) {
        return midpointIndex;
      }

      const firstPosition = readVector(positions, firstVertex);
      const secondPosition = readVector(positions, secondVertex);
      midpointIndex = pointCount++;
      positions.set(
        normalizeVector([
          firstPosition[0] + secondPosition[0],
          firstPosition[1] + secondPosition[1],
          firstPosition[2] + secondPosition[2],
        ]),
        midpointIndex * 3,
      );
      mids.set(key, midpointIndex);

      return midpointIndex;
    };

    for (let triangleOffset = 0; triangleOffset < triangles.length; triangleOffset += 3) {
      const firstVertex = triangles[triangleOffset];
      const secondVertex = triangles[triangleOffset + 1];
      const thirdVertex = triangles[triangleOffset + 2];
      const firstMidpoint = midpoint(firstVertex, secondVertex);
      const secondMidpoint = midpoint(secondVertex, thirdVertex);
      const thirdMidpoint = midpoint(thirdVertex, firstVertex);
      const outputOffset = triangleOffset * 4;
      result[outputOffset] = firstVertex;
      result[outputOffset + 1] = firstMidpoint;
      result[outputOffset + 2] = thirdMidpoint;
      result[outputOffset + 3] = secondVertex;
      result[outputOffset + 4] = secondMidpoint;
      result[outputOffset + 5] = firstMidpoint;
      result[outputOffset + 6] = thirdVertex;
      result[outputOffset + 7] = thirdMidpoint;
      result[outputOffset + 8] = secondMidpoint;
      result[outputOffset + 9] = firstMidpoint;
      result[outputOffset + 10] = secondMidpoint;
      result[outputOffset + 11] = thirdMidpoint;
    }

    triangles = result;
  }

  const half = new Int32Array(triangles.length).fill(-1);
  // Numeric keys remain exact at level 9: count² is below Number.MAX_SAFE_INTEGER.
  const edgeMap = new Map<number, number>();

  for (let halfEdgeIndex = 0; halfEdgeIndex < triangles.length; halfEdgeIndex++) {
    const firstCell = triangles[halfEdgeIndex];
    const secondCell = triangles[nextHalfEdge(halfEdgeIndex)];
    const key = Math.min(firstCell, secondCell) * count + Math.max(firstCell, secondCell);
    const other = edgeMap.get(key);

    if (other === undefined) {
      edgeMap.set(key, halfEdgeIndex);
    } else {
      half[halfEdgeIndex] = other;
      half[other] = halfEdgeIndex;
      edgeMap.delete(key);
    }
  }

  const randomNumber = createSeededRandom(seed + '/grid/' + level);
  const spacing = Math.sqrt((4 * Math.PI) / count);

  for (let cellIndex = 0; cellIndex < count; cellIndex++) {
    const position = readVector(positions, cellIndex);
    const axis = normalizeVector(
      cross(position, Math.abs(position[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]),
    );
    const tangentAxis = cross(position, axis);
    const jitterAngle = randomNumber() * Math.PI * 2;
    // Less than a quarter of local spacing; accepted only if incident orientation survives.
    const jitterDistance = spacing * 0.24 * irregularity * Math.sqrt(randomNumber());
    const jitteredPosition = normalizeVector([
      position[0] +
        jitterDistance * (axis[0] * Math.cos(jitterAngle) + tangentAxis[0] * Math.sin(jitterAngle)),
      position[1] +
        jitterDistance * (axis[1] * Math.cos(jitterAngle) + tangentAxis[1] * Math.sin(jitterAngle)),
      position[2] +
        jitterDistance * (axis[2] * Math.cos(jitterAngle) + tangentAxis[2] * Math.sin(jitterAngle)),
    ]);
    positions.set(jitteredPosition, cellIndex * 3);
  }

  for (let halfEdgeIndex = 0; halfEdgeIndex < triangles.length; halfEdgeIndex += 3) {
    const firstPosition = readVector(positions, triangles[halfEdgeIndex]);
    const secondPosition = readVector(positions, triangles[halfEdgeIndex + 1]);
    const thirdPosition = readVector(positions, triangles[halfEdgeIndex + 2]);

    if (
      dot(
        cross(
          subtractVectors(secondPosition, firstPosition),
          subtractVectors(thirdPosition, firstPosition),
        ),
        firstPosition,
      ) <= 0
    ) {
      throw Error('Grid displacement inverted a triangle. Reduce irregularity.');
    }
  }

  const flips = legalizeEdges(positions, triangles, half);
  const corners = new Float64Array(triangles.length);
  const cornerNeighbors = new Uint32Array(triangles.length);
  const cornerEdges = new Uint32Array(triangles.length);

  for (let halfEdgeIndex = 0; halfEdgeIndex < triangles.length; halfEdgeIndex += 3) {
    const firstPosition = readVector(positions, triangles[halfEdgeIndex]);
    const secondPosition = readVector(positions, triangles[halfEdgeIndex + 1]);
    const thirdPosition = readVector(positions, triangles[halfEdgeIndex + 2]);
    corners.set(
      normalizeVector(
        cross(
          subtractVectors(secondPosition, firstPosition),
          subtractVectors(thirdPosition, firstPosition),
        ),
      ),
      halfEdgeIndex,
    );
  }

  const edgeCount = triangles.length / 2;
  const edgeCells = new Uint32Array(edgeCount * 2);
  const edgeCorners = new Uint32Array(edgeCount * 2);
  const edgeLength = new Float64Array(edgeCount);
  const edgeDistance = new Float64Array(edgeCount);
  const edgeNormal = new Float64Array(edgeCount * 3);
  const halfToEdge = new Uint32Array(triangles.length);
  let edgeIndex = 0;

  for (let halfEdgeIndex = 0; halfEdgeIndex < triangles.length; halfEdgeIndex++) {
    if (halfEdgeIndex < half[halfEdgeIndex]) {
      const firstCell = triangles[halfEdgeIndex];
      const secondCell = triangles[nextHalfEdge(halfEdgeIndex)];
      const firstCorner = Math.floor(halfEdgeIndex / 3);
      const secondCorner = Math.floor(half[halfEdgeIndex] / 3);
      edgeCells.set([firstCell, secondCell], edgeIndex * 2);
      // Endpoints oriented so flux = psi[end]-psi[start] is outward from cell a.
      const midpoint = normalizeVector([
        positions[3 * firstCell] + positions[3 * secondCell],
        positions[3 * firstCell + 1] + positions[3 * secondCell + 1],
        positions[3 * firstCell + 2] + positions[3 * secondCell + 2],
      ]);
      const normal = normalizeVector(
        subtractVectors(readVector(positions, secondCell), readVector(positions, firstCell)),
      );
      const firstCornerPosition = readVector(corners, firstCorner);
      const secondCornerPosition = readVector(corners, secondCorner);
      const forward =
        dot(cross(midpoint, subtractVectors(secondCornerPosition, firstCornerPosition)), normal) >
        0;
      edgeCorners.set(
        forward ? [firstCorner, secondCorner] : [secondCorner, firstCorner],
        edgeIndex * 2,
      );
      edgeNormal.set(normal, edgeIndex * 3);
      edgeLength[edgeIndex] = angle(firstCornerPosition, secondCornerPosition);
      edgeDistance[edgeIndex] = angle(
        readVector(positions, firstCell),
        readVector(positions, secondCell),
      );
      halfToEdge[halfEdgeIndex] = halfToEdge[half[halfEdgeIndex]] = edgeIndex++;
    }
  }

  for (let halfEdgeIndex = 0; halfEdgeIndex < triangles.length; halfEdgeIndex++) {
    cornerNeighbors[halfEdgeIndex] = Math.floor(half[halfEdgeIndex] / 3);
    cornerEdges[halfEdgeIndex] = halfToEdge[halfEdgeIndex];
  }

  const offsets = new Uint32Array(count + 1);
  const first = new Int32Array(count).fill(-1);

  for (let halfEdgeIndex = 0; halfEdgeIndex < triangles.length; halfEdgeIndex++) {
    offsets[triangles[halfEdgeIndex] + 1]++;
    first[triangles[halfEdgeIndex]] = halfEdgeIndex;
  }

  for (let cellIndex = 1; cellIndex <= count; cellIndex++) {
    offsets[cellIndex] += offsets[cellIndex - 1];
  }

  const cellCorners = new Uint32Array(triangles.length);
  const neighbors = new Uint32Array(triangles.length);
  const arcEdges = new Uint32Array(triangles.length);
  const areas = new Float64Array(count);

  for (let cellIndex = 0; cellIndex < count; cellIndex++) {
    let halfEdgeIndex = first[cellIndex];
    const cellPosition = readVector(positions, cellIndex);

    for (
      let neighborOffset = offsets[cellIndex];
      neighborOffset < offsets[cellIndex + 1];
      neighborOffset++
    ) {
      cellCorners[neighborOffset] = Math.floor(halfEdgeIndex / 3);
      neighbors[neighborOffset] = triangles[nextHalfEdge(halfEdgeIndex)];
      arcEdges[neighborOffset] = halfToEdge[halfEdgeIndex];
      halfEdgeIndex = half[previousHalfEdge(halfEdgeIndex)];
    }

    if (halfEdgeIndex !== first[cellIndex]) {
      throw Error('Grid cell is not a closed cycle.');
    }

    for (
      let neighborOffset = offsets[cellIndex];
      neighborOffset < offsets[cellIndex + 1];
      neighborOffset++
    ) {
      const firstCornerPosition = readVector(corners, cellCorners[neighborOffset]);
      const secondCornerPosition = readVector(
        corners,
        cellCorners[
          neighborOffset + 1 === offsets[cellIndex + 1] ? offsets[cellIndex] : neighborOffset + 1
        ],
      );
      areas[cellIndex] +=
        2 *
        Math.atan2(
          Math.abs(dot(cellPosition, cross(firstCornerPosition, secondCornerPosition))),
          1 +
            dot(cellPosition, firstCornerPosition) +
            dot(firstCornerPosition, secondCornerPosition) +
            dot(secondCornerPosition, cellPosition),
        );
    }
  }

  const total = areas.reduce((totalArea, cellArea) => totalArea + cellArea, 0);

  if (Math.abs(total - 4 * Math.PI) > 1e-6) {
    throw Error('Grid area does not cover the sphere.');
  }

  return {
    count,
    level,
    positions,
    triangles,
    corners,
    offsets,
    cellCorners,
    neighbors,
    arcEdges,
    areas,
    edgeCells,
    edgeCorners,
    edgeLength,
    edgeDistance,
    edgeNormal,
    cornerNeighbors,
    cornerEdges,
    flips,
  };
}

function legalizeEdges(positions: Float64Array, triangles: Uint32Array, halfEdges: Int32Array) {
  const queue: number[] = [];

  for (let halfEdgeIndex = 0; halfEdgeIndex < halfEdges.length; halfEdgeIndex++) {
    if (halfEdgeIndex < halfEdges[halfEdgeIndex]) {
      queue.push(halfEdgeIndex);
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
    // A fourth point outside the outward hull face violates the spherical empty-circle predicate.
    const tolerance = 1e-12 * Math.hypot(...faceNormal);

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
    flips++;
  }

  return flips;
}

/** On a spherical Delaunay graph, walking toward larger dot products finds the Voronoi cell. */
export function nearestCell(grid: Grid, x: number, y: number, z: number, start = 0): number {
  let cellIndex = start;

  for (;;) {
    let best = cellIndex;
    let score =
      grid.positions[3 * cellIndex] * x +
      grid.positions[3 * cellIndex + 1] * y +
      grid.positions[3 * cellIndex + 2] * z;

    for (
      let neighborOffset = grid.offsets[cellIndex];
      neighborOffset < grid.offsets[cellIndex + 1];
      neighborOffset++
    ) {
      const neighborCell = grid.neighbors[neighborOffset];
      const neighborScore =
        grid.positions[3 * neighborCell] * x +
        grid.positions[3 * neighborCell + 1] * y +
        grid.positions[3 * neighborCell + 2] * z;

      if (neighborScore > score + 1e-15) {
        score = neighborScore;
        best = neighborCell;
      }
    }

    if (best === cellIndex) {
      return cellIndex;
    }

    cellIndex = best;
  }
}
