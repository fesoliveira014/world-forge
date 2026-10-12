import type { CrustHistory, Geology, Grid, WorldConfig } from '../model';
import { readVector, clamp } from '../math';
import { nearestCell } from '../grid/build';
import { computeDistances } from '../operators/spatial';
import { sampleUplift, createTerrainSampler, updateTectonicRelief } from './geology';
import { createHotspots, emplaceVolcanics, volcanicRates } from './volcanism';

/** A prescribed plate reconstruction, not a force or mantle solver.
 * Reference crust moves in rigid plate frames. Overlaps prefer buoyant crust;
 * gaps create ocean floor. Deformation is carried between time steps and relaxes.
 * Only the final geography is passed to climate and hydrology.
 */
export function evolveCrust(
  grid: Grid,
  geology: Geology,
  config: WorldConfig,
  progress: (elapsed: number) => void = () => {},
): void {
  if (config.tectonicDuration === 0) {
    return;
  }

  const cellCount = grid.count;
  const count = geology.plates.length;
  const sample = createTerrainSampler(config);
  const initialPlate = new Uint16Array(geology.plate);
  const initialBase = new Float32Array(cellCount);
  const initialAge = new Float32Array(geology.age);
  const initialContinental = new Float32Array(geology.continental);

  for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
    initialBase[cellIndex] = sample(...readVector(grid.positions, cellIndex)).base;
  }

  const order = Uint32Array.from({ length: cellCount }, (_, cellIndex) => cellIndex);
  order.sort(
    (firstCell, secondCell) =>
      initialBase[firstCell] +
      geology.uplift[firstCell] -
      initialBase[secondCell] -
      geology.uplift[secondCell],
  );
  let area = 0;
  let seaThreshold = 0;

  for (const cellIndex of order) {
    area += grid.areas[cellIndex];

    if (area >= config.oceanFraction * 4 * Math.PI) {
      seaThreshold = initialBase[cellIndex] + geology.uplift[cellIndex];
      break;
    }
  }

  for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
    initialBase[cellIndex] -= seaThreshold;
  }

  const crust: CrustHistory = {
    initialPlate,
    initialBase,
    base: new Float32Array(initialBase),
    deformation: new Float32Array(cellCount),
    volcanic: new Float32Array(cellCount),
    volcanicAge: new Float32Array(cellCount),
    materialBase: new Float32Array(cellCount),
    material: new Uint8Array(cellCount).fill(1),
    inverse: new Float64Array(count * 9),
    seaThreshold,
    steps: 0,
  };
  geology.crust = crust;
  // Cache the moving reference-site lookup for each plate/destination pair.
  // No repeated scan of the grid and no history copy for every geological step.
  const lookup = new Uint32Array(cellCount * count);
  const owners = new Uint16Array(cellCount);
  const baseline = new Float32Array(cellCount);
  const continental = new Float32Array(cellCount);
  const age = new Float32Array(cellCount);
  const material = new Uint8Array(cellCount);
  const deformation = new Float32Array(cellCount);
  const volcanic = new Float32Array(cellCount);
  const volcanicAge = new Float32Array(cellCount);
  const faults = new Float32Array(cellCount);
  const target = new Float32Array(cellCount);
  const weight = new Float32Array(cellCount);
  const increment = new Float64Array(count * 9);
  const overlap = new Uint8Array(cellCount);
  const sourceFrom = new Int32Array(cellCount);
  const hotspots = createHotspots(config);

  for (let plateIndex = 0; plateIndex < count; plateIndex++) {
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
      lookup[plateIndex * cellCount + cellIndex] = cellIndex;
    }
  }

  // 1 cm/year = 10 km/Myr. Frame rotations are exact even at a larger step;
  // a 150 km displacement bound resolves the empirical deformation integration.
  const maxOmega = Math.max(...geology.plates.map((plate) => Math.hypot(...plate.omega)));
  const dtLimit = Math.min(5, 150000 / Math.max(1, config.plateSpeed * 10000 * maxOmega));
  const steps = Math.ceil(config.tectonicDuration / dtLimit);
  const timeStep = config.tectonicDuration / steps;

  for (let step = 1; step <= steps; step++) {
    const elapsed = step * timeStep;

    for (let plateIndex = 0; plateIndex < count; plateIndex++) {
      rotationMatrix(
        crust.inverse,
        plateIndex * 9,
        geology.plates[plateIndex].omega,
        (-elapsed * config.plateSpeed * 10000) / config.radius,
      );
      rotationMatrix(
        increment,
        plateIndex * 9,
        geology.plates[plateIndex].omega,
        (-timeStep * config.plateSpeed * 10000) / config.radius,
      );
    }

    material.fill(0);
    overlap.fill(0);
    target.fill(0);
    weight.fill(0);
    faults.fill(0);

    for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
      const x = grid.positions[cellIndex * 3];
      const y = grid.positions[cellIndex * 3 + 1];
      const z = grid.positions[cellIndex * 3 + 2];
      let best = -Infinity;
      let gapScore = -Infinity;
      let gapPlate = 0;

      for (let plateIndex = 0; plateIndex < count; plateIndex++) {
        const matrixOffset = plateIndex * 9;
        const inverseMatrix = crust.inverse;
        const sourceX =
          inverseMatrix[matrixOffset] * x +
          inverseMatrix[matrixOffset + 1] * y +
          inverseMatrix[matrixOffset + 2] * z;
        const sourceY =
          inverseMatrix[matrixOffset + 3] * x +
          inverseMatrix[matrixOffset + 4] * y +
          inverseMatrix[matrixOffset + 5] * z;
        const sourceZ =
          inverseMatrix[matrixOffset + 6] * x +
          inverseMatrix[matrixOffset + 7] * y +
          inverseMatrix[matrixOffset + 8] * z;
        const plateCellOffset = plateIndex * cellCount + cellIndex;
        const source = nearestCell(grid, sourceX, sourceY, sourceZ, lookup[plateCellOffset]);
        lookup[plateCellOffset] = source;
        const seed = geology.plates[plateIndex].seed * 3;
        const proximity =
          sourceX * grid.positions[seed] +
          sourceY * grid.positions[seed + 1] +
          sourceZ * grid.positions[seed + 2];

        if (proximity > gapScore) {
          gapScore = proximity;
          gapPlate = plateIndex;
        }

        if (initialPlate[source] !== plateIndex) {
          continue;
        }

        const sampledBase = sampleUplift(grid, initialBase, sourceX, sourceY, sourceZ, source);

        if (sampledBase > 0) {
          overlap[cellIndex]++;
        }

        // Continental material overrides ocean floor. Among like crust, retain
        // the more buoyant candidate (younger seafloor or higher continental basement).
        const score = sampledBase > 0 ? 10 + clamp(sampledBase / 8000) : -initialAge[source] / 1000;

        if (score <= best) {
          continue;
        }

        best = score;
        owners[cellIndex] = plateIndex;
        material[cellIndex] = 1;
        baseline[cellIndex] = sampledBase;
        continental[cellIndex] = initialContinental[source];
        age[cellIndex] = initialAge[source] + elapsed;
      }

      if (!material[cellIndex]) {
        owners[cellIndex] = gapPlate;
        age[cellIndex] = crust.material[cellIndex] ? 0 : geology.age[cellIndex] + timeStep;
        continental[cellIndex] = 0;
        // Young opened ocean subsides toward an older abyssal floor.
        baseline[cellIndex] = -4200 - 1800 * (1 - Math.exp(-age[cellIndex] / 65));
      }

      const matrixOffset = owners[cellIndex] * 9;
      const stepMatrix = increment;
      const sourceX =
        stepMatrix[matrixOffset] * x +
        stepMatrix[matrixOffset + 1] * y +
        stepMatrix[matrixOffset + 2] * z;
      const sourceY =
        stepMatrix[matrixOffset + 3] * x +
        stepMatrix[matrixOffset + 4] * y +
        stepMatrix[matrixOffset + 5] * z;
      const sourceZ =
        stepMatrix[matrixOffset + 6] * x +
        stepMatrix[matrixOffset + 7] * y +
        stepMatrix[matrixOffset + 8] * z;
      const from = nearestCell(grid, sourceX, sourceY, sourceZ, cellIndex);
      deformation[cellIndex] = material[cellIndex]
        ? sampleUplift(grid, crust.deformation, sourceX, sourceY, sourceZ, from) *
          Math.exp(-timeStep / 90)
        : 0;
      // Unlike reference basement, new volcanic deposits also travel on opened ocean.
      // Do not import an edifice from an unrelated plate when ownership changes.
      const samePlate = geology.plate[from] === owners[cellIndex];
      volcanic[cellIndex] = samePlate
        ? sampleUplift(grid, crust.volcanic, sourceX, sourceY, sourceZ, from) *
          Math.exp(-timeStep / 220)
        : 0;
      volcanicAge[cellIndex] = samePlate
        ? sampleUplift(grid, crust.volcanicAge, sourceX, sourceY, sourceZ, from) + timeStep
        : timeStep;

      if (overlap[cellIndex] > 1) {
        target[cellIndex] = 1800;
        weight[cellIndex] = 1;
      }
    }

    // Current relative motion changes both sides of a continental boundary.
    // The influence is integrated in Myr, rather than added once per cell hop.
    for (let edgeIndex = 0; edgeIndex < grid.edgeLength.length; edgeIndex++) {
      const cellIndex = grid.edgeCells[2 * edgeIndex];
      const neighborCell = grid.edgeCells[2 * edgeIndex + 1];

      if (owners[cellIndex] === owners[neighborCell]) {
        continue;
      }

      const firstAngularVelocity = geology.plates[owners[cellIndex]].omega;
      const secondAngularVelocity = geology.plates[owners[neighborCell]].omega;
      const x = (grid.positions[cellIndex * 3] + grid.positions[neighborCell * 3]) * 0.5;
      const y = (grid.positions[cellIndex * 3 + 1] + grid.positions[neighborCell * 3 + 1]) * 0.5;
      const z = (grid.positions[cellIndex * 3 + 2] + grid.positions[neighborCell * 3 + 2]) * 0.5;
      const relativeAngularX = secondAngularVelocity[0] - firstAngularVelocity[0];
      const relativeAngularY = secondAngularVelocity[1] - firstAngularVelocity[1];
      const relativeAngularZ = secondAngularVelocity[2] - firstAngularVelocity[2];
      const closing = -(
        (relativeAngularY * z - relativeAngularZ * y) * grid.edgeNormal[edgeIndex * 3] +
        (relativeAngularZ * x - relativeAngularX * z) * grid.edgeNormal[edgeIndex * 3 + 1] +
        (relativeAngularX * y - relativeAngularY * x) * grid.edgeNormal[edgeIndex * 3 + 2]
      );
      const velocity = closing * config.plateSpeed * 10000;

      if (closing > 0.12) {
        // Continental collision thickens crust; one oceanic side permits arc volcanism.
        const isContinental = baseline[cellIndex] > 0;
        const isNeighborContinental = baseline[neighborCell] > 0;

        if (!isContinental || !isNeighborContinental) {
          const over = isContinental
            ? cellIndex
            : isNeighborContinental
              ? neighborCell
              : age[cellIndex] < age[neighborCell]
                ? cellIndex
                : neighborCell;
          faults[over] = Math.max(faults[over], clamp((closing * config.plateSpeed) / 4) * 170);
        }
      } else if (closing < -0.12) {
        // Decompression at rifts and spreading faults; most ocean ridges stay submerged.
        const rate = clamp((-closing * config.plateSpeed) / 4) * 70;
        faults[cellIndex] = Math.max(faults[cellIndex], rate);
        faults[neighborCell] = Math.max(faults[neighborCell], rate);
      }

      const desired =
        velocity >= 0 ? Math.min(2600, velocity * 0.07) : Math.max(-2800, velocity * 0.09);

      for (const cell of [cellIndex, neighborCell]) {
        if (baseline[cell] < -1000) {
          continue;
        }

        target[cell] += desired;
        weight[cell]++;
      }
    }

    const sources: number[] = [];

    for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
      if (weight[cellIndex] && Math.abs(target[cellIndex]) > 1) {
        target[cellIndex] /= weight[cellIndex];
        sources.push(cellIndex);
      }
    }

    sourceFrom.fill(-1);
    const distance = computeDistances(grid, sources, config.radius, sourceFrom);
    const response = 1 - Math.exp(-timeStep / 18);
    const construction =
      config.volcanicActivity > 0
        ? volcanicRates(grid, owners, faults, hotspots, elapsed, config)
        : faults.fill(0);

    for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
      const source = sourceFrom[cellIndex];

      if (source >= 0 && material[cellIndex]) {
        const influence = Math.exp(-((distance[cellIndex] / (220000 * config.tectonicWidth)) ** 2));
        deformation[cellIndex] +=
          (target[source] * config.exposure - deformation[cellIndex]) * response * influence;
      }

      crust.deformation[cellIndex] = deformation[cellIndex];
      crust.base[cellIndex] = baseline[cellIndex] + deformation[cellIndex];
      crust.volcanic[cellIndex] = emplaceVolcanics(
        volcanic[cellIndex],
        construction[cellIndex],
        timeStep,
      );
      crust.volcanicAge[cellIndex] = construction[cellIndex] > 5 ? 0 : volcanicAge[cellIndex];
    }

    geology.plate.set(owners);
    geology.continental.set(continental);
    geology.age.set(age);
    crust.material.set(material);
    crust.steps = step;

    if (step === steps || step % 5 === 0) {
      progress(elapsed);
    }
  }

  // Sampling continuous noise once in the final material frame supplies a fine
  // residual without regenerating a stationary noise continent under the crust.
  for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
    const materialPosition = referencePoint(
      crust.inverse,
      geology.plate[cellIndex],
      ...readVector(grid.positions, cellIndex),
    );
    crust.materialBase[cellIndex] = sample(...materialPosition).base - seaThreshold;
  }

  for (const plate of geology.plates) {
    plate.area = 0;
  }

  for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
    geology.plates[geology.plate[cellIndex]].area += grid.areas[cellIndex];
  }

  updateTectonicRelief(grid, geology, config);
}

/** Rodrigues rotation for unit-sphere material positions; factor scales angular motion. */
export function rotationMatrix(
  matrix: Float64Array,
  offset: number,
  omega: ArrayLike<number>,
  factor: number,
) {
  const speed = Math.hypot(omega[0], omega[1], omega[2]);
  const x = speed ? omega[0] / speed : 1;
  const y = speed ? omega[1] / speed : 0;
  const z = speed ? omega[2] / speed : 0;
  const cosine = Math.cos(speed * factor);
  const sine = Math.sin(speed * factor);
  const oneMinusCosine = 1 - cosine;
  matrix.set(
    [
      oneMinusCosine * x * x + cosine,
      oneMinusCosine * x * y - sine * z,
      oneMinusCosine * x * z + sine * y,
      oneMinusCosine * x * y + sine * z,
      oneMinusCosine * y * y + cosine,
      oneMinusCosine * y * z - sine * x,
      oneMinusCosine * x * z - sine * y,
      oneMinusCosine * y * z + sine * x,
      oneMinusCosine * z * z + cosine,
    ],
    offset,
  );
}

export function referencePoint(
  matrix: Float64Array,
  plate: number,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  const matrixOffset = plate * 9;

  return [
    matrix[matrixOffset] * x + matrix[matrixOffset + 1] * y + matrix[matrixOffset + 2] * z,
    matrix[matrixOffset + 3] * x + matrix[matrixOffset + 4] * y + matrix[matrixOffset + 5] * z,
    matrix[matrixOffset + 6] * x + matrix[matrixOffset + 7] * y + matrix[matrixOffset + 8] * z,
  ];
}
