import type { Grid, Terrain, WorldConfig } from '../model';

export interface HillslopeDiagnostics {
  durationMyr: number;
  steps: number;
  timeStepMyr: number;
  diffusivityM2PerMyr: number;
  /** Sum of all shared-edge transfers; material can cross more than one edge. */
  movedVolume: number;
  sedimentVolumeBefore: number;
  sedimentVolumeAfter: number;
  /** Stored Float32 sediment volume after minus before, in cubic metres. */
  sedimentResidual: number;
  maxHeightChange: number;
}

/** Fine, recent soil creep, with a reference diffusivity of 0.005 m²/year.
 * The caller supplies the recent interval; geological landscape aging is separate.
 * Only loose sediment crosses terrestrial interfaces. Bedrock and underwater
 * terrain remain unchanged, and this pass neither creates material nor exports it.
 *
 * Every edge transfers one equal-and-opposite volume. A physical area/conductance
 * CFL bound makes the unmodified height update a convex combination; reducing all
 * outgoing transfers together when sediment is scarce retains that bound. Thus
 * unequal tiny cells cannot overshoot, and several downhill faces cannot each
 * withdraw the same donor inventory. Float64 work arrays avoid timestep rounding;
 * the reported residual includes final Float32 terrain-storage rounding.
 */
export function evolveHillslopes(
  grid: Grid,
  terrain: Terrain,
  config: WorldConfig,
  durationMyr: number,
): HillslopeDiagnostics {
  if (!Number.isFinite(durationMyr) || durationMyr < 0) {
    throw Error('Hillslope duration must be finite and nonnegative.');
  }

  if (!Number.isFinite(config.radius) || config.radius <= 0) {
    throw Error('Hillslope transport requires a finite, positive planet radius.');
  }

  if (!Number.isFinite(config.erosion) || config.erosion < 0) {
    throw Error('Hillslope erosion strength must be finite and nonnegative.');
  }

  if (!Number.isFinite(config.hillslopeStrength) || config.hillslopeStrength < 0) {
    throw Error('Hillslope strength must be finite and nonnegative.');
  }

  const diffusivity = 5000 * config.erosion * config.hillslopeStrength;
  const area = Float64Array.from(grid.areas, (value) => value * config.radius ** 2);
  const inventory = Float64Array.from(terrain.sediment, (depth, cell) => depth * area[cell]);
  const sedimentVolumeBefore = inventory.reduce((sum, volume) => sum + volume, 0);
  const diagnostics: HillslopeDiagnostics = {
    durationMyr,
    steps: 0,
    timeStepMyr: 0,
    diffusivityM2PerMyr: diffusivity,
    movedVolume: 0,
    sedimentVolumeBefore,
    sedimentVolumeAfter: sedimentVolumeBefore,
    sedimentResidual: 0,
    maxHeightChange: 0,
  };

  if (durationMyr === 0 || diffusivity === 0 || sedimentVolumeBefore === 0) {
    return diagnostics;
  }

  const conductance = new Float64Array(grid.edgeLength.length);
  const totalConductance = new Float64Array(grid.count);

  for (let edgeIndex = 0; edgeIndex < conductance.length; edgeIndex++) {
    const firstCell = grid.edgeCells[edgeIndex * 2];
    const secondCell = grid.edgeCells[edgeIndex * 2 + 1];

    if (terrain.ocean[firstCell] || terrain.ocean[secondCell]) {
      continue;
    }

    const edgeConductance =
      (diffusivity * grid.edgeLength[edgeIndex]) / grid.edgeDistance[edgeIndex];

    if (!Number.isFinite(edgeConductance) || edgeConductance < 0) {
      throw Error('Hillslope transport requires finite, nonnegative edge conductance.');
    }

    conductance[edgeIndex] = edgeConductance;
    totalConductance[firstCell] += edgeConductance;
    totalConductance[secondCell] += edgeConductance;
  }

  let timeStepLimit = durationMyr;
  let connected = false;

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    if (!Number.isFinite(area[cellIndex]) || area[cellIndex] <= 0) {
      throw Error('Hillslope transport requires finite, positive cell areas.');
    }

    if (totalConductance[cellIndex] > 0) {
      timeStepLimit = Math.min(
        timeStepLimit,
        (0.45 * area[cellIndex]) / totalConductance[cellIndex],
      );
      connected = true;
    }
  }

  if (!connected) {
    return diagnostics;
  }

  const steps = Math.ceil(durationMyr / timeStepLimit);

  if (!Number.isSafeInteger(steps) || steps <= 0) {
    throw Error('The requested hillslope interval exceeds representable stable subdivisions.');
  }

  const timeStep = durationMyr / steps;
  const initialHeight = new Float64Array(terrain.height);
  const height = new Float64Array(terrain.height);
  const edgeVolume = new Float64Array(conductance.length);
  const outgoing = new Float64Array(grid.count);
  const donorFraction = new Float64Array(grid.count);
  const change = new Float64Array(grid.count);
  diagnostics.steps = steps;
  diagnostics.timeStepMyr = timeStep;

  for (let step = 0; step < steps; step++) {
    outgoing.fill(0);
    change.fill(0);

    for (let edgeIndex = 0; edgeIndex < conductance.length; edgeIndex++) {
      const firstCell = grid.edgeCells[edgeIndex * 2];
      const secondCell = grid.edgeCells[edgeIndex * 2 + 1];
      const amount = timeStep * conductance[edgeIndex] * (height[firstCell] - height[secondCell]);
      edgeVolume[edgeIndex] = amount;
      outgoing[amount >= 0 ? firstCell : secondCell] += Math.abs(amount);
    }

    for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
      donorFraction[cellIndex] =
        outgoing[cellIndex] > 0 ? Math.min(1, inventory[cellIndex] / outgoing[cellIndex]) : 1;
    }

    for (let edgeIndex = 0; edgeIndex < conductance.length; edgeIndex++) {
      const firstCell = grid.edgeCells[edgeIndex * 2];
      const secondCell = grid.edgeCells[edgeIndex * 2 + 1];
      const donor = edgeVolume[edgeIndex] >= 0 ? firstCell : secondCell;
      const amount = edgeVolume[edgeIndex] * donorFraction[donor];
      change[firstCell] -= amount;
      change[secondCell] += amount;
      diagnostics.movedVolume += Math.abs(amount);
    }

    for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
      // A fully exhausted donor can round a few ulps below zero after summing
      // several edges; no physical negative sediment inventory is retained.
      inventory[cellIndex] = Math.max(0, inventory[cellIndex] + change[cellIndex]);
      height[cellIndex] =
        initialHeight[cellIndex] +
        inventory[cellIndex] / area[cellIndex] -
        terrain.sediment[cellIndex];
    }
  }

  let sedimentVolumeAfter = 0;

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    if (inventory[cellIndex] !== terrain.sediment[cellIndex] * area[cellIndex]) {
      terrain.sediment[cellIndex] = inventory[cellIndex] / area[cellIndex];
      terrain.height[cellIndex] = terrain.bedrock[cellIndex] + terrain.sediment[cellIndex];
    }

    sedimentVolumeAfter += terrain.sediment[cellIndex] * area[cellIndex];
    diagnostics.maxHeightChange = Math.max(
      diagnostics.maxHeightChange,
      Math.abs(terrain.height[cellIndex] - initialHeight[cellIndex]),
    );
  }

  diagnostics.sedimentVolumeAfter = sedimentVolumeAfter;
  diagnostics.sedimentResidual = sedimentVolumeAfter - sedimentVolumeBefore;

  return diagnostics;
}
