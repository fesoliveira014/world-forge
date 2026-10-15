import {
  DEFAULT_CONFIG,
  VERSION,
  type World,
  type WorldConfig,
  type ResolvedRegionalRefinement,
} from './model';
import { validateConfig } from './config';
import { RESOURCE_RECIPE } from './resource-presets';
import {
  validateResolvedRefinementPlan,
  type ResolvedRefinementPlan,
} from './grid/refinement-plan';
import { validateResolvedRegionalRefinement } from './regional-refinement';
import {
  validateResolvedFeatureRefinementPlan,
  type ResolvedFeatureRefinementPlan,
} from './grid/feature-refinement';
import {
  validateResolvedFeatureCoarseningPlan,
  type ResolvedFeatureCoarseningPlan,
} from './grid/feature-coarsening';

const ACCEPTED_VERSIONS = [
  '2.0.0',
  '2.1.0',
  '2.2.0',
  '2.2.1',
  '2.3.0',
  '2.3.1',
  '2.4.0',
  '2.4.1',
  '2.5.0',
  '2.6.0',
  '2.7.0',
  '2.8.0',
  '2.8.1',
  '2.9.0',
  '2.10.0',
  '2.12.0',
  '2.13.0',
  '2.14.0',
  '2.15.0',
  '2.16.0',
  '2.16.1',
  '2.16.2',
  '2.17.0',
  '2.17.1',
  '2.25.0',
  '2.26.0',
  '2.27.0',
  VERSION,
];

/** Project files are generation recipes, not frozen world snapshots. */
export function worldProject(world: World) {
  return {
    version: world.version,
    config: world.config,
    resourceRecipe: world.resources.recipe,
    refinementPlans: world.refinementPlans,
    featureRefinementPlans: world.featureRefinementPlans,
    featureCoarseningPlans: world.featureCoarseningPlans,
    regionalRefinements: world.regionalRefinements,
  };
}

export function readWorldProject(data: unknown): {
  config: WorldConfig;
  resourceRecipeChanged: boolean;
  refinementPlans?: ResolvedRefinementPlan[];
  featureRefinementPlans?: ResolvedFeatureRefinementPlan[];
  featureCoarseningPlans?: ResolvedFeatureCoarseningPlan[];
  regionalRefinements?: ResolvedRegionalRefinement[];
} {
  const project = data as {
    version?: string;
    config?: Partial<WorldConfig>;
    resourceRecipe?: string;
    refinementPlans?: unknown;
    featureRefinementPlans?: unknown;
    featureCoarseningPlans?: unknown;
    regionalRefinements?: unknown;
  } | null;
  if (!project || !ACCEPTED_VERSIONS.includes(project.version ?? '') || !project.config) {
    throw Error('Choose an Atlas v2 project file.');
  }
  const config: WorldConfig = { ...DEFAULT_CONFIG, ...project.config };
  validateConfig(config);
  if (project.refinementPlans !== undefined && !Array.isArray(project.refinementPlans)) {
    throw Error('Saved refinement plans must be an array.');
  }
  const refinementPlans = (project.refinementPlans as unknown[] | undefined)?.map((plan) => {
    validateResolvedRefinementPlan(plan);
    return plan as ResolvedRefinementPlan;
  });
  if (
    project.featureRefinementPlans !== undefined &&
    !Array.isArray(project.featureRefinementPlans)
  ) {
    throw Error('Saved feature refinement plans must be an array.');
  }
  const featureRefinementPlans = (project.featureRefinementPlans as unknown[] | undefined)?.map(
    validateResolvedFeatureRefinementPlan,
  );
  if (
    project.featureCoarseningPlans !== undefined &&
    !Array.isArray(project.featureCoarseningPlans)
  ) {
    throw Error('Saved feature coarsening plans must be an array.');
  }
  const featureCoarseningPlans = (project.featureCoarseningPlans as unknown[] | undefined)?.map(
    validateResolvedFeatureCoarseningPlan,
  );
  const coarseningPasses = config.featureCoarseningBudget > 0 ? config.featureRefinementPasses : 0;
  if (featureCoarseningPlans && featureCoarseningPlans.length !== coarseningPasses) {
    throw Error('Saved quiet-land coarsening plan count does not match this recipe.');
  }
  if (project.regionalRefinements !== undefined && !Array.isArray(project.regionalRefinements)) {
    throw Error('Saved regional refinements must be an array.');
  }
  const regionalRefinements = (project.regionalRefinements as unknown[] | undefined)?.map(
    validateResolvedRegionalRefinement,
  );
  return {
    config,
    refinementPlans,
    featureRefinementPlans,
    featureCoarseningPlans,
    regionalRefinements,
    resourceRecipeChanged: !!project.resourceRecipe && project.resourceRecipe !== RESOURCE_RECIPE,
  };
}
