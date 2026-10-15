/** AETHER-2408 automatic regional adaptation benchmark and browser snapshots.
 * node --import tsx scripts/measure-auto-regions.ts [report.json] [snapshot-directory]
 * Add --analyze-only to reuse both snapshots without generating again.
 * Reuses the recorded v2.25 baseline (same pre-adaptation recipe, 40,962 terrain
 * and weather cells). New generation runs in a fresh process before comparison.
 */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deserialize, serialize } from 'node:v8';
import { DEFAULT_CONFIG, VERSION, type World } from '../src/core/model';
import { generateWorld } from '../src/core/pipeline';
import { encodeGraph } from '../src/core/storage/codec';
import { nearestCell } from '../src/core/grid/build';
import { analyzeLakeDistricts } from '../src/core/grid/feature-districts';
import { prepareQuietLandCoarsening } from '../src/core/grid/coarsen';

const script = fileURLToPath(import.meta.url);
const repo = resolve(dirname(script), '..');
const baselineDirectory = '/tmp/atlas-final-feature-refinement-2.25.0/baseline';
const sourceFixture = 'docs/observations/measurements/fantasy-density-browser-2.23.1.json';
const fixture = JSON.parse(readFileSync(resolve(repo, sourceFixture), 'utf8')).fixture;
const config = {
  ...DEFAULT_CONFIG,
  ...fixture.config,
  featureRefinementPasses: 1,
  featureRefinementSpacing: 10_000,
  featureRefinementBudget: 20,
  featureDistrictStrength: 60,
  featureDistrictRadius: 300_000,
  featureDistrictThreshold: 5,
  featureCoarseningBudget: 10,
  featureCoarseningSpacing: 250_000,
  featureCoarseningTolerance: 25,
};
assert.equal(config.seed, 'AETHER-2408');
assert.equal(config.surfaceLevel, 6);
assert.equal(config.processLevel, 6);

type Point = [number, number, number];
const coordinates = (point: Point) => ({
  longitude: (Math.atan2(point[2], point[0]) * 180) / Math.PI,
  latitude: (Math.asin(point[1]) * 180) / Math.PI,
});
const position = (world: World, cell: number): Point => [
  world.grid.positions[cell * 3],
  world.grid.positions[cell * 3 + 1],
  world.grid.positions[cell * 3 + 2],
];
const distance = (a: Point, b: Point) =>
  Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * config.radius;
function distribution(values: number[]) {
  values.sort((a, b) => a - b);
  const quantile = (q: number) => values[Math.floor((values.length - 1) * q)] ?? null;
  return { count: values.length, p10: quantile(0.1), median: quantile(0.5), p90: quantile(0.9) };
}
function region(world: World, center: Point, radius: number) {
  const spacing: number[] = [];
  let cells = 0;
  let wet = 0;
  let mixed = 0;
  const cosine = Math.cos(radius / config.radius);
  for (let cell = 0; cell < world.grid.count; cell++) {
    const point = position(world, cell);
    if (point[0] * center[0] + point[1] * center[1] + point[2] * center[2] < cosine) {
      continue;
    }
    cells++;
    const water = world.drainage.lakeCoverage[cell];
    if (water > 1e-4) {
      wet++;
    }
    if (water > 1e-4 && water < 0.9999) {
      mixed++;
    }
    spacing.push(Math.sqrt((2 * world.grid.areas[cell]) / Math.sqrt(3)) * config.radius);
  }
  return {
    cells,
    lakeAffectedCells: wet,
    mixedLakeCells: mixed,
    areaEquivalentSpacingMetres: distribution(spacing),
  };
}

function countRegion(world: World, center: Point, radius: number) {
  const cosine = Math.cos(radius / config.radius);
  const points = world.grid.positions;
  let count = 0;
  for (let index = 0; index < points.length; index += 3) {
    if (
      points[index] * center[0] + points[index + 1] * center[1] + points[index + 2] * center[2] >=
      cosine
    ) {
      count++;
    }
  }
  return count;
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

function generate(snapshotRoot: string) {
  const started = performance.now();
  const world = generateWorld(config, (stage, completed, total) => {
    process.stderr.write(`regional: ${completed}/${total} ${stage}\n`);
  });
  const measurement = {
    generationMs: performance.now() - started,
    peakRssMiB: process.resourceUsage().maxRSS / (process.platform === 'darwin' ? 1_048_576 : 1024),
    retainedBuffersMiB: world.bytes / 1_048_576,
    cells: world.grid.count,
    timings: world.timings,
  };
  saveSnapshot(world, resolve(snapshotRoot, 'refined'));
  writeFileSync(
    resolve(snapshotRoot, 'refined/measurement.json'),
    JSON.stringify(measurement, null, 2),
  );
  console.log(JSON.stringify(measurement));
}

if (process.argv[2] === '--worker') {
  generate(process.argv[3]);
} else {
  const analyzeOnly = process.argv[2] === '--analyze-only';
  const argument = analyzeOnly ? 3 : 2;
  const reportPath = resolve(
    process.argv[argument] ?? `${repo}/docs/observations/measurements/auto-regions-2.26.0.json`,
  );
  const snapshotRoot = resolve(
    process.argv[argument + 1] ?? '/tmp/atlas-regional-adaptation-2.26.0',
  );
  mkdirSync(snapshotRoot, { recursive: true });
  if (!existsSync(resolve(snapshotRoot, 'baseline'))) {
    symlinkSync(baselineDirectory, resolve(snapshotRoot, 'baseline'));
  }
  if (!analyzeOnly) {
    await new Promise<void>((done, reject) => {
      const worker = fork(script, ['--worker', snapshotRoot], { stdio: 'inherit' });
      worker.on('error', reject);
      worker.on('exit', (code) =>
        code === 0 ? done() : reject(Error(`Generation exited ${code}`)),
      );
    });
  }
  const baseline: World = deserialize(readFileSync(resolve(snapshotRoot, 'baseline/world.v8')));
  const refined: World = deserialize(readFileSync(resolve(snapshotRoot, 'refined/world.v8')));
  const measurement = JSON.parse(
    readFileSync(resolve(snapshotRoot, 'refined/measurement.json'), 'utf8'),
  );
  const context = { ...baseline, config };
  const started = performance.now();
  const districts = analyzeLakeDistricts(context);
  const masks = prepareQuietLandCoarsening(
    { ...context, radius: config.radius },
    districts.strength,
  );
  const baselineAnalysisMs = performance.now() - started;
  const counts = { districtCells: 0, biomeEligibleCells: 0, protectedCells: 0, quietCandidates: 0 };
  for (let cell = 0; cell < baseline.grid.count; cell++) {
    counts.districtCells += Number(districts.strength[cell] > 0);
    counts.biomeEligibleCells += masks.eligibleCells[cell];
    counts.protectedCells += masks.protectedCells[cell];
    counts.quietCandidates += Number(masks.eligibleCells[cell] > 0 && !masks.protectedCells[cell]);
  }
  const districtCaps = refined.featureRefinementPlans!.flatMap((plan) =>
    plan.caps.filter((cap) => cap.features.includes('lake-districts')),
  );
  const target: Point = [
    Math.cos((25.47 * Math.PI) / 180) * Math.cos((71 * Math.PI) / 180),
    Math.sin((25.47 * Math.PI) / 180),
    Math.cos((25.47 * Math.PI) / 180) * Math.sin((71 * Math.PI) / 180),
  ];
  districtCaps.sort((a, b) => distance(a.center, target) - distance(b.center, target));
  assert.ok(districtCaps.length > 0, 'regional detector must select broad features');
  const lake = districtCaps[0];
  const removals = refined.featureCoarseningPlans?.[0]?.removedCells ?? [];
  const removedPoints = removals.map((cell) => position(baseline, cell));
  let quiet: Point | undefined;
  let quietRadius = 150_000;
  let quietRemoved = 0;
  let largestReduction = 0;
  for (
    let index = 0;
    index < removedPoints.length;
    index += Math.max(1, Math.ceil(removedPoints.length / 256))
  ) {
    const point = removedPoints[index];
    for (const radius of [100_000, 150_000, 200_000, 300_000]) {
      const removed = removedPoints.reduce(
        (sum, other) => sum + Number(distance(point, other) < radius),
        0,
      );
      if (removed < 10) {
        continue;
      }
      const before = countRegion(baseline, point, radius);
      const after = countRegion(refined, point, radius);
      const reduction = (before - after) / before;
      if (reduction > largestReduction) {
        quiet = point;
        quietRadius = radius;
        quietRemoved = removed;
        largestReduction = reduction;
      }
    }
  }
  let riverCorner = -1;
  let flow = -1;
  for (let corner = 0; corner < baseline.rivers.channel.length; corner++) {
    if (!baseline.rivers.channel[corner] || baseline.drainage.discharge[corner] <= flow) {
      continue;
    }
    const point: Point = [
      baseline.grid.corners[corner * 3],
      baseline.grid.corners[corner * 3 + 1],
      baseline.grid.corners[corner * 3 + 2],
    ];
    if (distance(point, lake.center) > 1_200_000) {
      continue;
    }
    riverCorner = corner;
    flow = baseline.drainage.discharge[corner];
  }
  assert.ok(riverCorner >= 0);
  const river: Point = [
    baseline.grid.corners[riverCorner * 3],
    baseline.grid.corners[riverCorner * 3 + 1],
    baseline.grid.corners[riverCorner * 3 + 2],
  ];
  const anchor = (center: Point, radius: number) => ({
    ...coordinates(center),
    radiusMetres: radius,
    before: region(baseline, center, radius),
    after: region(refined, center, radius),
  });
  const sourceCell = nearestCell(baseline.grid, ...target, 0);
  const grossAdded = refined.featureRefinementStats!.reduce(
    (n, pass) => n + pass.afterCells - pass.beforeCells,
    0,
  );
  const grossRemoved = refined.featureCoarseningStats!.reduce(
    (n, pass) => n + pass.removedCells,
    0,
  );
  assert.ok(grossAdded <= Math.floor((baseline.grid.count * config.featureRefinementBudget) / 100));
  assert.ok(
    grossRemoved <= Math.floor((baseline.grid.count * config.featureCoarseningBudget) / 100),
  );
  assert.equal(refined.grid.count, baseline.grid.count + grossAdded - grossRemoved);
  const residual =
    refined.drainage.runoffTotal - refined.drainage.oceanDischarge - refined.drainage.lakeExchange;
  assert.ok(Math.abs(residual) < Math.max(1, refined.drainage.runoffTotal) * 1e-8);
  const report = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    sourceFixture,
    config,
    environment: { node: process.version, cpu: cpus()[0]?.model, generatorThreads: 1 },
    methodology: [
      "Same recreated AETHER-2408 recipe with 40,962 base surface cells and 40,962 weather cells; this is not the user's exact saved snapshot.",
      'Baseline reuses its recorded v2.25 generation. Refined generation runs the current implementation in a fresh synchronous Node process. Timings are single observations, not a browser multithreading comparison.',
      'The baseline feature-mask inspection uses the final saved physical fields; actual generation selects coarsening before its final delta/ecology stage. Reported selected removals and budgets come from generation itself.',
      'Regional spacing is area-equivalent cell spacing within geographic caps, not a promise that each point reaches the requested 10km floor.',
      'Quiet-land screenshot anchor maximizes net cell reduction among up to 256 deterministic removed-site candidates and 100/150/200/300km caps with at least 10 actual removals. Larger 300km context is also reported to expose surrounding fine features. The lake anchor is the selected district nearest 25.47N 71E.',
      'Coarsening and insertion have separate hard budgets against the same pre-pass surface. Removing cells does not expand the insertion allowance.',
      'Temporary encoded graph/V8 snapshots support browser QA; application saving and user data are not touched.',
    ],
    baseline: {
      cells: baseline.grid.count,
      retainedBuffersMiB: baseline.bytes / 1_048_576,
      analysisMs: baselineAnalysisMs,
      ...counts,
      districtCandidates: districts.candidates.length,
      userDesert: {
        ...coordinates(target),
        cell: sourceCell,
        lakeCoverage: baseline.drainage.lakeCoverage[sourceCell],
        districtStrength: districts.strength[sourceCell],
        shorelineDensity: districts.density[sourceCell],
      },
    },
    refined: {
      ...measurement,
      featureStats: refined.featureRefinementStats,
      coarseningStats: refined.featureCoarseningStats,
      selectedDistrictCaps: districtCaps.length,
    },
    comparison: {
      grossAddedCells: grossAdded,
      grossRemovedCells: grossRemoved,
      netAddedCells: refined.grid.count - baseline.grid.count,
      insertionBudget: Math.floor((baseline.grid.count * config.featureRefinementBudget) / 100),
      removalBudget: Math.floor((baseline.grid.count * config.featureCoarseningBudget) / 100),
      runoffRelativeResidual: Math.abs(residual) / Math.max(1, refined.drainage.runoffTotal),
    },
    captureAnchors: {
      lakeDistrict: {
        ...anchor(lake.center, lake.radiusMetres),
        targetSpacingMetres: lake.targetSpacingMetres,
      },
      quietLand: quiet
        ? {
            ...anchor(quiet, quietRadius),
            actualRemovedWithinRegion: quietRemoved,
            contextAt300km: anchor(quiet, 300_000),
            biome: baseline.ecology.biome[nearestCell(baseline.grid, ...quiet, 0)],
          }
        : null,
      river: { ...anchor(river, 200_000), sourceAnnualDischarge: flow },
    },
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      reportPath,
      snapshotRoot,
      comparison: report.comparison,
      captureAnchors: report.captureAnchors,
    }),
  );
}
