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

const surfaceGrid =
  config.processLevel === config.surfaceLevel
    ? processGrid
    : buildGrid(config.surfaceLevel, config.seed, config.irregularity);

const transfer = buildTransfer(processGrid, surfaceGrid);

const geology = buildGeology(processGrid, config);

const initialTerrain = createTerrain(surfaceGrid, processGrid, transfer, geology, config);

const evolutionStartedAt = performance.now();

evolveCrust(processGrid, geology, config);

const evolutionMs = performance.now() - evolutionStartedAt;

const evolvedTerrain = createTerrain(surfaceGrid, processGrid, transfer, geology, config);

let initialOceanArea = 0;

let evolvedOceanArea = 0;

let changedSurfaceArea = 0;

for (let cellIndex = 0; cellIndex < surfaceGrid.count; cellIndex++) {
  initialOceanArea += surfaceGrid.areas[cellIndex] * initialTerrain.ocean[cellIndex];
  evolvedOceanArea += surfaceGrid.areas[cellIndex] * evolvedTerrain.ocean[cellIndex];

  if (initialTerrain.ocean[cellIndex] !== evolvedTerrain.ocean[cellIndex]) {
    changedSurfaceArea += surfaceGrid.areas[cellIndex];
  }
}

const summary = {
  seed: config.seed,
  processCells: processGrid.count,
  surfaceCells: surfaceGrid.count,
  evolutionMs,
  durationMyr: config.tectonicDuration,
  steps: geology.crust!.steps,
  beforeOcean: initialOceanArea / (4 * Math.PI),
  afterOcean: evolvedOceanArea / (4 * Math.PI),
  changedSurfaceFraction: changedSurfaceArea / (4 * Math.PI),
};

console.log(JSON.stringify(summary, null, 2));

if (process.argv[5]) {
  writeFileSync(
    process.argv[5],
    JSON.stringify({
      ...summary,
      positions: Array.from(surfaceGrid.positions),
      triangles: Array.from(surfaceGrid.triangles),
      before: Array.from(initialTerrain.height),
      after: Array.from(evolvedTerrain.height),
      beforeOceanMask: Array.from(initialTerrain.ocean),
      afterOceanMask: Array.from(evolvedTerrain.ocean),
    }),
  );
}
