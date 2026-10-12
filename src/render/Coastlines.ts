import * as THREE from 'three';
import type { Grid, World } from '../core/model';
import { projectLines, type Projection } from './projection';
import { mapReliefScale, type MapStyle } from './MapStyle';

/** Ocean connectivity, rather than an elevation threshold, defines the coastline.
 * Inland lakes do not become separate landmass outlines. */
export function coastlineEdges(grid: Grid, ocean: Uint8Array) {
  const edges: number[] = [];

  for (let edgeIndex = 0; edgeIndex < grid.edgeLength.length; edgeIndex++) {
    if (ocean[grid.edgeCells[edgeIndex * 2]] !== ocean[grid.edgeCells[edgeIndex * 2 + 1]]) {
      edges.push(edgeIndex);
    }
  }

  return edges;
}

export function createCoastlines(
  world: World,
  relief: number,
  projection: Projection,
  style: MapStyle = 'natural',
) {
  const grid = world.grid;
  const edges = coastlineEdges(grid, world.terrain.ocean);
  const positions = new Float32Array(edges.length * 6);
  let vertexOffset = 0;

  for (const edgeIndex of edges) {
    for (let endpointIndex = 0; endpointIndex < 2; endpointIndex++) {
      const cornerIndex = grid.edgeCorners[edgeIndex * 2 + endpointIndex];
      const displayRadius =
        1 +
        (Math.max(0, world.drainage.height[cornerIndex]) / world.config.radius) * relief +
        0.003;

      for (let axis = 0; axis < 3; axis++) {
        positions[vertexOffset++] = grid.corners[cornerIndex * 3 + axis] * displayRadius;
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  if (projection === 'map') {
    projectLines(geometry, 0.005, mapReliefScale(style), 0.003);
  }

  const lines = new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({ color: '#f2dfb9', transparent: true, opacity: 0.85 }),
  );
  lines.renderOrder = 3;

  return lines;
}
