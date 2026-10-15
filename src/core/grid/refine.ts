import type { Grid } from '../model';
import { cross, dot, hashSeed, normalizeVector, readVector, type Vec3 } from '../math';
import { finalizeGrid, nearestCell } from './build';
import {
  faceCircumcenter,
  legalizeEdges,
  locateFace,
  mutableMeshFromGrid,
  splitFace,
  type SphericalMesh,
} from './mesh';

/** Physical target spacing in metres at a unit-sphere direction. */
export type SpacingField = (x: number, y: number, z: number) => number;

export interface RefinementOptions {
  /** Maximum sites inserted by this call. A capped result may not meet its spacing target. */
  maxAddedCells?: number;
}

function refinementLimit(planetRadius: number, options: RefinementOptions): number {
  if (!(planetRadius > 0) || !Number.isFinite(planetRadius)) {
    throw Error('Refinement requires a finite, positive planet radius.');
  }

  const limit = options.maxAddedCells;

  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw Error('The refinement cell budget must be a nonnegative safe integer.');
  }

  return limit ?? Infinity;
}

export interface SphericalRefinementRegion {
  center: Vec3;
  radiusMetres: number;
  targetSpacingMetres: number;
}

/** Continuous geodesic targets with a bounded outward spacing gradient. */
export function createRegionSpacing(
  baseSpacingMetres: number,
  planetRadius: number,
  regions: readonly SphericalRefinementRegion[],
  gradient = 0.35,
): SpacingField {
  if (!(baseSpacingMetres > 0) || !Number.isFinite(baseSpacingMetres)) {
    throw Error('Base spacing must be finite and positive.');
  }

  if (!(planetRadius > 0) || !Number.isFinite(planetRadius) || !(gradient > 0 && gradient <= 0.5)) {
    throw Error('Refinement requires a positive planet radius and a spacing gradient in (0, 0.5].');
  }

  const normalizedRegions = regions.map((region) => {
    if (
      !Number.isFinite(region.radiusMetres) ||
      region.radiusMetres < 0 ||
      !Number.isFinite(region.targetSpacingMetres) ||
      region.targetSpacingMetres <= 0 ||
      !region.center.every(Number.isFinite) ||
      Math.hypot(...region.center) === 0
    ) {
      throw Error(
        'A refinement region needs a valid direction, radius, and positive target spacing.',
      );
    }

    return { ...region, center: normalizeVector(region.center) };
  });

  return (x, y, z) => {
    const position: Vec3 = [x, y, z];
    let spacing = baseSpacingMetres;

    for (const region of normalizedRegions) {
      const distance =
        Math.atan2(Math.hypot(...cross(position, region.center)), dot(position, region.center)) *
        planetRadius;
      spacing = Math.min(
        spacing,
        region.targetSpacingMetres + gradient * Math.max(0, distance - region.radiusMetres),
      );
    }

    return spacing;
  };
}

/**
 * Insert spherical Delaunay circumcenters until the local covering-radius target is met.
 * Spacing fields must be continuous, positive, and graded (gradient at most 0.5).
 * Empty circumcircles separate every new site from existing sites by at least its
 * local target / sqrt(3); immutable seed sites may already have smaller separations.
 * An optional insertion budget can stop refinement before that target is reached;
 * each insertion and all its edge legalization finish before the budget is checked.
 */
export function refineMesh(
  mesh: SphericalMesh,
  planetRadius: number,
  seed: string,
  spacingAt: SpacingField,
  options: RefinementOptions = {},
): void {
  const maxAddedCells = refinementLimit(planetRadius, options);
  const originalCount = mesh.count;

  if (maxAddedCells === 0) {
    return;
  }

  const queue: number[] = [];
  let queued = new Uint8Array(mesh.triangles.length / 3);
  const enqueue = (face: number) => {
    if (face >= queued.length) {
      const expanded = new Uint8Array(mesh.triangles.length / 3);
      expanded.set(queued);
      queued = expanded;
    }

    if (!queued[face]) {
      queued[face] = 1;
      queue.push(face);
    }
  };
  const firstFace = hashSeed(seed + '/surface-refinement') % mesh.triangleCount;

  for (let face = 0; face < mesh.triangleCount; face++) {
    enqueue((firstFace + face) % mesh.triangleCount);
  }

  while (queue.length && mesh.count - originalCount < maxAddedCells) {
    const face = queue.pop()!;
    queued[face] = 0;
    const center = faceCircumcenter(mesh, face);
    const firstVertex = readVector(mesh.positions, mesh.triangles[face * 3]);
    const circumradius = Math.atan2(
      Math.hypot(...cross(center, firstVertex)),
      dot(center, firstVertex),
    );
    const spacing = spacingAt(...center);

    if (!(spacing > 0) || !Number.isFinite(spacing)) {
      throw Error('Refinement spacing must be finite and positive at every sampled direction.');
    }

    if (circumradius * planetRadius * Math.sqrt(3) <= spacing * (1 + 1e-10)) {
      continue;
    }

    if (circumradius < 1e-8) {
      throw Error('Requested refinement is below the numerical precision of the spherical mesh.');
    }

    const containingFace = locateFace(mesh, center, face);
    const edges = splitFace(mesh, containingFace, center);

    for (const edge of edges) {
      enqueue(Math.floor(edge / 3));
    }

    mesh.flips += legalizeEdges(mesh, edges, enqueue);
  }
}

/** Refine a private mesh so a shared baseline/process grid remains unchanged. */
export function refineGrid(
  grid: Grid,
  planetRadius: number,
  seed: string,
  spacingAt: SpacingField,
  options: RefinementOptions = {},
): Grid {
  if (refinementLimit(planetRadius, options) === 0) {
    return grid;
  }

  const mesh = mutableMeshFromGrid(grid);
  refineMesh(mesh, planetRadius, seed, spacingAt, options);
  const refined = finalizeGrid(mesh);
  const sourceCell = new Uint32Array(refined.count);
  let previousSource = 0;

  for (let cell = 0; cell < refined.count; cell++) {
    previousSource =
      cell < grid.count
        ? cell
        : nearestCell(
            grid,
            refined.positions[cell * 3],
            refined.positions[cell * 3 + 1],
            refined.positions[cell * 3 + 2],
            previousSource,
          );
    sourceCell[cell] = grid.refinement?.sourceCell[previousSource] ?? previousSource;
  }

  refined.refinement = {
    baseCount: grid.refinement?.baseCount ?? grid.count,
    insertedCount: refined.count - (grid.refinement?.baseCount ?? grid.count),
    passes: (grid.refinement?.passes ?? 0) + 1,
    sourceCell,
  };

  return refined;
}
