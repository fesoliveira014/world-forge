import type { Ecology } from '../model';
import { coarsenGrid, prepareQuietLandCoarsening } from './coarsen';
import { analyzeLakeDistricts } from './feature-districts';
import type { FeatureRefinementContext } from './feature-refinement';
import { refinementGeometryHash } from './refinement-plan';
import {
  normalizedRefinementConfigSignature,
  refinementConfigSignature,
} from './refinement-config';

export interface ResolvedFeatureCoarseningPlan {
  version: 1;
  pass: number;
  sourceCellCount: number;
  sourceGeometrySignature: string;
  configSignature: string;
  removedCells: number[];
}

export interface FeatureCoarseningStats {
  pass: number;
  beforeCells: number;
  afterCells: number;
  removedCells: number;
  candidateCells: number;
  budgetCells: number;
}

export function validateResolvedFeatureCoarseningPlan(
  value: unknown,
): ResolvedFeatureCoarseningPlan {
  const plan = value as ResolvedFeatureCoarseningPlan | null;
  if (
    !plan ||
    plan.version !== 1 ||
    !Number.isSafeInteger(plan.pass) ||
    plan.pass < 0 ||
    !Number.isSafeInteger(plan.sourceCellCount) ||
    plan.sourceCellCount < 4 ||
    typeof plan.sourceGeometrySignature !== 'string' ||
    typeof plan.configSignature !== 'string' ||
    normalizedRefinementConfigSignature(plan.configSignature) === null ||
    !Array.isArray(plan.removedCells) ||
    !plan.removedCells.every(
      (cell) => Number.isSafeInteger(cell) && cell >= 0 && cell < plan.sourceCellCount,
    ) ||
    new Set(plan.removedCells).size !== plan.removedCells.length
  ) {
    throw Error('Saved quiet-land coarsening contains invalid geometry or cell selections.');
  }
  return plan;
}

/** Save ordered removals against the source mesh; recipes never rediscover a
 * different quiet region when detection rules change in a later release. */
export function planFeatureCoarsening(
  context: FeatureRefinementContext & { ecology: Ecology },
  pass: number,
  budget: number,
  saved?: ResolvedFeatureCoarseningPlan,
) {
  const { grid, terrain, config } = context;
  const signature = refinementConfigSignature(config);
  const geometry = refinementGeometryHash(grid);
  const resolved = saved ? validateResolvedFeatureCoarseningPlan(saved) : undefined;
  if (
    resolved &&
    (resolved.pass !== pass ||
      resolved.sourceCellCount !== grid.count ||
      resolved.sourceGeometrySignature !== geometry ||
      normalizedRefinementConfigSignature(resolved.configSignature) !== signature ||
      resolved.removedCells.length > budget)
  ) {
    throw Error('Saved quiet-land coarsening does not match this world, recipe, or cell budget.');
  }
  // Saved selections are authoritative, as saved refinement caps are. Re-running
  // newer detector rules could otherwise reject an unchanged old recipe.
  const masks = resolved
    ? undefined
    : prepareQuietLandCoarsening(
        { ...context, radius: config.radius },
        analyzeLakeDistricts(context).strength,
      );
  const result = coarsenGrid(grid, terrain.height, {
    radius: config.radius,
    maxRemovedCells: budget,
    maxSpacingMetres: config.featureCoarseningSpacing,
    heightToleranceMetres: config.featureCoarseningTolerance,
    ...masks,
    resolvedRemovedCells: resolved?.removedCells,
  });
  return {
    ...result,
    resolved: resolved ?? {
      version: 1 as const,
      pass,
      sourceCellCount: grid.count,
      sourceGeometrySignature: geometry,
      configSignature: signature,
      removedCells: result.removedSourceCells,
    },
  };
}
