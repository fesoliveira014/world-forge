import * as THREE from 'three';
import type { World } from '../core/model';
import { nearestCell } from '../core/grid/build';
import { lakeCoverageAt } from '../core/generation/lake-state';

// Narrow channel/oxbow geometry sits just above the displayed surface.
export const WATER_LIFT = {
  river: 0.000075,
  oxbow: 0.00008,
};

export function surfaceRadius(world: World, cellIndex: number, relief: number) {
  return (
    1 +
    (Math.max(0, world.terrain.height[cellIndex] + world.drainage.lakeDepth[cellIndex]) * relief) /
      world.config.radius
  );
}

export function cornerRadius(world: World, cornerIndex: number, relief: number) {
  const drainage = world.drainage;
  const lakeIndex = drainage.lakeId[cornerIndex];
  const surfaceElevation =
    lakeIndex >= 0 && drainage.lakeFraction[cornerIndex] > 0
      ? Math.max(drainage.height[cornerIndex], drainage.lakes[lakeIndex].level)
      : drainage.height[cornerIndex];

  return 1 + (Math.max(0, surfaceElevation) * relief) / world.config.radius;
}

/** Drape narrow overlays onto the actual displayed triangle, not a second
 * interpolated height field. Nearest-cell walks inspect only incident faces.
 */
export class WaterSurface {
  private cell = 0;
  private ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3());
  private firstVertex = new THREE.Vector3();
  private secondVertex = new THREE.Vector3();
  private thirdVertex = new THREE.Vector3();
  private hit = new THREE.Vector3();

  constructor(
    private world: World,
    private relief: number,
    private dual = false,
    private flat = false,
    private raisedMap = false,
  ) {}

  place(point: THREE.Vector3, lift: number) {
    point.normalize();

    if (this.flat && !this.raisedMap) {
      return point.multiplyScalar(1 + lift);
    }

    const { grid } = this.world;
    this.cell = nearestCell(grid, point.x, point.y, point.z, this.cell);
    this.ray.direction.copy(point);
    const begin = grid.offsets[this.cell];
    const end = grid.offsets[this.cell + 1];

    for (let neighborOffset = begin; neighborOffset < end; neighborOffset++) {
      const cornerIndex = grid.cellCorners[neighborOffset];

      if (this.dual) {
        const next = grid.cellCorners[neighborOffset + 1 < end ? neighborOffset + 1 : begin];
        this.firstVertex
          .fromArray(grid.positions, this.cell * 3)
          .multiplyScalar(surfaceRadius(this.world, this.cell, this.relief));
        this.secondVertex
          .fromArray(grid.corners, cornerIndex * 3)
          .multiplyScalar(cornerRadius(this.world, cornerIndex, this.relief));
        this.thirdVertex
          .fromArray(grid.corners, next * 3)
          .multiplyScalar(cornerRadius(this.world, next, this.relief));
      } else {
        const firstCell = grid.triangles[cornerIndex * 3];
        const secondCell = grid.triangles[cornerIndex * 3 + 1];
        const thirdCell = grid.triangles[cornerIndex * 3 + 2];
        this.firstVertex
          .fromArray(grid.positions, firstCell * 3)
          .multiplyScalar(surfaceRadius(this.world, firstCell, this.relief));
        this.secondVertex
          .fromArray(grid.positions, secondCell * 3)
          .multiplyScalar(surfaceRadius(this.world, secondCell, this.relief));
        this.thirdVertex
          .fromArray(grid.positions, thirdCell * 3)
          .multiplyScalar(surfaceRadius(this.world, thirdCell, this.relief));
      }

      if (this.flat) {
        const longitude = Math.atan2(point.z, point.x);
        const latitude = Math.asin(point.y);
        const projected = [this.firstVertex, this.secondVertex, this.thirdVertex].map((vertex) => {
          const x = Math.atan2(vertex.z, vertex.x);
          return [
            x + Math.round((longitude - x) / (2 * Math.PI)) * 2 * Math.PI,
            Math.atan2(vertex.y, Math.hypot(vertex.x, vertex.z)),
            vertex.length(),
          ];
        });
        const [first, second, third] = projected;
        const determinant =
          (second[1] - third[1]) * (first[0] - third[0]) +
          (third[0] - second[0]) * (first[1] - third[1]);
        if (Math.abs(determinant) < 1e-15) {
          continue;
        }
        const firstWeight =
          ((second[1] - third[1]) * (longitude - third[0]) +
            (third[0] - second[0]) * (latitude - third[1])) /
          determinant;
        const secondWeight =
          ((third[1] - first[1]) * (longitude - third[0]) +
            (first[0] - third[0]) * (latitude - third[1])) /
          determinant;
        const thirdWeight = 1 - firstWeight - secondWeight;
        if (Math.min(firstWeight, secondWeight, thirdWeight) >= -1e-7) {
          return point.multiplyScalar(
            firstWeight * first[2] + secondWeight * second[2] + thirdWeight * third[2] + lift,
          );
        }
        continue;
      }

      if (
        this.ray.intersectTriangle(
          this.firstVertex,
          this.secondVertex,
          this.thirdVertex,
          false,
          this.hit,
        )
      ) {
        return point.multiplyScalar(this.hit.length() + lift);
      }
    }

    // At a shared edge, float rounding may miss both faces by a few ulps.
    return point.multiplyScalar(surfaceRadius(this.world, this.cell, this.relief) + lift);
  }
}

/** End within the cell-based lake surface, not at the former triangular patch.
 * The same receiving water is used by the globe, map and categorical views.
 */
export function lakeAnchor(world: World, cornerIndex: number, target: THREE.Vector3) {
  const grid = world.grid;

  if (world.drainage.lakeFraction[cornerIndex] <= 0) {
    return target.fromArray(grid.corners, cornerIndex * 3);
  }

  target.set(0, 0, 0);

  for (let incidentIndex = 0; incidentIndex < 3; incidentIndex++) {
    const cellIndex = grid.triangles[cornerIndex * 3 + incidentIndex];

    const wetFraction = lakeCoverageAt(world.drainage, cellIndex);
    target.x += grid.positions[cellIndex * 3] * wetFraction;
    target.y += grid.positions[cellIndex * 3 + 1] * wetFraction;
    target.z += grid.positions[cellIndex * 3 + 2] * wetFraction;
  }

  return target.lengthSq() > 0
    ? target.normalize()
    : target.fromArray(grid.corners, cornerIndex * 3);
}
