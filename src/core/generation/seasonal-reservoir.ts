import { SEASON, YEAR, type Lake, type LakeSeasons } from '../model';

export interface ReservoirForcing {
  inflow: readonly number[];
  /** Liquid precipitation, PET and displaced land runoff, all m³/s per sample. */
  at: (corner: number, season: number) => readonly [number, number, number];
}

/** A small seasonal reservoir over the existing basin hypsometry. Four substeps
 * per quarter bound footprint feedback. A bracketed annual storage solve avoids
 * simulating centuries to initialize a deep lake. Every recorded quarter retains
 * its exact storage change; no discharge is manufactured by annual normalization.
 */
export function balanceSeasonalLake(
  lake: Lake,
  sorted: number[],
  height: Float32Array,
  area: Float64Array,
  forcing: ReservoirForcing,
): Lake {
  const count = sorted.length;
  const cumulativeArea = new Float64Array(count + 1);
  const cumulativeBed = new Float64Array(count + 1);
  const volumeAtHeight = new Float64Array(count);
  const flux = Array.from({ length: 12 }, () => new Float64Array(count + 1));
  for (let index = 0; index < count; index++) {
    const corner = sorted[index];
    volumeAtHeight[index] = Math.max(
      0,
      height[corner] * cumulativeArea[index] - cumulativeBed[index],
    );
    cumulativeArea[index + 1] = cumulativeArea[index] + area[corner];
    cumulativeBed[index + 1] = cumulativeBed[index] + area[corner] * height[corner];
    for (let season = 0; season < 4; season++) {
      const sample = forcing.at(corner, season);
      for (let pathway = 0; pathway < 3; pathway++) {
        flux[season * 3 + pathway][index + 1] = flux[season * 3 + pathway][index] + sample[pathway];
      }
    }
  }
  const meanInput = forcing.inflow.reduce((sum, value) => sum + value, 0) / 4;
  const input = forcing.inflow.map((value) =>
    meanInput > 0 ? (value * lake.inflow) / meanInput : lake.inflow,
  );
  const lowestHeight = height[sorted[0]];
  const capacity = lake.capacity;
  const substeps = 4;
  const timeStep = SEASON / substeps;

  function wetSamples(storage: number): number {
    if (storage <= 0) {
      return 0;
    }
    let lower = 0;
    let upper = count;
    while (lower < upper) {
      const middle = (lower + upper) >>> 1;
      if (volumeAtHeight[middle] < storage) {
        lower = middle + 1;
      } else {
        upper = middle;
      }
    }
    return lower;
  }

  function runYear(initialStorage: number, record?: LakeSeasons): number {
    let storage = initialStorage;
    for (let season = 0; season < 4; season++) {
      const before = storage;
      let rain = 0;
      let evaporation = 0;
      let displaced = 0;
      let outflow = 0;
      for (let step = 0; step < substeps; step++) {
        const wet = wetSamples(storage);
        const rainVolume = flux[season * 3][wet] * timeStep;
        // The footprint replaces its own runoff; it cannot consume upstream water twice.
        const replacedVolume = Math.min(input[season], flux[season * 3 + 2][wet]) * timeStep;
        const available = storage + input[season] * timeStep + rainVolume - replacedVolume;
        const evaporatedVolume = Math.min(available, flux[season * 3 + 1][wet] * timeStep);
        const remaining = available - evaporatedVolume;
        const spilledVolume = Math.max(0, remaining - capacity);
        storage = Math.max(0, Math.min(capacity, remaining));
        rain += rainVolume;
        evaporation += evaporatedVolume;
        displaced += replacedVolume;
        outflow += spilledVolume;
      }
      if (record) {
        const wet = wetSamples(storage);
        record.storage.push(storage);
        record.area.push(cumulativeArea[wet]);
        record.level.push(
          wet ? (storage + cumulativeBed[wet]) / cumulativeArea[wet] : lowestHeight,
        );
        record.inflow.push(input[season]);
        record.directRain.push(rain / SEASON);
        record.evaporation.push(evaporation / SEASON);
        record.displacedRunoff.push(displaced / SEASON);
        record.outflow.push(outflow / SEASON);
        record.storageChange.push(storage - before);
      }
    }
    return storage;
  }

  let lower = 0;
  let upper = capacity;
  let initial = Math.min(capacity, lake.storage);
  const tolerance = Math.max(1, lake.inflow * YEAR, capacity) * 1e-9;
  for (let iteration = 0; iteration < 32; iteration++) {
    const change = runYear(initial) - initial;
    if (Math.abs(change) <= tolerance) {
      break;
    }
    if (change > 0) {
      lower = initial;
    } else {
      upper = initial;
    }
    initial = (lower + upper) / 2;
  }
  const seasonal: LakeSeasons = {
    initialStorage: initial,
    storage: [],
    level: [],
    area: [],
    inflow: [],
    directRain: [],
    evaporation: [],
    displacedRunoff: [],
    outflow: [],
    storageChange: [],
  };
  runYear(initial, seasonal);
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / 4;
  lake.seasonal = seasonal;
  lake.area = mean(seasonal.area);
  lake.storage = mean(seasonal.storage);
  lake.directRain = mean(seasonal.directRain);
  lake.evaporation = mean(seasonal.evaporation);
  lake.displacedRunoff = mean(seasonal.displacedRunoff);
  lake.outflow = mean(seasonal.outflow);
  lake.kind = lake.outflow > 0 ? 'spilling' : 'closed';
  // The routing footprint reaches the sill whenever the lake spills within a quarter.
  // Display and land suitability use the four sampled wet fractions instead.
  lake.level = lake.outflow > 0 ? lake.spill : Math.max(...seasonal.level);
  return lake;
}
