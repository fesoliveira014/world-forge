import * as THREE from 'three';
import type { Deposit, ResourceType, World } from '../core/model';
import { clamp } from '../core/math';
import { nearestCell } from '../core/grid/build';
import { resourcePreset } from '../core/resource-presets';
import { mapPoint, projectLines, clipMapMaterial, type Projection } from './projection';
import { displayRadiusAtHeight, surfaceHeight } from './WorldMeshes';

export type ResourceFilter = ResourceType | 'all';

export function depositMarkerSize(deposit: Deposit): number {
  const [minimum, maximum] = resourcePreset(deposit.resourceType).amountRange;
  return 7 + 7 * clamp(Math.log(deposit.amount / minimum) / Math.log(maximum / minimum));
}

/** One indexed billboard batch. Pixel dimensions encode amount; footprint is separate. */
export class ResourceMarkers extends THREE.Group {
  private readonly markers: { deposit: Deposit; position: THREE.Vector3; diameter: number }[] = [];
  private readonly material: THREE.ShaderMaterial;
  private readonly screenPoint = new THREE.Vector3();
  private readonly localCamera = new THREE.Vector3();

  constructor(
    world: World,
    filter: ResourceFilter,
    private readonly projection: Projection,
    relief: number,
    selected: string | null,
  ) {
    super();
    const positions: number[] = [];
    const offsets: number[] = [];
    const colors: number[] = [];
    const sizes: number[] = [];
    const selections: number[] = [];
    const indices: number[] = [];
    let lookupCell = 0;

    for (const deposit of world.resources.deposits) {
      if (filter !== 'all' && deposit.resourceType !== filter) {
        continue;
      }
      lookupCell = nearestCell(world.grid, ...deposit.anchor, lookupCell);
      const radius =
        displayRadiusAtHeight(surfaceHeight(world, lookupCell), relief, world.config.radius) +
        0.006;
      const [longitude, latitude] = mapPoint(...deposit.anchor);
      const color = new THREE.Color(resourcePreset(deposit.resourceType).color);
      const isSelected = deposit.id === selected;
      const diameter = depositMarkerSize(deposit) + (isSelected ? 4 : 0);

      // Copies wrap a marker crossing the map edge; the shader clips each fragment.
      for (const shift of projection === 'map' ? [-2 * Math.PI, 0, 2 * Math.PI] : [0]) {
        const position =
          projection === 'map'
            ? new THREE.Vector3(longitude + shift, latitude, 0.022)
            : new THREE.Vector3(...deposit.anchor).multiplyScalar(radius);
        this.markers.push({ deposit, position, diameter });
        const firstVertex = sizes.length;
        for (const [x, y] of [
          [-0.5, -0.5],
          [0.5, -0.5],
          [0.5, 0.5],
          [-0.5, 0.5],
        ]) {
          positions.push(position.x, position.y, position.z);
          offsets.push(x, y);
          colors.push(color.r, color.g, color.b);
          sizes.push(diameter);
          selections.push(+isSelected);
        }
        indices.push(
          firstVertex,
          firstVertex + 1,
          firstVertex + 2,
          firstVertex,
          firstVertex + 2,
          firstVertex + 3,
        );
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('markerOffset', new THREE.Float32BufferAttribute(offsets, 2));
    geometry.setAttribute('markerColor', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setAttribute('markerSize', new THREE.Float32BufferAttribute(sizes, 1));
    geometry.setAttribute('markerSelected', new THREE.Float32BufferAttribute(selections, 1));
    geometry.setIndex(indices);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        viewportPixels: { value: new THREE.Vector2(1, 1) },
        pixelRatio: { value: 1 },
        mapUnitsPerPixel: { value: 0 },
        flatMap: { value: projection === 'map' },
      },
      vertexShader: /* glsl */ `
        attribute vec2 markerOffset;
        attribute vec3 markerColor;
        attribute float markerSize;
        attribute float markerSelected;
        uniform vec2 viewportPixels;
        uniform float pixelRatio;
        uniform float mapUnitsPerPixel;
        varying vec2 discPosition;
        varying vec2 mapPosition;
        varying vec3 depositColor;
        varying float selected;

        void main() {
          vec4 clipPosition = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          clipPosition.xy += markerOffset * markerSize * pixelRatio * 2.0 / viewportPixels * clipPosition.w;
          gl_Position = clipPosition;
          discPosition = markerOffset * 2.0;
          mapPosition = position.xy + markerOffset * markerSize * mapUnitsPerPixel;
          depositColor = markerColor;
          selected = markerSelected;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform bool flatMap;
        varying vec2 discPosition;
        varying vec2 mapPosition;
        varying vec3 depositColor;
        varying float selected;

        void main() {
          if (flatMap && (abs(mapPosition.x) > 3.14159265 || abs(mapPosition.y) > 1.57079633)) {
            discard;
          }
          float radius = length(discPosition);
          if (radius > 1.0) { discard; }
          vec3 border = mix(vec3(0.025, 0.04, 0.06), vec3(1.0, 0.93, 0.7), selected);
          vec3 color = mix(depositColor, border, smoothstep(0.66, 0.81, radius));
          gl_FragColor = vec4(color, 1.0 - smoothstep(0.88, 1.0, radius));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    this.add(mesh);

    const selectedDeposit = world.resources.deposits.find((deposit) => deposit.id === selected);
    if (selectedDeposit && (filter === 'all' || selectedDeposit.resourceType === filter)) {
      this.add(createDepositExtent(world, selectedDeposit, projection, relief));
    }
  }

  updateViewport(renderer: THREE.WebGLRenderer, camera: THREE.Camera) {
    renderer.getDrawingBufferSize(this.material.uniforms.viewportPixels.value);
    const pixelRatio = renderer.getPixelRatio();
    this.material.uniforms.pixelRatio.value = pixelRatio;
    this.material.uniforms.mapUnitsPerPixel.value =
      camera instanceof THREE.OrthographicCamera
        ? (camera.right - camera.left) /
          camera.zoom /
          (this.material.uniforms.viewportPixels.value.x / pixelRatio)
        : 0;
  }

  /** Match the billboard's pixel footprint and reject the hidden side of the globe. */
  pick(camera: THREE.Camera, x: number, y: number, width: number, height: number): string | null {
    this.updateWorldMatrix(true, false);
    camera.updateWorldMatrix(true, false);
    camera.getWorldPosition(this.localCamera);
    this.worldToLocal(this.localCamera);
    if (this.projection === 'map') {
      this.screenPoint.set((x / width) * 2 - 1, 1 - (y / height) * 2, 0).unproject(camera);
      this.worldToLocal(this.screenPoint);
      if (Math.abs(this.screenPoint.x) > Math.PI || Math.abs(this.screenPoint.y) > Math.PI / 2) {
        return null;
      }
    }
    let selected: string | null = null;
    let bestDistance = Infinity;

    for (const marker of this.markers) {
      if (
        this.projection === 'globe' &&
        marker.position.dot(this.localCamera) <= marker.position.lengthSq()
      ) {
        continue;
      }
      this.screenPoint.copy(marker.position).applyMatrix4(this.matrixWorld).project(camera);
      if (this.screenPoint.z < -1 || this.screenPoint.z > 1) {
        continue;
      }
      const screenX = (this.screenPoint.x + 1) * width * 0.5;
      const screenY = (1 - this.screenPoint.y) * height * 0.5;
      const distance = Math.hypot(x - screenX, y - screenY);
      if (distance <= marker.diameter * 0.5 + 3 && distance < bestDistance) {
        selected = marker.deposit.id;
        bestDistance = distance;
      }
    }
    return selected;
  }
}

function createDepositExtent(
  world: World,
  deposit: Deposit,
  projection: Projection,
  relief: number,
) {
  const anchor = new THREE.Vector3(...deposit.anchor);
  const east = new THREE.Vector3()
    .crossVectors(
      Math.abs(anchor.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0),
      anchor,
    )
    .normalize();
  const north = new THREE.Vector3().crossVectors(anchor, east);
  const angularRadius = (deposit.extentKm * 1000) / world.config.radius;
  const points: THREE.Vector3[] = [];
  let cell = nearestCell(world.grid, ...deposit.anchor);

  for (let segment = 0; segment < 64; segment++) {
    const bearing = (segment / 64) * Math.PI * 2;
    const direction = anchor
      .clone()
      .multiplyScalar(Math.cos(angularRadius))
      .addScaledVector(east, Math.sin(angularRadius) * Math.cos(bearing))
      .addScaledVector(north, Math.sin(angularRadius) * Math.sin(bearing));
    cell = nearestCell(world.grid, direction.x, direction.y, direction.z, cell);
    direction.multiplyScalar(
      displayRadiusAtHeight(surfaceHeight(world, cell), relief, world.config.radius) + 0.008,
    );
    points.push(direction);
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(
    points.flatMap((point, index) => [point, points[(index + 1) % points.length]]),
  );
  const material = new THREE.LineBasicMaterial({ color: '#fff1b8' });
  if (projection === 'map') {
    projectLines(geometry, 0.024);
    clipMapMaterial(material);
  }
  const line = new THREE.LineSegments(geometry, material);
  line.renderOrder = 6;
  return line;
}
