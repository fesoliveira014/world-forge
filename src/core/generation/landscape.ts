import type { Climate, Geology, Grid, Terrain, WorldConfig } from '../model';
import { clamp, createNoise } from '../math';
import { restrictSurface } from '../operators/spatial';
import { referencePoint } from './crust-evolution';
import { sampleUplift } from './geology';
import { classifyWater } from './terrain';
import { depositInBasins } from './sediment';
import { erodeOutlets } from './outlet-erosion';

/** Integrated landscape aging under the provisional climate, not a paleoclimate solve.
 * Work on the process grid in physical units, then apply the height correction to
 * the fine surface. The one final climate/drainage pass sees all changed coasts.
 */
export function weatherLandscape(
  grid: Grid,
  processGrid: Grid,
  surfaceToProcess: Uint32Array,
  geology: Geology,
  terrain: Terrain,
  climate: Climate,
  config: WorldConfig,
): number {
  if (config.erosion === 0 || config.tectonicDuration === 0) {
    return 0;
  }

  const surface = restrictSurface(
    grid,
    processGrid,
    surfaceToProcess,
    terrain.height,
    terrain.ocean,
  );
  const height = surface.height;
  const initialHeight = new Float32Array(height);
  const oceanMask = new Uint8Array(surface.ocean);
  const diffusivity = new Float64Array(processGrid.count);
  const waves = new Float64Array(processGrid.count);
  const background = new Float64Array(processGrid.count);
  const outletDepth = new Float32Array(processGrid.count);
  const change = new Float64Array(processGrid.count);
  const rock = createNoise(config.seed + '/erodibility');
  const radius2 = config.radius ** 2;
  let dtLimit = config.tectonicDuration;

  for (let processCell = 0; processCell < processGrid.count; processCell++) {
    let rain = 0;
    let potentialEvapotranspiration = 0;
    let speed = 0;
    let temperature = 0;

    for (let seasonIndex = 0; seasonIndex < 4; seasonIndex++) {
      rain += climate.rain[seasonIndex][processCell];
      potentialEvapotranspiration += climate.pet[seasonIndex][processCell];
      temperature += climate.temperature[seasonIndex][processCell] / 4;
      speed +=
        Math.hypot(...climate.wind[seasonIndex].subarray(processCell * 3, processCell * 3 + 3)) / 4;
    }

    const x = processGrid.positions[processCell * 3];
    const y = processGrid.positions[processCell * 3 + 1];
    const z = processGrid.positions[processCell * 3 + 2];
    const materialPosition = geology.crust
      ? referencePoint(geology.crust.inverse, geology.plate[processCell], x, y, z)
      : [x, y, z];
    const scale = config.radius / 180000;
    const erodibility =
      0.8 +
      0.7 *
        rock(materialPosition[0] * scale, materialPosition[1] * scale, materialPosition[2] * scale);
    const wetness = clamp(rain / 1200);
    const aridity = clamp(1 - rain / Math.max(1, potentialEvapotranspiration));
    const active = Math.max(
      clamp(geology.uplift[processCell] / 3500),
      (geology.crust?.volcanic[processCell] ?? 0) > 500
        ? Math.exp(-(geology.crust?.volcanicAge[processCell] ?? 0) / 20)
        : 0,
    );
    // Cold high-latitude terrain retains younger drainage. This is a preservation
    // proxy; no ice-sheet excavation or glacial chronology is claimed.
    const coldRegion = clamp((Math.abs(y) - 0.7) / 0.22) * clamp((8 - temperature) / 15);
    const ageFraction = (1 - active * 0.85) * (1 - coldRegion * 0.8);
    const strength = config.erosion * erodibility * ageFraction;
    diffusivity[processCell] = (12000000 + wetness * 48000000) * strength; // effective m²/Myr
    waves[processCell] = 100000000 * config.waveErosion * strength * (0.4 + speed / 12);
    // Rain weathers exposed relief. Wind strips dry weathered material at a much
    // smaller rate; it does not plane off entire bedrock mountain ranges.
    background[processCell] =
      strength *
      (wetness * 1.5 * Math.sqrt(Math.max(0, height[processCell]) / 1000) +
        config.windErosion * 0.35 * aridity ** 2 * (speed / 10) ** 2);
    outletDepth[processCell] =
      config.tectonicDuration * strength * (0.8 + wetness * 1.8) * (1 - config.lakePersistence);
    let geometry = 0;

    for (
      let neighborOffset = processGrid.offsets[processCell];
      neighborOffset < processGrid.offsets[processCell + 1];
      neighborOffset++
    ) {
      const edgeIndex = processGrid.arcEdges[neighborOffset];
      geometry += processGrid.edgeLength[edgeIndex] / processGrid.edgeDistance[edgeIndex];
    }

    const conductance = Math.max(diffusivity[processCell], waves[processCell]) * geometry;

    if (conductance > 0) {
      dtLimit = Math.min(dtLimit, (0.35 * processGrid.areas[processCell] * radius2) / conductance);
    }
  }

  const steps = Math.ceil(config.tectonicDuration / dtLimit);
  const timeStep = config.tectonicDuration / steps;

  for (let step = 0; step < steps; step++) {
    change.fill(0);

    for (let processCell = 0; processCell < processGrid.count; processCell++) {
      if (oceanMask[processCell]) {
        continue;
      }

      let detachment = 0;
      let exposed = false;

      for (
        let neighborOffset = processGrid.offsets[processCell];
        neighborOffset < processGrid.offsets[processCell + 1];
        neighborOffset++
      ) {
        const neighborCell = processGrid.neighbors[neighborOffset];
        const edgeIndex = processGrid.arcEdges[neighborOffset];
        const geometry = processGrid.edgeLength[edgeIndex] / processGrid.edgeDistance[edgeIndex];

        if (oceanMask[neighborCell]) {
          exposed = true;
          // Waves approach a shallow abrasion platform, not the abyssal seafloor.
          detachment += waves[processCell] * geometry * Math.max(0, height[processCell] + 30);
        } else {
          detachment +=
            diffusivity[processCell] *
            geometry *
            Math.max(0, height[processCell] - height[neighborCell]);
        }
      }

      const erosionDepth =
        timeStep *
        (detachment / (processGrid.areas[processCell] * radius2) + background[processCell]);
      change[processCell] = Math.min(
        Math.max(0, height[processCell] - (exposed ? -30 : 0)),
        erosionDepth,
      );
    }

    for (let processCell = 0; processCell < processGrid.count; processCell++) {
      height[processCell] -= change[processCell];
    }

    // Only ocean-connected cells expose the next coastline to wave attack.
    for (let processCell = 0; processCell < processGrid.count; processCell++) {
      if (!oceanMask[processCell] && height[processCell] < 0) {
        for (
          let neighborOffset = processGrid.offsets[processCell];
          neighborOffset < processGrid.offsets[processCell + 1];
          neighborOffset++
        ) {
          if (oceanMask[processGrid.neighbors[neighborOffset]]) {
            oceanMask[processCell] = 1;
            break;
          }
        }
      }
    }
  }

  const correction = Float32Array.from(
    height,
    (elevation, processCell) => elevation - initialHeight[processCell],
  );
  const sediment = new Float64Array(grid.count);

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    if (terrain.ocean[cellIndex]) {
      continue;
    }

    const erosionDepth = Math.max(
      0,
      -sampleUplift(
        processGrid,
        correction,
        grid.positions[cellIndex * 3],
        grid.positions[cellIndex * 3 + 1],
        grid.positions[cellIndex * 3 + 2],
        surfaceToProcess[cellIndex],
      ),
    );
    const previousHeight = terrain.height[cellIndex];
    const loose = Math.min(erosionDepth, terrain.sediment[cellIndex]);
    terrain.sediment[cellIndex] -= loose;
    terrain.bedrock[cellIndex] -= erosionDepth - loose;
    terrain.height[cellIndex] = terrain.bedrock[cellIndex] + terrain.sediment[cellIndex];
    sediment[cellIndex] =
      (previousHeight - terrain.height[cellIndex]) * grid.areas[cellIndex] * radius2;
  }

  Object.assign(terrain, classifyWater(grid, terrain.height, config.radius));

  // Detachment is limited by sea level in enclosed interiors. Only an actual
  // connection to the ocean permits shoreline retreat below the datum.
  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    if (!terrain.ocean[cellIndex] && terrain.height[cellIndex] < 0) {
      const returned = -terrain.height[cellIndex];
      terrain.bedrock[cellIndex] += returned;
      terrain.height[cellIndex] = 0;
      sediment[cellIndex] = Math.max(
        0,
        sediment[cellIndex] - returned * grid.areas[cellIndex] * radius2,
      );
    }
  }

  const exported = depositInBasins(grid, terrain, sediment, config);
  const incisionBudget = Float32Array.from(
    surfaceToProcess,
    (processCell) => outletDepth[processCell],
  );

  return exported + erodeOutlets(grid, terrain, incisionBudget, config);
}
