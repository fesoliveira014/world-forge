import type { Drainage, Grid, Oxbow, Rivers, Terrain, WorldConfig } from '../model';
import {
  angle,
  readVector,
  clamp,
  cross,
  normalizeVector,
  createSeededRandom,
  type Vec3,
} from '../math';
import { nearestCell } from '../grid/build';
import { floodplainWidths } from './floodplains';

type Point = [number, number];

/** A bounded migration sketch in valley coordinates. Growth depends on elapsed
 * landscape time and bank mobility. A geometric intersection cuts off a loop;
 * age alone never selects a river's pattern. Units are physical metres.
 */
export function evolveBend(
  length: number,
  space: number,
  duration: number,
  mobility: number,
  variation: number,
) {
  const growth =
    (1 - Math.exp(-duration / 0.4)) * clamp(mobility * (0.35 + variation * 0.65), 0, 1.3);
  const amplitude = Math.min(space * 0.65, length * 0.22, 20000) * Math.min(1, growth);
  const longitudinal =
    Math.min(length * (variation > 0.72 ? 0.19 : 0.1), amplitude * 3.5) * Math.min(1, growth);
  const sign = variation > 0.5 ? 1 : -1;
  const count = amplitude >= 100 ? 16 : Math.max(1, Math.ceil(length / 40000));
  let points: Point[] = [];

  for (let sampleIndex = 0; sampleIndex <= count; sampleIndex++) {
    const alongFraction = sampleIndex / count;
    points.push([
      length * alongFraction + longitudinal * Math.sin(4 * Math.PI * alongFraction),
      sign * amplitude * Math.sin(2 * Math.PI * alongFraction),
    ]);
  }

  points[0] = [0, 0];
  points[points.length - 1] = [length, 0];
  const loops: Point[][] = [];

  // Two lobes at most; no repeated global path search or recursive cutoffs.
  for (let cutoff = 0; cutoff < 2; cutoff++) {
    let found = false;

    for (let firstSegment = 0; firstSegment + 3 < points.length && !found; firstSegment++) {
      for (
        let secondSegment = firstSegment + 2;
        secondSegment + 1 < points.length;
        secondSegment++
      ) {
        const firstPoint = points[firstSegment];
        const secondPoint = points[secondSegment];
        const firstDirectionX = points[firstSegment + 1][0] - firstPoint[0];
        const firstDirectionY = points[firstSegment + 1][1] - firstPoint[1];
        const secondDirectionX = points[secondSegment + 1][0] - secondPoint[0];
        const secondDirectionY = points[secondSegment + 1][1] - secondPoint[1];
        const determinant = firstDirectionX * secondDirectionY - firstDirectionY * secondDirectionX;

        if (Math.abs(determinant) < 1e-6) {
          continue;
        }

        const firstFraction =
          ((secondPoint[0] - firstPoint[0]) * secondDirectionY -
            (secondPoint[1] - firstPoint[1]) * secondDirectionX) /
          determinant;
        const secondFraction =
          ((secondPoint[0] - firstPoint[0]) * firstDirectionY -
            (secondPoint[1] - firstPoint[1]) * firstDirectionX) /
          determinant;

        if (
          firstFraction <= 0 ||
          firstFraction >= 1 ||
          secondFraction <= 0 ||
          secondFraction >= 1
        ) {
          continue;
        }

        const neck: Point = [
          firstPoint[0] + firstDirectionX * firstFraction,
          firstPoint[1] + firstDirectionY * firstFraction,
        ];
        loops.push([neck, ...points.slice(firstSegment + 1, secondSegment + 1), neck]);
        points = [...points.slice(0, firstSegment + 1), neck, ...points.slice(secondSegment + 1)];
        found = true;
        break;
      }
    }

    if (!found) {
      break;
    }
  }

  return { points, loops };
}

function buildCourse(
  grid: Grid,
  terrain: Terrain,
  drainage: Drainage,
  cornerIndex: number,
  config: WorldConfig,
  bankSpace?: number,
) {
  const receiverCorner = drainage.receiver[cornerIndex];
  const startPosition = readVector(grid.corners, cornerIndex);
  const endPosition = readVector(grid.corners, receiverCorner);
  const length = Math.max(1, angle(startPosition, endPosition) * config.radius);
  const side = normalizeVector(cross(startPosition, endPosition));
  const level = (drainage.height[cornerIndex] + drainage.height[receiverCorner]) / 2;
  const riverSlope =
    Math.max(0, drainage.height[cornerIndex] - drainage.height[receiverCorner]) / length;
  let edge = 0;

  for (let neighborSlot = 0; neighborSlot < 3; neighborSlot++) {
    if (grid.cornerNeighbors[cornerIndex * 3 + neighborSlot] === receiverCorner) {
      edge = grid.cornerEdges[cornerIndex * 3 + neighborSlot];
    }
  }

  let space = bankSpace ?? Infinity;

  for (let bankIndex = 0; bankIndex < 2; bankIndex++) {
    const cellIndex = grid.edgeCells[edge * 2 + bankIndex];
    const distance = (grid.areas[cellIndex] * config.radius ** 2) / (2 * length);

    if (terrain.ocean[cellIndex] || drainage.lakeCoverage[cellIndex] > 0.2) {
      space = 0;
      break;
    }

    const widths = floodplainWidths({
      supply: drainage.discharge[cornerIndex] * 0.6,
      peak: 0,
      length,
      riverSlope,
      bankSlope: Math.max(0, terrain.height[cellIndex] - level) / distance,
      availableWidth: distance * 0.6,
      sediment: terrain.sediment[cellIndex],
      extent: config.floodplainExtent,
    });
    space = Math.min(space, widths.bank);
  }

  const mobility = config.bankMobility / (1 + (riverSlope / 0.002) ** 2);
  const variation = createSeededRandom(`${config.seed}:bend:${cornerIndex}`)();
  const shape = evolveBend(
    length,
    drainage.discharge[cornerIndex] >= 100 ? space : 0,
    config.erosion > 0 ? config.fluvialDuration : 0,
    mobility,
    variation,
  );

  const projectCoursePoint = (localPoint: Point): Vec3 =>
    normalizeVector(
      startPosition.map(
        (coordinate, axisIndex) =>
          coordinate +
          (endPosition[axisIndex] - coordinate) * (localPoint[0] / length) +
          (side[axisIndex] * localPoint[1]) / config.radius,
      ),
    );

  const points = shape.points.map(projectCoursePoint);
  points[0] = startPosition;
  points[points.length - 1] = endPosition;

  return { points, loops: shape.loops.map((loop) => loop.map(projectCoursePoint)), length };
}

/** Sparse relict ponds from the provisional river course. One preserved cutoff per
 * cell prevents overlapping water budgets. Dry cutoffs remain visible as scars;
 * the land-water pass decides whether the inherited depression actually holds water.
 */
export function seedOxbows(
  grid: Grid,
  terrain: Terrain,
  drainage: Drainage,
  config: WorldConfig,
): Oxbow[] {
  const ponds: Oxbow[] = [];
  const occupied = new Uint8Array(grid.count);

  if (config.fluvialDuration <= 0 || config.erosion <= 0 || config.bankMobility <= 0) {
    return ponds;
  }

  for (let cornerIndex = 0; cornerIndex < drainage.receiver.length; cornerIndex++) {
    if (
      drainage.receiver[cornerIndex] < 0 ||
      drainage.discharge[cornerIndex] < 300 ||
      drainage.lakeFraction[cornerIndex] > 0
    ) {
      continue;
    }

    // Most abandoned channels eventually fill. This seeded preservation choice is
    // an explicit worldbuilding approximation, not a reconstructed cutoff date.
    if (createSeededRandom(`${config.seed}:cutoff-survival:${cornerIndex}`)() > 0.35) {
      continue;
    }

    const shape = buildCourse(grid, terrain, drainage, cornerIndex, config);

    for (const cutoff of shape.loops) {
      // Sediment plugs the neck. Preserve an open horseshoe away from the live channel.
      const loop = cutoff.slice(1, -1);

      if (loop.length < 3) {
        continue;
      }

      const center = normalizeVector(
        loop.reduce(
          (sum, point) => sum.map((coordinate, axisIndex) => coordinate + point[axisIndex]) as Vec3,
          [0, 0, 0] as Vec3,
        ),
      );
      const cell = nearestCell(grid, ...center, grid.triangles[cornerIndex * 3]);

      if (occupied[cell] || terrain.ocean[cell] || drainage.lakeCoverage[cell] > 0.05) {
        continue;
      }

      let length = 0;

      for (let sampleIndex = 1; sampleIndex < loop.length; sampleIndex++) {
        length += angle(loop[sampleIndex - 1], loop[sampleIndex]) * config.radius;
      }

      const width = clamp(8 * Math.sqrt(drainage.discharge[cornerIndex]), 40, 900);
      const area = Math.min(length * width, grid.areas[cell] * config.radius ** 2 * 0.03);

      if (area < 20000) {
        continue;
      }

      occupied[cell] = 1;
      ponds.push({
        cell,
        points: Float32Array.from(loop.flat()),
        width: area / length,
        area,
        capacity: 1.5,
      });
    }
  }

  return ponds;
}

/** The displayed river and its vegetation banks consume this same centerline. */
export function buildRiverCourses(
  grid: Grid,
  terrain: Terrain,
  drainage: Drainage,
  rivers: Rivers,
  config: WorldConfig,
) {
  const corners: number[] = [];
  const offsets = [0];
  const positions: number[] = [];
  const sinuosity: number[] = [];

  for (let cornerIndex = 0; cornerIndex < drainage.receiver.length; cornerIndex++) {
    if (!rivers.channel[cornerIndex] || drainage.receiver[cornerIndex] < 0) {
      continue;
    }

    const shape = buildCourse(grid, terrain, drainage, cornerIndex, config);
    let distance = 0;

    for (let sampleIndex = 1; sampleIndex < shape.points.length; sampleIndex++) {
      distance += angle(shape.points[sampleIndex - 1], shape.points[sampleIndex]) * config.radius;
    }

    corners.push(cornerIndex);
    positions.push(...shape.points.flat());
    offsets.push(positions.length / 3);
    sinuosity.push(distance / shape.length);
  }

  return {
    corner: Uint32Array.from(corners),
    offsets: Uint32Array.from(offsets),
    points: Float32Array.from(positions),
    sinuosity: Float32Array.from(sinuosity),
  };
}
