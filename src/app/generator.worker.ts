/// <reference lib="webworker" />
import { generateWorldAsync, type ClimateRequest } from '../core/pipeline';
import { prepareClimate } from '../core/generation/climate';
import type { Climate, World } from '../core/model';
import type {
  GenerationInput,
  GenerationRequest,
  RefinementRequest,
  RecipeImportRequest,
  GenerationResponse,
} from './generation-messages';
import {
  discardWorldDraft,
  probeSnapshotStorage,
  restoreWorldSnapshot,
  stageWorldSnapshot,
} from '../core/storage';
import { prepareWorldView } from '../core/view/prepare';
import { refineExistingWorld, replayRegionalRefinements } from '../core/regional-refinement';
import { readWorldProject } from '../core/project';

let nextClimateRequest = 0;
const pendingClimate = new Map<
  number,
  { jobId: number; resolve: (climate: Climate) => void; reject: (error: Error) => void }
>();

function solveParallelClimate(request: ClimateRequest, jobId: number): Promise<Climate> {
  const prepared = prepareClimate(
    request.grid,
    request.height,
    request.ocean,
    request.config,
    request.referenceOcean,
    request.recycledEvapotranspiration,
  );
  const requestId = ++nextClimateRequest;

  return new Promise((resolve, reject) => {
    pendingClimate.set(requestId, { jobId, resolve, reject });
    // Preparation and source buffers remain owned by the generation pipeline.
    self.postMessage({
      type: 'climate-request',
      id: jobId,
      requestId,
      prepared,
    } satisfies GenerationResponse);
  });
}

async function runGeneration(request: GenerationRequest | RefinementRequest | RecipeImportRequest) {
  const { id: jobId } = request;
  const progress = (stage: string, completed: number, total: number) =>
    self.postMessage({
      type: 'progress',
      id: jobId,
      stage,
      completed,
      total,
    } satisfies GenerationResponse);

  try {
    await probeSnapshotStorage();
    if (request.type === 'import') {
      progress('Reading generation recipe', 0, 1);
      const project = readWorldProject(JSON.parse(await request.file.text()));
      self.postMessage({
        type: 'recipe-loaded',
        id: jobId,
        config: project.config,
        resourceRecipeChanged: project.resourceRecipeChanged,
      } satisfies GenerationResponse);
      request = {
        type: 'generate',
        id: jobId,
        outputSnapshotId: request.outputSnapshotId,
        draftOwnerId: request.draftOwnerId,
        config: project.config,
        refinementPlans: project.refinementPlans,
        featureRefinementPlans: project.featureRefinementPlans,
        featureCoarseningPlans: project.featureCoarseningPlans,
        regionalRefinements: project.regionalRefinements,
        climateConcurrency: request.climateConcurrency,
      };
    }
    let world: World;
    if (request.type === 'refine') {
      progress('Restoring physical state for refinement', 0, 1);
      world = await restoreWorldSnapshot(request.snapshotId);
      world = refineExistingWorld(world, request.request, { progress });
    } else {
      world = await generateWorldAsync(request.config, progress, {
        refinementPlans: request.refinementPlans,
        featureRefinementPlans: request.featureRefinementPlans,
        featureCoarseningPlans: request.featureCoarseningPlans,
        climateConcurrency: request.climateConcurrency,
        solveClimate:
          request.climateConcurrency > 1
            ? (climateRequest) => solveParallelClimate(climateRequest, jobId)
            : undefined,
      });
      if (request.regionalRefinements?.length) {
        world = replayRegionalRefinements(world, request.regionalRefinements, { progress });
      }
    }
    progress('Indexing the world for paged viewing', 0, 1);
    const prepared = await prepareWorldView(world);
    const descriptor = await stageWorldSnapshot(world, {
      ...prepared,
      id: request.outputSnapshotId,
      ownerId: request.draftOwnerId,
      progress: (completed, total) => progress('Preparing world view', completed, total),
    });
    // Only a small handle crosses into the page. Ending this compute worker
    // releases the hot simulation; the reader opens immutable pages on demand.
    self.postMessage({
      type: 'complete',
      id: jobId,
      handle: {
        snapshotId: descriptor.id,
        saved: false,
        name: descriptor.name,
        version: world.version,
        config: world.config,
        summary: prepared.summary,
      },
    } satisfies GenerationResponse);
  } catch (error) {
    await discardWorldDraft(request.outputSnapshotId, request.draftOwnerId).catch(() => undefined);
    self.postMessage({
      type: 'error',
      id: jobId,
      message: error instanceof Error ? error.message : String(error),
    } satisfies GenerationResponse);
  }
}

self.onmessage = (event: MessageEvent<GenerationInput>) => {
  const message = event.data;

  if (message.type === 'generate' || message.type === 'refine' || message.type === 'import') {
    void runGeneration(message);

    return;
  }

  const pending = pendingClimate.get(message.requestId);

  if (!pending || pending.jobId !== message.id) {
    return;
  }

  pendingClimate.delete(message.requestId);

  if (message.type === 'climate-result') {
    pending.resolve(message.climate);
  } else {
    pending.reject(new Error(message.message));
  }
};
