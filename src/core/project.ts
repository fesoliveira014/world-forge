import { DEFAULT_CONFIG, VERSION, type World, type WorldConfig } from './model';
import { validateConfig } from './config';
import { RESOURCE_RECIPE } from './resource-presets';

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
  VERSION,
];

/** Project files are generation recipes, not frozen world snapshots. */
export function worldProject(world: World) {
  return { version: world.version, config: world.config, resourceRecipe: world.resources.recipe };
}

export function readWorldProject(data: unknown): {
  config: WorldConfig;
  resourceRecipeChanged: boolean;
} {
  const project = data as {
    version?: string;
    config?: Partial<WorldConfig>;
    resourceRecipe?: string;
  } | null;
  if (!project || !ACCEPTED_VERSIONS.includes(project.version ?? '') || !project.config) {
    throw Error('Choose an Atlas v2 project file.');
  }
  const config: WorldConfig = { ...DEFAULT_CONFIG, ...project.config };
  validateConfig(config);
  return {
    config,
    resourceRecipeChanged: !!project.resourceRecipe && project.resourceRecipe !== RESOURCE_RECIPE,
  };
}
