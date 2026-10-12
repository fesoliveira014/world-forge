import type { Grid, WorldConfig, Geology, Plate } from '../model';
import {
  readVector,
  clamp,
  cross,
  dot,
  createNoise,
  normalizeVector,
  createSeededRandom,
  randomSpherePoint,
  MinHeap,
} from '../math';

export function createTerrainSampler(config: WorldConfig) {
  const sampleTerrainNoise = createNoise(config.seed + '/terrain');
  const sampleCrustNoise = createNoise(config.seed + '/crust');
  const valleys = createNoise(config.seed + '/valleys');
  const valleyScale = config.radius / 200000;

  return (x: number, y: number, z: number) => {
    const warpedX = x + 0.22 * sampleTerrainNoise(x * 2 + 14, y * 2, z * 2);
    const warpedY = y + 0.22 * sampleTerrainNoise(x * 2, y * 2 + 27, z * 2);
    const warpedZ = z + 0.22 * sampleTerrainNoise(x * 2, y * 2, z * 2 + 41);
    const scale = config.continentScale;
    const continent =
      sampleCrustNoise(
        (warpedX * 1.65) / scale + 4,
        (warpedY * 1.65) / scale + 9,
        (warpedZ * 1.65) / scale + 7,
      ) *
        0.8 +
      sampleCrustNoise((warpedX * 3.4) / scale, (warpedY * 3.4) / scale, (warpedZ * 3.4) / scale) *
        0.2;
    const inherited =
      sampleTerrainNoise(warpedX * 4, warpedY * 4, warpedZ * 4) * 350 +
      sampleTerrainNoise(warpedX * 9, warpedY * 9, warpedZ * 9) * 120 +
      sampleTerrainNoise(warpedX * 22, warpedY * 22, warpedZ * 22) * 40 +
      sampleTerrainNoise(warpedX * 53, warpedY * 53, warpedZ * 53) * 12;

    return {
      continental: clamp(0.5 + continent * 1.6),
      base: continent * 12500 + inherited,
      // Low relief at a fixed physical scale gives plains shared valleys and divides.
      // It is applied after the continental height compression, which otherwise reduces
      // the inherited detail to a few metres and leaves long, almost parallel slopes.
      lowlandRelief:
        0.75 * valleys(warpedX * valleyScale, warpedY * valleyScale, warpedZ * valleyScale) +
        0.25 *
          valleys(warpedX * valleyScale * 2, warpedY * valleyScale * 2, warpedZ * valleyScale * 2),
      mountainTexture:
        1 +
        0.16 * sampleTerrainNoise(warpedX * 22, warpedY * 22, warpedZ * 22) +
        0.08 * sampleTerrainNoise(warpedX * 53, warpedY * 53, warpedZ * 53),
      age: clamp(0.5 + sampleTerrainNoise(x * 3 + 20, y * 3, z * 3) * 0.5) * 220,
    };
  };
}

export function buildGeology(grid: Grid, config: WorldConfig): Geology {
  const randomNumber = createSeededRandom(config.seed + '/plates');
  const plates: Plate[] = [];
  const owner = new Uint16Array(grid.count).fill(65535);
  const frontiers: number[][] = [];
  const plateCount = config.plates;
  const weights = Array.from({ length: plateCount }, (_, plateIndex) =>
    plateIndex < Math.ceil(plateCount * 0.45)
      ? 3 + randomNumber() * 6
      : plateIndex < Math.ceil(plateCount * 0.8)
        ? 0.5 + randomNumber() * 1.2
        : 0.05 + randomNumber() * 0.22,
  );
  const weightSum = weights.reduce((totalWeight, weight) => totalWeight + weight, 0);

  for (let plateIndex = 0; plateIndex < plateCount; plateIndex++) {
    let seed = 0;
    let best = -1;

    // Major seeds spread out; late small seeds may grow into enclosed microplates.
    for (let trial = 0; trial < 30; trial++) {
      const candidate = Math.floor(randomNumber() * grid.count);

      if (owner[candidate] !== 65535) {
        continue;
      }

      let distance = 2;

      for (const plate of plates) {
        distance = Math.min(
          distance,
          1 - dot(readVector(grid.positions, candidate), readVector(grid.positions, plate.seed)),
        );
      }

      const score = plateIndex < Math.ceil(plateCount * 0.45) ? distance : randomNumber();

      if (score > best) {
        best = score;
        seed = candidate;
      }
    }

    const axis = randomSpherePoint(randomNumber);
    const speed = 0.35 + randomNumber() * 0.8;
    plates.push({
      seed,
      target: (4 * Math.PI * weights[plateIndex]) / weightSum,
      area: grid.areas[seed],
      omega: [axis[0] * speed, axis[1] * speed, axis[2] * speed],
      name: `Plate ${String(plateIndex + 1).padStart(2, '0')}`,
    });
    owner[seed] = plateIndex;
    frontiers[plateIndex] = [];
  }

  const appendFrontier = (cellIndex: number, plateIndex: number) => {
    for (
      let neighborOffset = grid.offsets[cellIndex];
      neighborOffset < grid.offsets[cellIndex + 1];
      neighborOffset++
    ) {
      const neighborCell = grid.neighbors[neighborOffset];

      if (owner[neighborCell] === 65535) {
        frontiers[plateIndex].push(neighborCell);
      }
    }
  };

  for (let plateIndex = 0; plateIndex < plateCount; plateIndex++) {
    appendFrontier(plates[plateIndex].seed, plateIndex);
  }

  let remaining = grid.count - plateCount;

  while (remaining) {
    let chosen = -1;
    let priority = Infinity;

    for (let plateIndex = 0; plateIndex < plateCount; plateIndex++) {
      if (frontiers[plateIndex].length) {
        const score =
          (plates[plateIndex].area / plates[plateIndex].target) * (0.85 + randomNumber() * 0.3);

        if (score < priority) {
          priority = score;
          chosen = plateIndex;
        }
      }
    }

    if (chosen < 0) {
      throw Error('Plate frontier did not cover the grid.');
    }

    const frontier = frontiers[chosen];
    const frontierIndex = Math.floor(randomNumber() * frontier.length);
    const cellIndex = frontier[frontierIndex];
    frontier[frontierIndex] = frontier[frontier.length - 1];
    frontier.pop();

    if (owner[cellIndex] !== 65535) {
      continue;
    }

    owner[cellIndex] = chosen;
    plates[chosen].area += grid.areas[cellIndex];
    remaining--;
    appendFrontier(cellIndex, chosen);
  }

  const continental = new Float32Array(grid.count);
  const age = new Float32Array(grid.count);
  const sample = createTerrainSampler(config);

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    const terrainSample = sample(...readVector(grid.positions, cellIndex));
    continental[cellIndex] = terrainSample.continental;
    age[cellIndex] = terrainSample.age;
  }

  const geology: Geology = {
    plate: owner,
    plates,
    continental,
    age,
    boundary: new Uint8Array(grid.edgeLength.length),
    uplift: new Float32Array(grid.count),
    volcanism: new Float32Array(grid.count),
  };
  updateTectonicRelief(grid, geology, config);

  return geology;
}

/** Recompute present boundary features after material and plate ownership have moved. */
export function updateTectonicRelief(grid: Grid, geology: Geology, config: WorldConfig): void {
  const { plate: owner, plates, continental, age } = geology;
  // Feature sources keep their plate and crust context through distance propagation.
  const boundary = new Uint8Array(grid.edgeLength.length);
  const uplift = new Float32Array(grid.count);
  const positive = new Float32Array(grid.count);
  const volcanism = new Float32Array(grid.count);
  type Source = { cell: number; strength: number; width: number; kind: number };
  const sources: Source[][] = Array.from({ length: 5 }, () => []);

  for (let edgeIndex = 0; edgeIndex < boundary.length; edgeIndex++) {
    const firstCell = grid.edgeCells[edgeIndex * 2];
    const secondCell = grid.edgeCells[edgeIndex * 2 + 1];

    if (owner[firstCell] === owner[secondCell]) {
      continue;
    }

    const firstPosition = readVector(grid.positions, firstCell);
    const secondPosition = readVector(grid.positions, secondCell);
    const midpoint = normalizeVector([
      firstPosition[0] + secondPosition[0],
      firstPosition[1] + secondPosition[1],
      firstPosition[2] + secondPosition[2],
    ]);
    const firstVelocity = cross(plates[owner[firstCell]].omega, midpoint);
    const secondVelocity = cross(plates[owner[secondCell]].omega, midpoint);
    const relativeVelocity = [
      secondVelocity[0] - firstVelocity[0],
      secondVelocity[1] - firstVelocity[1],
      secondVelocity[2] - firstVelocity[2],
    ];
    const normal = readVector(grid.edgeNormal, edgeIndex);
    const convergence = -dot(relativeVelocity, normal);
    const shear = Math.abs(dot(relativeVelocity, cross(midpoint, normal)));
    const firstIsContinental = continental[firstCell] > 0.53;
    const secondIsContinental = continental[secondCell] > 0.53;

    const addBoundarySource = (
      family: number,
      cell: number,
      strength: number,
      width: number,
      kind: number,
    ) => sources[family].push({ cell, strength, width: width * config.tectonicWidth, kind });

    if (convergence > 0.12) {
      boundary[edgeIndex] = 1;
      const strength = clamp((convergence - 0.12) * 0.8);

      if (firstIsContinental && secondIsContinental) {
        addBoundarySource(0, firstCell, strength, 380000, 1);
        addBoundarySource(0, secondCell, strength, 380000, 1);
      } else {
        const subducting = firstIsContinental
          ? secondCell
          : secondIsContinental
            ? firstCell
            : age[firstCell] > age[secondCell]
              ? firstCell
              : secondCell;
        const over = subducting === firstCell ? secondCell : firstCell;
        addBoundarySource(1, subducting, strength, 170000, 2);
        addBoundarySource(2, over, strength, 240000, 3);
      }
    } else if (convergence < -0.12) {
      boundary[edgeIndex] = 2;
      const strength = clamp((-convergence - 0.12) * 0.7);
      addBoundarySource(
        firstIsContinental ? 3 : 4,
        firstCell,
        strength,
        firstIsContinental ? 380000 : 520000,
        firstIsContinental ? 4 : 5,
      );
      addBoundarySource(
        secondIsContinental ? 3 : 4,
        secondCell,
        strength,
        secondIsContinental ? 380000 : 520000,
        secondIsContinental ? 4 : 5,
      );
    } else if (shear > 0.14) {
      boundary[edgeIndex] = 3;
    }
  }

  for (let family = 0; family < sources.length; family++) {
    const best = new Float64Array(grid.count).fill(Infinity);
    const sourceId = new Int32Array(grid.count).fill(-1);
    const heap = new MinHeap();
    const familySources = sources[family];
    familySources.forEach((source, sourceIndex) => {
      const cost = -Math.log(Math.max(source.strength, 0.001));

      if (cost < best[source.cell]) {
        best[source.cell] = cost;
        sourceId[source.cell] = sourceIndex;
        heap.push(source.cell, cost);
      }
    });

    while (heap.size) {
      const [cellIndex, cost] = heap.pop();

      if (cost > best[cellIndex] + 1e-10) {
        continue;
      }

      const sourceIndex = sourceId[cellIndex];
      const source = familySources[sourceIndex];

      for (
        let neighborOffset = grid.offsets[cellIndex];
        neighborOffset < grid.offsets[cellIndex + 1];
        neighborOffset++
      ) {
        const neighborCell = grid.neighbors[neighborOffset];

        if (
          owner[neighborCell] !== owner[source.cell] ||
          continental[neighborCell] > 0.53 !== continental[source.cell] > 0.53
        ) {
          continue;
        }

        const candidateCost =
          cost + (grid.edgeDistance[grid.arcEdges[neighborOffset]] * config.radius) / source.width;

        if (candidateCost < best[neighborCell] && candidateCost < 7) {
          best[neighborCell] = candidateCost;
          sourceId[neighborCell] = sourceIndex;
          heap.push(neighborCell, candidateCost);
        }
      }
    }

    for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
      if (sourceId[cellIndex] >= 0) {
        const source = familySources[sourceId[cellIndex]];
        const distance = Math.max(
          0,
          (best[cellIndex] + Math.log(Math.max(source.strength, 0.001))) * source.width,
        );
        // Faster-decaying belts keep high relief near its tectonic source.
        const reliefContribution =
          source.strength * Math.exp(-Math.pow(distance / source.width, 2));
        let delta =
          family === 0
            ? 4700 * reliefContribution
            : family === 1
              ? -1700 * reliefContribution
              : family === 2
                ? 3300 *
                  reliefContribution *
                  (0.4 + 1.4 * Math.exp(-Math.pow((distance - 110000) / 100000, 2)))
                : family === 3
                  ? -650 * reliefContribution
                  : 850 * reliefContribution;
        delta *= config.exposure;

        // A cell near both a collision and an arc is not two superposed ranges.
        // With history enabled, volcanic construction is accumulated separately.
        if (geology.crust && (family === 2 || family === 4)) {
          delta = 0;
        }

        if (delta > 0) {
          positive[cellIndex] = Math.max(positive[cellIndex], delta);
        } else {
          uplift[cellIndex] += delta;
        }

        if (family === 2 || family === 4) {
          volcanism[cellIndex] = Math.max(
            volcanism[cellIndex],
            reliefContribution * config.exposure,
          );
        }
      }
    }
  }

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    uplift[cellIndex] += positive[cellIndex];
  }

  Object.assign(geology, { uplift, volcanism, boundary });
}

/** Smooth intensive geology; categorical ownership always uses nearestCell. */
export function sampleUplift(
  grid: Grid,
  field: Float32Array,
  x: number,
  y: number,
  z: number,
  start: number,
) {
  let weightedHeight = 0;
  let weights = 0;

  const accumulateSample = (cellIndex: number) => {
    const angularOffset = Math.max(
      1e-9,
      1 -
        grid.positions[cellIndex * 3] * x -
        grid.positions[cellIndex * 3 + 1] * y -
        grid.positions[cellIndex * 3 + 2] * z,
    );
    const sampleWeight = 1 / (angularOffset * angularOffset);
    weightedHeight += field[cellIndex] * sampleWeight;
    weights += sampleWeight;
  };

  accumulateSample(start);

  for (
    let neighborOffset = grid.offsets[start];
    neighborOffset < grid.offsets[start + 1];
    neighborOffset++
  ) {
    accumulateSample(grid.neighbors[neighborOffset]);
  }

  return weightedHeight / weights;
}
