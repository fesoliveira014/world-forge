import * as THREE from 'three';
import { lakeCoverageAt } from '../core/generation/lake-state';
import type { Layer, World } from '../core/model';
import { WaterSurface, WATER_LIFT } from './WaterSurface';
import { CATEGORICAL } from './palette';
import { clipMapMaterial, projectMesh, type Projection } from './projection';
import { mapReliefScale, type MapStyle } from './MapStyle';

/** Rain-fed cutoff pools and dry channel scars use the same stored footprint. */
export function createOxbowSurfaces(
  world: World,
  relief: number,
  season: number,
  projection: Projection,
  layer: Layer = 'world',
  style: MapStyle = 'natural',
) {
  const surface = new WaterSurface(
    world,
    relief,
    CATEGORICAL.includes(layer),
    projection === 'map',
    style === 'relief',
  );
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const center = new THREE.Vector3();
  const previousPoint = new THREE.Vector3();
  const after = new THREE.Vector3();
  const side = new THREE.Vector3();
  const point = new THREE.Vector3();
  const color = new THREE.Color();

  for (let pondIndex = 0; pondIndex < world.terrain.oxbows.length; pondIndex++) {
    const pond = world.terrain.oxbows[pondIndex];
    const cellIndex = pond.cell;

    if (
      world.terrain.ocean[cellIndex] ||
      lakeCoverageAt(world.drainage, cellIndex, season) >= 0.5
    ) {
      continue;
    }

    const depth =
      season < 0
        ? world.water.oxbowDepth.reduce((sum, field) => sum + field[pondIndex], 0) / 4
        : world.water.oxbowDepth[season][pondIndex];
    const temperature =
      season < 0
        ? world.water.temperature[cellIndex]
        : world.water.seasonalTemperature[season][cellIndex];
    const count = pond.points.length / 3;
    const start = positions.length / 3;
    const width = (pond.width * 2.5) / world.config.radius;
    color.set(depth < 0.02 ? '#8c8065' : temperature < 0 ? '#bdcfd3' : '#398f9c');
    if (style === 'illustrated') {
      color.set(depth < 0.02 ? '#aca588' : temperature < 0 ? '#e4e8db' : '#9eafa5');
    }

    for (let sampleIndex = 0; sampleIndex < count; sampleIndex++) {
      center.fromArray(pond.points, sampleIndex * 3).normalize();
      previousPoint.fromArray(pond.points, Math.max(0, sampleIndex - 1) * 3);
      after.fromArray(pond.points, Math.min(count - 1, sampleIndex + 1) * 3).sub(previousPoint);
      side.copy(center).cross(after).normalize().multiplyScalar(width);

      for (const sign of [-1, 1]) {
        point.copy(center).addScaledVector(side, sign);
        surface.place(point, WATER_LIFT.oxbow);
        positions.push(point.x, point.y, point.z);
      }

      for (let sampleIndex = 0; sampleIndex < 2; sampleIndex++) {
        colors.push(color.r, color.g, color.b);
      }

      const vertexOffset = start + sampleIndex * 2;

      if (sampleIndex + 1 < count) {
        indices.push(
          vertexOffset,
          vertexOffset + 1,
          vertexOffset + 2,
          vertexOffset + 1,
          vertexOffset + 3,
          vertexOffset + 2,
        );
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });

  if (projection === 'map') {
    projectMesh(geometry, WATER_LIFT.oxbow, mapReliefScale(style));
    clipMapMaterial(material);
  }

  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 2;

  return mesh;
}
