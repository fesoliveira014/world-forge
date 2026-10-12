import * as THREE from 'three';
import type { Layer, World } from '../core/model';
import { FlowParticles } from './FlowParticles';
import { createRiverStrips } from './RiverStrips';
import { createOxbowSurfaces } from './OxbowSurfaces';
import { RiverGeometry } from './RiverGeometry';
import { BANK_LAYERS, createLayerMaterial } from './RiverbankTexture';
import { exposedLandFraction } from '../core/generation/lake-state';
import { clipMapMaterial, projectLines, projectMesh, type Projection } from './projection';
import { mapReliefScale, type MapStyle } from './MapStyle';

/** Only the display settings needed to construct grid, plate, water, and flow overlays. */
interface OverlayOptions {
  mapStyle?: MapStyle;
  projection: Projection;
  layer: Layer;
  season: number;
  relief: number;
  gridLines: boolean;
  boundaries: boolean;
  rivers: boolean;
  vectors: boolean;
  riverThreshold: number;
  riverWidth: number;
  particleCount: number;
}

export function surfaceHeight(world: World, cellIndex: number) {
  return world.terrain.height[cellIndex] + world.drainage.lakeDepth[cellIndex];
}

export function cornerHeight(world: World, cornerIndex: number) {
  const lakeIndex = world.drainage.lakeId[cornerIndex];

  return lakeIndex >= 0 && world.drainage.lakeFraction[cornerIndex] > 0
    ? Math.max(world.drainage.height[cornerIndex], world.drainage.lakes[lakeIndex].level)
    : world.drainage.height[cornerIndex];
}

export function displayRadiusAtHeight(height: number, relief: number, planetRadius: number) {
  return 1 + (Math.max(0, height) / planetRadius) * relief;
}

/** Indexed dual fans keep categorical colors inside each cell. Allocated only when needed. */
export function buildCellMesh(
  world: World,
  relief: number,
  projection: Projection,
  texture: THREE.DataTexture,
) {
  const grid = world.grid;
  const vertices = grid.count + grid.cellCorners.length;
  const positions = new Float32Array(vertices * 3);
  const colors = new Float32Array(vertices * 3);
  const cellIndices = new Float32Array(vertices);
  const bankLand = new Float32Array(vertices);
  const indices = new Uint32Array(grid.cellCorners.length * 3);
  let vertexIndex = 0;
  let triangleOffset = 0;

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    const first = vertexIndex;
    const begin = grid.offsets[cellIndex];
    const end = grid.offsets[cellIndex + 1];
    const displayRadius = displayRadiusAtHeight(
      surfaceHeight(world, cellIndex),
      relief,
      world.config.radius,
    );
    cellIndices[vertexIndex] = cellIndex;
    bankLand[vertexIndex] = exposedLandFraction(world.terrain, world.drainage, cellIndex);

    for (let axisIndex = 0; axisIndex < 3; axisIndex++) {
      positions[vertexIndex * 3 + axisIndex] =
        grid.positions[cellIndex * 3 + axisIndex] * displayRadius;
    }

    vertexIndex++;

    for (let neighborOffset = begin; neighborOffset < end; neighborOffset++) {
      const cornerIndex = grid.cellCorners[neighborOffset];
      const cornerDisplayRadius = displayRadiusAtHeight(
        cornerHeight(world, cornerIndex),
        relief,
        world.config.radius,
      );
      cellIndices[vertexIndex] = cellIndex;
      bankLand[vertexIndex] = bankLand[first];

      for (let axisIndex = 0; axisIndex < 3; axisIndex++) {
        positions[vertexIndex * 3 + axisIndex] =
          grid.corners[cornerIndex * 3 + axisIndex] * cornerDisplayRadius;
      }

      vertexIndex++;
    }

    for (let triangleIndex = 0; triangleIndex < end - begin; triangleIndex++) {
      indices[triangleOffset++] = first;
      indices[triangleOffset++] = first + 1 + triangleIndex;
      indices[triangleOffset++] = first + 1 + ((triangleIndex + 1) % (end - begin));
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geom.setAttribute('cell', new THREE.BufferAttribute(cellIndices, 1));
  geom.setAttribute('bankLand', new THREE.BufferAttribute(bankLand, 1));
  geom.setIndex(new THREE.BufferAttribute(indices, 1));
  const material = createLayerMaterial(texture, projection === 'map');
  material.side = THREE.DoubleSide;

  if (projection === 'map') {
    projectMesh(geom);
    clipMapMaterial(material);
  } else {
    geom.userData.base = positions.slice();
  }

  return new THREE.Mesh(geom, material);
}

export function buildOverlayMeshes(group: THREE.Group, world: World, options: OverlayOptions) {
  const grid = world.grid;
  const style = options.layer === 'world' ? (options.mapStyle ?? 'natural') : 'natural';

  function addLines(
    points: number[],
    color: string,
    opacity = 1,
    vertexColors?: number[],
    radialLift = 0.002,
  ) {
    if (!points.length) {
      return;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));

    if (vertexColors) {
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(vertexColors, 3));
    }

    if (options.projection === 'map') {
      projectLines(geometry, 0.004, mapReliefScale(style), radialLift);
    }

    group.add(
      new THREE.LineSegments(
        geometry,
        new THREE.LineBasicMaterial({
          color,
          transparent: opacity < 1,
          opacity,
          vertexColors: !!vertexColors,
        }),
      ),
    );
  }

  const lakeLevels = new Float32Array(world.drainage.lakes.length);

  for (const lake of world.drainage.lakes) {
    lakeLevels[lake.id] = lake.level;
  }

  function cornerPosition(cornerIndex: number, offset = 0.002): number[] {
    const lakeIndex = world.drainage.lakeId[cornerIndex];
    const elevation =
      lakeIndex >= 0 && world.drainage.lakeFraction[cornerIndex] > 0
        ? Math.max(world.drainage.height[cornerIndex], lakeLevels[lakeIndex])
        : world.drainage.height[cornerIndex];
    const displayRadius =
      displayRadiusAtHeight(elevation, options.relief, world.config.radius) + offset;

    return [
      grid.corners[cornerIndex * 3] * displayRadius,
      grid.corners[cornerIndex * 3 + 1] * displayRadius,
      grid.corners[cornerIndex * 3 + 2] * displayRadius,
    ];
  }

  if (options.gridLines) {
    const points: number[] = [];

    for (let edgeIndex = 0; edgeIndex < grid.edgeLength.length; edgeIndex++) {
      points.push(
        ...cornerPosition(grid.edgeCorners[edgeIndex * 2]),
        ...cornerPosition(grid.edgeCorners[edgeIndex * 2 + 1]),
      );
    }

    addLines(points, '#a0c6ca', 0.13);
  }

  if (options.boundaries || options.layer === 'tectonics') {
    const points: number[] = [];
    const colors: number[] = [];
    const color = new THREE.Color();

    for (let edgeIndex = 0; edgeIndex < grid.edgeLength.length; edgeIndex++) {
      const firstCell = grid.edgeCells[edgeIndex * 2];
      const secondCell = grid.edgeCells[edgeIndex * 2 + 1];
      const firstPlate = world.geology.plate[world.transfer[firstCell]];
      const secondPlate = world.geology.plate[world.transfer[secondCell]];

      if (firstPlate === secondPlate) {
        continue;
      }

      const processGrid = world.process;
      const processCell = world.transfer[firstCell];
      let kind = 0;

      for (
        let neighborOffset = processGrid.offsets[processCell];
        neighborOffset < processGrid.offsets[processCell + 1];
        neighborOffset++
      ) {
        if (world.geology.plate[processGrid.neighbors[neighborOffset]] === secondPlate) {
          kind = world.geology.boundary[processGrid.arcEdges[neighborOffset]];
          break;
        }
      }

      color.set(kind === 1 ? '#f4aa81' : kind === 2 ? '#86d5dc' : '#ece7bb');
      points.push(
        ...cornerPosition(grid.edgeCorners[edgeIndex * 2], 0.004),
        ...cornerPosition(grid.edgeCorners[edgeIndex * 2 + 1], 0.004),
      );
      colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
    }

    addLines(points, '#ffffff', 1, colors, 0.004);
  }

  let river: ReturnType<typeof createRiverStrips> | null = null;
  const showWater =
    options.layer !== 'initial' &&
    (options.rivers ||
      ['drainage', 'lakes', 'floodplains', 'sources', 'landforms', 'wetlands'].includes(
        options.layer,
      ));
  const showHabitats = BANK_LAYERS.includes(options.layer);
  const network = showWater ? new RiverGeometry(world) : undefined;

  if (showWater || showHabitats) {
    group.add(
      createOxbowSurfaces(
        world,
        options.relief,
        options.season,
        options.projection,
        options.layer,
        style,
      ),
    );
  }

  if (showWater) {
    river = createRiverStrips(
      world,
      options.riverThreshold,
      options.riverWidth,
      options.relief,
      options.season,
      options.projection,
      options.layer,
      network,
      style,
    );
    group.add(river.object);
  }

  const field =
    options.layer === 'currents' || options.layer === 'sst'
      ? 'current'
      : options.layer === 'wind'
        ? 'wind'
        : null;
  let flow: FlowParticles | null = null;

  if (options.vectors && field) {
    flow = new FlowParticles(
      world,
      field,
      options.season,
      options.particleCount,
      options.relief,
      options.projection,
    );
    group.add(flow.object);
  }

  return { river, flow };
}
