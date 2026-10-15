/** Engineering estimates from complete measured runs, never runtime cutoffs.
 * node --import tsx scripts/estimate-cost.ts report.json [report2.json ...]
 *   --surface-cells 1000000 --process-level 7 --batches 12 --remeshes 2
 * Cell count is an explicit planning estimate, not inferred from a spacing slider.
 */
import { readFileSync } from 'node:fs';

interface Measurement {
  version: string;
  surfaceCells: number;
  processCells: number;
  totalMs: number;
  config: { landscapeBatches: number; evolutionRefinements: number };
  stages: { name: string; ms: number }[];
  memory: { processPeakRssMiB: number };
  environment?: { memoryLimitMiB?: number; generatorThreads?: number };
  execution?: { climateWorkers: number };
}

type Group = 'climate' | 'process' | 'refinement' | 'landscape' | 'surface';

function groupFor(name: string): Group {
  if (/climate/i.test(name)) {
    return 'climate';
  }
  if (/Simulation grid|Plates & tectonics|Crust evolution/.test(name)) {
    return 'process';
  }
  if (
    /refinement plan|refinement cost estimate|surface mesh|terrain remesh|spatial transfer/i.test(
      name,
    )
  ) {
    return 'refinement';
  }
  if (/landscape evolution|Fine hillslope|Fine wind|Landscape water & drainage/.test(name)) {
    return 'landscape';
  }
  return 'surface';
}

const args = process.argv.slice(2);
function option(name: string, fallback?: number) {
  const index = args.indexOf(name);
  if (index < 0) {
    if (fallback !== undefined) {
      return fallback;
    }
    throw Error(`${name} is required.`);
  }
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value) || value < 0) {
    throw Error(`${name} must be a finite nonnegative number.`);
  }
  args.splice(index, 2);
  return value;
}

try {
  const surfaceCells = option('--surface-cells');
  const processLevel = option('--process-level');
  const batches = option('--batches', 12);
  const remeshes = option('--remeshes', 2);
  if (
    !Number.isSafeInteger(surfaceCells) ||
    surfaceCells < 12 ||
    !Number.isInteger(processLevel) ||
    processLevel < 3 ||
    processLevel > 7 ||
    !Number.isInteger(batches) ||
    batches < 1 ||
    batches > 12 ||
    !Number.isInteger(remeshes) ||
    remeshes > 2
  ) {
    throw Error(
      'Use a positive integer surface count, process level 3–7, 1–12 batches, and 0–2 remeshes.',
    );
  }
  if (!args.length || args.some((arg) => arg.startsWith('--'))) {
    throw Error('Provide at least one complete measurement JSON file.');
  }
  const reports: Measurement[] = args.flatMap((path) => {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(value) ? value : [value];
  });
  for (const report of reports) {
    if (
      !(report.surfaceCells > 0) ||
      !(report.processCells > 0) ||
      !(report.totalMs > 0) ||
      !Array.isArray(report.stages) ||
      !report.memory ||
      !(report.memory.processPeakRssMiB > 0) ||
      !Number.isInteger(report.config?.landscapeBatches) ||
      report.config.landscapeBatches < 1 ||
      !Number.isInteger(report.config?.evolutionRefinements) ||
      report.config.evolutionRefinements < 0
    ) {
      throw Error('Every input must be a complete successful generation report.');
    }
  }
  if (new Set(reports.map((report) => report.version)).size !== 1) {
    throw Error('Cost calibration requires measurements of the same generator version.');
  }
  const climateWorkers = (report: Measurement) =>
    report.execution?.climateWorkers ?? report.environment?.generatorThreads ?? 1;
  if (new Set(reports.map(climateWorkers)).size !== 1) {
    throw Error(
      'Cost calibration requires the same climate worker count. Compare serial and parallel runs separately.',
    );
  }
  const processCells = 10 * 4 ** processLevel + 2;
  if (surfaceCells < processCells) {
    throw Error('The estimated surface count cannot be smaller than the process grid.');
  }
  const groups: Group[] = ['climate', 'process', 'refinement', 'landscape', 'surface'];
  const estimates = groups.map((group) => {
    const processOwned = group === 'climate' || group === 'process';
    const points = reports
      .map((report) => {
        const repetitions =
          group === 'landscape'
            ? report.config.landscapeBatches
            : group === 'refinement'
              ? 1 + report.config.evolutionRefinements
              : 1;
        return {
          cells: processOwned ? report.processCells : report.surfaceCells,
          ms:
            report.stages
              .filter((stage) => groupFor(stage.name) === group)
              .reduce((sum, stage) => sum + stage.ms, 0) / repetitions,
        };
      })
      .filter((point) => point.ms > 0)
      .sort((first, second) => first.cells - second.cells);
    if (!points.length) {
      return { group, estimatedMs: 0, exponent: null, fit: 'No measured stages in this group.' };
    }
    const smallest = points[0];
    const largest = points.at(-1)!;
    const calibrated = largest.cells / smallest.cells > 1.5;
    const exponent = calibrated
      ? Math.log(largest.ms / smallest.ms) / Math.log(largest.cells / smallest.cells)
      : group === 'climate'
        ? 2
        : group === 'process'
          ? 1.5
          : 1;
    const cells = processOwned ? processCells : surfaceCells;
    const repetitions = group === 'landscape' ? batches : group === 'refinement' ? 1 + remeshes : 1;
    return {
      group,
      estimatedMs: largest.ms * (cells / largest.cells) ** exponent * repetitions,
      exponent,
      fit: calibrated
        ? 'Power fitted to the smallest and largest measured grids.'
        : 'Uncalibrated model: diffusion-limited climate N²; process evolution N^1.5; surface work N. Add another measured resolution.',
    };
  });
  const estimatedMs = estimates.reduce((sum, entry) => sum + entry.estimatedMs, 0);
  const largest = reports.reduce((first, second) =>
    first.memory.processPeakRssMiB > second.memory.processPeakRssMiB ? first : second,
  );
  const estimatedPeakRssMiB =
    largest.memory.processPeakRssMiB *
    Math.max(surfaceCells / largest.surfaceCells, processCells / largest.processCells);
  console.log(
    JSON.stringify(
      {
        kind: 'planning-estimate-not-measurement',
        generatorVersion: reports[0].version,
        climateWorkers: climateWorkers(reports[0]),
        target: { surfaceCells, processCells, batches, remeshes },
        estimatedMinutes: estimatedMs / 60000,
        sensitivityMinutes: { halfCost: estimatedMs / 120000, doubleCost: estimatedMs / 30000 },
        estimatedPeakRssMiB,
        memoryLimitMiB: largest.environment?.memoryLimitMiB ?? null,
        pagingAssessment:
          'Compare a completed run with actual available memory. This forecast cannot establish that a recipe fits; saved-plan JS arrays, remesh overlap, renderer buffers and GC peaks can vary.',
        groups: estimates,
        assumptions: [
          'Same seed, physical parameters, stage algorithm, and executor as the measured runs.',
          'Final surface-cell count must be provided explicitly; adaptive selection is geography-dependent.',
          'Batch and refinement costs normalized by their counts; intermediate mesh growth is approximated by final size.',
          'Half/double values are sensitivity bounds, not a statistical confidence interval or execution deadline.',
          'Every requested generation runs to completion; this estimate never changes spacing or truncates refinement.',
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
