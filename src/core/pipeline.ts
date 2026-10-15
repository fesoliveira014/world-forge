import {
  DEFAULT_CONFIG,
  VERSION,
  type World,
  type WorldConfig,
  type Progress,
  type Grid,
  type Climate,
} from './model';
import { buildGrid } from './grid/build';
import {
  planFeatureCoarsening,
  type ResolvedFeatureCoarseningPlan,
  type FeatureCoarseningStats,
} from './grid/feature-coarsening';
import { refineGrid } from './grid/refine';
import { estimateRefinementWork, type RefinementWorkEstimate } from './grid/refinement-work';
import {
  planSurfaceRefinement,
  replaySurfaceRefinement,
  type ResolvedRefinementPlan,
} from './grid/refinement-plan';
import { buildTransfer, restrictSurface } from './operators/spatial';
import { buildOverlapTransfer, type OverlapTransfer } from './operators/transfer';
import { buildGeology } from './generation/geology';
import { evolveCrust } from './generation/crust-evolution';
import { createTerrain, classifyWater } from './generation/terrain';
import { solveClimate } from './generation/climate';
import { solveLandWater, restrictEvaporation } from './generation/land-water';
import { routeWater } from './generation/drainage';
import { solveSalinity } from './generation/salinity';
import { applySalineRiverExposure } from './generation/floodplains';
import { erodeRiverLandscape } from './generation/erosion';
import { weatherLandscape } from './generation/landscape';
import { evolveHillslopes } from './generation/hillslope';
import { transportWindSediment } from './generation/wind-erosion';
import { transportCoastalSediment } from './generation/coastal-transport';
import { remapTerrain } from './operators/remap';
import { classifyEcology } from './generation/ecology';
import { selectRivers } from './generation/rivers';
import { seedOxbows, buildRiverCourses } from './generation/river-courses';
import { buildDeltas } from './generation/deltas';
import { validateConfig } from './config';
import { generateDeposits } from './generation/resources';
import { buildFertility } from './generation/fertility';
import { RESOURCE_RECIPE } from './resource-presets';
import {
  planFeatureRefinement,
  replayFeatureRefinement,
  type ResolvedFeatureRefinementPlan,
  type FeatureRefinementPassStats,
} from './grid/feature-refinement';

export interface ClimateRequest {
  grid: Grid;
  height: Float32Array;
  ocean: Uint8Array;
  config: WorldConfig;
  referenceOcean: Uint8Array;
  recycledEvapotranspiration?: Float32Array;
}

export interface GenerationOptions {
  refinementPlans?: ResolvedRefinementPlan[];
  featureRefinementPlans?: ResolvedFeatureRefinementPlan[];
  featureCoarseningPlans?: ResolvedFeatureCoarseningPlan[];
}

export interface AsyncGenerationOptions extends GenerationOptions {
  solveClimate?: (request: ClimateRequest) => Promise<Climate>;
  climateConcurrency?: number;
}

function solveClimateRequest(request: ClimateRequest): Climate {
  return solveClimate(
    request.grid,
    request.height,
    request.ocean,
    request.config,
    request.referenceOcean,
    request.recycledEvapotranspiration,
  );
}

/** Synchronous reference path, using the same stage machine as parallel generation. */
export function generateWorld(
  config: WorldConfig,
  progress: Progress = () => {},
  options: GenerationOptions = {},
): World {
  const generation = generateWorldStages(config, progress, options);
  let step = generation.next();
  while (!step.done) {
    step = generation.next(solveClimateRequest(step.value));
  }
  return step.value;
}

/** Only independent seasonal climate work is delegated; all dependent physical
 * stages retain their order and exactly the same arithmetic as the reference path.
 */
export async function generateWorldAsync(
  config: WorldConfig,
  progress: Progress = () => {},
  options: AsyncGenerationOptions = {},
): Promise<World> {
  const generation = generateWorldStages(config, progress, options);
  let step = generation.next();
  while (!step.done) {
    const climate = options.solveClimate
      ? await options.solveClimate(step.value)
      : solveClimateRequest(step.value);
    step = generation.next(climate);
  }
  step.value.execution.climateWorkers = options.solveClimate
    ? Math.max(1, Math.min(4, Math.floor(options.climateConcurrency ?? 1)))
    : 1;
  return step.value;
}

/** Explicit stage order. Yield points expose read-only climate inputs to a bounded
 * executor without retaining a second World or duplicating generation logic.
 */
function* generateWorldStages(
  config: WorldConfig,
  progress: Progress,
  options: AsyncGenerationOptions,
): Generator<ClimateRequest, World, Climate> {
  config = { ...DEFAULT_CONFIG, ...config };
  validateConfig(config);
  const generationStartedAt = performance.now();
  const timings: { name: string; ms: number }[] = [];
  let completedStages = 0;
  const adaptive = config.refinementStrength > 0;
  const durationMyr = config.erosion > 0 ? config.fluvialDuration : 0;
  const remeshCount = adaptive && durationMyr > 0 ? config.evolutionRefinements : 0;
  const batches = durationMyr > 0 ? Math.max(config.landscapeBatches, remeshCount + 1) : 0;
  const evolution: World['evolution'] = {
    durationMyr,
    batches,
    drainageRefreshes: 0,
    remeshes: [],
    hillslopeMoved: 0,
    windMoved: 0,
    coastalMoved: 0,
  };
  const refinementPlans: ResolvedRefinementPlan[] = [];
  const refinementWork: RefinementWorkEstimate[] = [];
  const featureRefinementPlans: ResolvedFeatureRefinementPlan[] = [];
  const featureRefinementStats: FeatureRefinementPassStats[] = [];
  const featureCoarseningPlans: ResolvedFeatureCoarseningPlan[] = [];
  const featureCoarseningStats: FeatureCoarseningStats[] = [];
  const coarseningPasses = config.featureCoarseningBudget > 0 ? config.featureRefinementPasses : 0;
  if (
    options.featureCoarseningPlans &&
    options.featureCoarseningPlans.length !== coarseningPasses
  ) {
    throw Error('Saved quiet-land coarsening plan count does not match this recipe.');
  }
  const plannedRefinements = adaptive ? 1 + remeshCount : 0;
  if (options.refinementPlans && options.refinementPlans.length !== plannedRefinements) {
    throw Error('Saved refinement plan count does not match this recipe.');
  }
  if (
    options.featureRefinementPlans &&
    options.featureRefinementPlans.length !== config.featureRefinementPasses
  ) {
    throw Error('Saved feature refinement plan count does not match this recipe.');
  }
  const needsClimateFeedback = adaptive || config.erosion > 0 || config.recycling > 0;
  const totalStages =
    14 +
    (adaptive ? 5 : 0) +
    (config.tectonicDuration > 0 ? 1 : 0) +
    (config.erosion > 0 ? 1 : 0) +
    batches * 5 +
    remeshCount * 5 +
    (needsClimateFeedback ? 2 : 0) +
    config.featureRefinementPasses * 5 +
    coarseningPasses * 4;

  const runStage = <T>(name: string, run: () => T, detail?: string): T => {
    const progressName = detail ? `${name} · ${detail}` : name;
    progress(progressName, completedStages, totalStages);
    const stageStartedAt = performance.now();
    const result = run();
    timings.push({ name, ms: performance.now() - stageStartedAt });
    progress(progressName, ++completedStages, totalStages);

    return result;
  };

  function* runClimateStage(
    name: string,
    request: ClimateRequest,
  ): Generator<ClimateRequest, Climate, Climate> {
    const workers = options.solveClimate
      ? Math.max(1, Math.min(4, options.climateConcurrency ?? 1))
      : 1;
    const label = workers > 1 ? `${name} · ${workers} seasonal workers` : name;
    progress(label, completedStages, totalStages);
    const started = performance.now();
    const result = yield request;
    timings.push({ name, ms: performance.now() - started });
    progress(label, ++completedStages, totalStages);
    return result;
  }

  const estimateWork = (plan: ResolvedRefinementPlan) => {
    const work = runStage(`Refinement cost estimate · ${refinementWork.length + 1}`, () =>
      estimateRefinementWork(surfaceGrid, plan),
    );
    refinementWork.push(work);
    const memory =
      work.estimatedPeakMiB >= 1024
        ? `${(work.estimatedPeakMiB / 1024).toFixed(1)} GiB`
        : `${Math.ceil(work.estimatedPeakMiB)} MiB`;
    return `roughly ${work.estimatedCells.toLocaleString('en-US')} cells, ${memory} surface working memory; cancel to adjust detail`;
  };

  const processGrid = runStage('Simulation grid', () =>
    buildGrid(config.processLevel, config.seed, config.irregularity),
  );
  let surfaceGrid = runStage('Surface grid', () =>
    config.surfaceLevel === config.processLevel
      ? processGrid
      : buildGrid(config.surfaceLevel, config.seed, config.irregularity),
  );
  let transfer = runStage('Spatial transfer', () => buildTransfer(processGrid, surfaceGrid));
  let overlap: OverlapTransfer | undefined;
  const geology = runStage('Plates & tectonics', () => buildGeology(processGrid, config));

  if (config.tectonicDuration > 0) {
    runStage('Crust evolution', () =>
      evolveCrust(processGrid, geology, config, (elapsed) =>
        progress(
          `Crust evolution · ${Math.round(elapsed)} / ${config.tectonicDuration} Myr`,
          completedStages,
          totalStages,
        ),
      ),
    );
  }

  let terrain = runStage('Terrain & oceans', () =>
    createTerrain(surfaceGrid, processGrid, transfer, geology, config, { continuous: adaptive }),
  );
  const identityTransfer = Uint32Array.from(
    { length: processGrid.count },
    (_, cellIndex) => cellIndex,
  );
  const referenceOceanMask = createTerrain(
    processGrid,
    processGrid,
    identityTransfer,
    geology,
    config,
    { continuous: adaptive },
  ).ocean;
  let coarseSurface = restrictSurface(
    surfaceGrid,
    processGrid,
    transfer,
    terrain.height,
    terrain.ocean,
  );
  let climate = yield* runClimateStage('Seasonal climate', {
    grid: processGrid,
    height: coarseSurface.height,
    ocean: coarseSurface.ocean,
    config,
    referenceOcean: referenceOceanMask,
  });

  if (adaptive) {
    const initialConfig = {
      ...config,
      refinementMinSpacing: config.refinementMinSpacing * 2 ** remeshCount,
    };
    // Keep provisional hydrology in this short-lived scope. Only geometry and the
    // resolved spacing field survive to insertion; no pilot World is retained.
    const plan = runStage('Pilot water & refinement plan', () => {
      if (options.refinementPlans) {
        return replaySurfaceRefinement(surfaceGrid, initialConfig, options.refinementPlans[0]);
      }
      const pilotWater = solveLandWater(
        surfaceGrid,
        processGrid,
        transfer,
        climate,
        terrain,
        config,
        coarseSurface.height,
      );
      const pilotDrainage = routeWater(surfaceGrid, terrain, pilotWater, config);
      return planSurfaceRefinement(
        surfaceGrid,
        terrain,
        pilotDrainage,
        geology,
        transfer,
        initialConfig,
      );
    });
    refinementPlans.push(plan.resolved);
    const workDescription = estimateWork(plan.resolved);
    surfaceGrid = runStage(
      'Adaptive surface mesh',
      () => refineGrid(surfaceGrid, config.radius, config.seed, plan.spacingAt),
      workDescription,
    );
    runStage('Conservative spatial transfer', () => {
      transfer = buildTransfer(processGrid, surfaceGrid);
      overlap = buildOverlapTransfer(processGrid, surfaceGrid);
    });
    terrain = runStage('Refined terrain & oceans', () =>
      createTerrain(surfaceGrid, processGrid, transfer, geology, config, {
        continuous: true,
        volcanicDetail: true,
      }),
    );
    coarseSurface = restrictSurface(
      surfaceGrid,
      processGrid,
      transfer,
      terrain.height,
      terrain.ocean,
      overlap,
    );
  }

  let landWater = runStage('Land water budget', () =>
    solveLandWater(
      surfaceGrid,
      processGrid,
      transfer,
      climate,
      terrain,
      config,
      coarseSurface.height,
      overlap,
    ),
  );
  let sedimentExport = 0;
  // Only one stage-local height copy is alive; history remains on the terrain.
  const recordChange = (before: Float32Array) => {
    for (let cell = 0; cell < surfaceGrid.count; cell++) {
      terrain.surfaceChange[cell] += terrain.height[cell] - before[cell];
    }
  };
  const sedimentVolume = () =>
    terrain.sediment.reduce(
      (sum, depth, cell) => sum + depth * surfaceGrid.areas[cell] * config.radius ** 2,
      0,
    );
  const refreshHydrology = () => {
    Object.assign(terrain, classifyWater(surfaceGrid, terrain.height, config.radius));
    coarseSurface = restrictSurface(
      surfaceGrid,
      processGrid,
      transfer,
      terrain.height,
      terrain.ocean,
      overlap,
    );
    landWater = solveLandWater(
      surfaceGrid,
      processGrid,
      transfer,
      climate,
      terrain,
      config,
      coarseSurface.height,
      overlap,
    );
    evolution.drainageRefreshes++;
    return routeWater(surfaceGrid, terrain, landWater, config);
  };

  // First mature the geological terrain, then derive the river graph that will
  // shape it. This keeps regional weathering from smoothing away the new valleys.
  if (config.erosion > 0) {
    sedimentExport = runStage('Landscape weathering & sediment', () => {
      const before = new Float32Array(terrain.height);
      const exported = weatherLandscape(
        surfaceGrid,
        processGrid,
        transfer,
        geology,
        terrain,
        climate,
        config,
        overlap,
      );
      recordChange(before);
      Object.assign(terrain, classifyWater(surfaceGrid, terrain.height, config.radius));
      coarseSurface = restrictSurface(
        surfaceGrid,
        processGrid,
        transfer,
        terrain.height,
        terrain.ocean,
        overlap,
      );
      landWater = solveLandWater(
        surfaceGrid,
        processGrid,
        transfer,
        climate,
        terrain,
        config,
        coarseSurface.height,
        overlap,
      );

      return exported;
    });
  }

  let drainage = runStage('Rivers & reservoirs', () =>
    routeWater(surfaceGrid, terrain, landWater, config),
  );

  const remeshBoundaries = new Map<number, number>();
  for (let pass = 1; pass <= remeshCount; pass++) {
    remeshBoundaries.set(Math.floor((batches * pass) / (remeshCount + 1)), pass);
  }
  for (let batch = 0; batch < batches; batch++) {
    const pass = remeshBoundaries.get(batch);
    if (pass !== undefined) {
      const stageConfig = {
        ...config,
        refinementMinSpacing: config.refinementMinSpacing * 2 ** (remeshCount - pass),
      };
      const plan = runStage(`Evolved refinement plan · ${pass}`, () =>
        options.refinementPlans
          ? replaySurfaceRefinement(surfaceGrid, stageConfig, options.refinementPlans[pass])
          : planSurfaceRefinement(surfaceGrid, terrain, drainage, geology, transfer, stageConfig),
      );
      refinementPlans.push(plan.resolved);
      const workDescription = estimateWork(plan.resolved);
      const beforeCells = surfaceGrid.count;
      const sedimentBefore = sedimentVolume();
      runStage(
        `Conservative terrain remesh · ${pass}`,
        () => {
          const refined = refineGrid(surfaceGrid, config.radius, config.seed, plan.spacingAt);
          terrain = remapTerrain(surfaceGrid, refined, terrain, config);
          surfaceGrid = refined;
        },
        workDescription,
      );
      evolution.remeshes.push({
        beforeCells,
        afterCells: surfaceGrid.count,
        elapsedMyr: (durationMyr * batch) / batches,
        sedimentBefore,
        sedimentAfter: sedimentVolume(),
      });
      runStage(`Rebuild spatial transfers · ${pass}`, () => {
        transfer = buildTransfer(processGrid, surfaceGrid);
        overlap = buildOverlapTransfer(processGrid, surfaceGrid);
      });
      drainage = runStage(`Remeshed water & drainage · ${pass}`, refreshHydrology);
    }
    // Every resolution receives only its assigned slice of ONE recent interval.
    const batchDuration = durationMyr / batches;
    const batchConfig = { ...config, fluvialDuration: batchDuration };
    const before = new Float32Array(terrain.height);
    sedimentExport += runStage(
      batch === 0
        ? 'River landscape evolution'
        : `River landscape evolution · ${batch + 1} / ${batches}`,
      () => {
        if (batch === 0) {
          terrain.oxbows = seedOxbows(surfaceGrid, terrain, drainage, config);
        }
        return erodeRiverLandscape(surfaceGrid, terrain, drainage, batchConfig);
      },
    );
    evolution.hillslopeMoved += runStage(
      `Fine hillslope transport · ${batch + 1} / ${batches}`,
      () => evolveHillslopes(surfaceGrid, terrain, config, batchDuration).movedVolume,
    );
    evolution.windMoved += runStage(
      `Fine wind transport · ${batch + 1} / ${batches}`,
      () =>
        transportWindSediment(
          surfaceGrid,
          processGrid,
          transfer,
          terrain,
          climate,
          landWater,
          config,
          batchDuration,
        ).movedVolume,
    );
    evolution.coastalMoved! += runStage(
      `Coastal sediment transport · ${batch + 1} / ${batches}`,
      () =>
        transportCoastalSediment(
          surfaceGrid,
          processGrid,
          transfer,
          terrain,
          climate,
          config,
          batchDuration,
        ).movedVolume,
    );
    recordChange(before);
    drainage = runStage(`Landscape water & drainage · ${batch + 1} / ${batches}`, refreshHydrology);
  }

  if (needsClimateFeedback) {
    const recycledAet = restrictEvaporation(
      surfaceGrid,
      processGrid,
      transfer,
      terrain,
      landWater,
      overlap,
    );
    climate = yield* runClimateStage('Final climate', {
      grid: processGrid,
      height: coarseSurface.height,
      ocean: coarseSurface.ocean,
      config,
      referenceOcean: referenceOceanMask,
      recycledEvapotranspiration: recycledAet,
    });
    runStage('Final water & drainage', () => {
      landWater = solveLandWater(
        surfaceGrid,
        processGrid,
        transfer,
        climate,
        terrain,
        config,
        coarseSurface.height,
        overlap,
      );
      drainage = routeWater(surfaceGrid, terrain, landWater, config);
    });
  }

  let rivers = runStage('Headwaters & channels', () =>
    selectRivers(surfaceGrid, terrain, landWater, drainage, config),
  );
  // These are resolution-only passes over the final landscape. Keep the climate
  // forcing used by the last climate solve; neither geology nor erosion advances.
  const climateReferenceHeight = coarseSurface.height;
  const featureBaseCells = surfaceGrid.count;
  const featureBudget = Math.floor((featureBaseCells * config.featureRefinementBudget) / 100);
  const coarseningBudget = Math.floor((featureBaseCells * config.featureCoarseningBudget) / 100);
  let grossAddedCells = 0;
  let grossRemovedCells = 0;
  for (let pass = 0; pass < config.featureRefinementPasses; pass++) {
    const label = `${pass + 1} / ${config.featureRefinementPasses}`;
    if (coarseningPasses) {
      const removalBudget = Math.ceil(
        Math.max(0, coarseningBudget - grossRemovedCells) / (config.featureRefinementPasses - pass),
      );
      const beforeCells = surfaceGrid.count;
      const result = runStage(`Quiet land mesh · ${label}`, () => {
        const ecology = classifyEcology(surfaceGrid, terrain, landWater, drainage, rivers, config);
        const plan = planFeatureCoarsening(
          { grid: surfaceGrid, terrain, drainage, rivers, ecology, config },
          pass,
          removalBudget,
          options.featureCoarseningPlans?.[pass],
        );
        if (plan.grid !== surfaceGrid) {
          terrain = remapTerrain(surfaceGrid, plan.grid, terrain, config);
          surfaceGrid = plan.grid;
        }
        return plan;
      });
      featureCoarseningPlans.push(result.resolved);
      const changed = surfaceGrid.count !== beforeCells;
      const removedCells = beforeCells - surfaceGrid.count;
      grossRemovedCells += removedCells;
      featureCoarseningStats.push({
        pass,
        beforeCells,
        afterCells: surfaceGrid.count,
        removedCells,
        candidateCells: result.stats.candidateCells,
        budgetCells: removalBudget,
      });
      runStage(`Quiet land transfers · ${label}`, () => {
        if (!changed) {
          return;
        }
        transfer = buildTransfer(processGrid, surfaceGrid);
        overlap = buildOverlapTransfer(processGrid, surfaceGrid);
      });
      runStage(`Quiet land water & drainage · ${label}`, () => {
        if (!changed) {
          return;
        }
        landWater = solveLandWater(
          surfaceGrid,
          processGrid,
          transfer,
          climate,
          terrain,
          config,
          climateReferenceHeight,
          overlap,
        );
        drainage = routeWater(surfaceGrid, terrain, landWater, config);
      });
      runStage(`Quiet land channels · ${label}`, () => {
        if (changed) {
          rivers = selectRivers(surfaceGrid, terrain, landWater, drainage, config);
        }
      });
    }
    // Removal never grants additional insertion allowance: both budgets are
    // fixed against the pre-pass mesh and shared across all final passes.
    const remaining = Math.max(0, featureBudget - grossAddedCells);
    const budget = Math.ceil(remaining / (config.featureRefinementPasses - pass));
    const context = { grid: surfaceGrid, terrain, drainage, rivers, config };
    const plan = runStage(`Final feature plan · ${label}`, () =>
      options.featureRefinementPlans
        ? replayFeatureRefinement(context, options.featureRefinementPlans[pass], budget)
        : planFeatureRefinement(context, budget),
    );
    featureRefinementPlans.push(plan.resolved);
    const beforeCells = surfaceGrid.count;
    runStage(
      `Final feature mesh · ${label}`,
      () => {
        if (!budget || !plan.resolved.caps.length) {
          return;
        }
        const refined = refineGrid(surfaceGrid, config.radius, config.seed, plan.spacingAt, {
          maxAddedCells: budget,
        });
        if (refined.count === surfaceGrid.count) {
          return;
        }
        terrain = remapTerrain(surfaceGrid, refined, terrain, config);
        surfaceGrid = refined;
      },
      `${plan.stats.selectedCells.toLocaleString('en-US')} feature cells; at most ${budget.toLocaleString('en-US')} added cells`,
    );
    const changed = surfaceGrid.count !== beforeCells;
    grossAddedCells += surfaceGrid.count - beforeCells;
    runStage(`Final feature transfers · ${label}`, () => {
      if (!changed) {
        return;
      }
      transfer = buildTransfer(processGrid, surfaceGrid);
      overlap = buildOverlapTransfer(processGrid, surfaceGrid);
    });
    runStage(`Final feature water & drainage · ${label}`, () => {
      if (!changed) {
        return;
      }
      landWater = solveLandWater(
        surfaceGrid,
        processGrid,
        transfer,
        climate,
        terrain,
        config,
        climateReferenceHeight,
        overlap,
      );
      drainage = routeWater(surfaceGrid, terrain, landWater, config);
    });
    runStage(`Final feature channels · ${label}`, () => {
      if (!changed) {
        return;
      }
      rivers = selectRivers(surfaceGrid, terrain, landWater, drainage, config);
    });
    featureRefinementStats.push({
      beforeCells,
      afterCells: surfaceGrid.count,
      budget,
      candidateCells: plan.stats.candidateCells,
      selectedCells: plan.stats.selectedCells,
      budgetExhausted:
        plan.stats.stoppedByBudget || (budget > 0 && surfaceGrid.count - beforeCells >= budget),
      byDetector: plan.stats.byDetector,
    });
  }
  runStage('River courses & deltas', () => {
    rivers.courses = buildRiverCourses(surfaceGrid, terrain, drainage, rivers, config);
    rivers.deltas = buildDeltas(surfaceGrid, terrain, drainage, rivers, config, {
      physicalNeighborhood: adaptive || grossAddedCells > 0 || grossRemovedCells > 0,
    });
  });
  // Salinity has its own explicit hydrologic duration. Evaluate it once on the
  // finished drainage network; climate iterations and resolution passes are not
  // additional years of salt accumulation.
  runStage('Lake salts & soil salinity', () => {
    solveSalinity(surfaceGrid, terrain, landWater, drainage, config);
    applySalineRiverExposure(surfaceGrid, terrain, drainage, rivers, config);
  });
  const ecology = runStage('Biomes & ecology', () =>
    classifyEcology(surfaceGrid, terrain, landWater, drainage, rivers, config),
  );
  const resources = runStage('Minerals & fertility', () => ({
    recipe: RESOURCE_RECIPE,
    deposits: generateDeposits(
      {
        process: processGrid,
        geology,
        referenceOceanMask,
        seed: config.seed,
        radius: config.radius,
      },
      config,
    ),
    fertility: buildFertility({
      grid: surfaceGrid,
      transfer,
      geology,
      terrain,
      water: landWater,
      drainage,
      rivers,
      ecology,
      config,
    }),
  }));
  const world: World = {
    version: VERSION,
    config: { ...config },
    grid: surfaceGrid,
    process: processGrid,
    transfer,
    geology,
    terrain,
    climate,
    climateReferenceHeight,
    water: landWater,
    drainage,
    rivers,
    ecology,
    resources,
    timings,
    elapsed: 0,
    bytes: 0,
    sedimentExport,
    evolution,
    refinementPlans,
    refinementWork,
    featureRefinementPlans,
    featureRefinementStats,
    featureCoarseningPlans,
    featureCoarseningStats,
    execution: { climateWorkers: 1 },
  };
  runStage('Publish world', () => {
    world.bytes = collectWorldBuffers(world).reduce(
      (totalBytes, buffer) => totalBytes + buffer.byteLength,
      0,
    );
  });
  world.elapsed = performance.now() - generationStartedAt;

  return world;
}

/** Deduplicate shared geometry before transferring ownership or reporting retained bytes. */
export function collectWorldBuffers(value: unknown): ArrayBuffer[] {
  const uniqueBuffers = new Set<ArrayBuffer>();

  function visitBuffers(item: unknown) {
    if (ArrayBuffer.isView(item)) {
      if (item.buffer instanceof ArrayBuffer) {
        uniqueBuffers.add(item.buffer);
      }
    } else if (Array.isArray(item)) {
      // Saved plans contain large numeric arrays. Do not copy them with
      // Object.values just to discover that they hold no transferable buffers.
      for (const child of item) {
        if (child && typeof child === 'object') {
          visitBuffers(child);
        }
      }
    } else if (item && typeof item === 'object') {
      for (const child of Object.values(item)) {
        visitBuffers(child);
      }
    }
  }

  visitBuffers(value);

  return [...uniqueBuffers];
}
