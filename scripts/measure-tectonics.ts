import { writeFileSync } from 'node:fs';
import { DEFAULT_CONFIG } from '../src/core/model';
import { buildGrid } from '../src/core/grid/build';
import { buildTransfer } from '../src/core/operators/spatial';
import { buildGeology } from '../src/core/generation/geology';
import { evolveCrust } from '../src/core/generation/crust-evolution';
import { createTerrain } from '../src/core/generation/terrain';

// One optional terrain comparison. No climate reruns or machine-specific timing gate.
const config = {
  ...DEFAULT_CONFIG,
  seed: process.argv[2] ?? DEFAULT_CONFIG.seed,
  processLevel: Number(process.argv[3] ?? 5),
  surfaceLevel: Number(process.argv[4] ?? 6),
};

const processGrid = buildGrid(config.processLevel, config.seed, config.irregularity);

const grid =
  config.processLevel === config.surfaceLevel
    ? processGrid
    : buildGrid(config.surfaceLevel, config.seed, config.irregularity);

const transfer = buildTransfer(processGrid, grid);

const geology = buildGeology(processGrid, config);

const before = createTerrain(grid, processGrid, transfer, geology, config);

const start = performance.now();

evolveCrust(processGrid, geology, config);

const evolutionMs = performance.now() - start;

const after = createTerrain(grid, processGrid, transfer, geology, config);

let beforeOcean = 0;

let afterOcean = 0;

let changed = 0;

for (let i = 0; i < grid.count; i++) {
  beforeOcean += grid.areas[i] * before.ocean[i];
  afterOcean += grid.areas[i] * after.ocean[i];

  if (before.ocean[i] !== after.ocean[i]) {
    changed += grid.areas[i];
  }
}

const summary = {
  seed: config.seed,
  processCells: processGrid.count,
  surfaceCells: grid.count,
  evolutionMs,
  durationMyr: config.tectonicDuration,
  steps: geology.crust!.steps,
  beforeOcean: beforeOcean / (4 * Math.PI),
  afterOcean: afterOcean / (4 * Math.PI),
  changedSurfaceFraction: changed / (4 * Math.PI),
};

console.log(JSON.stringify(summary, null, 2));

if (process.argv[5]) {
  writeFileSync(
    process.argv[5],
    JSON.stringify({
      ...summary,
      positions: Array.from(grid.positions),
      triangles: Array.from(grid.triangles),
      before: Array.from(before.height),
      after: Array.from(after.height),
      beforeOceanMask: Array.from(before.ocean),
      afterOceanMask: Array.from(after.ocean),
    }),
  );
}
