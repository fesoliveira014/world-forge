import type {
  Climate,
  WorldConfig,
  RegionalRefinementRequest,
  ResolvedRegionalRefinement,
} from '../core/model';
import type { ResolvedRefinementPlan } from '../core/grid/refinement-plan';
import type { ResolvedFeatureRefinementPlan } from '../core/grid/feature-refinement';
import type { ResolvedFeatureCoarseningPlan } from '../core/grid/feature-coarsening';
import type { PreparedClimate } from '../core/generation/climate';
import type { WorldHandle } from '../core/view/types';

/** Shared worker protocol. Keep these field names stable across sender and receiver. */
export interface DraftPublication {
  outputSnapshotId: string;
  draftOwnerId: string;
}

export interface GenerationRequest extends DraftPublication {
  type: 'generate';
  id: number;
  config: WorldConfig;
  refinementPlans?: ResolvedRefinementPlan[];
  featureRefinementPlans?: ResolvedFeatureRefinementPlan[];
  featureCoarseningPlans?: ResolvedFeatureCoarseningPlan[];
  regionalRefinements?: ResolvedRegionalRefinement[];
  climateConcurrency: number;
}

export interface RefinementRequest extends DraftPublication {
  type: 'refine';
  id: number;
  snapshotId: string;
  request: RegionalRefinementRequest;
}

export interface RecipeImportRequest extends DraftPublication {
  type: 'import';
  id: number;
  file: Blob;
  climateConcurrency: number;
}

export type GenerationInput =
  | GenerationRequest
  | RefinementRequest
  | RecipeImportRequest
  | { type: 'climate-result'; id: number; requestId: number; climate: Climate }
  | { type: 'climate-error'; id: number; requestId: number; message: string };

export type GenerationResponse =
  | { type: 'recipe-loaded'; id: number; config: WorldConfig; resourceRecipeChanged: boolean }
  | { type: 'progress'; id: number; stage: string; completed: number; total: number }
  | { type: 'climate-request'; id: number; requestId: number; prepared: PreparedClimate }
  | { type: 'complete'; id: number; handle: WorldHandle }
  | { type: 'error'; id: number; message: string };
