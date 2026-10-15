import {
  VERSION,
  type Grid,
  type Progress,
  type RegionalRefinementRequest,
  type ResolvedRegionalRefinement,
  type World,
} from './model';
import { normalizeVector } from './math';
import { createGradedSpacingField } from './grid/graded-spacing';
import { refineGrid, type SpacingField } from './grid/refine';
import { refinementGeometryHash } from './grid/refinement-plan';
import {
  normalizedRefinementConfigSignature,
  refinementConfigSignature,
} from './grid/refinement-config';
import {
  estimateRegionalRefinementWork,
  type RefinementWorkEstimate,
} from './grid/refinement-work';
import { buildTransfer, restrictSurface } from './operators/spatial';
import { buildOverlapTransfer } from './operators/transfer';
import { remapTerrain } from './operators/remap';
import { solveSalinity } from './generation/salinity';
import { applySalineRiverExposure } from './generation/floodplains';
import { solveLandWater } from './generation/land-water';
import { routeWater } from './generation/drainage';
import { selectRivers } from './generation/rivers';
import { buildRiverCourses } from './generation/river-courses';
import { buildDeltas } from './generation/deltas';
import { classifyEcology } from './generation/ecology';
import { buildFertility } from './generation/fertility';
import { collectWorldBuffers } from './pipeline';

export interface RegionalRefinementPlan {
  resolved: ResolvedRegionalRefinement;
  spacingAt: SpacingField;
  estimate: RefinementWorkEstimate;
}

export interface RegionalRefinementOptions {
  progress?: Progress;
}

function direction(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every(Number.isFinite) &&
    Number.isFinite(Math.hypot(...value)) &&
    Math.hypot(...value) > 0
  );
}

function validateRequest(
  value: unknown,
  planetRadius: number,
  cornerCount?: number,
): RegionalRefinementRequest {
  const request = value as RegionalRefinementRequest | null;
  if (
    !request ||
    !Number.isFinite(request.targetSpacingMetres) ||
    request.targetSpacingMetres <= 0
  ) {
    throw Error('Regional target spacing must be finite and positive.');
  }
  // This is the same angular precision bound enforced by spherical insertion,
  // not a quality or workload limit. Never silently raise a requested spacing.
  if (request.targetSpacingMetres / planetRadius < Math.sqrt(3) * 1e-8) {
    throw Error('Regional target spacing is below the spherical mesh numerical precision.');
  }
  if (request.kind === 'region') {
    if (
      !direction(request.center) ||
      !Number.isFinite(request.radiusMetres) ||
      request.radiusMetres < 0 ||
      request.radiusMetres > Math.PI * planetRadius
    ) {
      throw Error(
        'A spherical region needs a direction and radius between zero and π planet radii.',
      );
    }
    return { ...request, center: normalizeVector(request.center) };
  }
  if (
    request.kind !== 'watershed' ||
    !Number.isSafeInteger(request.corner) ||
    request.corner < 0 ||
    (cornerCount !== undefined && request.corner >= cornerCount)
  ) {
    throw Error('Choose a watershed corner on the current world.');
  }
  return { ...request };
}

/** Validate saved sparse footprints without constructing a globe or reselecting flow. */
export function validateResolvedRegionalRefinement(value: unknown): ResolvedRegionalRefinement {
  const plan = value as ResolvedRegionalRefinement | null;
  if (
    !plan ||
    plan.format !== 'atlas-regional-refinement/v1' ||
    typeof plan.sourceGeometryHash !== 'string' ||
    typeof plan.configSignature !== 'string' ||
    !Number.isSafeInteger(plan.sourceCellCount) ||
    plan.sourceCellCount < 4 ||
    !Number.isFinite(plan.planetRadiusMetres) ||
    plan.planetRadiusMetres <= 0 ||
    !Number.isFinite(plan.baseSpacingMetres) ||
    plan.baseSpacingMetres <= 0 ||
    !Number.isFinite(plan.gradation) ||
    plan.gradation <= 0 ||
    plan.gradation > 0.5 ||
    !Array.isArray(plan.caps) ||
    plan.caps.length === 0 ||
    !plan.caps.every(
      (cap) =>
        cap &&
        direction(cap.center) &&
        Math.abs(Math.hypot(...cap.center) - 1) < 1e-9 &&
        Number.isFinite(cap.radiusMetres) &&
        cap.radiusMetres >= 0 &&
        cap.radiusMetres <= Math.PI * plan.planetRadiusMetres,
    )
  ) {
    throw Error('Saved regional refinement contains invalid geometry or physical spacing.');
  }
  validateRequest(plan.request, plan.planetRadiusMetres, plan.sourceCellCount * 2 - 4);
  return plan;
}

function angularDistance(
  first: Float64Array,
  firstIndex: number,
  second: Float64Array,
  secondIndex: number,
): number {
  const firstX = first[firstIndex * 3];
  const firstY = first[firstIndex * 3 + 1];
  const firstZ = first[firstIndex * 3 + 2];
  const secondX = second[secondIndex * 3];
  const secondY = second[secondIndex * 3 + 1];
  const secondZ = second[secondIndex * 3 + 2];
  return Math.atan2(
    Math.hypot(
      firstY * secondZ - firstZ * secondY,
      firstZ * secondX - firstX * secondZ,
      firstX * secondY - firstY * secondX,
    ),
    firstX * secondX + firstY * secondY + firstZ * secondZ,
  );
}

function maximumSpacing(grid: Grid, radius: number): number {
  let maximum = 0;
  for (let corner = 0; corner < grid.corners.length / 3; corner++) {
    maximum = Math.max(
      maximum,
      angularDistance(grid.positions, grid.triangles[corner * 3], grid.corners, corner),
    );
  }
  // Existing sites already satisfy this background. Only the selected footprint
  // and its physical transition halo request insertion elsewhere.
  return maximum * Math.sqrt(3) * radius * (1 + 1e-9);
}

function spacingField(plan: ResolvedRegionalRefinement): SpacingField {
  const positions = new Float64Array(plan.caps.length * 3);
  const radii = new Float64Array(plan.caps.length);
  for (let index = 0; index < plan.caps.length; index++) {
    positions.set(plan.caps[index].center, index * 3);
    radii[index] = plan.caps[index].radiusMetres;
  }
  return createGradedSpacingField(
    { count: plan.caps.length, positions },
    new Float64Array(plan.caps.length).fill(plan.request.targetSpacingMetres),
    plan.planetRadiusMetres,
    plan.baseSpacingMetres,
    plan.gradation,
    radii,
  );
}

/** Resolve a user selection before changing any topology. The sparse footprint
 * is saved, so subsequent watershed changes cannot move a replayed operation.
 */
export function planRegionalRefinement(
  world: World,
  value: RegionalRefinementRequest,
): RegionalRefinementPlan {
  const { grid, config } = world;
  const request = validateRequest(value, config.radius, grid.corners.length / 3);
  const caps: ResolvedRegionalRefinement['caps'] = [];
  if (request.kind === 'region') {
    caps.push({ center: [...request.center], radiusMetres: request.radiusMetres });
  } else {
    const system = world.rivers.system[request.corner];
    const selected = new Uint8Array(grid.count);
    for (let corner = 0; corner < world.rivers.system.length; corner++) {
      if (world.rivers.system[corner] !== system) {
        continue;
      }
      for (let incident = 0; incident < 3; incident++) {
        const cell = grid.triangles[corner * 3 + incident];
        if (!world.terrain.ocean[cell]) {
          selected[cell] = 1;
        }
      }
    }
    for (let cell = 0; cell < grid.count; cell++) {
      if (!selected[cell]) {
        continue;
      }
      let radius = 0;
      for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
        radius = Math.max(
          radius,
          angularDistance(grid.positions, cell, grid.corners, grid.cellCorners[offset]),
        );
      }
      caps.push({
        center: [
          grid.positions[cell * 3],
          grid.positions[cell * 3 + 1],
          grid.positions[cell * 3 + 2],
        ],
        radiusMetres: radius * config.radius,
      });
    }
    if (!caps.length) {
      throw Error('The selected corner has no land watershed to refine.');
    }
  }
  const resolved: ResolvedRegionalRefinement = {
    format: 'atlas-regional-refinement/v1',
    sourceGeometryHash: refinementGeometryHash(grid),
    sourceCellCount: grid.count,
    configSignature: refinementConfigSignature(world.config),
    planetRadiusMetres: config.radius,
    baseSpacingMetres: maximumSpacing(grid, config.radius),
    gradation: 0.35,
    request,
    caps,
  };
  const estimate = estimateRegionalRefinementWork(grid, resolved);
  // The caller can retain the displayed source for failure/cancel rollback.
  // Account for that snapshot explicitly; the estimate is never a quality cap.
  estimate.estimatedPeakMiB += world.bytes / 1048576;
  return { resolved, spacingAt: spacingField(resolved), estimate };
}

function needsInsertion(grid: Grid, spacingAt: SpacingField, radius: number): boolean {
  for (let corner = 0; corner < grid.corners.length / 3; corner++) {
    const required =
      angularDistance(grid.positions, grid.triangles[corner * 3], grid.corners, corner) *
      radius *
      Math.sqrt(3);
    if (
      required >
      spacingAt(
        grid.corners[corner * 3],
        grid.corners[corner * 3 + 1],
        grid.corners[corner * 3 + 2],
      ) *
        (1 + 1e-10)
    ) {
      return true;
    }
  }
  return false;
}

function applyRegionalRefinement(
  world: World,
  value: ResolvedRegionalRefinement,
  options: RegionalRefinementOptions,
): World {
  const plan = validateResolvedRegionalRefinement(value);
  if (
    plan.sourceCellCount !== world.grid.count ||
    plan.sourceGeometryHash !== refinementGeometryHash(world.grid) ||
    plan.planetRadiusMetres !== world.config.radius ||
    normalizedRefinementConfigSignature(plan.configSignature) !==
      refinementConfigSignature(world.config)
  ) {
    throw Error('Saved regional refinement does not match this world and mesh.');
  }
  const progress = options.progress ?? (() => {});
  const spacingAt = spacingField(plan);
  if (!needsInsertion(world.grid, spacingAt, world.config.radius)) {
    progress('Region already resolves the requested spacing', 1, 1);
    return world;
  }
  const started = performance.now();
  const timings: World['timings'] = [];
  const total = 8;
  let completed = 0;
  const run = <T>(name: string, action: () => T): T => {
    progress(name, completed, total);
    const stageStarted = performance.now();
    const result = action();
    timings.push({ name, ms: performance.now() - stageStarted });
    progress(name, ++completed, total);
    return result;
  };
  const climateReferenceHeight = run('Retain climate forcing', () => {
    if (world.climateReferenceHeight) {
      return world.climateReferenceHeight;
    }
    const sourceOverlap = world.grid.refinement
      ? buildOverlapTransfer(world.process, world.grid)
      : undefined;
    return restrictSurface(
      world.grid,
      world.process,
      world.transfer,
      world.terrain.height,
      world.terrain.ocean,
      sourceOverlap,
    ).height;
  });
  const grid = run('Refine selected geography', () =>
    refineGrid(world.grid, world.config.radius, world.config.seed, spacingAt),
  );
  const terrain = run('Preserve evolved terrain', () =>
    remapTerrain(world.grid, grid, world.terrain, world.config),
  );
  const { transfer, overlap } = run('Rebuild regional spatial transfers', () => ({
    transfer: buildTransfer(world.process, grid),
    overlap: buildOverlapTransfer(world.process, grid),
  }));
  const { water, drainage } = run('Rebuild water and drainage', () => {
    const water = solveLandWater(
      grid,
      world.process,
      transfer,
      world.climate,
      terrain,
      world.config,
      climateReferenceHeight,
      overlap,
    );
    const drainage = routeWater(grid, terrain, water, world.config);
    // Reclassify the conserved geographic salt inventory against the new lake
    // footprints without introducing weathering, inherited salt or elapsed time.
    // Older snapshots retain unknown salinity until a new world is generated.
    if (terrain.saltMass || terrain.saltParcels) {
      solveSalinity(grid, terrain, water, drainage, world.config, { advanceYears: 0 });
    }
    return { water, drainage };
  });
  const rivers = run('Rebuild channels and courses', () => {
    const rivers = selectRivers(grid, terrain, water, drainage, world.config);
    rivers.courses = buildRiverCourses(grid, terrain, drainage, rivers, world.config);
    rivers.deltas = buildDeltas(grid, terrain, drainage, rivers, world.config, {
      physicalNeighborhood: true,
    });
    applySalineRiverExposure(grid, terrain, drainage, rivers, world.config);
    return rivers;
  });
  const { ecology, resources } = run('Rebuild habitats and fertility', () => {
    const ecology = classifyEcology(grid, terrain, water, drainage, rivers, world.config);
    const fertility = buildFertility({
      grid,
      transfer,
      geology: world.geology,
      terrain,
      water,
      drainage,
      rivers,
      ecology,
      config: world.config,
    });
    return { ecology, resources: { ...world.resources, fertility } };
  });
  const refined: World = {
    ...world,
    version: VERSION,
    grid,
    terrain,
    transfer,
    water,
    drainage,
    rivers,
    ecology,
    resources,
    climateReferenceHeight,
    regionalRefinements: [...(world.regionalRefinements ?? []), structuredClone(plan)],
    timings: [...world.timings, ...timings],
  };
  run('Publish refined world', () => {
    refined.bytes = collectWorldBuffers(refined).reduce(
      (sum, buffer) => sum + buffer.byteLength,
      0,
    );
  });
  refined.timings = [...world.timings, ...timings];
  refined.elapsed = world.elapsed + performance.now() - started;
  return refined;
}

/** Add resolution to the current material state without advancing any physical clock. */
export function refineExistingWorld(
  world: World,
  request: RegionalRefinementRequest,
  options: RegionalRefinementOptions = {},
): World {
  const plan = planRegionalRefinement(world, request);
  return applyRegionalRefinement(world, plan.resolved, options);
}

/** Replay after the base recipe has been generated once. Each operation checks
 * its exact source mesh and uses its saved geographic footprint, including basins.
 */
export function replayRegionalRefinements(
  world: World,
  history: readonly ResolvedRegionalRefinement[] = [],
  options: RegionalRefinementOptions = {},
): World {
  let refined = world;
  for (const plan of history) {
    refined = applyRegionalRefinement(refined, plan, options);
  }
  return refined;
}
