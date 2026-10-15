import type { Climate, Grid, LandWater, Terrain, WorldConfig } from '../model';
import { clamp } from '../math';
import { createScalarStencilSampler } from '../operators/scalar-sampling';

export interface WindSedimentDiagnostics {
  movedVolume: number; // gross deposited volume across interfaces, m³
  initialVolume: number; // loose sediment on the complete sphere, m³
  finalVolume: number; // after packing updated sediment depths, m³
  residual: number; // final minus initial; includes Float32 depth roundoff, m³
  maxDonorFraction: number; // largest combined outgoing / initial inventory
}

/** One synchronous, conservative redistribution of loose sediment over a supplied
 * landscape interval. All seasonal requests see the same initial inventory, so
 * neither multiple neighbors nor opposing seasons can spend a donor twice.
 * The caller owns the evolution clock; this operator does not replay crust history.
 */
export function transportWindSediment(
  grid: Grid,
  processGrid: Grid,
  transfer: Uint32Array,
  terrain: Terrain,
  climate: Climate,
  water: LandWater,
  config: WorldConfig,
  durationMyr: number,
): WindSedimentDiagnostics {
  const radiusSquared = config.radius * config.radius;
  const result: WindSedimentDiagnostics = {
    movedVolume: 0,
    initialVolume: 0,
    finalVolume: 0,
    residual: 0,
    maxDonorFraction: 0,
  };

  for (let cell = 0; cell < grid.count; cell++) {
    result.initialVolume += terrain.sediment[cell] * grid.areas[cell] * radiusSquared;
  }

  result.finalVolume = result.initialVolume;

  if (durationMyr <= 0 || config.windErosion <= 0 || config.erosion <= 0 || !climate.wind.length) {
    return result;
  }

  const availableDepth = new Float64Array(grid.count);
  const outgoing = new Float64Array(grid.count);
  const forward = new Float64Array(grid.edgeLength.length);
  const reverse = new Float64Array(grid.edgeLength.length);
  const delta = new Float64Array(grid.count);
  const sample = createScalarStencilSampler(processGrid);
  const durationPerSeason = durationMyr / climate.wind.length;

  for (let cell = 0; cell < grid.count; cell++) {
    if (terrain.ocean[cell] || terrain.sediment[cell] <= 0) {
      continue;
    }

    const drySoil = clamp(1 - water.soil[cell] / Math.max(1, config.soilCapacity));
    const dryClimate = clamp((water.aridity[cell] - 0.75) / 1.25);
    const snowFree = 1 / (1 + Math.max(0, water.snow[cell]) / 10);
    // Sediment is the available loose substrate; no new bedrock or grain-size
    // inventory is invented. Moist and snow-covered surfaces resist entrainment.
    availableDepth[cell] = terrain.sediment[cell] * drySoil ** 2 * dryClimate * snowFree;
  }

  for (let edge = 0; edge < grid.edgeLength.length; edge++) {
    const firstCell = grid.edgeCells[edge * 2];
    const secondCell = grid.edgeCells[edge * 2 + 1];

    if (availableDepth[firstCell] === 0 && availableDepth[secondCell] === 0) {
      continue;
    }

    const firstCorner = grid.edgeCorners[edge * 2];
    const secondCorner = grid.edgeCorners[edge * 2 + 1];
    let x = grid.corners[firstCorner * 3] + grid.corners[secondCorner * 3];
    let y = grid.corners[firstCorner * 3 + 1] + grid.corners[secondCorner * 3 + 1];
    let z = grid.corners[firstCorner * 3 + 2] + grid.corners[secondCorner * 3 + 2];
    const magnitude = Math.hypot(x, y, z);
    x /= magnitude;
    y /= magnitude;
    z /= magnitude;
    const stencil = sample(x, y, z, transfer[firstCell]);
    const interfaceLength = grid.edgeLength[edge] * config.radius;
    const centerDistance = Math.max(1e-6, grid.edgeDistance[edge] * config.radius);
    const slope = (terrain.height[secondCell] - terrain.height[firstCell]) / centerDistance;

    for (const wind of climate.wind) {
      let velocityX = 0;
      let velocityY = 0;
      let velocityZ = 0;

      for (let vertex = 0; vertex < 3; vertex++) {
        const processCell = stencil.cells[vertex];
        const weight = stencil.weights[vertex];
        velocityX += weight * wind[processCell * 3];
        velocityY += weight * wind[processCell * 3 + 1];
        velocityZ += weight * wind[processCell * 3 + 2];
      }

      const radial = velocityX * x + velocityY * y + velocityZ * z;
      velocityX -= radial * x;
      velocityY -= radial * y;
      velocityZ -= radial * z;
      const speed = Math.hypot(velocityX, velocityY, velocityZ);

      if (speed <= 4) {
        continue;
      }

      const normalVelocity =
        velocityX * grid.edgeNormal[edge * 3] +
        velocityY * grid.edgeNormal[edge * 3 + 1] +
        velocityZ * grid.edgeNormal[edge * 3 + 2];
      const donor = normalVelocity >= 0 ? firstCell : secondCell;
      const uphill = normalVelocity >= 0 ? Math.max(0, slope) : Math.max(0, -slope);
      // Prototype effective drift: 10 km/Myr at 10 m/s, with a 4 m/s threshold.
      // The finite-volume exchange uses metres of interface and displacement;
      // physical slope reduces upslope transport and retains sheltered sediment.
      const displacement =
        10000 *
        config.erosion *
        config.windErosion *
        ((speed - 4) / 6) ** 2 *
        (Math.abs(normalVelocity) / speed) *
        durationPerSeason;
      const requested =
        (availableDepth[donor] * interfaceLength * displacement) / (1 + uphill / 0.05);

      if (normalVelocity >= 0) {
        forward[edge] += requested;
      } else {
        reverse[edge] += requested;
      }

      outgoing[donor] += requested;
    }
  }

  // One multiplier bounds the complete donor request across every interface and
  // season. Incoming sediment is deposited only after all these requests exist.
  const donorScale = new Float64Array(grid.count);

  for (let cell = 0; cell < grid.count; cell++) {
    const availableVolume = availableDepth[cell] * grid.areas[cell] * radiusSquared;
    donorScale[cell] = outgoing[cell] > 0 ? Math.min(1, availableVolume / outgoing[cell]) : 0;
    const initialVolume = terrain.sediment[cell] * grid.areas[cell] * radiusSquared;

    if (initialVolume > 0) {
      result.maxDonorFraction = Math.max(
        result.maxDonorFraction,
        (outgoing[cell] * donorScale[cell]) / initialVolume,
      );
    }
  }

  for (let edge = 0; edge < grid.edgeLength.length; edge++) {
    const firstCell = grid.edgeCells[edge * 2];
    const secondCell = grid.edgeCells[edge * 2 + 1];
    const firstToSecond = forward[edge] * donorScale[firstCell];
    const secondToFirst = reverse[edge] * donorScale[secondCell];
    const exchanged = firstToSecond - secondToFirst;
    delta[firstCell] -= exchanged;
    delta[secondCell] += exchanged;
    result.movedVolume += firstToSecond + secondToFirst;
  }

  if (result.movedVolume === 0) {
    return result;
  }

  result.finalVolume = 0;

  for (let cell = 0; cell < grid.count; cell++) {
    const area = grid.areas[cell] * radiusSquared;
    // Only roundoff can make the capped result negative. Keeping inventories in
    // Float64 until packing avoids unequal-area depth exchanges and drift.
    terrain.sediment[cell] = Math.max(0, terrain.sediment[cell] + delta[cell] / area);
    terrain.height[cell] = terrain.bedrock[cell] + terrain.sediment[cell];
    result.finalVolume += terrain.sediment[cell] * area;
  }

  result.residual = result.finalVolume - result.initialVolume;

  return result;
}
