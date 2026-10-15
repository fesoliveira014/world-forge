/** Generate AETHER-2408 with 40,962 terrain/weather seed cells and report salts.
 * node --import tsx scripts/measure-salinity.ts [browser-fixture-directory]
 * Optional fixture output uses the ordinary snapshot graph; no render substitutes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_CONFIG, VERSION } from '../src/core/model';
import { generateWorld } from '../src/core/pipeline';
import { encodeGraph } from '../src/core/storage/codec';
import { lakeAtCell } from '../src/core/generation/lake-state';

const config = {
  ...DEFAULT_CONFIG,
  seed: 'AETHER-2408',
  surfaceLevel: 6,
  processLevel: 6,
};
const world = generateWorld(config, (stage, completed, total) => {
  process.stderr.write(`${completed}/${total} ${stage}\n`);
});
const classes = { fresh: 0, brackish: 0, saline: 0, hypersaline: 0, dry: 0 };
for (const lake of world.drainage.lakes) {
  const concentration = lake.salinity?.concentration ?? 0;
  classes[
    lake.storage <= 0
      ? 'dry'
      : concentration < 0.5
        ? 'fresh'
        : concentration < 5
          ? 'brackish'
          : concentration < 50
            ? 'saline'
            : 'hypersaline'
  ]++;
}
const candidates: {
  cell: number;
  latitude: number;
  longitude: number;
  biome: number;
  lakeId: number;
  concentration: number;
  soilConcentration: number;
  affectedFraction: number;
  fertility: number;
}[] = [];
let affectedArea = 0;
for (let cell = 0; cell < world.grid.count; cell++) {
  const fraction = world.drainage.soilSalinityFraction?.[cell] ?? 0;
  const soilConcentration = world.drainage.soilSalinity?.[cell] ?? 0;
  if (soilConcentration >= 0.5) {
    affectedArea += fraction * world.grid.areas[cell] * config.radius ** 2;
  }
  const lake = lakeAtCell(world.grid, world.drainage, cell);
  if (!lake?.salinity || lake.salinity.concentration < 0.5) {
    continue;
  }
  candidates.push({
    cell,
    latitude: (Math.asin(world.grid.positions[cell * 3 + 1]) * 180) / Math.PI,
    longitude:
      (Math.atan2(world.grid.positions[cell * 3 + 2], world.grid.positions[cell * 3]) * 180) /
      Math.PI,
    biome: world.ecology.biome[cell],
    lakeId: lake.id,
    concentration: lake.salinity.concentration,
    soilConcentration,
    affectedFraction: fraction,
    fertility: world.resources.fertility[cell],
  });
}
candidates.sort((a, b) => b.affectedFraction - a.affectedFraction);
const report = {
  version: VERSION,
  config,
  surfaceCells: world.grid.count,
  weatherCells: world.process.count,
  elapsedMs: world.elapsed,
  retainedMiB: world.bytes / 1048576,
  salinityStage: world.timings.find((stage) => stage.name === 'Lake salts & soil salinity'),
  budget: world.drainage.salinityBudget,
  lakeClasses: classes,
  saltAffectedAreaKm2: affectedArea / 1e6,
  candidates: candidates.slice(0, 20),
  desertCandidates: candidates.filter((cell) => cell.biome === 6).slice(0, 20),
};
mkdirSync('docs/observations/measurements', { recursive: true });
writeFileSync(
  `docs/observations/measurements/salinity-${VERSION}.json`,
  JSON.stringify(report, null, 2) + '\n',
);
if (process.argv[2]) {
  const directory = resolve(process.argv[2]);
  mkdirSync(directory, { recursive: true });
  const graph = encodeGraph(world);
  const replacer = (_key: string, value: unknown) =>
    value === undefined
      ? { __qaUndefined: 1 }
      : typeof value === 'number' && !Number.isFinite(value)
        ? { __qaNumber: String(value) }
        : value;
  writeFileSync(
    `${directory}/graph.json`,
    JSON.stringify({ manifest: graph.manifest, nodes: graph.nodes }, replacer),
  );
  for (let buffer = 0; buffer < graph.manifest.buffers.length; buffer++) {
    for (let page = 0; page < graph.manifest.buffers[buffer].pages; page++) {
      writeFileSync(`${directory}/${buffer}-${page}.bin`, new Uint8Array(graph.page(buffer, page)));
    }
  }
}
console.log(JSON.stringify(report, null, 2));
