/** Fresh-process AETHER-2408 comparison, plus snapshots usable by browser QA.
 * node --import tsx scripts/measure-feature-refinement.ts [report.json] [snapshot-directory]
 * Add --refined-only before those arguments to reuse an already measured baseline.
 */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deserialize, serialize } from 'node:v8';
import { DEFAULT_CONFIG, VERSION, type World } from '../src/core/model';
import { generateWorld } from '../src/core/pipeline';
import { encodeGraph } from '../src/core/storage/codec';
import { nearestCell } from '../src/core/grid/build';
import { gridSpacing } from '../src/core/grid/spacing';

const MiB = 1048576;
const script = fileURLToPath(import.meta.url);
const repo = resolve(dirname(script), '..');
const sourceFixture = resolve(
  repo,
  'docs/observations/measurements/fantasy-density-browser-2.23.1.json',
);

function distribution(values: number[]) {
  const sorted = [...values].sort((first, second) => first - second);
  if (!sorted.length) {
    return null;
  }
  const at = (fraction: number) => sorted[Math.floor((sorted.length - 1) * fraction)];
  return {
    count: sorted.length,
    minimum: sorted[0],
    p10: at(0.1),
    median: at(0.5),
    p90: at(0.9),
    maximum: sorted.at(-1),
  };
}

function localSpacing(world: World, cell: number) {
  let minimum = Infinity;
  for (let offset = world.grid.offsets[cell]; offset < world.grid.offsets[cell + 1]; offset++) {
    const neighbor = world.grid.neighbors[offset];
    let dot = 0;
    let squaredChord = 0;
    for (let axis = 0; axis < 3; axis++) {
      const first = world.grid.positions[cell * 3 + axis];
      const second = world.grid.positions[neighbor * 3 + axis];
      dot += first * second;
      squaredChord += (first - second) ** 2;
    }
    const angle =
      dot > 0 ? 2 * Math.asin(Math.min(1, Math.sqrt(squaredChord) / 2)) : Math.acos(dot);
    minimum = Math.min(minimum, angle * world.config.radius);
  }
  return minimum;
}

function saveSnapshot(world: World, path: string) {
  mkdirSync(path, { recursive: true });
  writeFileSync(`${path}/world.v8`, serialize(world));
  const graph = encodeGraph(world);
  const replacer = (_key: string, value: unknown) =>
    value === undefined
      ? { __qaUndefined: 1 }
      : typeof value === 'number' && !Number.isFinite(value)
        ? { __qaNumber: String(value) }
        : value;
  writeFileSync(
    `${path}/graph.json`,
    JSON.stringify({ manifest: graph.manifest, nodes: graph.nodes }, replacer),
  );
  for (let buffer = 0; buffer < graph.manifest.buffers.length; buffer++) {
    for (let page = 0; page < graph.manifest.buffers[buffer].pages; page++) {
      writeFileSync(`${path}/${buffer}-${page}.bin`, new Uint8Array(graph.page(buffer, page)));
    }
  }
}

function measure(variant: 'baseline' | 'refined', snapshotRoot: string) {
  const fixture = JSON.parse(readFileSync(sourceFixture, 'utf8')).fixture;
  const config = {
    ...DEFAULT_CONFIG,
    ...fixture.config,
    featureRefinementPasses: variant === 'baseline' ? 0 : 1,
    featureRefinementSpacing: DEFAULT_CONFIG.featureRefinementSpacing,
    featureRefinementBudget: DEFAULT_CONFIG.featureRefinementBudget,
  };
  const started = performance.now();
  const world = generateWorld(config, (stage, completed, total) => {
    if (completed < total) {
      process.stderr.write(`${variant}: ${completed}/${total} ${stage}\n`);
    }
  });
  const generationMs = performance.now() - started;
  const memory = process.memoryUsage();
  const peakGenerationRssMiB =
    process.resourceUsage().maxRSS / (process.platform === 'darwin' ? MiB : 1024);
  const baseline: World | undefined =
    variant === 'refined'
      ? deserialize(readFileSync(resolve(snapshotRoot, 'baseline/world.v8')))
      : undefined;
  const shoreCaps = world.featureRefinementPlans!.flatMap((plan) =>
    plan.caps.filter((cap) => cap.features.includes('lake-shores')),
  );
  let previous = 0;
  let previousBefore = 0;
  const selectedShores = shoreCaps.map((cap) => {
    previous = nearestCell(world.grid, ...cap.center, previous);
    if (baseline) {
      previousBefore = nearestCell(baseline.grid, ...cap.center, previousBefore);
    }
    return {
      longitude: (Math.atan2(cap.center[2], cap.center[0]) * 180) / Math.PI,
      latitude: (Math.asin(cap.center[1]) * 180) / Math.PI,
      sourceSpacingMetres: cap.radiusMetres * Math.sqrt(3),
      targetSpacingMetres: cap.targetSpacingMetres,
      nearestAdjacentSpacingBeforeMetres: baseline ? localSpacing(baseline, previousBefore) : null,
      nearestAdjacentSpacingAfterMetres: localSpacing(world, previous),
    };
  });
  let selectedOutsideLakeOutlets = 0;
  let selectedAtLakeOutlets = 0;
  if (baseline) {
    const outletCells = new Set<number>();
    for (const lake of baseline.drainage.lakes) {
      if (lake.outlet < 0 || lake.outflow <= 0) {
        continue;
      }
      for (let incident = 0; incident < 3; incident++) {
        outletCells.add(baseline.grid.triangles[lake.outlet * 3 + incident]);
      }
    }
    for (const cap of world.featureRefinementPlans!.flatMap((plan) => plan.caps)) {
      previousBefore = nearestCell(baseline.grid, ...cap.center, previousBefore);
      if (outletCells.has(previousBefore)) {
        selectedAtLakeOutlets++;
      } else {
        selectedOutsideLakeOutlets++;
      }
    }
  }
  let mixedLakeCells = 0;
  let lakeAreaM2 = 0;
  for (let cell = 0; cell < world.grid.count; cell++) {
    const coverage = world.drainage.lakeCoverage[cell];
    if (coverage > 1e-4 && coverage < 0.9999) {
      mixedLakeCells++;
    }
    lakeAreaM2 += coverage * world.grid.areas[cell] * config.radius ** 2;
  }
  const residual =
    world.drainage.runoffTotal - world.drainage.oceanDischarge - world.drainage.lakeExchange;
  assert.ok(Math.abs(residual) < Math.max(1, world.drainage.runoffTotal) * 1e-8);
  const report = {
    variant,
    config,
    cells: world.grid.count,
    generationMs,
    retainedBuffersMiB: world.bytes / MiB,
    peakGenerationRssMiB,
    afterGenerationMemoryMiB: {
      rss: memory.rss / MiB,
      heap: memory.heapUsed / MiB,
      external: memory.external / MiB,
    },
    spacingMetres: gridSpacing(world.grid, config.radius),
    lakes: world.drainage.lakes.length,
    lakeAreaM2,
    mixedLakeCells,
    runoffRelativeResidual: Math.abs(residual) / Math.max(1, world.drainage.runoffTotal),
    featureStats: world.featureRefinementStats,
    selectedCapLocations: {
      atExistingLakeOutlets: selectedAtLakeOutlets,
      outsideExistingLakeOutlets: selectedOutsideLakeOutlets,
    },
    featureTimings: world.timings.filter(({ name }) => name.startsWith('Final feature ')),
    allTimings: world.timings,
    selectedLakeShoreSpacing: {
      source: distribution(selectedShores.map((shore) => shore.sourceSpacingMetres)),
      plannedTarget: distribution(selectedShores.map((shore) => shore.targetSpacingMetres)),
      actualNearestAdjacentBefore: distribution(
        selectedShores.flatMap((shore) =>
          shore.nearestAdjacentSpacingBeforeMetres === null
            ? []
            : [shore.nearestAdjacentSpacingBeforeMetres],
        ),
      ),
      actualNearestAdjacentAfter: distribution(
        selectedShores.map((shore) => shore.nearestAdjacentSpacingAfterMetres),
      ),
      samples: selectedShores.slice(0, 12),
      nearUserDesert: [...selectedShores]
        .sort(
          (first, second) =>
            (first.latitude - 25.47) ** 2 +
            ((first.longitude - 71) * Math.cos((25.47 * Math.PI) / 180)) ** 2 -
            ((second.latitude - 25.47) ** 2 +
              ((second.longitude - 71) * Math.cos((25.47 * Math.PI) / 180)) ** 2),
        )
        .slice(0, 12),
    },
  };
  const snapshot = resolve(snapshotRoot, variant);
  saveSnapshot(world, snapshot);
  writeFileSync(`${snapshot}/measurement.json`, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(
    `${variant}: completed ${world.grid.count} cells in ${(generationMs / 1000).toFixed(2)}s\n`,
  );
}

if (process.argv[2] === '--worker') {
  measure(process.argv[3] as 'baseline' | 'refined', process.argv[4]);
} else {
  const refinedOnly = process.argv[2] === '--refined-only';
  const firstArgument = refinedOnly ? 3 : 2;
  const output = resolve(
    process.argv[firstArgument] ??
      `${repo}/docs/observations/measurements/final-feature-refinement-2.25.0.json`,
  );
  const snapshotRoot = resolve(
    process.argv[firstArgument + 1] ?? '/tmp/atlas-final-feature-refinement-2.25.0',
  );
  for (const variant of refinedOnly ? ['refined'] : ['baseline', 'refined']) {
    await new Promise<void>((resolveWorker, rejectWorker) => {
      const worker = fork(script, ['--worker', variant, snapshotRoot], { stdio: 'inherit' });
      worker.on('error', rejectWorker);
      worker.on('exit', (code) =>
        code === 0 ? resolveWorker() : rejectWorker(Error(`${variant} exited ${code}`)),
      );
    });
  }
  const baseline = JSON.parse(readFileSync(`${snapshotRoot}/baseline/measurement.json`, 'utf8'));
  const refined = JSON.parse(readFileSync(`${snapshotRoot}/refined/measurement.json`, 'utf8'));
  const budget = Math.floor((baseline.cells * DEFAULT_CONFIG.featureRefinementBudget) / 100);
  const addedCells = refined.cells - baseline.cells;
  assert.ok(addedCells > 0 && addedCells <= budget);
  const report = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      cpu: cpus()[0]?.model,
      generatorThreads: 1,
    },
    fixtureSource: 'docs/observations/measurements/fantasy-density-browser-2.23.1.json',
    methodology: [
      "Same recreated AETHER-2408 Balanced cloud recipe; this is not the user's exact saved snapshot.",
      'Baseline and one final feature pass run in separate fresh Node processes. Each uses the synchronous reference path; timings are single observations, not a multithreaded browser benchmark.',
      'Peak RSS is the process high-water mark captured after generation and before snapshot export; retainedBuffersMiB counts deduplicated World array buffers.',
      'Selected lake-shore source spacing is sqrt(3) times its source-cell circumradius. Paired actual before/after spacing measures the closest adjacent cell centre at the same retained anchor; it is not an assertion that every cell reaches the requested10km target.',
      'Selected cap locations are independently checked against the baseline cells incident to positive-outflow lake outlets; overlapping detector provenance alone does not establish coverage of other feature locations.',
      "Selection reserves half of the estimated work budget equally across active detectors, ranked by each detector's own scores. Unused reserves and the other half return to global priority selection; the insertion cap enforces the actual cell limit.",
      'Browser QA may run concurrently on the same cloud host during the refined measurement. These single observations should not be interpreted as a precise before/after performance ratio.',
      'Encoded graph snapshots and V8 World files live in the requested temporary snapshot directory; no application save or user data is modified.',
    ],
    baseline,
    refined,
    comparison: {
      addedCells,
      hardCellBudget: budget,
      fractionOfBudgetUsed: addedCells / budget,
      retainedBuffersIncreaseMiB: refined.retainedBuffersMiB - baseline.retainedBuffersMiB,
      totalGenerationDifferenceMs: refined.generationMs - baseline.generationMs,
      measuredFinalFeatureStageMs: refined.featureTimings.reduce(
        (sum: number, stage: { ms: number }) => sum + stage.ms,
        0,
      ),
      allActualCellsWithinBudget: refined.cells <= baseline.cells + budget,
    },
  };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output, snapshotRoot, comparison: report.comparison }));
}
