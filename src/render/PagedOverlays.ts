import * as THREE from 'three';
import type { OverlayLines, OverlayPacket, WorldHandle } from '../core/view/types';
import type { Deposit } from '../core/model';
import type { Vec3 } from '../core/math';
import { resourcePreset } from '../core/resource-presets';
import { depositMarkerSize } from './ResourceMarkers';
import { mapPoint, projectLines, MAP_HEIGHT_SHEAR, type Projection } from './projection';
import { mapReliefScale, type MapStyle } from './MapStyle';
import { PagedFlowTrails } from './PagedFlowTrails';
import { FANTASY_PALETTES, isFantasyMapStyle } from './FantasyStyle';

export interface OverlayAppearance {
  projection: Projection;
  relief: number;
  mapStyle: MapStyle;
  riverWidth: number;
  particleCount: number;
  vectors: boolean;
  flowKind?: 'wind' | 'current';
}
export interface OverlayLayerVisibility {
  rivers: boolean;
  coastlines: boolean;
  gridLines: boolean;
  boundaries: boolean;
  vectors: boolean;
}
export function disposeRenderObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    if (mesh.material) {
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        material.dispose();
      }
    }
  });
  object.removeFromParent();
}
export function overlayPosition(
  direction: Vec3,
  height: number,
  handle: WorldHandle,
  appearance: OverlayAppearance,
  offset = 0.000015,
): THREE.Vector3 {
  const altitude = (Math.max(0, height) / handle.config.radius) * appearance.relief;
  if (appearance.projection === 'globe') {
    return new THREE.Vector3(...direction).multiplyScalar(1 + altitude + offset);
  }
  const [lon, lat] = mapPoint(...direction);
  const lift = altitude * mapReliefScale(appearance.mapStyle);
  return new THREE.Vector3(lon, lat + lift * MAP_HEIGHT_SHEAR, lift + offset);
}
function linesGeometry(lines: OverlayLines, handle: WorldHandle, appearance: OverlayAppearance) {
  const positions = new Float32Array(lines.positions.length);
  // Projection's seam splitter also interpolates the physical relief stored in radius.
  for (let i = 0; i < lines.heights.length; i++) {
    const radius =
      1 + (Math.max(0, lines.heights[i]) / handle.config.radius) * appearance.relief + 0.000018;
    for (let a = 0; a < 3; a++) {
      positions[i * 3 + a] = lines.positions[i * 3 + a] * radius;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (appearance.projection === 'map') {
    projectLines(geometry, 0.00003, mapReliefScale(appearance.mapStyle), 0.000018);
  }
  return geometry;
}
export class PagedOverlays extends THREE.Group {
  readonly deposits: { deposit: Deposit; point: THREE.Vector3 }[] = [];
  private flowTrails: PagedFlowTrails | null = null;
  private retainedFlowTime = 0;
  private riverMaterial: THREE.ShaderMaterial | null = null;
  private markers: THREE.Sprite[] = [];
  private readonly visibleLayers = new Map<keyof OverlayLayerVisibility, THREE.Object3D>();
  constructor(
    packet: OverlayPacket,
    handle: WorldHandle,
    appearance: OverlayAppearance,
    selectedDeposit: string | null,
  ) {
    super();
    const fantasyPalette = isFantasyMapStyle(appearance.mapStyle)
      ? FANTASY_PALETTES[appearance.mapStyle]
      : null;
    const remember = (layer: keyof OverlayLayerVisibility, object: THREE.Object3D | null) => {
      if (object) {
        object.name = `overlay-${layer}`;
        this.visibleLayers.set(layer, object);
      }
    };
    const add = (
      lines: OverlayLines,
      color: string,
      opacity: number,
      dashed = false,
      surface = false,
      baseSphereOcclusion = false,
    ) => {
      if (!lines.positions.length) {
        return null;
      }
      const material = surface
        ? anchorLineMaterial(color, appearance.projection === 'map', opacity, baseSphereOcclusion)
        : dashed
          ? new THREE.LineDashedMaterial({
              color,
              transparent: true,
              opacity,
              dashSize: 0.003,
              gapSize: 0.002,
              depthWrite: false,
            })
          : new THREE.LineBasicMaterial({
              color,
              transparent: opacity < 1,
              opacity,
              depthWrite: false,
            });
      const mesh = new THREE.LineSegments(linesGeometry(lines, handle, appearance), material);
      mesh.computeLineDistances();
      mesh.renderOrder = 2;
      this.add(mesh);
      return mesh;
    };
    if (packet.rivers.positions.length) {
      const ribbon = riverRibbon(packet.rivers, handle, appearance);
      this.riverMaterial = ribbon.material as THREE.ShaderMaterial;
      this.add(ribbon);
      remember('rivers', ribbon);
    }
    remember(
      'coastlines',
      add(
        packet.coasts,
        fantasyPalette?.ink ?? (appearance.mapStyle === 'illustrated' ? '#383c31' : '#aecbd0'),
        0.68,
        false,
        true,
      ),
    );
    remember('boundaries', add(packet.boundaries, '#ebaa87', 0.8, true));
    if (packet.grid) {
      remember('gridLines', add(packet.grid, '#88a5b1', 0.55, false, true, true));
    }
    if (packet.drift) {
      add(packet.drift, '#ffcc85', 0.9);
    }
    if (packet.flow?.positions.length) {
      this.flowTrails = new PagedFlowTrails(packet.flow, handle, {
        ...appearance,
        kind: appearance.flowKind ?? 'wind',
      });
      this.flowTrails.object.visible = appearance.vectors;
      remember('vectors', this.flowTrails.object);
      this.add(this.flowTrails.object);
    }
    for (const deposit of packet.deposits) {
      const point = overlayPosition(deposit.anchor, 0, handle, appearance, 0.002);
      this.deposits.push({ deposit, point });
      const material = new THREE.SpriteMaterial({
        color: resourcePreset(deposit.resourceType).color,
        depthTest: false,
        sizeAttenuation: false,
      });
      const marker = new THREE.Sprite(material);
      marker.position.copy(point);
      const size =
        depositMarkerSize(deposit) * 0.0014 * (selectedDeposit === deposit.id ? 1.35 : 1);
      marker.scale.setScalar(size);
      marker.renderOrder = 5;
      this.add(marker);
      this.markers.push(marker);
      if (deposit.id === selectedDeposit) {
        const extent = regionRing(
          deposit.anchor,
          deposit.extentKm * 1000,
          handle.config.radius,
          '#fff1b8',
          appearance.projection === 'map',
        );
        if (appearance.projection === 'map') {
          projectLines(extent.geometry, 0.003);
        }
        this.add(extent);
      }
    }
  }
  /** Checkboxes take effect without waiting for a replacement packet. Apply the
   * latest flags to newly arrived packets too, since their query may be stale. */
  setVisibleLayers(flags: OverlayLayerVisibility): boolean {
    let changed = false;
    for (const [layer, object] of this.visibleLayers) {
      if (object.visible !== flags[layer]) {
        object.visible = flags[layer];
        changed = true;
      }
    }
    return changed;
  }
  get hasParticles() {
    return !!this.flowTrails?.object.visible && this.flowTrails.hasParticles;
  }
  setParticleCount(count: number) {
    this.flowTrails?.setParticleCount(count);
  }
  preserveFlowPhase(previous: PagedOverlays) {
    // An intervening empty packet while Flow trails is off must not forget the
    // paused phase before the next enabled packet arrives.
    this.retainedFlowTime = previous.flowTrails?.time ?? previous.retainedFlowTime;
    if (this.flowTrails) {
      this.flowTrails.time = this.retainedFlowTime;
    }
  }
  animate(
    seconds: number,
    enabled: boolean,
    speed: number,
    camera: THREE.Camera,
    width: number,
    height: number,
  ) {
    this.flowTrails?.setViewport(width, height);
    this.flowTrails?.animate(seconds, enabled && this.hasParticles, speed);
    if (this.riverMaterial) {
      this.riverMaterial.uniforms.viewport.value.set(width, height);
    }
    for (let i = 0; i < this.markers.length; i++) {
      this.markers[i].visible =
        camera instanceof THREE.OrthographicCamera ||
        this.deposits[i].point.dot(camera.position) > this.deposits[i].point.lengthSq();
    }
  }
  pick(
    camera: THREE.Camera,
    x: number,
    y: number,
    width: number,
    height: number,
    flat: boolean,
  ): string | null {
    const point = new THREE.Vector3();
    let selected: string | null = null;
    let best = Infinity;
    for (const marker of this.deposits) {
      if (!flat && marker.point.dot(camera.position) <= marker.point.lengthSq()) {
        continue;
      }
      point.copy(marker.point).project(camera);
      if (point.z < -1 || point.z > 1) {
        continue;
      }
      const distance = Math.hypot(
        ((point.x + 1) * width) / 2 - x,
        ((1 - point.y) * height) / 2 - y,
      );
      if (distance < depositMarkerSize(marker.deposit) && distance < best) {
        selected = marker.deposit.id;
        best = distance;
      }
    }
    return selected;
  }
}

function riverRibbon(lines: OverlayLines, handle: WorldHandle, appearance: OverlayAppearance) {
  const source = linesGeometry(lines, handle, appearance);
  const points = source.getAttribute('position');
  const positions: number[] = [];
  const other: number[] = [];
  const sides: number[] = [];
  const widths: number[] = [];
  for (let segment = 0; segment < points.count / 2; segment++) {
    let lengthSquared = 0;
    for (let axis = 0; axis < 3; axis++) {
      lengthSquared +=
        (points.getComponent(segment * 2, axis) - points.getComponent(segment * 2 + 1, axis)) ** 2;
    }
    // Map seam splitting reserves a second, degenerate segment for ordinary
    // reaches. It needs no ribbon vertices or undefined screen-space tangent.
    if (lengthSquared < 1e-20) {
      continue;
    }
    const width =
      lines.widths[Math.floor(segment / (appearance.projection === 'map' ? 2 : 1))] || 10;
    for (const [end, side] of [
      [0, -1],
      [0, 1],
      [1, 1],
      [0, -1],
      [1, 1],
      [1, -1],
    ]) {
      const vertex = segment * 2 + end;
      const next = segment * 2 + 1 - end;
      positions.push(points.getX(vertex), points.getY(vertex), points.getZ(vertex));
      other.push(points.getX(next), points.getY(next), points.getZ(next));
      sides.push(side * (end ? -1 : 1));
      widths.push(width / handle.config.radius);
    }
  }
  source.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('other', new THREE.Float32BufferAttribute(other, 3));
  geometry.setAttribute('edgeSide', new THREE.Float32BufferAttribute(sides, 1));
  geometry.setAttribute('channelWidth', new THREE.Float32BufferAttribute(widths, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: {
      viewport: { value: new THREE.Vector2(1000, 700) },
      widthScale: { value: appearance.riverWidth },
      flatView: { value: appearance.projection === 'map' },
      ink: {
        value: new THREE.Color(
          isFantasyMapStyle(appearance.mapStyle)
            ? FANTASY_PALETTES[appearance.mapStyle].river
            : appearance.mapStyle === 'illustrated'
              ? '#486d78'
              : '#5aafce',
        ),
      },
    },
    vertexShader: /* glsl */ `
      attribute vec3 other;
      attribute float edgeSide;
      attribute float channelWidth;
      uniform vec2 viewport;
      uniform float widthScale;
      uniform bool flatView;
      varying vec3 surfacePoint;
      varying vec2 mapPosition;
      void main() {
        vec4 here = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vec4 there = projectionMatrix * modelViewMatrix * vec4(other, 1.0);
        // Front-hemisphere clipping happens per fragment below. Avoid exploding
        // screen-space normals for a far-side endpoint at the camera plane.
        float hereW = max(0.00001, abs(here.w));
        float thereW = max(0.00001, abs(there.w));
        vec2 delta = (there.xy / thereW - here.xy / hereW) * viewport;
        vec2 normal = length(delta) > 0.00001 ? normalize(vec2(-delta.y, delta.x)) : vec2(0.0);
        float pixels = max(0.8, channelWidth * abs(projectionMatrix[1][1]) / hereW * viewport.y * 0.5) * widthScale;
        vec2 expansion = normal * edgeSide * min(40.0, pixels) / viewport * hereW;
        here.xy += expansion;
        surfacePoint = (modelMatrix * vec4(position, 1.0)).xyz;
        mapPosition = surfacePoint.xy;
        if (flatView) {
          mapPosition += expansion / vec2(projectionMatrix[0][0], projectionMatrix[1][1]);
        }
        gl_Position = here;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 ink;
      uniform bool flatView;
      varying vec3 surfacePoint;
      varying vec2 mapPosition;
      void main() {
        if (flatView) {
          if (abs(mapPosition.x) > 3.14159265359 || abs(mapPosition.y) > 1.57079632679) discard;
        } else if (dot(normalize(surfacePoint), cameraPosition - surfacePoint) <= 0.0) {
          discard;
        }
        gl_FragColor = vec4(ink, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.DoubleSide,
    // The physical surface samples supply relief placement. Coarser display
    // triangles must not bury a narrow channel between those samples; explicit
    // horizon clipping above still hides every back-facing river fragment.
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 2;
  // Screen-space channel width may extend beyond the centerline bounding box.
  mesh.frustumCulled = false;
  return mesh;
}

/** Selection overlays stay visible over relief but never show through the far hemisphere. */
export function anchorLineMaterial(
  color: string,
  flat: boolean,
  opacity = 0.95,
  baseSphereOcclusion = false,
) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ink: { value: new THREE.Color(color) },
      flatView: { value: flat },
      opacity: { value: opacity },
    },
    vertexShader: `varying vec3 point; void main() { point = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 ink; uniform bool flatView; uniform float opacity; varying vec3 point;
      void main() {
        ${
          baseSphereOcclusion
            ? `if (!flatView) {
              // Straight zero-height chords can dip inside the sphere. Restore
              // their radial surface only for visibility; preserve their geometry.
              vec3 surfacePoint = normalize(point) * max(1.0, length(point));
              vec3 ray = surfacePoint - cameraPosition;
              float closestT = clamp(-dot(cameraPosition, ray) / max(dot(ray, ray), 1e-20), 0.0, 1.0);
              vec3 closest = cameraPosition + closestT * ray;
              if (closestT > 0.0 && closestT < 1.0 && dot(closest, closest) < 0.9999999) discard;
            }`
            : 'if (!flatView && dot(normalize(point), cameraPosition - point) <= 0.0) discard;'
        }
        if (flatView && (abs(point.x) > 3.141593 || abs(point.y) > 1.570797)) discard;
        gl_FragColor = vec4(ink, opacity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
}

/** A geodesic ring is independent of mesh IDs and survives snapshot replacement. */
export function regionRing(
  center: Vec3,
  radiusMetres: number,
  planetRadius: number,
  color = '#ffd08a',
  flat = false,
): THREE.LineSegments {
  const anchor = new THREE.Vector3(...center).normalize();
  const east = new THREE.Vector3()
    .crossVectors(
      Math.abs(anchor.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0),
      anchor,
    )
    .normalize();
  const north = new THREE.Vector3().crossVectors(anchor, east);
  const radius = Math.min(Math.PI, radiusMetres / planetRadius);
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < 128; i++) {
    const angle = (i * Math.PI) / 64;
    points.push(
      anchor
        .clone()
        .multiplyScalar(Math.cos(radius))
        .addScaledVector(east, Math.sin(radius) * Math.cos(angle))
        .addScaledVector(north, Math.sin(radius) * Math.sin(angle))
        .multiplyScalar(1.0001),
    );
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(
    points.flatMap((point, i) => [point, points[(i + 1) % points.length]]),
  );
  const line = new THREE.LineSegments(geometry, anchorLineMaterial(color, flat));
  line.renderOrder = 10;
  return line;
}
