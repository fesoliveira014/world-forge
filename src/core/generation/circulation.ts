import type { Grid, WorldConfig } from '../model';
import { readVector, clamp, cross, dot, createSeededRandom, type Vec3 } from '../math';
import { computeDistances } from '../operators/spatial';
import {
  computeStableTimeStep,
  prepareTransport,
  transportInventory,
} from '../operators/transport';

interface Whorl {
  center: Vec3;
  radius: number;
  strength: number;
}

function atmosphericWhorls(config: WorldConfig, season: number): Whorl[] {
  const randomNumber = createSeededRandom(config.seed + '/atmosphere');
  const whorls: Whorl[] = [];
  const shift = ((Math.sin((season * Math.PI) / 2) * config.obliquity * Math.PI) / 180) * 0.3;

  for (const band of [-65, -32, 0, 32, 65]) {
    for (let whorlIndex = 0; whorlIndex < 7; whorlIndex++) {
      const latitude = ((band + (randomNumber() - 0.5) * 15) * Math.PI) / 180 + shift;
      const longitude = ((whorlIndex + randomNumber() * 0.5) * Math.PI * 2) / 7;
      whorls.push({
        center: [
          Math.cos(latitude) * Math.cos(longitude),
          Math.sin(latitude),
          Math.cos(latitude) * Math.sin(longitude),
        ],
        radius: (0.5 + randomNumber() * 0.35) * config.circulationScale,
        strength:
          (band === 0 ? -1 : Math.sign(band)) *
          (Math.abs(band) > 45 ? -1 : 1) *
          (7 + randomNumber() * 7),
      });
    }
  }

  return whorls;
}

export function windField(
  grid: Grid,
  height: Float32Array,
  config: WorldConfig,
  season: number,
  heightGradient: Float32Array,
) {
  const whorls = atmosphericWhorls(config, season);
  const wind = new Float32Array(grid.count * 3);
  const shift = ((Math.sin((season * Math.PI) / 2) * config.obliquity * Math.PI) / 180) * 0.3;

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    const position = readVector(grid.positions, cellIndex);
    let velocityX = 0;
    let velocityY = 0;
    let velocityZ = 0;

    for (const whorl of whorls) {
      const cosineDistance = dot(position, whorl.center);

      if (cosineDistance < Math.cos(whorl.radius)) {
        continue;
      }

      const angularDistance = Math.acos(clamp(cosineDistance, -1, 1));
      const tangent = cross(whorl.center, position);
      const whorlWeight =
        (whorl.strength * Math.pow(1 - angularDistance / whorl.radius, 2)) /
        Math.max(0.12, Math.sin(angularDistance));
      velocityX += tangent[0] * whorlWeight;
      velocityY += tangent[1] * whorlWeight;
      velocityZ += tangent[2] * whorlWeight;
    }

    // Weak zonal background preserves a rotation-consistent Earth-like preset.
    const latitude = Math.asin(position[1]) - shift;
    const zonal = -Math.cos(latitude * 6) * 2.2;
    velocityX += position[2] * zonal;
    velocityZ -= position[0] * zonal;
    const gradientX = heightGradient[cellIndex * 3];
    const gradientY = heightGradient[cellIndex * 3 + 1];
    const gradientZ = heightGradient[cellIndex * 3 + 2];
    const upslopeVelocity = Math.max(
      0,
      velocityX * gradientX + velocityY * gradientY + velocityZ * gradientZ,
    );
    const gradientSquared = gradientX * gradientX + gradientY * gradientY + gradientZ * gradientZ;
    const diversion =
      gradientSquared > 0
        ? (clamp(Math.sqrt(gradientSquared) * 350) * 0.7 * upslopeVelocity) / gradientSquared
        : 0;
    const drag = 1 / (1 + Math.max(0, height[cellIndex]) / 9000);
    wind[cellIndex * 3] = (velocityX - diversion * gradientX) * drag * config.windStrength;
    wind[cellIndex * 3 + 1] = (velocityY - diversion * gradientY) * drag * config.windStrength;
    wind[cellIndex * 3 + 2] = (velocityZ - diversion * gradientZ) * drag * config.windStrength;
  }

  return { wind, gradient: heightGradient };
}

export function thermalBaseline(
  grid: Grid,
  height: Float32Array,
  ocean: Uint8Array,
  config: WorldConfig,
  season: number,
) {
  const temperature = new Float32Array(grid.count);
  const phase = Math.sin((season * Math.PI) / 2);

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    const latitude = Math.asin(grid.positions[cellIndex * 3 + 1]);
    const seasonal =
      phase * Math.sin(latitude) * config.obliquity * (ocean[cellIndex] ? 0.13 : 0.7);
    temperature[cellIndex] =
      config.temperature +
      14 -
      45 * Math.pow(Math.abs(Math.sin(latitude)), 2.5) +
      seasonal -
      Math.max(0, height[cellIndex]) * 0.006;
  }

  return temperature;
}

/** Coast geometry is unchanged across the four seasons of one climate pass. */
export function prepareOceanGeometry(
  grid: Grid,
  ocean: Uint8Array,
  radius: number,
  referenceOcean: Uint8Array,
) {
  const landCells: number[] = [];
  const referenceLandCells: number[] = [];

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    if (!ocean[cellIndex]) {
      landCells.push(cellIndex);
    }
    if (!referenceOcean[cellIndex]) {
      referenceLandCells.push(cellIndex);
    }
  }

  return {
    referenceOcean,
    coastDistance: computeDistances(grid, landCells, radius),
    referenceDistance: computeDistances(grid, referenceLandCells, radius),
  };
}

/** Prescribed streamfunction; shared edge flux is authoritative, displayed vectors are reconstructed. */
export function oceanCirculation(
  grid: Grid,
  ocean: Uint8Array,
  baseline: Float32Array,
  config: WorldConfig,
  season: number,
  geometry: ReturnType<typeof prepareOceanGeometry>,
) {
  const randomNumber = createSeededRandom(config.seed + '/gyres');
  const whorls: Whorl[] = [];
  const planetRadius = config.radius;
  const { coastDistance, referenceDistance, referenceOcean } = geometry;

  // Centers depend on the fixed process grid, never the selected surface subdivision.
  for (let band = -1; band <= 1; band += 2) {
    for (let whorlIndex = 0; whorlIndex < 5; whorlIndex++) {
      let best = -1;
      let score = -1;

      for (let trialIndex = 0; trialIndex < 80; trialIndex++) {
        const cellIndex = Math.floor(randomNumber() * grid.count);
        const latitude = grid.positions[cellIndex * 3 + 1];

        if (!referenceOcean[cellIndex] || latitude * band < 0.08 || latitude * band > 0.87) {
          continue;
        }

        let separation = 1;

        for (const whorl of whorls) {
          separation = Math.min(
            separation,
            1 - dot(readVector(grid.positions, cellIndex), whorl.center),
          );
        }

        const candidateScore = referenceDistance[cellIndex] * Math.min(0.7, separation);

        if (candidateScore > score) {
          score = candidateScore;
          best = cellIndex;
        }
      }

      if (best >= 0) {
        whorls.push({
          center: readVector(grid.positions, best),
          radius: 0.45 + randomNumber() * 0.55,
          strength:
            band * (0.7 + randomNumber() * 0.5) * (1 + 0.08 * Math.sin((season * Math.PI) / 2)),
        });
      }
    }
  }

  const cornerCount = grid.corners.length / 3;
  const streamFunction = new Float64Array(cornerCount);

  for (let cornerIndex = 0; cornerIndex < cornerCount; cornerIndex++) {
    const firstCell = grid.triangles[cornerIndex * 3];
    const secondCell = grid.triangles[cornerIndex * 3 + 1];
    const thirdCell = grid.triangles[cornerIndex * 3 + 2];

    if (!ocean[firstCell] || !ocean[secondCell] || !ocean[thirdCell]) {
      continue;
    }

    const position = readVector(grid.corners, cornerIndex);
    let streamValue = 0;

    for (const whorl of whorls) {
      const cosineDistance = dot(position, whorl.center);

      if (cosineDistance > Math.cos(whorl.radius)) {
        const normalizedDistance = Math.acos(clamp(cosineDistance, -1, 1)) / whorl.radius;
        streamValue += whorl.strength * Math.pow(1 - normalizedDistance * normalizedDistance, 3);
      }
    }

    const coastFactor = clamp(
      Math.min(coastDistance[firstCell], coastDistance[secondCell], coastDistance[thirdCell]) /
        800000,
    );
    streamFunction[cornerIndex] =
      streamValue * coastFactor * planetRadius * 0.12 * config.currentStrength;
  }

  const flux = new Float64Array(grid.edgeLength.length);
  const current = new Float32Array(grid.count * 3);
  const divergence = new Float64Array(grid.count);

  for (let edgeIndex = 0; edgeIndex < flux.length; edgeIndex++) {
    const firstCell = grid.edgeCells[edgeIndex * 2];
    const secondCell = grid.edgeCells[edgeIndex * 2 + 1];

    if (!ocean[firstCell] || !ocean[secondCell]) {
      continue;
    }

    const edgeFlux =
      streamFunction[grid.edgeCorners[edgeIndex * 2 + 1]] -
      streamFunction[grid.edgeCorners[edgeIndex * 2]];
    flux[edgeIndex] = edgeFlux;
    divergence[firstCell] += edgeFlux;
    divergence[secondCell] -= edgeFlux;
    const velocity = edgeFlux / Math.max(1, grid.edgeLength[edgeIndex] * planetRadius);

    for (let axisIndex = 0; axisIndex < 3; axisIndex++) {
      current[firstCell * 3 + axisIndex] += velocity * grid.edgeNormal[edgeIndex * 3 + axisIndex];
      current[secondCell * 3 + axisIndex] += velocity * grid.edgeNormal[edgeIndex * 3 + axisIndex];
    }
  }

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    let radial = 0;

    for (let axisIndex = 0; axisIndex < 3; axisIndex++) {
      radial += current[cellIndex * 3 + axisIndex] * grid.positions[cellIndex * 3 + axisIndex];
    }

    for (let axisIndex = 0; axisIndex < 3; axisIndex++) {
      current[cellIndex * 3 + axisIndex] =
        ((current[cellIndex * 3 + axisIndex] - radial * grid.positions[cellIndex * 3 + axisIndex]) *
          2) /
        (grid.offsets[cellIndex + 1] - grid.offsets[cellIndex]);
    }
  }

  const inventory = new Float64Array(grid.count);
  const delta = new Float64Array(grid.count);
  const timeStep = computeStableTimeStep(grid, flux, planetRadius, 5 * 86400);
  const horizon = 180 * 86400;
  const transport = prepareTransport(grid, flux, planetRadius);
  const equilibrium = new Float64Array(grid.count);

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    equilibrium[cellIndex] =
      grid.areas[cellIndex] * planetRadius * planetRadius * baseline[cellIndex];
    inventory[cellIndex] = equilibrium[cellIndex];
  }

  for (let time = 0; time < horizon;) {
    const step = Math.min(timeStep, horizon - time);
    transportInventory(transport, inventory, delta, step);
    const relax = 1 - Math.exp(-step / (70 * 86400));

    for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
      inventory[cellIndex] += (equilibrium[cellIndex] - inventory[cellIndex]) * relax;
    }

    time += step;
  }

  const seaSurfaceTemperature = new Float32Array(grid.count);
  let maxDivergence = 0;

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    seaSurfaceTemperature[cellIndex] = Math.max(
      -1.8,
      inventory[cellIndex] / (grid.areas[cellIndex] * planetRadius * planetRadius),
    );
    maxDivergence = Math.max(maxDivergence, Math.abs(divergence[cellIndex]));
  }

  return { flux, current, sst: seaSurfaceTemperature, maxDivergence };
}
