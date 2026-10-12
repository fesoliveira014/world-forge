import * as THREE from 'three';
import type { World } from '../core/model';
import { clamp } from '../core/math';
import { lakeAnchor } from './WaterSurface';
import { curveRiverPath } from './RiverCurve';

export const riverHalfWidth = (discharge: number, scale: number) =>
  scale * clamp(0.00017 * Math.sqrt(discharge / 20), 0.000035, 0.003);

/** Course lookup and shoreline anchors shared by river water and bank pigment. */
export class RiverGeometry {
  readonly courseAt: Int32Array;
  readonly bankAt: Int32Array;
  private strongestUpstream: Int32Array;
  private previousGuide = new THREE.Vector3();
  private nextGuide = new THREE.Vector3();
  private firstPosition = new THREE.Vector3();
  private secondPosition = new THREE.Vector3();
  private center = new THREE.Vector3();

  constructor(readonly world: World) {
    const cornerCount = world.drainage.receiver.length;
    this.courseAt = new Int32Array(cornerCount).fill(-1);
    this.bankAt = new Int32Array(cornerCount).fill(-1);
    this.strongestUpstream = new Int32Array(cornerCount).fill(-1);
    for (let corner = 0; corner < cornerCount; corner++) {
      const receiver = world.drainage.receiver[corner];
      if (receiver < 0 || !world.rivers.channel[corner]) {
        continue;
      }
      const previous = this.strongestUpstream[receiver];
      if (previous < 0 || world.drainage.discharge[corner] > world.drainage.discharge[previous]) {
        this.strongestUpstream[receiver] = corner;
      }
    }
    world.rivers.courses.corner.forEach(
      (cornerIndex, courseIndex) => (this.courseAt[cornerIndex] = courseIndex),
    );
    world.ecology.floodplains.corner.forEach(
      (cornerIndex, bankIndex) => (this.bankAt[cornerIndex] = bankIndex),
    );
  }

  getCoursePoints(cornerIndex: number): Float32Array {
    const {
      grid,
      drainage,
      rivers: { courses },
    } = this.world;
    const courseIndex = this.courseAt[cornerIndex];
    const receiverCorner = drainage.receiver[cornerIndex];
    const points =
      courseIndex < 0
        ? Float32Array.from([
            ...grid.corners.subarray(cornerIndex * 3, cornerIndex * 3 + 3),
            ...grid.corners.subarray(receiverCorner * 3, receiverCorner * 3 + 3),
          ])
        : courses.points.slice(
            courses.offsets[courseIndex] * 3,
            courses.offsets[courseIndex + 1] * 3,
          );
    lakeAnchor(this.world, cornerIndex, this.firstPosition).toArray(points, 0);
    lakeAnchor(this.world, receiverCorner, this.firstPosition).toArray(points, points.length - 3);
    let mouth = drainage.lakeFraction[cornerIndex] > 0 || drainage.lakeFraction[receiverCorner] > 0;

    if (drainage.receiver[receiverCorner] < 0 && drainage.lakeFraction[receiverCorner] <= 0) {
      for (let incidentIndex = 0; incidentIndex < 3; incidentIndex++) {
        const cellIndex = grid.triangles[receiverCorner * 3 + incidentIndex];

        if (!this.world.terrain.ocean[cellIndex]) {
          continue;
        }

        mouth = true;
        this.secondPosition.fromArray(grid.positions, cellIndex * 3);
        this.firstPosition
          .lerp(this.secondPosition, 0.4)
          .normalize()
          .toArray(points, points.length - 3);
        break;
      }
    }

    // Moving only a curved course's endpoint into a lake can make its final span
    // double back through the old points. Mouths use the direct anchored approach.
    if (mouth) {
      return Float32Array.from([...points.subarray(0, 3), ...points.subarray(points.length - 3)]);
    }
    const upstreamCorner = this.strongestUpstream[cornerIndex];
    const downstreamCorner = drainage.receiver[receiverCorner];
    const followsTrunk = this.strongestUpstream[receiverCorner] === cornerIndex;
    const previous =
      upstreamCorner >= 0 ? lakeAnchor(this.world, upstreamCorner, this.previousGuide) : null;
    const next =
      followsTrunk && this.world.rivers.channel[receiverCorner] && downstreamCorner >= 0
        ? lakeAnchor(this.world, downstreamCorner, this.nextGuide)
        : null;
    return curveRiverPath(points, previous, next);
  }

  /** Bank records are stored in edge-cell order; resolve them to a flow-relative side. */
  getBankIndex(cornerIndex: number, sign: number) {
    const bankIndex = this.bankAt[cornerIndex];

    if (bankIndex < 0) {
      return -1;
    }

    const { grid, drainage } = this.world;
    const receiverCorner = drainage.receiver[cornerIndex];
    let edge = 0;

    for (let incidentIndex = 0; incidentIndex < 3; incidentIndex++) {
      if (grid.cornerNeighbors[cornerIndex * 3 + incidentIndex] === receiverCorner) {
        edge = grid.cornerEdges[cornerIndex * 3 + incidentIndex];
      }
    }

    this.firstPosition.fromArray(grid.corners, cornerIndex * 3);
    this.secondPosition.fromArray(grid.corners, receiverCorner * 3);
    this.center.copy(this.firstPosition).cross(this.secondPosition);
    this.firstPosition.fromArray(grid.positions, grid.edgeCells[edge * 2] * 3);

    return bankIndex * 2 + ((this.center.dot(this.firstPosition) < 0 ? -1 : 1) === sign ? 0 : 1);
  }
}
