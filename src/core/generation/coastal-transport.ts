import type { Climate, Grid, Terrain, WorldConfig } from '../model';
import { createScalarStencilSampler } from '../operators/scalar-sampling';

export interface CoastalTransportDiagnostics {
  movedVolume: number;
  initialVolume: number;
  finalVolume: number;
  residual: number;
  steps: number;
}

/** Effective littoral drift of existing loose sediment, in metres and Myr.
 * The ocean/land interface defines the shoreline normal; seasonal wind and
 * current projected along its tangent drive transport. This is a coarse wave
 * climate proxy, not a resolved surf-zone model. No bedrock is eroded here.
 * Only cells incident to an ocean shoreline participate, so inland lakes and
 * remote ocean floors cannot acquire an artificial transport connection.
 * Equal/opposite interface volumes and a physical CFL bound preserve inventory
 * on irregular cells. Packing to Float32 is the only reported mass residual.
 */
export function transportCoastalSediment(
  grid: Grid,
  processGrid: Grid,
  transfer: Uint32Array,
  terrain: Terrain,
  climate: Climate,
  config: WorldConfig,
  durationMyr: number,
): CoastalTransportDiagnostics {
  if (!Number.isFinite(durationMyr) || durationMyr < 0) {
    throw Error('Coastal transport duration must be finite and nonnegative.');
  }
  if (!Number.isFinite(config.radius) || config.radius <= 0) {
    throw Error('Coastal transport requires a finite, positive planet radius.');
  }
  if (
    !Number.isFinite(config.erosion) ||
    config.erosion < 0 ||
    !Number.isFinite(config.waveErosion) ||
    config.waveErosion < 0
  ) {
    throw Error('Coastal transport strengths must be finite and nonnegative.');
  }
  const radiusSquared = config.radius ** 2;
  const result: CoastalTransportDiagnostics = {
    movedVolume: 0,
    initialVolume: 0,
    finalVolume: 0,
    residual: 0,
    steps: 0,
  };
  for (let cell = 0; cell < grid.count; cell++) {
    result.initialVolume += terrain.sediment[cell] * grid.areas[cell] * radiusSquared;
  }
  result.finalVolume = result.initialVolume;
  const strength = config.erosion * config.waveErosion;
  if (durationMyr === 0 || strength === 0 || result.initialVolume === 0) {
    return result;
  }

  const normal = new Float64Array(grid.count * 3);
  for (let edge = 0; edge < grid.edgeLength.length; edge++) {
    const a = grid.edgeCells[2 * edge];
    const b = grid.edgeCells[2 * edge + 1];
    if (terrain.ocean[a] === terrain.ocean[b]) {
      continue;
    }
    const sign = terrain.ocean[b] ? 1 : -1;
    const weight = (sign * grid.edgeLength[edge]) / Math.max(1e-12, grid.edgeDistance[edge]);
    for (let k = 0; k < 3; k++) {
      const value = weight * (grid.positions[3 * b + k] - grid.positions[3 * a + k]);
      normal[3 * a + k] += value;
      normal[3 * b + k] += value;
    }
  }
  const active: number[] = [];
  for (let cell = 0; cell < grid.count; cell++) {
    const offset = 3 * cell;
    const radial =
      normal[offset] * grid.positions[offset] +
      normal[offset + 1] * grid.positions[offset + 1] +
      normal[offset + 2] * grid.positions[offset + 2];
    for (let k = 0; k < 3; k++) {
      normal[offset + k] -= radial * grid.positions[offset + k];
    }
    const length = Math.hypot(normal[offset], normal[offset + 1], normal[offset + 2]);
    if (length <= 1e-12) {
      continue;
    }
    active.push(cell);
    for (let k = 0; k < 3; k++) {
      normal[offset + k] /= length;
    }
  }
  if (active.length === 0) {
    return result;
  }

  const sample = createScalarStencilSampler(processGrid);
  const edges: { a: number; b: number; rate: number }[] = [];
  const outgoingRate = new Float64Array(grid.count);
  for (let edge = 0; edge < grid.edgeLength.length; edge++) {
    const a = grid.edgeCells[2 * edge];
    const b = grid.edgeCells[2 * edge + 1];
    if (
      Math.hypot(normal[3 * a], normal[3 * a + 1], normal[3 * a + 2]) < 0.5 ||
      Math.hypot(normal[3 * b], normal[3 * b + 1], normal[3 * b + 2]) < 0.5
    ) {
      continue;
    }
    let x = grid.positions[3 * a] + grid.positions[3 * b];
    let y = grid.positions[3 * a + 1] + grid.positions[3 * b + 1];
    let z = grid.positions[3 * a + 2] + grid.positions[3 * b + 2];
    const length = Math.hypot(x, y, z);
    x /= length;
    y /= length;
    z /= length;
    const nx = normal[3 * a] + normal[3 * b];
    const ny = normal[3 * a + 1] + normal[3 * b + 1];
    const nz = normal[3 * a + 2] + normal[3 * b + 2];
    let tx = y * nz - z * ny;
    let ty = z * nx - x * nz;
    let tz = x * ny - y * nx;
    const tangentLength = Math.hypot(tx, ty, tz);
    if (tangentLength <= 1e-12) {
      continue;
    }
    tx /= tangentLength;
    ty /= tangentLength;
    tz /= tangentLength;
    const stencil = sample(x, y, z, transfer[a]);
    let speed = 0;
    const winds = climate.wind ?? [];
    const currents = climate.current ?? [];
    for (let vertex = 0; vertex < 3; vertex++) {
      const p = 3 * stencil.cells[vertex];
      const weight = stencil.weights[vertex];
      for (const wind of winds) {
        // Effective 10 km/Myr at a 10 m/s alongshore wind.
        speed +=
          (weight * 1000 * (wind[p] * tx + wind[p + 1] * ty + wind[p + 2] * tz)) /
          Math.max(1, winds.length);
      }
      for (const current of currents) {
        speed +=
          (weight * 3000 * (current[p] * tx + current[p + 1] * ty + current[p + 2] * tz)) /
          Math.max(1, currents.length);
      }
    }
    const projection =
      tx * grid.edgeNormal[3 * edge] +
      ty * grid.edgeNormal[3 * edge + 1] +
      tz * grid.edgeNormal[3 * edge + 2];
    const rate = strength * speed * projection * grid.edgeLength[edge] * config.radius;
    if (!Number.isFinite(rate)) {
      throw Error('Coastal forcing must be finite.');
    }
    if (Math.abs(rate) < 1e-12) {
      continue;
    }
    edges.push({ a, b, rate });
    outgoingRate[rate > 0 ? a : b] += Math.abs(rate);
  }
  if (!edges.length) {
    return result;
  }

  const area = new Float64Array(grid.count);
  const inventory = new Float64Array(grid.count);
  const mobility = new Float64Array(grid.count);
  let limit = durationMyr;
  for (const cell of active) {
    area[cell] = grid.areas[cell] * radiusSquared;
    if (!(area[cell] > 0) || !Number.isFinite(area[cell])) {
      throw Error('Coastal cell area must be positive.');
    }
    inventory[cell] = terrain.sediment[cell] * area[cell];
    // A coarse cell can straddle the shoreline even when its mean height lies
    // outside the surf zone. Reduce its participating fraction continuously.
    mobility[cell] = 1 / (1 + (Math.abs(terrain.height[cell]) / 100) ** 2);
    if (outgoingRate[cell] > 0) {
      limit = Math.min(limit, (0.45 * area[cell]) / outgoingRate[cell]);
    }
  }
  const steps = Math.ceil(durationMyr / limit);
  if (!Number.isSafeInteger(steps) || steps <= 0) {
    throw Error('Coastal interval exceeds representable stable subdivisions.');
  }
  result.steps = steps;
  const dt = durationMyr / steps;
  const change = new Float64Array(grid.count);
  for (let step = 0; step < steps; step++) {
    for (const cell of active) {
      change[cell] = 0;
    }
    for (const { a, b, rate } of edges) {
      const donor = rate > 0 ? a : b;
      // The active loose layer is at most 20 m. The CFL bound covers the entire
      // outgoing sum, so separate faces cannot spend the same material twice.
      const mobileDepth = Math.min(20, inventory[donor] / area[donor]) * mobility[donor];
      const amount = dt * rate * mobileDepth;
      change[a] -= amount;
      change[b] += amount;
      result.movedVolume += Math.abs(amount);
    }
    for (const cell of active) {
      inventory[cell] = Math.max(0, inventory[cell] + change[cell]);
    }
  }
  for (const cell of active) {
    const before = terrain.sediment[cell] * area[cell];
    terrain.sediment[cell] = inventory[cell] / area[cell];
    terrain.height[cell] = terrain.bedrock[cell] + terrain.sediment[cell];
    result.finalVolume += terrain.sediment[cell] * area[cell] - before;
  }
  result.residual = result.finalVolume - result.initialVolume;
  return result;
}
