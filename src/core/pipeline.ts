import { DEFAULT_CONFIG, VERSION, type World, type WorldConfig, type Progress } from './model';
import { buildGrid } from './grid/build';
import { buildTransfer, restrictSurface } from './operators/spatial';
import { buildGeology } from './generation/geology';
import { evolveCrust } from './generation/crust-evolution';
import { createTerrain, classifyWater } from './generation/terrain';
import { solveClimate } from './generation/climate';
import { solveLandWater, restrictEvaporation } from './generation/land-water';
import { routeWater } from './generation/drainage';
import { erodeRiverLandscape } from './generation/erosion';
import { weatherLandscape } from './generation/landscape';
import { classifyEcology } from './generation/ecology';
import { selectRivers } from './generation/rivers';
import { seedOxbows, buildRiverCourses } from './generation/river-courses';
import { buildDeltas } from './generation/deltas';
import { validateConfig } from './config';
import { generateDeposits } from './generation/resources';
import { buildFertility } from './generation/fertility';
import { RESOURCE_RECIPE } from './resource-presets';

/** Explicit stage order. A worker owns a single job and transfers its finished snapshot. */
export function generateWorld(config: WorldConfig, progress: Progress = () => {}): World {
  config = { ...DEFAULT_CONFIG, ...config };
  validateConfig(config);
  const generationStartedAt = performance.now();
  const timings: { name: string; ms: number }[] = [];
  let completedStages = 0;
  const needsClimateFeedback = config.erosion > 0 || config.recycling > 0;
  const totalStages =
    13 +
    (config.tectonicDuration > 0 ? 1 : 0) +
    (config.erosion > 0 ? 2 : 0) +
    (needsClimateFeedback ? 2 : 0);

  const runStage = <T>(name: string, run: () => T): T => {
    progress(name, completedStages, totalStages);
    const stageStartedAt = performance.now();
    const result = run();
    timings.push({ name, ms: performance.now() - stageStartedAt });
    progress(name, ++completedStages, totalStages);

    return result;
  };

  const processGrid = runStage('Simulation grid', () =>
    buildGrid(config.processLevel, config.seed, config.irregularity),
  );
  const surfaceGrid = runStage('Surface grid', () =>
    config.surfaceLevel === config.processLevel
      ? processGrid
      : buildGrid(config.surfaceLevel, config.seed, config.irregularity),
  );
  const transfer = runStage('Spatial transfer', () => buildTransfer(processGrid, surfaceGrid));
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

  const terrain = runStage('Terrain & oceans', () =>
    createTerrain(surfaceGrid, processGrid, transfer, geology, config),
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
  ).ocean;
  let coarseSurface = restrictSurface(
    surfaceGrid,
    processGrid,
    transfer,
    terrain.height,
    terrain.ocean,
  );
  let climate = runStage('Seasonal climate', () =>
    solveClimate(
      processGrid,
      coarseSurface.height,
      coarseSurface.ocean,
      config,
      referenceOceanMask,
    ),
  );
  let landWater = runStage('Land water budget', () =>
    solveLandWater(
      surfaceGrid,
      processGrid,
      transfer,
      climate,
      terrain,
      config,
      coarseSurface.height,
    ),
  );
  let sedimentExport = 0;
  const heightBeforeErosion = config.erosion > 0 ? new Float32Array(terrain.height) : null;

  // First mature the geological terrain, then derive the river graph that will
  // shape it. This keeps regional weathering from smoothing away the new valleys.
  if (config.erosion > 0) {
    sedimentExport = runStage('Landscape weathering & sediment', () => {
      const exported = weatherLandscape(
        surfaceGrid,
        processGrid,
        transfer,
        geology,
        terrain,
        climate,
        config,
      );
      Object.assign(terrain, classifyWater(surfaceGrid, terrain.height, config.radius));
      coarseSurface = restrictSurface(
        surfaceGrid,
        processGrid,
        transfer,
        terrain.height,
        terrain.ocean,
      );
      landWater = solveLandWater(
        surfaceGrid,
        processGrid,
        transfer,
        climate,
        terrain,
        config,
        coarseSurface.height,
      );

      return exported;
    });
  }

  let drainage = runStage('Rivers & reservoirs', () =>
    routeWater(surfaceGrid, terrain, landWater, config),
  );

  if (config.erosion > 0) {
    sedimentExport += runStage('River landscape evolution', () => {
      terrain.oxbows = seedOxbows(surfaceGrid, terrain, drainage, config);

      return erodeRiverLandscape(surfaceGrid, terrain, drainage, config);
    });

    for (let cellIndex = 0; cellIndex < surfaceGrid.count; cellIndex++) {
      terrain.surfaceChange[cellIndex] =
        terrain.height[cellIndex] - heightBeforeErosion![cellIndex];
    }

    Object.assign(terrain, classifyWater(surfaceGrid, terrain.height, config.radius));
    coarseSurface = restrictSurface(
      surfaceGrid,
      processGrid,
      transfer,
      terrain.height,
      terrain.ocean,
    );
  }

  if (needsClimateFeedback) {
    const recycledAet = restrictEvaporation(surfaceGrid, processGrid, transfer, terrain, landWater);
    climate = runStage('Final climate', () =>
      solveClimate(
        processGrid,
        coarseSurface.height,
        coarseSurface.ocean,
        config,
        referenceOceanMask,
        recycledAet,
      ),
    );
    runStage('Final water & drainage', () => {
      landWater = solveLandWater(
        surfaceGrid,
        processGrid,
        transfer,
        climate,
        terrain,
        config,
        coarseSurface.height,
      );
      drainage = routeWater(surfaceGrid, terrain, landWater, config);
    });
  }

  const rivers = runStage('Headwaters & channels', () =>
    selectRivers(surfaceGrid, terrain, landWater, drainage, config),
  );
  runStage('River courses & deltas', () => {
    rivers.courses = buildRiverCourses(surfaceGrid, terrain, drainage, rivers, config);
    rivers.deltas = buildDeltas(surfaceGrid, terrain, drainage, rivers, config);
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
    water: landWater,
    drainage,
    rivers,
    ecology,
    resources,
    timings,
    elapsed: 0,
    bytes: 0,
    sedimentExport,
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
    } else if (item && typeof item === 'object') {
      for (const child of Object.values(item)) {
        visitBuffers(child);
      }
    }
  }

  visitBuffers(value);

  return [...uniqueBuffers];
}
