/** Fresh-process measurements, with an independent RSS sampler during synchronous stages.
 * npm run measure -- [recipe.json [surfaceLevel [processLevel]]] [--output report.json]
 * Add --progress for stderr stage updates, --save-recipe resolved-recipe.json,
 * or --measure-transfer for a timed ownership transfer of the complete snapshot.
 * --threads 1 is serial; the default uses up to four available climate workers.
 */
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, platform, release, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { collectWorldBuffers, generateWorld, generateWorldAsync } from '../src/core/pipeline';
import { DEFAULT_CONFIG, type World, type WorldConfig } from '../src/core/model';
import { readWorldProject, worldProject } from '../src/core/project';
import { gridSpacing } from '../src/core/grid/spacing';
import type { ResolvedRefinementPlan } from '../src/core/grid/refinement-plan';
import { createNodeClimatePool } from './climate-pool';
import { replayRegionalRefinements } from '../src/core/regional-refinement';
import type { ResolvedRegionalRefinement } from '../src/core/model';
import { prepareWorldView } from '../src/core/view/prepare';
import { encodeGraph } from '../src/core/storage/codec';

const MiB = 1048576;
const scriptPath = fileURLToPath(import.meta.url);

interface MeasurementRequest {
  config: WorldConfig;
  refinementPlans?: ResolvedRefinementPlan[];
  regionalRefinements?: ResolvedRegionalRefinement[];
  saveRecipe?: string;
  measureTransfer?: boolean;
  measureViewIndex?: boolean;
  threads: number;
}

function digest(value: string | ArrayBufferView) {
  const bytes =
    typeof value === 'string'
      ? value
      : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return createHash('sha256').update(bytes).digest('hex');
}

function optionalFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

function environment(climateWorkers: number) {
  const memoryLimit = optionalFile('/sys/fs/cgroup/memory.max');
  const cpuQuota = optionalFile('/sys/fs/cgroup/cpu.max')?.split(' ').map(Number);
  return {
    node: process.version,
    platform: platform(),
    kernel: release(),
    architecture: process.arch,
    cpuModel: cpus()[0]?.model,
    availableParallelism: availableParallelism(),
    cpuQuota: cpuQuota && Number.isFinite(cpuQuota[0]) ? cpuQuota[0] / cpuQuota[1] : null,
    hostMemoryMiB: totalmem() / MiB,
    memoryLimitMiB:
      memoryLimit && Number.isFinite(Number(memoryLimit)) ? Number(memoryLimit) / MiB : null,
    generatorThreads: climateWorkers,
    otherStageThreads: 1,
  };
}

async function measureInWorker(request: MeasurementRequest) {
  const baselineMemory = process.memoryUsage();
  let sampledPeakRss = baselineMemory.rss;
  let sampledPeakHeap = baselineMemory.heapUsed;
  let sampledPeakExternal = baselineMemory.external;
  const stageMemory: {
    name: string;
    completed: number;
    elapsedMs: number;
    rssMiB: number;
    heapMiB: number;
    externalMiB: number;
  }[] = [];
  const started = performance.now();
  const pool = request.threads > 1 ? createNodeClimatePool(request.threads) : undefined;
  const progress = (name: string, completed: number, total: number) => {
    const memory = process.memoryUsage();
    sampledPeakRss = Math.max(sampledPeakRss, memory.rss);
    sampledPeakHeap = Math.max(sampledPeakHeap, memory.heapUsed);
    sampledPeakExternal = Math.max(sampledPeakExternal, memory.external);
    stageMemory.push({
      name,
      completed,
      elapsedMs: performance.now() - started,
      rssMiB: memory.rss / MiB,
      heapMiB: memory.heapUsed / MiB,
      externalMiB: memory.external / MiB,
    });
    process.send?.({ name, completed, total });
  };
  let world: World;
  try {
    world = pool
      ? await generateWorldAsync(request.config, progress, {
          refinementPlans: request.refinementPlans,
          solveClimate: pool.solve,
          climateConcurrency: request.threads,
        })
      : generateWorld(request.config, progress, { refinementPlans: request.refinementPlans });
  } finally {
    await pool?.close();
  }
  if (request.regionalRefinements?.length) {
    world = replayRegionalRefinements(world, request.regionalRefinements, { progress });
  }
  const runtimeMs = performance.now() - started;
  // maxRSS includes peaks inside blocking stages. Darwin reports bytes.
  const processPeakRssMiB =
    process.resourceUsage().maxRSS / (process.platform === 'darwin' ? MiB : 1024);
  const serializationStarted = performance.now();
  const recipe = worldProject(world);
  const recipeJson = JSON.stringify(recipe);
  const publication: {
    recipeSerializationMs: number;
    serializedRecipeBytes: number;
    recipeWriteMs?: number;
    ownerTransferMs?: number;
    postPublicationPeakRssMiB?: number;
    viewIndexMs?: number;
    viewIndexMiB?: number;
    snapshotGraphMiB?: number;
    snapshotPages?: number;
  } = {
    recipeSerializationMs: performance.now() - serializationStarted,
    serializedRecipeBytes: Buffer.byteLength(recipeJson),
  };
  if (request.saveRecipe) {
    const writingStarted = performance.now();
    writeFileSync(request.saveRecipe, `${recipeJson}\n`);
    publication.recipeWriteMs = performance.now() - writingStarted;
  }
  if (request.measureViewIndex) {
    progress('Prepare paged view index', 0, 1);
    const indexStarted = performance.now();
    const prepared = prepareWorldView(world);
    publication.viewIndexMs = performance.now() - indexStarted;
    publication.viewIndexMiB =
      collectWorldBuffers(prepared.sidecars).reduce((sum, buffer) => sum + buffer.byteLength, 0) /
      MiB;
    const graph = encodeGraph({ world, sidecars: prepared.sidecars });
    publication.snapshotGraphMiB =
      graph.manifest.buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0) / MiB;
    publication.snapshotPages = graph.manifest.buffers.reduce(
      (sum, buffer) => sum + buffer.pages,
      0,
    );
    progress('Prepare paged view index', 1, 1);
  }
  const report = {
    schemaVersion: 2,
    measuredAt: new Date().toISOString(),
    version: world.version,
    environment: environment(world.execution.climateWorkers),
    execution: world.execution,
    config: world.config,
    recipeSha256: digest(recipeJson),
    replayedRefinementPlans: !!request.refinementPlans,
    refinementPlanCount: world.refinementPlans.length,
    refinementPlanBytes: Buffer.byteLength(JSON.stringify(world.refinementPlans)),
    refinementWork: world.refinementWork ?? [],
    geometrySha256: digest(world.grid.positions),
    topologySha256: digest(world.grid.triangles),
    heightSha256: digest(world.terrain.height),
    surfaceCells: world.grid.count,
    processCells: world.process.count,
    refinement: world.grid.refinement
      ? {
          baseCount: world.grid.refinement.baseCount,
          insertedCount: world.grid.refinement.insertedCount,
          passes: world.grid.refinement.passes,
        }
      : null,
    nearestCenterSpacingM: gridSpacing(world.grid, world.config.radius),
    totalMs: world.elapsed,
    runtimeIncludingPoolShutdownMs: runtimeMs,
    retainedMiB: world.bytes / MiB,
    memory: {
      processPeakRssMiB,
      baselineRssMiB: baselineMemory.rss / MiB,
      sampledPeakRssMiB: sampledPeakRss / MiB,
      sampledPeakHeapMiB: sampledPeakHeap / MiB,
      sampledPeakExternalMiB: sampledPeakExternal / MiB,
      sampling:
        'Fresh child process; OS high-water RSS includes all climate worker threads and transient allocations. Heap/external stage samples describe the orchestrator thread only. Parent RSS sampling runs independently of synchronous generation.',
      stages: stageMemory,
    },
    stages: world.timings.map((stage) => ({ ...stage, share: stage.ms / world.elapsed })),
    evolution: world.evolution,
    atmosphereRelativeResidual: world.climate.atmosphereResidual,
    oceanFluxDivergence: world.climate.oceanDivergence,
    runoffRoutingResidual:
      world.drainage.runoffTotal - world.drainage.oceanDischarge - world.drainage.lakeExchange,
    sedimentExport: world.sedimentExport,
    lakes: world.drainage.lakes.length,
    deposits: world.resources.deposits.length,
    fertilityMiB: world.resources.fertility.byteLength / MiB,
    publication,
  };
  if (request.measureTransfer) {
    const transferringStarted = performance.now();
    const owned = structuredClone(world, { transfer: collectWorldBuffers(world) });
    publication.ownerTransferMs = performance.now() - transferringStarted;
    if (owned.grid.count !== report.surfaceCells) {
      throw Error('Snapshot transfer changed the mesh.');
    }
  }
  publication.postPublicationPeakRssMiB =
    process.resourceUsage().maxRSS / (process.platform === 'darwin' ? MiB : 1024);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.disconnect?.();
}

async function runIsolated(request: MeasurementRequest, progress: boolean) {
  const child = fork(scriptPath, ['--measure-worker'], {
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
  });
  const samples = new Map<string, { samples: number; peakRssMiB: number }>();
  let currentStage = 'Starting worker';
  let output = '';
  let observedPeakRssMiB = 0;
  let observedHighWaterRssMiB = 0;
  child.stdout!.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.on('message', (message: { name: string; completed: number; total: number }) => {
    currentStage = message.name;
    if (progress) {
      process.stderr.write(`${message.completed}/${message.total} ${message.name}\n`);
    }
  });
  const sample = () => {
    const status = optionalFile(`/proc/${child.pid}/status`);
    if (!status) {
      return;
    }
    const rssMiB = Number(status.match(/^VmRSS:\s+(\d+) kB$/m)?.[1] ?? 0) / 1024;
    const highWaterMiB = Number(status.match(/^VmHWM:\s+(\d+) kB$/m)?.[1] ?? 0) / 1024;
    observedPeakRssMiB = Math.max(observedPeakRssMiB, rssMiB);
    observedHighWaterRssMiB = Math.max(observedHighWaterRssMiB, highWaterMiB);
    const stage = samples.get(currentStage) ?? { samples: 0, peakRssMiB: 0 };
    stage.samples++;
    stage.peakRssMiB = Math.max(stage.peakRssMiB, rssMiB);
    samples.set(currentStage, stage);
  };
  const interval = setInterval(sample, 50);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (code === 0) {
          resolve();
        } else {
          reject(Error(`Measurement worker failed (${signal ?? code}); no successful result.`));
        }
      });
      child.send(request);
    });
  } finally {
    clearInterval(interval);
  }
  const report = JSON.parse(output);
  report.memory.independentSampler = {
    intervalMs: 50,
    available: samples.size > 0,
    observedPeakRssMiB,
    observedHighWaterRssMiB,
    stages: [...samples].map(([name, memory]) => ({ name, ...memory })),
  };
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--measure-worker') {
    const request = await new Promise<MeasurementRequest>((resolve) => {
      process.once('message', resolve);
    });
    await measureInWorker(request);
    return;
  }
  const takeOption = (name: string) => {
    const index = args.indexOf(name);
    if (index < 0) {
      return undefined;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw Error(`${name} requires a value.`);
    }
    args.splice(index, 2);
    return value;
  };
  const outputPath = takeOption('--output');
  const saveRecipe = takeOption('--save-recipe');
  const threads = Number(takeOption('--threads') ?? Math.min(4, availableParallelism()));
  if (!Number.isInteger(threads) || threads < 1 || threads > 4) {
    throw Error('--threads must be an integer from 1 to 4.');
  }
  const progressIndex = args.indexOf('--progress');
  const progress = progressIndex >= 0;
  if (progress) {
    args.splice(progressIndex, 1);
  }
  const transferIndex = args.indexOf('--measure-transfer');
  const measureTransfer = transferIndex >= 0;
  if (measureTransfer) {
    args.splice(transferIndex, 1);
  }
  const viewIndex = args.indexOf('--measure-view-index');
  const measureViewIndex = viewIndex >= 0;
  if (measureViewIndex) {
    args.splice(viewIndex, 1);
  }
  if (args.length > 3 || args.some((arg) => arg.startsWith('--'))) {
    throw Error(
      'Usage: measure [recipe.json [surfaceLevel [processLevel]]] [--output path] [--save-recipe path] [--progress]',
    );
  }
  const [projectPath, surfaceOverride, processOverride] = args;
  const project = projectPath
    ? readWorldProject(JSON.parse(readFileSync(projectPath, 'utf8')))
    : undefined;
  const configurations = project
    ? [project.config]
    : [5, 7].map((surfaceLevel) => ({ ...DEFAULT_CONFIG, surfaceLevel }));
  if (saveRecipe && configurations.length !== 1) {
    throw Error('--save-recipe requires a single input recipe.');
  }
  if (
    (project?.refinementPlans || project?.regionalRefinements?.length) &&
    (surfaceOverride || processOverride)
  ) {
    throw Error(
      'Resolution overrides invalidate saved spacing decisions. Use a recipe without refinementPlans to resolve a new plan.',
    );
  }
  const reports = [];
  for (const configuration of configurations) {
    const config = {
      ...configuration,
      ...(surfaceOverride ? { surfaceLevel: Number(surfaceOverride) } : {}),
      ...(processOverride ? { processLevel: Number(processOverride) } : {}),
    };
    const report = await runIsolated(
      {
        config,
        refinementPlans: project?.refinementPlans,
        regionalRefinements: project?.regionalRefinements,
        saveRecipe,
        measureTransfer,
        measureViewIndex,
        threads,
      },
      progress,
    );
    reports.push(report);
    console.log(JSON.stringify(report));
    if (outputPath) {
      writeFileSync(
        outputPath,
        `${JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2)}\n`,
      );
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
  if (process.connected) {
    process.disconnect?.();
  }
});
