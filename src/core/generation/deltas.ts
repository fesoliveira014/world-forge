import type { Delta, Drainage, Grid, Rivers, Terrain, WorldConfig } from '../model';
import { angle, readVector, cross, dot, normalizeVector, type Vec3 } from '../math';
import { nearestCell } from '../grid/build';

/** Terminal subcell distributaries partition one authoritative river delivery.
 * Every branch ends in the same connected receiving water. No upstream receiver
 * is changed, and no branch receives a duplicate of the trunk's whole discharge.
 */
export function buildDeltas(
  grid: Grid,
  terrain: Terrain,
  drainage: Drainage,
  rivers: Rivers,
  config: WorldConfig,
  options: { physicalNeighborhood?: boolean } = {},
): Delta[] {
  const deltas: Delta[] = [];

  for (let cornerIndex = 0; cornerIndex < drainage.receiver.length; cornerIndex++) {
    const receiverCorner = drainage.receiver[cornerIndex];

    if (
      !rivers.channel[cornerIndex] ||
      receiverCorner < 0 ||
      drainage.discharge[cornerIndex] < 250
    ) {
      continue;
    }

    const lake = drainage.lakeFraction[receiverCorner] > 0 ? drainage.lakeId[receiverCorner] : -1;

    if (
      lake < 0 &&
      (drainage.receiver[receiverCorner] >= 0 ||
        ![0, 1, 2].some(
          (incidentIndex) => terrain.ocean[grid.triangles[receiverCorner * 3 + incidentIndex]],
        ))
    ) {
      continue;
    }

    const level = lake < 0 ? 0 : drainage.lakes[lake].level;
    const start = readVector(grid.corners, cornerIndex);
    const finish = readVector(grid.corners, receiverCorner);
    const side = normalizeVector(cross(start, finish));
    const reach = angle(start, finish) * config.radius;

    if (Math.max(0, drainage.height[cornerIndex] - level) / Math.max(1, reach) > 0.006) {
      continue;
    }

    const cells = new Set<number>();

    for (const corner of [cornerIndex, receiverCorner]) {
      for (let incidentIndex = 0; incidentIndex < 3; incidentIndex++) {
        const cellIndex = grid.triangles[corner * 3 + incidentIndex];
        cells.add(cellIndex);

        if (options.physicalNeighborhood) {
          continue;
        }

        for (
          let neighborOffset = grid.offsets[cellIndex];
          neighborOffset < grid.offsets[cellIndex + 1];
          neighborOffset++
        ) {
          cells.add(grid.neighbors[neighborOffset]);
        }
      }
    }

    if (options.physicalNeighborhood) {
      // A fixed ring shrinks wherever the adaptive mesh adds sites. Extend the
      // mouth's incident cells by physical distance, using the same 60 km reach
      // as the receiving-water search below.
      const nearby = [...cells];

      for (let head = 0; head < nearby.length; head++) {
        const cellIndex = nearby[head];

        for (
          let neighborOffset = grid.offsets[cellIndex];
          neighborOffset < grid.offsets[cellIndex + 1];
          neighborOffset++
        ) {
          const neighbor = grid.neighbors[neighborOffset];

          if (
            cells.has(neighbor) ||
            angle(finish, readVector(grid.positions, neighbor)) * config.radius > 60000
          ) {
            continue;
          }

          cells.add(neighbor);
          nearby.push(neighbor);
        }
      }
    }

    let sedimentVolume = 0;

    for (const cellIndex of cells) {
      sedimentVolume +=
        terrain.deltaSediment[cellIndex] * grid.areas[cellIndex] * config.radius ** 2;
    }

    if (sedimentVolume < 1e7) {
      continue;
    }

    const isWaterCorner = (corner: number) =>
      lake >= 0
        ? drainage.lakeId[corner] === lake && drainage.lakeFraction[corner] > 0
        : [0, 1, 2].some(
            (incidentIndex) => terrain.ocean[grid.triangles[corner * 3 + incidentIndex]],
          );

    const seen = new Set([receiverCorner]);
    const queue = [receiverCorner];

    for (let step = 0; step < queue.length && (options.physicalNeighborhood || step < 24); step++) {
      const corner = queue[step];

      for (let neighborSlot = 0; neighborSlot < 3; neighborSlot++) {
        const next = grid.cornerNeighbors[corner * 3 + neighborSlot];

        if (
          seen.has(next) ||
          !isWaterCorner(next) ||
          angle(finish, readVector(grid.corners, next)) * config.radius > 60000
        ) {
          continue;
        }

        seen.add(next);
        queue.push(next);
      }
    }

    const resolveEndpoint = (corner: number): Vec3 => {
      const position = readVector(grid.corners, corner);

      if (lake >= 0) {
        return position;
      }
      // center of an explicit wet patch
      const cell = [0, 1, 2]
        .map((incidentIndex) => grid.triangles[corner * 3 + incidentIndex])
        .find((cellIndex) => terrain.ocean[cellIndex])!;
      const ocean = readVector(grid.positions, cell);

      return normalizeVector(
        position.map((coordinate, axisIndex) => coordinate * 0.55 + ocean[axisIndex] * 0.45),
      );
    };

    queue.sort(
      (firstCorner, secondCorner) =>
        dot(side, readVector(grid.corners, firstCorner)) -
        dot(side, readVector(grid.corners, secondCorner)),
    );
    const terminals = [...new Set([receiverCorner, queue[0], queue[queue.length - 1]])];
    const branches: Delta['branches'] = [];

    for (const terminal of terminals) {
      const endpointPosition = resolveEndpoint(terminal);
      const points: number[] = [];
      let guess = grid.triangles[cornerIndex * 3];
      let valid = true;

      for (let sampleIndex = 0; sampleIndex <= 8; sampleIndex++) {
        const alongFraction = sampleIndex / 8;
        const position = normalizeVector(
          start.map(
            (coordinate, axisIndex) =>
              coordinate * (1 - alongFraction) + endpointPosition[axisIndex] * alongFraction,
          ),
        );
        guess = nearestCell(grid, ...position, guess);

        if (
          sampleIndex > 1 &&
          sampleIndex < 8 &&
          !terrain.ocean[guess] &&
          drainage.lakeCoverage[guess] < 0.5 &&
          terrain.height[guess] > level + 35
        ) {
          valid = false;
          break;
        }

        points.push(...position);
      }

      if (valid) {
        branches.push({ points: Float32Array.from(points), fraction: 0 });
      }
    }

    if (branches.length < 2) {
      continue;
    }

    const fractions = branches.length === 2 ? [0.65, 0.35] : [0.55, 0.25, 0.2];

    for (let branchIndex = 0; branchIndex < branches.length; branchIndex++) {
      branches[branchIndex].fraction = fractions[branchIndex];
    }

    deltas.push({ corner: cornerIndex, lake, sedimentVolume, branches });
  }

  return deltas;
}
