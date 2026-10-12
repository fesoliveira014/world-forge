/** Optional timing runs; no machine-specific performance gates.
 * npm run measure -- [project.json [surfaceLevel [processLevel]]]
 */
import { readFileSync } from 'node:fs';
import { generateWorld } from '../src/core/pipeline';
import { DEFAULT_CONFIG } from '../src/core/model';
import { readWorldProject } from '../src/core/project';

const [projectPath, surfaceOverride, processOverride] = process.argv.slice(2);
const configurations = projectPath
  ? [readWorldProject(JSON.parse(readFileSync(projectPath, 'utf8'))).config]
  : [5, 7].map((surfaceLevel) => ({ ...DEFAULT_CONFIG, surfaceLevel }));

for (const configuration of configurations) {
  const config = {
    ...configuration,
    ...(surfaceOverride ? { surfaceLevel: Number(surfaceOverride) } : {}),
    ...(processOverride ? { processLevel: Number(processOverride) } : {}),
  };
  const world = generateWorld(config);
  console.log(
    JSON.stringify({
      version: world.version,
      config,
      surfaceCells: world.grid.count,
      processCells: world.process.count,
      totalMs: world.elapsed,
      retainedMiB: world.bytes / 1048576,
      stages: world.timings,
      atmosphereRelativeResidual: world.climate.atmosphereResidual,
      oceanFluxDivergence: world.climate.oceanDivergence,
      lakes: world.drainage.lakes.length,
      deposits: world.resources.deposits.length,
      fertilityMiB: world.resources.fertility.byteLength / 1048576,
    }),
  );
}
