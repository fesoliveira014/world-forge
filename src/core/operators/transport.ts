import type { Grid } from '../model';

/** Signed area fluxes (m²/s), one per shared edge; positive a -> b. */
export function computeVectorFlux(grid: Grid, vector: Float32Array, radius: number): Float64Array {
  const flux = new Float64Array(grid.edgeLength.length);

  for (let edgeIndex = 0; edgeIndex < flux.length; edgeIndex++) {
    const firstCell = grid.edgeCells[2 * edgeIndex];
    const secondCell = grid.edgeCells[2 * edgeIndex + 1];
    let normal = 0;

    for (let axisIndex = 0; axisIndex < 3; axisIndex++) {
      normal +=
        (vector[3 * firstCell + axisIndex] + vector[3 * secondCell + axisIndex]) *
        0.5 *
        grid.edgeNormal[edgeIndex * 3 + axisIndex];
    }

    flux[edgeIndex] = normal * grid.edgeLength[edgeIndex] * radius;
  }

  return flux;
}

export function computeStableTimeStep(
  grid: Grid,
  flux: Float64Array,
  radius: number,
  maxStep: number,
  mixing?: Float64Array,
): number {
  const outgoingFlux = new Float64Array(grid.count);

  for (let edgeIndex = 0; edgeIndex < flux.length; edgeIndex++) {
    outgoingFlux[grid.edgeCells[2 * edgeIndex + (flux[edgeIndex] < 0 ? 1 : 0)]] += Math.abs(
      flux[edgeIndex],
    );
  }

  if (mixing) {
    for (let edgeIndex = 0; edgeIndex < flux.length; edgeIndex++) {
      outgoingFlux[grid.edgeCells[2 * edgeIndex]] += mixing[edgeIndex];
      outgoingFlux[grid.edgeCells[2 * edgeIndex + 1]] += mixing[edgeIndex];
    }
  }

  let timeStep = maxStep;

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    if (outgoingFlux[cellIndex] > 0) {
      timeStep = Math.min(
        timeStep,
        (0.65 * grid.areas[cellIndex] * radius * radius) / outgoingFlux[cellIndex],
      );
    }
  }

  return timeStep;
}

/** A fixed seasonal flow compiled into inventory transfer rates (s⁻¹).
 * Both directions include diffusion. Rates use the donor's own physical area,
 * so unequal cells exchange equal water volumes rather than equal depths.
 */
export interface PreparedTransport {
  edgeCells: Uint32Array;
  forwardRate: Float64Array;
  reverseRate: Float64Array;
}

export function prepareTransport(
  grid: Grid,
  flux: Float64Array,
  radius: number,
  mixing?: Float64Array,
): PreparedTransport {
  const forwardRate = new Float64Array(flux.length);
  const reverseRate = new Float64Array(flux.length);
  const radiusSquared = radius * radius;

  for (let edgeIndex = 0; edgeIndex < flux.length; edgeIndex++) {
    const firstCell = grid.edgeCells[edgeIndex * 2];
    const secondCell = grid.edgeCells[edgeIndex * 2 + 1];
    const conductance = mixing?.[edgeIndex] ?? 0;
    forwardRate[edgeIndex] =
      (Math.max(0, flux[edgeIndex]) + conductance) / (grid.areas[firstCell] * radiusSquared);
    reverseRate[edgeIndex] =
      (Math.max(0, -flux[edgeIndex]) + conductance) / (grid.areas[secondCell] * radiusSquared);
  }

  return { edgeCells: grid.edgeCells, forwardRate, reverseRate };
}

/** Upwind advection and diffusion share one equal-and-opposite edge exchange.
 * Read the old inventory for every edge, then apply changes in a separate pass.
 * The caller retains the same CFL limit, including for a shortened final step.
 */
export function transportInventory(
  transport: PreparedTransport,
  inventory: Float64Array,
  delta: Float64Array,
  timeStep: number,
): void {
  delta.fill(0);
  const { edgeCells, forwardRate, reverseRate } = transport;

  for (let edgeIndex = 0; edgeIndex < forwardRate.length; edgeIndex++) {
    const firstCell = edgeCells[edgeIndex * 2];
    const secondCell = edgeCells[edgeIndex * 2 + 1];
    const amount =
      timeStep *
      (forwardRate[edgeIndex] * inventory[firstCell] -
        reverseRate[edgeIndex] * inventory[secondCell]);
    delta[firstCell] -= amount;
    delta[secondCell] += amount;
  }

  for (let cellIndex = 0; cellIndex < inventory.length; cellIndex++) {
    inventory[cellIndex] += delta[cellIndex];
  }
}

/** Physical eddy diffusivity K (m²/s); conductance uses shared face length / center distance. */
export function computeDiffusionConductance(grid: Grid, diffusivity: number): Float64Array {
  return Float64Array.from(
    grid.edgeLength,
    (length, edgeIndex) => (diffusivity * length) / grid.edgeDistance[edgeIndex],
  );
}
