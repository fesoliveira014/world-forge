import * as THREE from 'three';
import { WaterSurface, WATER_LIFT } from './WaterSurface';

export interface RiverPoint {
  position: THREE.Vector3;
  width: number;
  phase: number;
  activity: number;
  source: number;
}

/** A connected stroke made of rectangular/trapezoidal spans and bounded bevels.
 * Each span has one perpendicular on both ends: its quad cannot twist into a
 * bow tie. Joins fill the corner without shrinking width or extending a miter.
 */
export class RiverRibbon {
  private positions: number[] = [];
  private uv: number[] = [];
  private activity: number[] = [];
  private sources: number[] = [];
  private indices: number[] = [];
  private point = new THREE.Vector3();
  private normal = new THREE.Vector3();
  private previousNormal = new THREE.Vector3();
  private firstPosition = new THREE.Vector3();
  private firstEdge = new THREE.Vector3();
  private secondEdge = new THREE.Vector3();
  private ribbonCount = 0;

  constructor(private surface: WaterSurface) {}

  private addVertex(riverPoint: RiverPoint, side: number) {
    this.point.copy(riverPoint.position).addScaledVector(this.normal, riverPoint.width * side);
    this.surface.place(this.point, WATER_LIFT.river);
    const vertexIndex = this.positions.length / 3;
    // Judge tiny bevels using the same precision as the uploaded vertex buffer.
    this.positions.push(
      Math.fround(this.point.x),
      Math.fround(this.point.y),
      Math.fround(this.point.z),
    );
    this.uv.push(riverPoint.phase, side);
    this.activity.push(riverPoint.activity);
    this.sources.push(riverPoint.source);

    return vertexIndex;
  }

  private addBevelTriangle(firstVertex: number, secondVertex: number, center: number) {
    this.firstPosition.fromArray(this.positions, firstVertex * 3);
    this.firstEdge.fromArray(this.positions, secondVertex * 3).sub(this.firstPosition);
    this.secondEdge.fromArray(this.positions, center * 3).sub(this.firstPosition);
    const signedArea = this.firstEdge.cross(this.secondEdge).dot(this.firstPosition);

    // Collinear joins need no filler. Match the spans' inward winding otherwise.
    if (Math.abs(signedArea) < 1e-16) {
      return;
    }

    this.indices.push(
      firstVertex,
      signedArea < 0 ? secondVertex : center,
      signedArea < 0 ? center : secondVertex,
    );
  }

  addPath(points: RiverPoint[]) {
    if (points.length < 2) {
      return;
    }

    this.ribbonCount++;
    let previousLeft = -1;
    let previousRight = -1;

    for (let pointIndex = 1; pointIndex < points.length; pointIndex++) {
      const startPoint = points[pointIndex - 1];
      const endPoint = points[pointIndex];
      this.normal.copy(startPoint.position).cross(endPoint.position).normalize();
      let left: number;
      let right: number;

      if (previousLeft >= 0 && this.previousNormal.dot(this.normal) > 1 - 1e-10) {
        left = previousLeft;
        right = previousRight;
      } else {
        left = this.addVertex(startPoint, -1);
        right = this.addVertex(startPoint, 1);

        if (previousLeft >= 0) {
          const center = this.addVertex(startPoint, 0);
          this.addBevelTriangle(previousLeft, left, center);
          this.addBevelTriangle(previousRight, right, center);
        }
      }

      const endLeft = this.addVertex(endPoint, -1);
      const endRight = this.addVertex(endPoint, 1);
      this.indices.push(left, right, endLeft, right, endRight, endLeft);
      previousLeft = endLeft;
      previousRight = endRight;
      this.previousNormal.copy(this.normal);
    }
  }

  buildGeometry() {
    const buildGeometry = new THREE.BufferGeometry();
    buildGeometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    buildGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    buildGeometry.setAttribute('activity', new THREE.Float32BufferAttribute(this.activity, 1));
    buildGeometry.setAttribute('sourceId', new THREE.Uint8BufferAttribute(this.sources, 1));
    buildGeometry.setIndex(this.indices);
    buildGeometry.userData.ribbons = this.ribbonCount;

    return buildGeometry;
  }
}
