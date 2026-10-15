import type { Drainage, Geology, Grid, Terrain, WorldConfig } from '../model';
import { clamp, type Vec3 } from '../math';
import { calculateHeightGradient } from '../operators/spatial';
import { createGradedSpacingField } from './graded-spacing';
import { computeCornerSupport } from '../operators/corner-fields';
import {
  normalizedRefinementConfigSignature,
  refinementConfigSignature,
} from './refinement-config';

export interface SurfaceRefinementPlan {
  baseSpacing: number;
  targetSpacing: Float64Array;
  spacingAt: (x: number, y: number, z: number) => number;
  resolved: ResolvedRefinementPlan;
}

/** Exact, JSON-safe spacing decisions; geometry is regenerated from the recipe.
 * No terrain, drainage, or full mesh snapshot is retained by a saved plan.
 */
export interface ResolvedRefinementPlan {
  format: 'atlas-refinement-plan/v1';
  geometryHash: string;
  configSignature: string;
  cellCount: number;
  radiusMetres: number;
  baseSpacingMetres: number;
  gradation: number;
  targetSpacingMetres: number[];
  sourceRadiiMetres: number[];
  volcanicCaps: {
    position: Vec3;
    radiusMetres: number;
    targetSpacingMetres: number;
  }[];
}

/** Two independent 32-bit byte hashes detect accidentally mismatched seed meshes.
 * This is a reproducibility identifier, not a security/authentication checksum.
 */
export function refinementGeometryHash(grid: Grid): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const field of [grid.positions, grid.triangles]) {
    const bytes = new Uint8Array(field.buffer, field.byteOffset, field.byteLength);
    for (const byte of bytes) {
      first = Math.imul(first ^ byte, 0x01000193);
      second = Math.imul(second ^ byte, 0x85ebca6b);
    }
  }
  return `${grid.count}:${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

/** Validate JSON shape before a recipe is accepted, without allocating its mesh. */
export function validateResolvedRefinementPlan(value: unknown): ResolvedRefinementPlan {
  const resolved = value as ResolvedRefinementPlan | null;
  const positive = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0;
  if (
    !resolved ||
    resolved.format !== 'atlas-refinement-plan/v1' ||
    !Number.isSafeInteger(resolved.cellCount) ||
    resolved.cellCount <= 0 ||
    typeof resolved.geometryHash !== 'string' ||
    typeof resolved.configSignature !== 'string' ||
    !positive(resolved.radiusMetres) ||
    !positive(resolved.baseSpacingMetres) ||
    !positive(resolved.gradation) ||
    resolved.gradation > 0.5 ||
    !Array.isArray(resolved.targetSpacingMetres) ||
    resolved.targetSpacingMetres.length !== resolved.cellCount ||
    !resolved.targetSpacingMetres.every(
      (value) => positive(value) && value <= resolved.baseSpacingMetres,
    ) ||
    !Array.isArray(resolved.sourceRadiiMetres) ||
    resolved.sourceRadiiMetres.length !== resolved.cellCount ||
    !resolved.sourceRadiiMetres.every(
      (value) => Number.isFinite(value) && value >= 0 && value <= Math.PI * resolved.radiusMetres,
    ) ||
    !Array.isArray(resolved.volcanicCaps) ||
    !resolved.volcanicCaps.every(
      (cap) =>
        cap &&
        Array.isArray(cap.position) &&
        cap.position.length === 3 &&
        cap.position.every(Number.isFinite) &&
        Math.abs(Math.hypot(...cap.position) - 1) < 1e-9 &&
        Number.isFinite(cap.radiusMetres) &&
        cap.radiusMetres >= 0 &&
        cap.radiusMetres <= Math.PI * resolved.radiusMetres &&
        positive(cap.targetSpacingMetres) &&
        cap.targetSpacingMetres <= resolved.baseSpacingMetres,
    )
  ) {
    throw Error('Saved refinement plan contains invalid physical spacing values.');
  }
  return resolved;
}

/** Reject stale or malformed plans instead of silently selecting different detail. */
export function replaySurfaceRefinement(
  grid: Grid,
  config: WorldConfig,
  value: ResolvedRefinementPlan,
): SurfaceRefinementPlan {
  const resolved = validateResolvedRefinementPlan(value);
  if (
    resolved.cellCount !== grid.count ||
    resolved.geometryHash !== refinementGeometryHash(grid) ||
    resolved.radiusMetres !== config.radius ||
    normalizedRefinementConfigSignature(resolved.configSignature) !==
      refinementConfigSignature(config)
  ) {
    throw Error('Saved refinement plan does not match this recipe and mesh. Regenerate the plan.');
  }
  const targetSpacing = Float64Array.from(resolved.targetSpacingMetres);
  const sampleSpacing = createGradedSpacingField(
    grid,
    targetSpacing,
    config.radius,
    resolved.baseSpacingMetres,
    resolved.gradation,
    Float64Array.from(resolved.sourceRadiiMetres),
  );
  const capPositions = new Float64Array(resolved.volcanicCaps.length * 3);
  const capTargets = new Float64Array(resolved.volcanicCaps.length);
  const capRadii = new Float64Array(resolved.volcanicCaps.length);
  for (let index = 0; index < resolved.volcanicCaps.length; index++) {
    const cap = resolved.volcanicCaps[index];
    capPositions.set(cap.position, index * 3);
    capTargets[index] = cap.targetSpacingMetres;
    capRadii[index] = cap.radiusMetres;
  }
  const volcanicSpacing = createGradedSpacingField(
    { count: resolved.volcanicCaps.length, positions: capPositions },
    capTargets,
    config.radius,
    resolved.baseSpacingMetres,
    resolved.gradation,
    capRadii,
  );
  return {
    baseSpacing: resolved.baseSpacingMetres,
    targetSpacing,
    resolved,
    spacingAt: (x, y, z) => Math.min(sampleSpacing(x, y, z), volcanicSpacing(x, y, z)),
  };
}

/** Resolve geography into a deterministic spacing field before inserting any sites.
 * The pilot owns no evolved landscape state. The returned closure retains only its
 * geometry and spacing, so its water and drainage arrays can be released immediately.
 */
export function planSurfaceRefinement(
  grid: Grid,
  terrain: Terrain,
  drainage: Drainage,
  geology: Geology,
  surfaceToProcess: Uint32Array,
  config: WorldConfig,
): SurfaceRefinementPlan {
  let baseSpacing = 0;
  const sourceRadii = new Float64Array(grid.count);
  for (let corner = 0; corner < grid.triangles.length / 3; corner++) {
    const cell = grid.triangles[corner * 3];
    let cosine = 0;
    for (let axis = 0; axis < 3; axis++) {
      cosine += grid.corners[corner * 3 + axis] * grid.positions[cell * 3 + axis];
    }
    const circumradius = Math.acos(clamp(cosine, -1, 1)) * config.radius;
    baseSpacing = Math.max(baseSpacing, circumradius * Math.sqrt(3));
    for (let incident = 0; incident < 3; incident++) {
      const incidentCell = grid.triangles[corner * 3 + incident];
      sourceRadii[incidentCell] = Math.max(sourceRadii[incidentCell], circumradius);
    }
  }
  // A background triangle exactly at the seed's worst radius does not request work.
  baseSpacing *= 1 + 1e-9;
  const minimum = Math.min(baseSpacing, config.refinementMinSpacing);
  const importance = new Float64Array(grid.count);
  const gradient = calculateHeightGradient(grid, terrain.height, config.radius);

  for (let cell = 0; cell < grid.count; cell++) {
    let reconstructionError = 0;
    for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
      const neighbor = grid.neighbors[offset];
      if (terrain.ocean[cell] !== terrain.ocean[neighbor]) {
        importance[cell] = 1;
      }
      let predictedDifference = 0;
      for (let axis = 0; axis < 3; axis++) {
        predictedDifference +=
          gradient[cell * 3 + axis] *
          (grid.positions[neighbor * 3 + axis] - grid.positions[cell * 3 + axis]) *
          config.radius;
      }
      reconstructionError = Math.max(
        reconstructionError,
        Math.abs(terrain.height[neighbor] - terrain.height[cell] - predictedDifference),
      );
    }
    if (!terrain.ocean[cell]) {
      // Curvature and under-resolved relief request detail even on gentle lowlands.
      importance[cell] = Math.max(importance[cell], clamp((reconstructionError - 40) / 350));
    }
    const processCell = surfaceToProcess[cell];
    if (config.volcanicActivity > 0 && config.tectonicDuration > 0) {
      importance[cell] = Math.max(
        importance[cell],
        clamp((geology.crust?.volcanic[processCell] ?? 0) / 1500),
      );
    }
  }

  const support = computeCornerSupport(grid);
  const catchmentArea = new Float64Array(drainage.height.length);
  for (let corner = 0; corner < catchmentArea.length; corner++) {
    for (let incident = 0; incident < 3; incident++) {
      const cell = grid.triangles[corner * 3 + incident];
      if (!terrain.ocean[cell]) {
        catchmentArea[corner] += support.cornerCellArea[corner * 3 + incident] * config.radius ** 2;
      }
    }
  }
  // Shoreline routing can replace flood parents with dry-floor channels whose
  // receivers occur later in the original flood order. Accumulate the final
  // receiver graph so those tributaries reach downstream refinement decisions.
  const incoming = new Uint8Array(catchmentArea.length);
  const order = new Uint32Array(catchmentArea.length);
  for (const receiver of drainage.receiver) {
    if (receiver >= 0) {
      incoming[receiver]++;
    }
  }
  let head = 0;
  let tail = 0;
  for (let corner = 0; corner < incoming.length; corner++) {
    if (incoming[corner] === 0) {
      order[tail++] = corner;
    }
  }
  while (head < tail) {
    const corner = order[head++];
    const receiver = drainage.receiver[corner];
    if (receiver >= 0) {
      catchmentArea[receiver] += catchmentArea[corner];
      if (--incoming[receiver] === 0) {
        order[tail++] = receiver;
      }
    }
  }
  if (tail !== catchmentArea.length) {
    throw Error('Surface refinement requires acyclic drainage receivers.');
  }
  for (let corner = 0; corner < drainage.height.length; corner++) {
    const river =
      drainage.discharge[corner] >= config.riverSourceFlow &&
      catchmentArea[corner] >= config.riverSourceArea * 1e6 &&
      drainage.receiver[corner] >= 0;
    if (river) {
      for (let incident = 0; incident < 3; incident++) {
        const cell = grid.triangles[corner * 3 + incident];
        if (!terrain.ocean[cell]) {
          importance[cell] = 1;
        }
      }
    }
  }
  // Low outlets matter even when they fail a slope or river-discharge threshold.
  for (const lake of drainage.lakes) {
    if (lake.outlet < 0) {
      continue;
    }
    for (let incident = 0; incident < 3; incident++) {
      importance[grid.triangles[lake.outlet * 3 + incident]] = 1;
    }
  }

  const targetSpacing = Float64Array.from(
    importance,
    (score) => baseSpacing * (minimum / baseSpacing) ** (config.refinementStrength * score),
  );
  // Each selected pilot cell denotes a region. Its enclosing spherical cap keeps
  // that entire footprint at the target; exact geodesic envelopes then grade
  // outward without interpolation artifacts from narrow or irregular triangles.
  const gradation = 0.35;
  // Sparse sources can request detail even if a pilot cell missed a narrow vent.
  const sources =
    config.volcanicActivity > 0 && config.tectonicDuration > 0
      ? [
          ...(geology.hotspots ?? []).filter(
            (source) =>
              source.start <= config.tectonicDuration && source.end >= config.tectonicDuration,
          ),
          ...(geology.crust?.volcanicSources ?? []).filter((source) => source.volume > 0),
        ]
      : [];
  const sourceSpacing = baseSpacing * (minimum / baseSpacing) ** config.refinementStrength;
  return replaySurfaceRefinement(grid, config, {
    format: 'atlas-refinement-plan/v1',
    geometryHash: refinementGeometryHash(grid),
    configSignature: refinementConfigSignature(config),
    cellCount: grid.count,
    radiusMetres: config.radius,
    baseSpacingMetres: baseSpacing,
    gradation,
    targetSpacingMetres: Array.from(targetSpacing),
    sourceRadiiMetres: Array.from(sourceRadii),
    volcanicCaps: sources.map((source) => ({
      position: [...source.position],
      radiusMetres: Math.min(Math.PI * config.radius, source.radius),
      targetSpacingMetres: sourceSpacing,
    })),
  });
}
