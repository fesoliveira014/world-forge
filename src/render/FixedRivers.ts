import * as THREE from 'three';
import type { Layer } from '../core/model';
import type { FixedRiverBatch } from '../core/view/river-render-types';
import { riverCurvatureLimits } from '../core/view/river-width-limits';
import type { WorldHandle } from '../core/view/types';
import { mapReliefScale, type MapStyle } from './MapStyle';
import { RIVER_SOURCE_COLORS } from './palette';
import { projectMesh, type Projection } from './projection';
import { WATER_LIFT } from './WaterSurface';
import { FANTASY_PALETTES, isFantasyMapStyle } from './FantasyStyle';

export interface FixedRiverAppearance {
  projection: Projection;
  relief: number;
  mapStyle: MapStyle;
  layer: Layer;
  riverWidth: number;
}

const BANK_WIDTH = 4096;
const BANK_HEIGHT = BANK_WIDTH / 2;
const clamp = (value: number, minimum = 0, maximum = 1) =>
  Math.max(minimum, Math.min(maximum, value));

/** Paint directly into premultiplied storage, retaining strongest coverage at
 * junctions. Banks use physical widths, independently of the river width slider.
 * Longitude wraps, and distances use the local latitude metric, as in the
 * original RiverbankTexture. Only this batch's capsule bounds are visited.
 */
export function paintFixedRiverBanks(
  data: Uint8Array,
  width: number,
  height: number,
  batch: FixedRiverBatch,
) {
  let changed = false;
  const scale = height / Math.PI;
  const horizontalScale = width / (2 * Math.PI);
  const positions = batch.positions;
  const pointX = (point: number) =>
    (Math.atan2(positions[point * 3 + 2], positions[point * 3]) + Math.PI) * horizontalScale;
  const pointY = (point: number) =>
    (Math.atan2(
      positions[point * 3 + 1],
      Math.hypot(positions[point * 3], positions[point * 3 + 2]),
    ) +
      Math.PI / 2) *
    scale;
  const radiusAt = (point: number, side: number) => {
    const angularWidth = batch.bankWidths[point * 2 + side];
    return angularWidth > 0 ? Math.max(1.1, angularWidth * scale) : 0;
  };

  for (let path = 0; path + 1 < batch.offsets.length; path++) {
    for (let end = batch.offsets[path] + 1; end < batch.offsets[path + 1]; end++) {
      const start = end - 1;
      const startWidths = [radiusAt(start, 0), radiusAt(start, 1)];
      const endWidths = [radiusAt(end, 0), radiusAt(end, 1)];
      const radius = Math.max(...startWidths, ...endWidths);
      if (!radius) {
        continue;
      }
      const startX = pointX(start);
      const startY = pointY(start);
      let endX = pointX(end);
      const endY = pointY(end);
      endX += Math.round((startX - endX) / width) * width;
      const cosine =
        Math.max(0.025, Math.cos((startY + endY) / (2 * scale) - Math.PI / 2)) *
        (scale / horizontalScale);
      const directionX = (endX - startX) * cosine;
      const directionY = endY - startY;
      const lengthSquared = directionX * directionX + directionY * directionY;
      if (lengthSquared < 1e-12) {
        continue;
      }
      const horizontalRadius = radius / cosine;
      const minX = Math.floor(Math.min(startX, endX) - horizontalRadius);
      const maxX = Math.ceil(Math.max(startX, endX) + horizontalRadius);
      const minY = Math.max(0, Math.floor(Math.min(startY, endY) - radius));
      const maxY = Math.min(height - 1, Math.ceil(Math.max(startY, endY) + radius));

      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const offsetX = (x + 0.5 - startX) * cosine;
          const offsetY = y + 0.5 - startY;
          const along = clamp((offsetX * directionX + offsetY * directionY) / lengthSquared);
          // x/z longitude has opposite handedness to the spherical cross product.
          const side = directionX * offsetY - directionY * offsetX < 0 ? 0 : 1;
          const bankRadius = startWidths[side] + (endWidths[side] - startWidths[side]) * along;
          if (bankRadius <= 0) {
            continue;
          }
          const distance =
            Math.hypot(offsetX - directionX * along, offsetY - directionY * along) / bankRadius;
          if (distance >= 1) {
            continue;
          }
          const firstColor = start * 8 + side * 4;
          const lastColor = end * 8 + side * 4;
          const fade = clamp((distance - 0.18) / 0.82);
          const opacity =
            batch.bankColors[firstColor + 3] +
            (batch.bankColors[lastColor + 3] - batch.bankColors[firstColor + 3]) * along;
          const alpha = Math.round(255 * clamp(opacity) * (1 - fade * fade * (3 - 2 * fade)));
          const pixel = (y * width + (((x % width) + width) % width)) * 4;
          if (alpha <= data[pixel + 3]) {
            continue;
          }
          for (let component = 0; component < 3; component++) {
            const pigment =
              batch.bankColors[firstColor + component] +
              (batch.bankColors[lastColor + component] - batch.bankColors[firstColor + component]) *
                along;
            data[pixel + component] = Math.round(clamp(pigment) * alpha);
          }
          data[pixel + 3] = alpha;
          changed = true;
        }
      }
    }
  }
  return changed;
}

/** Offset-line intersections give both spans the same inner edge at a turn.
 * Only the outside receives a bevel: the spans and this one triangle partition
 * the water footprint instead of painting the inner corner multiple times.
 * All geographic samples, flow phase and seasonal attributes stay intact.
 */
export function buildFixedRiverGeometry(
  batch: FixedRiverBatch,
  radius: number,
  appearance: FixedRiverAppearance,
): THREE.BufferGeometry {
  let waterPointCount = 0;
  for (let path = 0; path + 1 < batch.offsets.length; path++) {
    if (batch.kinds[path] !== 4) {
      waterPointCount += batch.offsets[path + 1] - batch.offsets[path];
    }
  }
  // Prepared packets derive these ceilings before long trunks are split, so
  // shared endpoints have identical widths. Older/synthetic packets can still
  // derive local limits without changing their immutable geographic samples.
  let curvatureLimits = batch.curvatureLimits;
  if (!curvatureLimits && waterPointCount > 0) {
    curvatureLimits = new Float32Array(batch.heights.length).fill(1);
    for (let path = 0; path + 1 < batch.offsets.length; path++) {
      if (batch.kinds[path] === 0) {
        curvatureLimits.set(
          riverCurvatureLimits(
            batch.positions,
            batch.offsets[path],
            batch.offsets[path + 1],
            batch.incoming.subarray(path * 3, path * 3 + 3),
          ),
          batch.offsets[path],
        );
      }
    }
  }
  const capacity = waterPointCount * 3;
  const positions = new Float32Array(capacity * 3);
  const coordinates = new Float32Array(capacity * 2);
  const activities = new Float32Array(capacity);
  const sources = new Uint8Array(capacity);
  const kinds = new Uint8Array(capacity);
  const indices = new Uint32Array(waterPointCount * 9);
  const center = new THREE.Vector3();
  const before = new THREE.Vector3();
  const after = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const previousNormal = new THREE.Vector3();
  const nextNormal = new THREE.Vector3();
  const turnAxis = new THREE.Vector3();
  const first = new THREE.Vector3();
  const firstEdge = new THREE.Vector3();
  const secondEdge = new THREE.Vector3();
  let vertexCount = 0;
  let indexCount = 0;
  let segmentCount = 0;
  let pathCount = 0;
  let kind = 0;

  const pointWidth = (point: number) =>
    kind === 0
      ? Math.min(batch.halfWidths[point] * appearance.riverWidth, curvatureLimits![point])
      : batch.halfWidths[point];
  const addVertex = (point: number, side: number) => {
    const width = pointWidth(point);
    const lift = kind === 0 ? WATER_LIFT.river : WATER_LIFT.oxbow;
    const altitude = (Math.max(0, batch.heights[point]) / radius) * appearance.relief;
    center
      .fromArray(batch.positions, point * 3)
      .addScaledVector(normal, width * side)
      .normalize();
    center.multiplyScalar(1 + altitude + lift).toArray(positions, vertexCount * 3);
    coordinates[vertexCount * 2] = batch.phase[point];
    coordinates[vertexCount * 2 + 1] = side;
    activities[vertexCount] = batch.activity[point];
    sources[vertexCount] = batch.sources[point];
    kinds[vertexCount] = kind;
    return vertexCount++;
  };
  const triangle = (a: number, b: number, c: number) => {
    indices[indexCount++] = a;
    indices[indexCount++] = b;
    indices[indexCount++] = c;
  };
  const signedArea = (a: number, b: number, c: number) => {
    first.fromArray(positions, a * 3);
    firstEdge.fromArray(positions, b * 3).sub(first);
    secondEdge.fromArray(positions, c * 3).sub(first);
    return firstEdge.cross(secondEdge).dot(first);
  };
  const bevel = (a: number, b: number, middle: number) => {
    const area = signedArea(a, b, middle);
    if (Math.abs(area) >= 1e-16) {
      triangle(a, area < 0 ? b : middle, area < 0 ? middle : b);
    }
  };

  for (let path = 0; path + 1 < batch.offsets.length; path++) {
    kind = batch.kinds[path];
    if (kind === 4) {
      continue;
    }
    let previousLeft = -1;
    let previousRight = -1;
    const firstSegment = segmentCount;
    const retained = new Int32Array(batch.offsets[path + 1] - batch.offsets[path]);
    let count = 0;
    for (let point = batch.offsets[path]; point < batch.offsets[path + 1]; point++) {
      center.fromArray(batch.positions, point * 3).normalize();
      if (count > 0 && center.distanceToSquared(before) < 1e-14) {
        retained[count - 1] = point;
      } else {
        retained[count++] = point;
      }
      before.copy(center);
    }
    if (count < 2) {
      continue;
    }
    for (let sample = 0; sample < count; sample++) {
      const point = retained[sample];
      center.fromArray(batch.positions, point * 3).normalize();
      before
        .fromArray(
          sample > 0 ? batch.positions : batch.incoming,
          sample > 0 ? retained[sample - 1] * 3 : path * 3,
        )
        .normalize();
      if (sample + 1 < count) {
        after.fromArray(batch.positions, retained[sample + 1] * 3).normalize();
      } else if (batch.outgoing) {
        after.fromArray(batch.outgoing, path * 3).normalize();
      } else {
        after.set(0, 0, 0);
      }
      previousNormal.crossVectors(before, center);
      nextNormal.crossVectors(center, after);
      const hasIncoming = previousNormal.lengthSq() > 1e-20;
      const hasOutgoing = nextNormal.lengthSq() > 1e-20;
      previousNormal.normalize();
      nextNormal.normalize();
      if (!hasIncoming) {
        previousNormal.copy(nextNormal);
      }
      if (!hasOutgoing) {
        nextNormal.copy(previousNormal);
      }
      const alignment = clamp(previousNormal.dot(nextNormal), -1, 1);
      const turn = turnAxis.crossVectors(previousNormal, nextNormal).dot(center);
      let incomingLeft: number;
      let incomingRight: number;
      let outgoingLeft: number;
      let outgoingRight: number;
      let inside = -1;
      let outsideBefore = -1;
      let outsideAfter = -1;
      if (alignment > 1 - 1e-10 || Math.abs(turn) < 1e-12) {
        normal.copy(previousNormal);
        incomingLeft = outgoingLeft = addVertex(point, -1);
        incomingRight = outgoingRight = addVertex(point, 1);
      } else {
        const innerSide = Math.sign(turn);
        const width = pointWidth(point);
        normal
          .copy(previousNormal)
          .add(nextNormal)
          .multiplyScalar(1 / Math.max(1e-12, 1 + alignment));
        // Dense straight subdivisions must not narrow a stroke. Only the
        // longitudinal trim of a sharp inner miter is bounded by span length.
        const trim = width * Math.sqrt(Math.max(0, normal.lengthSq() - 1));
        const maxTrim = 0.45 * Math.min(before.distanceTo(center), after.distanceTo(center));
        if (trim > maxTrim) {
          normal.multiplyScalar(maxTrim / trim);
        }
        inside = addVertex(point, innerSide);
        normal.copy(previousNormal);
        outsideBefore = addVertex(point, -innerSide);
        normal.copy(nextNormal);
        outsideAfter = addVertex(point, -innerSide);
        incomingLeft = innerSide < 0 ? inside : outsideBefore;
        incomingRight = innerSide > 0 ? inside : outsideBefore;
        outgoingLeft = innerSide < 0 ? inside : outsideAfter;
        outgoingRight = innerSide > 0 ? inside : outsideAfter;
      }
      if (sample > 0) {
        // Unequal spans can trim one inner corner into a concave quad. Its
        // other diagonal partitions the same boundary without a reversed
        // sliver. Keep the existing diagonal for convex spans, and require
        // both replacement triangles to be valid rather than flipping faces.
        if (
          (signedArea(previousLeft, previousRight, incomingLeft) > 0 ||
            signedArea(previousRight, incomingRight, incomingLeft) > 0) &&
          signedArea(previousLeft, previousRight, incomingRight) <= 0 &&
          signedArea(previousLeft, incomingRight, incomingLeft) <= 0
        ) {
          triangle(previousLeft, previousRight, incomingRight);
          triangle(previousLeft, incomingRight, incomingLeft);
        } else {
          triangle(previousLeft, previousRight, incomingLeft);
          triangle(previousRight, incomingRight, incomingLeft);
        }
        segmentCount++;
      }
      // The batch containing the outgoing span owns this join. Its predecessor
      // computes the same shared inner intersection using the outgoing halo.
      if (inside >= 0 && sample + 1 < count) {
        bevel(outsideBefore, outsideAfter, inside);
      }
      previousLeft = outgoingLeft;
      previousRight = outgoingRight;
    }
    if (segmentCount > firstSegment) {
      pathCount++;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(positions.slice(0, vertexCount * 3), 3),
  );
  geometry.setAttribute('uv', new THREE.BufferAttribute(coordinates.slice(0, vertexCount * 2), 2));
  geometry.setAttribute('activity', new THREE.BufferAttribute(activities.slice(0, vertexCount), 1));
  geometry.setAttribute('sourceId', new THREE.BufferAttribute(sources.slice(0, vertexCount), 1));
  geometry.setAttribute('riverKind', new THREE.BufferAttribute(kinds.slice(0, vertexCount), 1));
  const retainedIndices =
    vertexCount <= 65535
      ? Uint16Array.from(indices.subarray(0, indexCount))
      : indices.slice(0, indexCount);
  geometry.setIndex(new THREE.BufferAttribute(retainedIndices, 1));
  geometry.userData.paths = pathCount;
  geometry.userData.segments = segmentCount;
  if (appearance.projection === 'map' && vertexCount > 0) {
    projectMesh(geometry, WATER_LIFT.river, mapReliefScale(appearance.mapStyle));
    // Appearance updates rebuild this geometry; seam interpolation recipes are
    // only needed by mutable meshes and would otherwise retain boxed arrays.
    delete geometry.userData.mapCopies;
  }
  geometry.computeBoundingSphere();
  return geometry;
}

export function createFixedRiverMaterial(appearance: FixedRiverAppearance) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      flatView: { value: appearance.projection === 'map' },
      inkMode: { value: appearance.mapStyle === 'illustrated' },
      reliefMode: { value: appearance.mapStyle === 'relief' },
      sourceMode: { value: appearance.layer === 'sources' },
      fantasyMode: { value: false },
      fantasyRiver: { value: new THREE.Color() },
      fantasyHighlight: { value: new THREE.Color() },
      fantasyPaper: { value: new THREE.Color() },
      fantasyOxbowColors: { value: [new THREE.Color(), new THREE.Color(), new THREE.Color()] },
      sourceColors: { value: RIVER_SOURCE_COLORS.map((color) => new THREE.Color(color)) },
      oxbowColors: {
        value: ['#398f9c', '#8c8065', '#bdcfd3'].map((color) => new THREE.Color(color)),
      },
      inkOxbowColors: {
        value: ['#9eafa5', '#aca588', '#e4e8db'].map((color) => new THREE.Color(color)),
      },
    },
    vertexShader: /* glsl */ `
      attribute float activity;
      attribute float sourceId;
      attribute float riverKind;
      varying vec2 flowCoordinates;
      varying float flowActivity;
      varying float waterSource;
      varying float waterKind;
      varying vec3 surfacePoint;
      void main() {
        flowCoordinates = uv;
        flowActivity = activity;
        waterSource = sourceId;
        waterKind = riverKind;
        surfacePoint = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float time;
      uniform bool flatView;
      uniform bool sourceMode;
      uniform bool inkMode;
      uniform bool reliefMode;
      uniform bool fantasyMode;
      uniform vec3 fantasyRiver;
      uniform vec3 fantasyHighlight;
      uniform vec3 fantasyPaper;
      uniform vec3 fantasyOxbowColors[3];
      uniform vec3 sourceColors[7];
      uniform vec3 oxbowColors[3];
      uniform vec3 inkOxbowColors[3];
      varying vec2 flowCoordinates;
      varying float flowActivity;
      varying float waterSource;
      varying float waterKind;
      varying vec3 surfacePoint;
      void main() {
        if (flatView) {
          if (abs(surfacePoint.x) > 3.14159265359 || abs(surfacePoint.y) > 1.57079632679) discard;
        } else if (dot(normalize(surfacePoint), cameraPosition - surfacePoint) <= 0.0) {
          discard;
        }
        float phase = fract(flowCoordinates.x * 70.0 - time * 0.7 + abs(flowCoordinates.y) * 0.12);
        float pulse = pow(0.5 + 0.5 * cos(phase * 6.2831853), 8.0);
        vec3 baseColor = sourceMode ? sourceColors[int(clamp(waterSource + 0.5, 0.0, 6.0))] : vec3(0.10, 0.49, 0.64);
        vec3 waterColor = mix(baseColor, vec3(0.78, 0.99, 0.93), pulse * (sourceMode ? 0.25 : 0.85));
        waterColor = mix(vec3(0.36, 0.46, 0.50), waterColor, flowActivity);
        if (fantasyMode) {
          waterColor = mix(fantasyRiver, fantasyHighlight, pulse * 0.22);
          waterColor = mix(mix(fantasyPaper, fantasyRiver, 0.45), waterColor, flowActivity);
        } else if (inkMode) {
          waterColor = mix(vec3(0.16, 0.20, 0.19), vec3(0.34, 0.42, 0.39), pulse * 0.18);
          waterColor = mix(vec3(0.40, 0.43, 0.38), waterColor, flowActivity);
        } else if (reliefMode) {
          waterColor = mix(vec3(0.10, 0.30, 0.38), vec3(0.38, 0.65, 0.67), pulse * 0.35);
          waterColor = mix(vec3(0.50, 0.60, 0.61), waterColor, flowActivity);
        }
        float opacity = mix(0.30, 0.95, flowActivity);
        if (waterKind > 0.5) {
          int kind = int(clamp(waterKind - 0.5, 0.0, 2.0));
          waterColor = fantasyMode ? fantasyOxbowColors[kind] : inkMode ? inkOxbowColors[kind] : oxbowColors[kind];
          opacity = 1.0;
        }
        gl_FragColor = vec4(waterColor, (1.0 - smoothstep(0.68, 1.0, abs(flowCoordinates.y))) * opacity);
        #include <colorspace_fragment>
      }
    `,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    // The persistent physical drape must survive coarser terrain facets. Explicit
    // per-fragment horizon clipping still hides the whole far hemisphere.
    depthTest: false,
  });
  updateFantasyRiverPalette(material, appearance);
  return material;
}

function updateFantasyRiverPalette(
  material: THREE.ShaderMaterial,
  appearance: FixedRiverAppearance,
) {
  const palette =
    appearance.layer === 'world' && isFantasyMapStyle(appearance.mapStyle)
      ? FANTASY_PALETTES[appearance.mapStyle]
      : null;
  material.uniforms.fantasyMode.value = !!palette;
  if (palette) {
    material.uniforms.fantasyRiver.value.set(palette.river);
    material.uniforms.fantasyHighlight.value.set(palette.riverHighlight);
    material.uniforms.fantasyPaper.value.set(palette.paper);
    const oxbows = material.uniforms.fantasyOxbowColors.value as THREE.Color[];
    oxbows[0].set(palette.river);
    oxbows[1].set(palette.rock);
    oxbows[2].set(palette.snow);
  }
}

function bufferBytes(batch: FixedRiverBatch) {
  return Object.values(batch).reduce<number>(
    (sum, value) => sum + (ArrayBuffer.isView(value) ? value.byteLength : 0),
    0,
  );
}

function geometryBytes(geometry: THREE.BufferGeometry) {
  return (
    Object.values(geometry.attributes).reduce((sum, value) => sum + value.array.byteLength, 0) +
    (geometry.index?.array.byteLength ?? 0)
  );
}

const EMPTY_BANK_FIELD = new Float32Array();

/** Retain only immutable water data needed for future projection/appearance
 * changes. Atlas painting has already consumed the original bank payload.
 */
function compactRiverPacket(packet: FixedRiverBatch): FixedRiverBatch | null {
  let paths = 0;
  let points = 0;
  for (let path = 0; path + 1 < packet.offsets.length; path++) {
    if (packet.kinds[path] !== 4) {
      paths++;
      points += packet.offsets[path + 1] - packet.offsets[path];
    }
  }
  if (paths === 0) {
    return null;
  }
  if (paths === packet.kinds.length) {
    return { ...packet, bankWidths: EMPTY_BANK_FIELD, bankColors: EMPTY_BANK_FIELD };
  }
  const offsets = new Uint32Array(paths + 1);
  const incoming = new Float32Array(paths * 3);
  const outgoing = packet.outgoing ? new Float32Array(paths * 3) : undefined;
  const kinds = new Uint8Array(paths);
  const positions = new Float32Array(points * 3);
  const heights = new Float32Array(points);
  const halfWidths = new Float32Array(points);
  const curvatureLimits = packet.curvatureLimits ? new Float32Array(points) : undefined;
  const phase = new Float32Array(points);
  const activity = new Float32Array(points);
  const sources = new Uint8Array(points);
  let nextPath = 0;
  let nextPoint = 0;
  for (let path = 0; path + 1 < packet.offsets.length; path++) {
    if (packet.kinds[path] === 4) {
      continue;
    }
    const begin = packet.offsets[path];
    const end = packet.offsets[path + 1];
    offsets[nextPath] = nextPoint;
    incoming.set(packet.incoming.subarray(path * 3, path * 3 + 3), nextPath * 3);
    outgoing?.set(packet.outgoing!.subarray(path * 3, path * 3 + 3), nextPath * 3);
    kinds[nextPath] = packet.kinds[path];
    positions.set(packet.positions.subarray(begin * 3, end * 3), nextPoint * 3);
    heights.set(packet.heights.subarray(begin, end), nextPoint);
    halfWidths.set(packet.halfWidths.subarray(begin, end), nextPoint);
    curvatureLimits?.set(packet.curvatureLimits!.subarray(begin, end), nextPoint);
    phase.set(packet.phase.subarray(begin, end), nextPoint);
    activity.set(packet.activity.subarray(begin, end), nextPoint);
    sources.set(packet.sources.subarray(begin, end), nextPoint);
    nextPoint += end - begin;
    nextPath++;
  }
  offsets[paths] = points;
  return {
    ...packet,
    offsets,
    incoming,
    outgoing,
    kinds,
    positions,
    heights,
    halfWidths,
    curvatureLimits,
    phase,
    activity,
    sources,
    bankWidths: EMPTY_BANK_FIELD,
    bankColors: EMPTY_BANK_FIELD,
  };
}

/** One snapshot/season/threshold owns this asset across scene recreation. Bank
 * inputs are painted in arrival order and discarded; the atlas and exact water
 * samples survive projection changes without another reader request.
 */
export class FixedRiverAsset {
  readonly bankTexture: THREE.DataTexture;
  private readonly records = new Map<number, FixedRiverBatch | null>();
  private readonly waterPackets: FixedRiverBatch[] = [];
  private rawBytes = 0;
  private retainedBytes = 0;
  private banksDirty = false;
  private disposed = false;

  constructor() {
    this.bankTexture = new THREE.DataTexture(
      new Uint8Array(BANK_WIDTH * BANK_HEIGHT * 4),
      BANK_WIDTH,
      BANK_HEIGHT,
      THREE.RGBAFormat,
    );
    this.bankTexture.wrapS = THREE.RepeatWrapping;
    this.bankTexture.minFilter = THREE.LinearMipmapLinearFilter;
    this.bankTexture.magFilter = THREE.LinearFilter;
    this.bankTexture.generateMipmaps = true;
    this.bankTexture.needsUpdate = true;
  }

  get packets(): readonly FixedRiverBatch[] {
    return this.waterPackets;
  }

  get receivedBatches() {
    return this.records.size;
  }

  get sourceBytes() {
    return this.rawBytes;
  }

  get packetBytes() {
    return this.retainedBytes;
  }

  get releasedBytes() {
    return this.rawBytes - this.retainedBytes;
  }

  /** Retained packet CPU bytes plus the CPU atlas and estimated GPU mipmaps. */
  get bytes() {
    return this.disposed
      ? 0
      : this.retainedBytes + Math.ceil(BANK_WIDTH * BANK_HEIGHT * 4 * (1 + 4 / 3));
  }

  addBatch(
    packet: FixedRiverBatch,
    options: { deferBankUpload?: boolean } = {},
  ): FixedRiverBatch | null {
    if (this.disposed) {
      return null;
    }
    if (this.records.has(packet.batch)) {
      return this.records.get(packet.batch)!;
    }
    if (packet.bankWidths.length > 0 && packet.bankColors.length > 0) {
      const changed = paintFixedRiverBanks(
        this.bankTexture.image.data as Uint8Array,
        BANK_WIDTH,
        BANK_HEIGHT,
        packet,
      );
      this.banksDirty = this.banksDirty || changed;
    }
    const retained = compactRiverPacket(packet);
    this.records.set(packet.batch, retained);
    this.rawBytes += bufferBytes(packet);
    if (retained) {
      this.waterPackets.push(retained);
      this.retainedBytes += bufferBytes(retained);
    }
    if (!options.deferBankUpload) {
      this.flushBanks();
    }
    return retained;
  }

  /** Mark the atlas for one upload after a group of CPU batches is consumed. */
  flushBanks(): boolean {
    if (this.disposed || !this.banksDirty) {
      return false;
    }
    this.bankTexture.needsUpdate = true;
    this.banksDirty = false;
    return true;
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.records.clear();
    this.waterPackets.length = 0;
    this.retainedBytes = 0;
    this.bankTexture.dispose();
    this.bankTexture.image.data = new Uint8Array();
  }
}

/** A scene owns only the projected geometry and shared river material. An
 * external asset survives scene disposal; the standalone constructor owns and
 * releases its asset for callers that do not need projection-scene reuse.
 */
export class FixedRivers extends THREE.Group {
  readonly asset: FixedRiverAsset;
  readonly bankTexture: THREE.DataTexture;
  private readonly ownsAsset: boolean;
  private readonly material: THREE.ShaderMaterial;
  private readonly batches = new Map<number, { batch: FixedRiverBatch; mesh: THREE.Mesh }>();
  private appearance: FixedRiverAppearance;
  private disposed = false;
  private lastSeconds: number | undefined;
  private animationTime = 0;

  constructor(
    private readonly handle: WorldHandle,
    appearance: FixedRiverAppearance,
    asset?: FixedRiverAsset,
  ) {
    super();
    this.name = 'fixed-rivers';
    this.appearance = { ...appearance };
    this.material = createFixedRiverMaterial(appearance);
    this.ownsAsset = asset === undefined;
    this.asset = asset ?? new FixedRiverAsset();
    this.bankTexture = this.asset.bankTexture;
  }

  addBatch(batch: FixedRiverBatch, options: { deferBankUpload?: boolean } = {}) {
    if (this.disposed || this.batches.has(batch.batch)) {
      return;
    }
    const retained = this.asset.addBatch(batch, options);
    if (!retained) {
      return;
    }
    const geometry = buildFixedRiverGeometry(retained, this.handle.config.radius, this.appearance);
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.name = `fixed-rivers-${batch.batch}`;
    mesh.renderOrder = 2;
    this.batches.set(batch.batch, { batch: retained, mesh });
    this.add(mesh);
  }

  /** Bulk loading can paint CPU batches progressively and upload the shared
   * atlas once at completion, instead of regenerating its mipmaps per batch.
   */
  flushBanks(): boolean {
    return !this.disposed && this.asset.flushBanks();
  }

  setAppearance(appearance: FixedRiverAppearance) {
    if (this.disposed) {
      return;
    }
    const changedGeometry =
      appearance.projection !== this.appearance.projection ||
      appearance.relief !== this.appearance.relief ||
      appearance.riverWidth !== this.appearance.riverWidth ||
      (appearance.projection === 'map' &&
        mapReliefScale(appearance.mapStyle) !== mapReliefScale(this.appearance.mapStyle));
    if (
      appearance.mapStyle !== this.appearance.mapStyle ||
      appearance.layer !== this.appearance.layer
    ) {
      updateFantasyRiverPalette(this.material, appearance);
    }
    this.appearance = { ...appearance };
    this.material.uniforms.flatView.value = appearance.projection === 'map';
    this.material.uniforms.inkMode.value = appearance.mapStyle === 'illustrated';
    this.material.uniforms.reliefMode.value = appearance.mapStyle === 'relief';
    this.material.uniforms.sourceMode.value = appearance.layer === 'sources';
    if (changedGeometry) {
      for (const { batch, mesh } of this.batches.values()) {
        const previous = mesh.geometry;
        mesh.geometry = buildFixedRiverGeometry(batch, this.handle.config.radius, appearance);
        previous.dispose();
      }
    }
  }

  animate(seconds: number, enabled = true, speed = 1) {
    if (enabled) {
      this.animationTime += Math.max(0, seconds - (this.lastSeconds ?? 0)) * speed;
    }
    this.lastSeconds = seconds;
    this.material.uniforms.time.value = this.animationTime;
  }

  get pathCount() {
    let count = 0;
    for (const { mesh } of this.batches.values()) {
      count += mesh.geometry.userData.paths;
    }
    return count;
  }

  get segmentCount() {
    let count = 0;
    for (const { mesh } of this.batches.values()) {
      count += mesh.geometry.userData.segments;
    }
    return count;
  }

  /** CPU packet/buffer bytes plus estimated GPU buffers and mipmapped atlas. */
  get bytes() {
    if (this.disposed) {
      return 0;
    }
    let bytes = this.asset.bytes;
    for (const { mesh } of this.batches.values()) {
      bytes += geometryBytes(mesh.geometry) * 2;
    }
    return bytes;
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const { mesh } of this.batches.values()) {
      mesh.geometry.dispose();
    }
    this.batches.clear();
    this.clear();
    this.material.dispose();
    if (this.ownsAsset) {
      this.asset.dispose();
    }
    this.removeFromParent();
  }
}
