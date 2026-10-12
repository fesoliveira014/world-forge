import { SEASON, type Climate, type Grid, type WorldConfig } from '../model';
import { clamp } from '../math';
import { calculateHeightGradient, computeDistances } from '../operators/spatial';
import {
  computeStableTimeStep,
  computeVectorFlux,
  transportInventory,
  prepareTransport,
  computeDiffusionConductance,
} from '../operators/transport';
import { windField, thermalBaseline, oceanCirculation, prepareOceanGeometry } from './circulation';

export function solveClimate(
  grid: Grid,
  height: Float32Array,
  ocean: Uint8Array,
  config: WorldConfig,
  referenceOcean: Uint8Array = ocean,
  recycledEvapotranspiration?: Float32Array, // process-grid annual mm, from the provisional land budget
): Climate {
  const result: Climate = {
    temperature: [],
    rain: [],
    pet: [],
    wind: [],
    current: [],
    sst: [],
    moisture: [],
    evaporation: [],
    atmosphereResidual: 0,
    oceanDivergence: 0,
  };
  const planetRadius = config.radius;
  const radiusSquared = planetRadius * planetRadius;
  const oceanCells: number[] = [];

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    if (ocean[cellIndex]) {
      oceanCells.push(cellIndex);
    }
  }

  const nearestOceanCell = new Int32Array(grid.count).fill(-1);
  const coastDistance = computeDistances(grid, oceanCells, planetRadius, nearestOceanCell);
  const mixing = computeDiffusionConductance(grid, config.moistureMixing);
  const heightGradient = calculateHeightGradient(grid, height, planetRadius);
  const oceanGeometry = prepareOceanGeometry(grid, ocean, planetRadius, referenceOcean);
  const cellAreas = Float64Array.from(grid.areas, (area) => area * radiusSquared);

  for (let seasonIndex = 0; seasonIndex < 4; seasonIndex++) {
    const temperatureBaseline = thermalBaseline(grid, height, ocean, config, seasonIndex);
    const {
      current,
      sst: seaSurfaceTemperature,
      maxDivergence,
    } = oceanCirculation(grid, ocean, temperatureBaseline, config, seasonIndex, oceanGeometry);
    const { wind, gradient } = windField(grid, height, config, seasonIndex, heightGradient);
    const temperature = new Float32Array(temperatureBaseline);

    for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
      if (ocean[cellIndex]) {
        temperature[cellIndex] = seaSurfaceTemperature[cellIndex];
      } else {
        const seasonal =
          Math.sin((seasonIndex * Math.PI) / 2) *
          grid.positions[cellIndex * 3 + 1] *
          config.obliquity *
          0.3;
        temperature[cellIndex] -= seasonal * Math.exp(-coastDistance[cellIndex] / 650000);
        // A physical coastal reach, independent of cell size, carries current-driven SST anomalies inland.
        const coast = nearestOceanCell[cellIndex];

        if (coast >= 0) {
          temperature[cellIndex] +=
            (seaSurfaceTemperature[coast] - temperatureBaseline[coast]) *
            0.6 *
            Math.exp(-coastDistance[cellIndex] / 650000);
        }
      }
    }

    const flux = computeVectorFlux(grid, wind, planetRadius);
    const transport = prepareTransport(grid, flux, planetRadius, mixing);
    const timeStep = computeStableTimeStep(grid, flux, planetRadius, 86400, mixing);
    const spinupDuration = Math.max(35, config.moistureLifetime * 3) * 86400;
    const simulationDuration = spinupDuration + 30 * 86400;
    const atmosphericWater = new Float64Array(grid.count);
    const transportChange = new Float64Array(grid.count);
    const accumulatedRain = new Float64Array(grid.count);
    const accumulatedEvaporation = new Float64Array(grid.count);
    const potentialEvapotranspiration = new Float32Array(grid.count);
    const precipitationSink = new Float64Array(grid.count);
    const evaporationSource = new Float64Array(grid.count);
    const waterCapacity = new Float64Array(grid.count);
    const rainoutFraction = new Float64Array(grid.count);
    const stepRainoutFraction = new Float64Array(grid.count);
    let initialWater = 0;
    const exchange: AtmosphericExchange = {
      capacity: waterCapacity,
      evaporationSource,
      accumulatedRain,
      accumulatedEvaporation,
      evaporatedWater: 0,
      precipitatedWater: 0,
    };

    for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
      const area = cellAreas[cellIndex];
      atmosphericWater[cellIndex] = area * 0.012;
      initialWater += atmosphericWater[cellIndex];
      const speed = Math.hypot(
        wind[cellIndex * 3],
        wind[cellIndex * 3 + 1],
        wind[cellIndex * 3 + 2],
      );
      const upslope = Math.max(
        0,
        wind[cellIndex * 3] * gradient[cellIndex * 3] +
          wind[cellIndex * 3 + 1] * gradient[cellIndex * 3 + 1] +
          wind[cellIndex * 3 + 2] * gradient[cellIndex * 3 + 2],
      );
      waterCapacity[cellIndex] =
        area * 0.013 * Math.exp(clamp(temperature[cellIndex], -35, 45) * 0.047);
      const absoluteLatitudeSine = Math.abs(grid.positions[cellIndex * 3 + 1]);
      precipitationSink[cellIndex] =
        ((1 + 0.7 * Math.pow(1 - absoluteLatitudeSine, 4)) / config.moistureLifetime +
          config.orographicStrength * Math.min(0.7, upslope * 18)) /
        86400;
      rainoutFraction[cellIndex] = 1 - Math.exp(-precipitationSink[cellIndex] * timeStep);
      evaporationSource[cellIndex] = ocean[cellIndex]
        ? (Math.max(0.00025, 0.0026 + 0.00006 * seaSurfaceTemperature[cellIndex]) *
            (0.7 + speed * 0.06) *
            config.evaporationScale) /
          86400
        : ((recycledEvapotranspiration?.[cellIndex] ?? 0) * config.recycling * 0.001) /
          (365.25 * 86400);
      potentialEvapotranspiration[cellIndex] =
        (Math.max(0, temperature[cellIndex] + 5) * (0.075 + speed * 0.0015) * SEASON) / 86400;
    }

    for (let time = 0; time < simulationDuration;) {
      const step = Math.min(
        timeStep,
        simulationDuration - time,
        time < spinupDuration ? spinupDuration - time : Infinity,
      );
      transportInventory(transport, atmosphericWater, transportChange, step);
      const saturationFraction = 1 - Math.exp(-step / 86400);

      // Only the spin-up boundary and final step need different sink weights.
      // Keep exponentials and the boundary decision outside the hot cell loop.
      if (step !== timeStep) {
        for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
          stepRainoutFraction[cellIndex] = 1 - Math.exp(-precipitationSink[cellIndex] * step);
        }
      }
      exchangeAtmosphericWater(
        atmosphericWater,
        ocean,
        cellAreas,
        exchange,
        step === timeStep ? rainoutFraction : stepRainoutFraction,
        step,
        saturationFraction,
        time >= spinupDuration,
      );

      time += step;
    }

    const seasonalRainfall = new Float32Array(grid.count);
    const seasonalEvaporation = new Float32Array(grid.count);
    const moisture = new Float32Array(grid.count);
    let finalWater = 0;

    for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
      seasonalRainfall[cellIndex] =
        (accumulatedRain[cellIndex] * 1000 * SEASON) / (simulationDuration - spinupDuration);
      seasonalEvaporation[cellIndex] =
        (accumulatedEvaporation[cellIndex] * 1000 * SEASON) / (simulationDuration - spinupDuration);
      moisture[cellIndex] = (atmosphericWater[cellIndex] / cellAreas[cellIndex]) * 1000;
      finalWater += atmosphericWater[cellIndex];
    }

    result.atmosphereResidual = Math.max(
      result.atmosphereResidual,
      Math.abs(initialWater + exchange.evaporatedWater - exchange.precipitatedWater - finalWater) /
        Math.max(1, initialWater + exchange.evaporatedWater),
    );
    result.oceanDivergence = Math.max(result.oceanDivergence, maxDivergence);
    result.temperature.push(temperature);
    result.rain.push(seasonalRainfall);
    result.pet.push(potentialEvapotranspiration);
    result.wind.push(wind);
    result.current.push(current);
    result.sst.push(seaSurfaceTemperature);
    result.moisture.push(moisture);
    result.evaporation.push(seasonalEvaporation);
  }

  return result;
}

interface AtmosphericExchange {
  capacity: Float64Array;
  evaporationSource: Float64Array;
  accumulatedRain: Float64Array;
  accumulatedEvaporation: Float64Array;
  evaporatedWater: number;
  precipitatedWater: number;
}

/** Small, allocation-free hot loop, separate from seasonal setup for the JS JIT.
 * Preserve the evaporation/rainout order and the complete atmosphere ledger.
 */
function exchangeAtmosphericWater(
  inventory: Float64Array,
  ocean: Uint8Array,
  cellAreas: Float64Array,
  exchange: AtmosphericExchange,
  rainoutFraction: Float64Array,
  timeStep: number,
  saturationFraction: number,
  recordClimate: boolean,
): void {
  const { capacity, evaporationSource, accumulatedRain, accumulatedEvaporation } = exchange;
  let evaporatedWater = exchange.evaporatedWater;
  let precipitatedWater = exchange.precipitatedWater;

  for (let cellIndex = 0; cellIndex < inventory.length; cellIndex++) {
    const area = cellAreas[cellIndex];
    const waterCapacity = capacity[cellIndex];
    const availableWater = inventory[cellIndex];
    const relativeHumidity = availableWater / waterCapacity;
    const evaporation =
      evaporationSource[cellIndex] *
      timeStep *
      (ocean[cellIndex] ? clamp(1 - relativeHumidity / 2, 0.08, 1) : 1) *
      area;
    const suppliedWater = availableWater + evaporation;
    const saturated = Math.max(0, suppliedWater - waterCapacity) * saturationFraction;
    const precipitation = (suppliedWater - saturated) * rainoutFraction[cellIndex] + saturated;
    inventory[cellIndex] = suppliedWater - precipitation;
    evaporatedWater += evaporation;
    precipitatedWater += precipitation;

    if (recordClimate) {
      accumulatedRain[cellIndex] += precipitation / area;
      accumulatedEvaporation[cellIndex] += evaporation / area;
    }
  }

  exchange.evaporatedWater = evaporatedWater;
  exchange.precipitatedWater = precipitatedWater;
}
