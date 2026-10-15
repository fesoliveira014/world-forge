import type { Drainage, Ecology, Grid, Rivers, Terrain } from '../model';
import { cross, dot, normalizeVector, readVector, subtractVectors, type Vec3 } from '../math';
import { calculateHeightGradient } from '../operators/spatial';
import { finalizeGrid } from './build';
import { legalizeEdges, pairHalfEdges, type SphericalMesh } from './mesh';

export interface CoarseningOptions {
  radius: number;
  maxRemovedCells: number;
  /** Maximum reconstructed height deviation within a removed site's cavity. */
  heightToleranceMetres: number;
  /** Maximum covering-radius-derived spacing of replacement triangles. */
  maxSpacingMetres: number;
  eligibleCells?: Uint8Array;
  protectedCells?: Uint8Array;
  /** Authoritative, ordered source-cell selections from a saved plan. */
  resolvedRemovedCells?: readonly number[];
}

export interface CoarseningStats {
  candidateCells: number;
  removedCells: number;
  protectedCells: number;
  rejectedGeometry: number;
  rejectedHeight: number;
  rejectedSpacing: number;
}

export interface CoarseningResult {
  grid: Grid;
  sourceCells: Uint32Array;
  removedSourceCells: number[];
  stats: CoarseningStats;
}

/** Keep broad biome interiors eligible while anchoring hydrographic and terrain
 * features. An optional geographic feature mask protects entire lake districts,
 * including the apparently dry ground between their individual water bodies. */
export function prepareQuietLandCoarsening(
  context: {
    grid: Grid;
    terrain: Terrain;
    drainage: Drainage;
    rivers: Rivers;
    ecology: Ecology;
    radius: number;
  },
  districtStrength?: ArrayLike<number>,
): { eligibleCells: Uint8Array; protectedCells: Uint8Array } {
  const { grid, terrain, drainage, rivers, ecology, radius } = context;
  const eligibleCells = new Uint8Array(grid.count);
  let protectedCells = new Uint8Array(grid.count);
  const quietBiomes = new Set([3, 4, 5, 7, 8, 9, 10]);
  const gradient = calculateHeightGradient(grid, terrain.height, radius);
  const protectCorner = (corner: number) => {
    if (corner < 0 || corner * 3 >= grid.triangles.length) {
      return;
    }
    for (let side = 0; side < 3; side++) {
      protectedCells[grid.triangles[corner * 3 + side]] = 1;
    }
  };

  for (let cell = 0; cell < grid.count; cell++) {
    const biome = ecology.biome[cell];
    eligibleCells[cell] = quietBiomes.has(biome) ? 1 : 0;
    if (
      terrain.ocean[cell] ||
      (districtStrength?.[cell] ?? 0) > 0 ||
      drainage.lakeCoverage[cell] > 1e-5 ||
      drainage.seasonalLakeCoverage?.some((season) => season[cell] > 1e-5) ||
      ecology.wetlandFraction[cell] > 0.005 ||
      ecology.floodplainFraction[cell] > 0.005 ||
      terrain.deltaSediment[cell] > 0.1 ||
      Math.hypot(gradient[cell * 3], gradient[cell * 3 + 1], gradient[cell * 3 + 2]) > 0.025
    ) {
      protectedCells[cell] = 1;
    }
    let reliefError = 0;
    let lower = false;
    let higher = false;
    let nearestHeightDifference = Infinity;
    for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
      const neighbor = grid.neighbors[offset];
      if (ecology.biome[neighbor] !== biome) {
        protectedCells[cell] = 1;
      }
      const difference = terrain.height[neighbor] - terrain.height[cell];
      lower ||= difference < 0;
      higher ||= difference > 0;
      nearestHeightDifference = Math.min(nearestHeightDifference, Math.abs(difference));
      let predicted = 0;
      for (let axis = 0; axis < 3; axis++) {
        predicted +=
          gradient[cell * 3 + axis] *
          radius *
          (grid.positions[neighbor * 3 + axis] - grid.positions[cell * 3 + axis]);
      }
      reliefError = Math.max(reliefError, Math.abs(difference - predicted));
    }
    if (reliefError > 60 || ((!lower || !higher) && nearestHeightDifference > 10)) {
      protectedCells[cell] = 1;
    }
  }
  for (let corner = 0; corner < rivers.channel.length; corner++) {
    if (drainage.lakeFraction[corner] > 1e-5) {
      protectCorner(corner);
    }
    if (rivers.channel[corner]) {
      protectCorner(corner);
      protectCorner(drainage.receiver[corner]);
    }
  }
  for (const delta of rivers.deltas) {
    protectCorner(delta.corner);
  }
  for (const lake of drainage.lakes) {
    protectCorner(lake.outlet);
  }
  for (const oxbow of terrain.oxbows) {
    protectedCells[oxbow.cell] = 1;
  }
  // Retaining every immediate neighbor preserves a feature site's complete
  // incident triangle star. No deletion cavity can then touch that feature.
  const expanded = protectedCells.slice();
  for (let cell = 0; cell < grid.count; cell++) {
    if (!protectedCells[cell]) {
      continue;
    }
    for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
      expanded[grid.neighbors[offset]] = 1;
    }
  }
  protectedCells = expanded;
  return { eligibleCells, protectedCells };
}

type Triangle = [number, number, number];

function orientedArea(a: Vec3, b: Vec3, c: Vec3, normal: Vec3) {
  return dot(cross(subtractVectors(b, a), subtractVectors(c, a)), normal);
}

function triangleWeights(position: Vec3, triangle: Triangle, positions: Float64Array) {
  const weights = triangle.map((_, index) => {
    const first = subtractVectors(readVector(positions, triangle[(index + 1) % 3]), position);
    const second = subtractVectors(readVector(positions, triangle[(index + 2) % 3]), position);
    return dot(position, cross(first, second));
  });
  const sum = weights[0] + weights[1] + weights[2];
  if (!(sum > 0) || Math.min(...weights) < -1e-10 * sum) {
    return null;
  }
  return weights.map((weight) => Math.max(0, weight) / sum);
}

function sampleTriangles(
  position: Vec3,
  triangles: Triangle[],
  positions: Float64Array,
  height: ArrayLike<number>,
) {
  for (const triangle of triangles) {
    const weights = triangleWeights(position, triangle, positions);
    if (weights) {
      return weights.reduce((value, weight, side) => value + weight * height[triangle[side]], 0);
    }
  }
  return NaN;
}

/** Delete an independent site by triangulating only its polygonal cavity. Ear
 * clipping handles concave stars; internal edge flips restore spherical Delaunay. */
function triangulateCavity(grid: Grid, cell: number): Triangle[] | null {
  const center = readVector(grid.positions, cell);
  const boundary = Array.from(grid.neighbors.subarray(grid.offsets[cell], grid.offsets[cell + 1]));
  if (boundary.length < 3 || boundary.length > 32) {
    return null;
  }
  const at = (vertex: number) => readVector(grid.positions, vertex);
  let signed = 0;
  for (let index = 0; index < boundary.length; index++) {
    signed += orientedArea(
      center,
      at(boundary[index]),
      at(boundary[(index + 1) % boundary.length]),
      center,
    );
  }
  if (signed < 0) {
    boundary.reverse();
  }
  const polygon = [...boundary];
  const triangles: Triangle[] = [];
  while (polygon.length > 3) {
    let removed = false;
    for (let index = 0; index < polygon.length; index++) {
      const triangle: Triangle = [
        polygon[(index + polygon.length - 1) % polygon.length],
        polygon[index],
        polygon[(index + 1) % polygon.length],
      ];
      if (orientedArea(at(triangle[0]), at(triangle[1]), at(triangle[2]), center) <= 1e-18) {
        continue;
      }
      if (
        polygon.some(
          (vertex) =>
            !triangle.includes(vertex) && triangleWeights(at(vertex), triangle, grid.positions),
        )
      ) {
        continue;
      }
      triangles.push(triangle);
      polygon.splice(index, 1);
      removed = true;
      break;
    }
    if (!removed) {
      return null;
    }
  }
  triangles.push(polygon as Triangle);
  for (let iteration = 0; iteration < boundary.length ** 2 * 4; iteration++) {
    let changed = false;
    for (let first = 0; first < triangles.length && !changed; first++) {
      for (let second = first + 1; second < triangles.length && !changed; second++) {
        const a = triangles[first];
        const b = triangles[second];
        for (let side = 0; side < 3; side++) {
          const u = a[side];
          const v = a[(side + 1) % 3];
          const w = a[(side + 2) % 3];
          const twin = b.findIndex((vertex, index) => vertex === v && b[(index + 1) % 3] === u);
          if (twin < 0) {
            continue;
          }
          const other = b[(twin + 2) % 3];
          const normal = cross(subtractVectors(at(v), at(u)), subtractVectors(at(w), at(u)));
          if (dot(normal, subtractVectors(at(other), at(u))) <= 1e-14 * Math.hypot(...normal)) {
            continue;
          }
          triangles[first] = [w, other, v];
          triangles[second] = [other, w, u];
          changed = true;
          break;
        }
      }
    }
    if (!changed) {
      return triangles;
    }
  }
  return null;
}

/** Sample the overlay of the old star and replacement triangulation: its vertices
 * and every crossed spoke. On these tiny spherical patches this bounds the
 * change much more reliably than checking just the removed site's elevation. */
function cavityHeightError(
  grid: Grid,
  cell: number,
  triangles: Triangle[],
  height: ArrayLike<number>,
) {
  const center = readVector(grid.positions, cell);
  const original: Triangle[] = Array.from(
    grid.cellCorners.subarray(grid.offsets[cell], grid.offsets[cell + 1]),
    (corner) => [
      grid.triangles[corner * 3],
      grid.triangles[corner * 3 + 1],
      grid.triangles[corner * 3 + 2],
    ],
  );
  const samples: Vec3[] = [center];
  for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
    const neighbor = readVector(grid.positions, grid.neighbors[offset]);
    samples.push(
      normalizeVector([center[0] + neighbor[0], center[1] + neighbor[1], center[2] + neighbor[2]]),
    );
    const spoke = cross(center, neighbor);
    const span = dot(center, neighbor);
    for (const triangle of triangles) {
      for (let side = 0; side < 3; side++) {
        const first = readVector(grid.positions, triangle[side]);
        const second = readVector(grid.positions, triangle[(side + 1) % 3]);
        let intersection = cross(spoke, cross(first, second));
        if (Math.hypot(...intersection) < 1e-20) {
          continue;
        }
        intersection = normalizeVector(intersection);
        if (dot(intersection, center) < 0) {
          intersection = [-intersection[0], -intersection[1], -intersection[2]];
        }
        if (
          dot(center, intersection) < span - 1e-12 ||
          dot(neighbor, intersection) < span - 1e-12
        ) {
          continue;
        }
        const edgeSpan = dot(first, second);
        if (
          dot(first, intersection) < edgeSpan - 1e-12 ||
          dot(second, intersection) < edgeSpan - 1e-12
        ) {
          continue;
        }
        samples.push(intersection);
      }
    }
  }
  let error = 0;
  for (const sample of samples) {
    const before = sampleTriangles(sample, original, grid.positions, height);
    const after = sampleTriangles(sample, triangles, grid.positions, height);
    if (!Number.isFinite(before) || !Number.isFinite(after)) {
      return Infinity;
    }
    error = Math.max(error, Math.abs(before - after));
  }
  return error;
}

/** Deterministic bounded surface simplification. Every retained site is an exact
 * geographic anchor; only nonadjacent candidate cavities are retriangulated.
 * Physical fields must subsequently be transferred with remapTerrain. */
export function coarsenGrid(
  grid: Grid,
  height: ArrayLike<number>,
  options: CoarseningOptions,
): CoarseningResult {
  const { radius, maxRemovedCells, heightToleranceMetres, maxSpacingMetres } = options;
  if (
    !Number.isFinite(radius) ||
    radius <= 0 ||
    !Number.isFinite(heightToleranceMetres) ||
    heightToleranceMetres < 0 ||
    !Number.isFinite(maxSpacingMetres) ||
    maxSpacingMetres <= 0
  ) {
    throw Error(
      'Coarsening requires positive finite radius/spacing and nonnegative height tolerance.',
    );
  }
  if (!Number.isSafeInteger(maxRemovedCells) || maxRemovedCells < 0) {
    throw Error('The coarsening cell budget must be a nonnegative safe integer.');
  }
  if (
    height.length !== grid.count ||
    (options.eligibleCells && options.eligibleCells.length !== grid.count) ||
    (options.protectedCells && options.protectedCells.length !== grid.count)
  ) {
    throw Error('Coarsening fields must match the source grid.');
  }
  const stats: CoarseningStats = {
    candidateCells: 0,
    removedCells: 0,
    protectedCells: 0,
    rejectedGeometry: 0,
    rejectedHeight: 0,
    rejectedSpacing: 0,
  };
  const identity = () => Uint32Array.from({ length: grid.count }, (_, cell) => cell);
  const noOp = (): CoarseningResult => ({
    grid,
    sourceCells: identity(),
    removedSourceCells: [],
    stats,
  });
  if (
    options.resolvedRemovedCells &&
    (options.resolvedRemovedCells.length > maxRemovedCells ||
      new Set(options.resolvedRemovedCells).size !== options.resolvedRemovedCells.length)
  ) {
    throw Error('Saved coarsening selections exceed their budget or contain duplicates.');
  }
  if (!maxRemovedCells && !options.resolvedRemovedCells?.length) {
    return noOp();
  }
  const replay = options.resolvedRemovedCells !== undefined;
  const sourceCount = options.resolvedRemovedCells?.length ?? grid.count;
  // Keep only compact ranks and scalar errors while evaluating the whole world.
  // Retaining every candidate's nested cavity geometry would make a one-cell
  // removal budget consume memory proportional to all candidate triangles.
  const candidateCells = new Uint32Array(sourceCount);
  const candidateErrors = new Float64Array(grid.count);
  let candidateCount = 0;
  for (let source = 0; source < sourceCount; source++) {
    const cell = replay ? options.resolvedRemovedCells![source] : source;
    if (!Number.isSafeInteger(cell) || cell < 0 || cell >= grid.count) {
      throw Error('Saved coarsening selection is outside its source grid.');
    }
    if (options.protectedCells?.[cell] || (options.eligibleCells && !options.eligibleCells[cell])) {
      stats.protectedCells++;
      if (replay) {
        throw Error('Saved coarsening selection touches a protected feature.');
      }
      continue;
    }
    stats.candidateCells++;
    const triangles = triangulateCavity(grid, cell);
    if (!triangles) {
      stats.rejectedGeometry++;
      if (replay) {
        throw Error('Saved coarsening selection has invalid cavity geometry.');
      }
      continue;
    }
    let spacing = 0;
    for (const triangle of triangles) {
      const a = readVector(grid.positions, triangle[0]);
      const center = normalizeVector(
        cross(
          subtractVectors(readVector(grid.positions, triangle[1]), a),
          subtractVectors(readVector(grid.positions, triangle[2]), a),
        ),
      );
      spacing = Math.max(
        spacing,
        Math.atan2(Math.hypot(...cross(a, center)), dot(a, center)) * radius * Math.sqrt(3),
      );
    }
    if (spacing > maxSpacingMetres * (1 + 1e-10)) {
      stats.rejectedSpacing++;
      if (replay) {
        throw Error('Saved coarsening selection exceeds its spacing limit.');
      }
      continue;
    }
    const error = cavityHeightError(grid, cell, triangles, height);
    if (!Number.isFinite(error) || error > heightToleranceMetres + 1e-6) {
      stats.rejectedHeight++;
      if (replay) {
        throw Error('Saved coarsening selection exceeds its height tolerance.');
      }
      continue;
    }
    candidateCells[candidateCount++] = cell;
    candidateErrors[cell] = error;
  }
  const candidates = candidateCells.subarray(0, candidateCount);
  if (!replay) {
    candidates.sort(
      (first, second) => candidateErrors[first] - candidateErrors[second] || first - second,
    );
  }
  const blocked = new Uint8Array(grid.count);
  const removed = new Uint8Array(grid.count);
  const replacement: Triangle[] = [];
  const removedSourceCells: number[] = [];
  for (const cell of candidates) {
    if (
      removedSourceCells.length >= maxRemovedCells ||
      grid.count - removedSourceCells.length <= 12
    ) {
      break;
    }
    if (blocked[cell]) {
      if (replay) {
        throw Error('Saved coarsening selections contain intersecting cavities.');
      }
      continue;
    }
    // Geometry is deterministic on the unchanged source. Recompute only the
    // accepted, nonadjacent cavities, whose retained storage is budget-bounded.
    const cavity = triangulateCavity(grid, cell);
    if (!cavity) {
      throw Error('A validated coarsening cavity could not be reconstructed.');
    }
    removed[cell] = blocked[cell] = 1;
    for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
      blocked[grid.neighbors[offset]] = 1;
    }
    removedSourceCells.push(cell);
    replacement.push(...cavity);
  }
  if (replay && removedSourceCells.length !== options.resolvedRemovedCells!.length) {
    throw Error('Saved coarsening selections could not be fully applied.');
  }
  if (!removedSourceCells.length) {
    return noOp();
  }
  const count = grid.count - removedSourceCells.length;
  const sourceCells = new Uint32Array(count);
  const oldToNew = new Uint32Array(grid.count);
  const positions = new Float64Array(count * 3);
  let next = 0;
  for (let cell = 0; cell < grid.count; cell++) {
    if (removed[cell]) {
      continue;
    }
    sourceCells[next] = cell;
    oldToNew[cell] = next;
    positions.set(grid.positions.subarray(cell * 3, cell * 3 + 3), next++ * 3);
  }
  const triangles = new Uint32Array((2 * count - 4) * 3);
  next = 0;
  for (let face = 0; face < grid.triangles.length; face += 3) {
    const a = grid.triangles[face];
    const b = grid.triangles[face + 1];
    const c = grid.triangles[face + 2];
    if (removed[a] || removed[b] || removed[c]) {
      continue;
    }
    triangles.set([oldToNew[a], oldToNew[b], oldToNew[c]], next);
    next += 3;
  }
  for (const triangle of replacement) {
    triangles.set(
      triangle.map((cell) => oldToNew[cell]),
      next,
    );
    next += 3;
  }
  if (next !== triangles.length) {
    throw Error('Coarsening cavities did not preserve a closed spherical mesh.');
  }
  const mesh: SphericalMesh = {
    count,
    level: grid.level,
    positions,
    triangles,
    halfEdges: pairHalfEdges(triangles),
    triangleCount: triangles.length / 3,
    flips: grid.flips,
    insertedCount: 1,
  };
  mesh.flips += legalizeEdges(mesh);
  const coarsened = finalizeGrid(mesh);
  // Compaction creates a new organizational baseline. Geographic anchors survive
  // exactly; old integer cell IDs cannot describe the new compacted index space.
  coarsened.refinement = {
    baseCount: count,
    insertedCount: 0,
    passes: (grid.refinement?.passes ?? 0) + 1,
    sourceCell: Uint32Array.from({ length: count }, (_, cell) => cell),
  };
  stats.removedCells = removedSourceCells.length;
  return { grid: coarsened, sourceCells, removedSourceCells, stats };
}
