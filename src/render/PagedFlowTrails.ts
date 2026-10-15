import * as THREE from 'three';
import type { OverlayLines, WorldHandle } from '../core/view/types';
import { mapReliefScale, type MapStyle } from './MapStyle';
import { MAP_HEIGHT_SHEAR, mapPoint, type Projection } from './projection';

export interface PagedFlowAppearance {
  projection: Projection;
  relief: number;
  mapStyle: MapStyle;
  kind?: 'wind' | 'current';
  particleCount: number;
}

export const FLOW_TRAIL_MAX_PATHS = 512;
export const FLOW_TRAIL_MAX_STEPS = 64;
const ANGULAR_STEP = 0.004;
const SURFACE_LIFT = 0.00002;
const MAX_PARTICLES = 8192;

interface Path {
  a: THREE.Vector3;
  b: THREE.Vector3;
  tangent: THREE.Vector3;
  angle: number;
  heightA: number;
  heightB: number;
  start: number;
  end: number;
}
interface Streamline {
  parts: Path[];
  angle: number;
  speed: number;
}
interface MapSample {
  x: number;
  y: number;
  height: number;
  t: number;
}

function nonnegative(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
function greatestCommonDivisor(a: number, b: number): number {
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
}
function sampleDirection(path: Path, t: number, target: THREE.Vector3) {
  if (t === 0) {
    return target.copy(path.a);
  }
  if (t === 1) {
    return target.copy(path.b);
  }
  return target
    .copy(path.a)
    .multiplyScalar(Math.cos(path.angle * t))
    .addScaledVector(path.tangent, Math.sin(path.angle * t))
    .normalize();
}

/** Project the bounded, field-integrated paths without restarting their history
 * at each sample, map seam or pole. Older two-point packets remain supported. */
export function flowTrailGeometry(
  lines: OverlayLines,
  handle: WorldHandle,
  appearance: PagedFlowAppearance,
) {
  const paths: Streamline[] = [];
  const segments = Math.floor(lines.positions.length / 6);
  const offsets = lines.pathOffsets;
  const total = offsets ? Math.max(0, offsets.length - 1) : segments;
  const limit = Math.min(total, FLOW_TRAIL_MAX_PATHS);
  for (let candidate = 0; candidate < limit; candidate++) {
    const sourcePath = Math.floor((candidate * total) / limit);
    const first = offsets ? offsets[sourcePath] : sourcePath;
    const last = offsets ? offsets[sourcePath + 1] : first + 1;
    if (first >= last || last > segments || last - first > FLOW_TRAIL_MAX_STEPS) {
      continue;
    }
    const parts: Path[] = [];
    let distance = 0;
    for (let source = first; source < last; source++) {
      const a = new THREE.Vector3().fromArray(lines.positions, source * 6);
      const b = new THREE.Vector3().fromArray(lines.positions, source * 6 + 3);
      if (
        ![a.x, a.y, a.z, b.x, b.y, b.z].every(Number.isFinite) ||
        a.lengthSq() < 1e-20 ||
        b.lengthSq() < 1e-20
      ) {
        break;
      }
      a.normalize();
      b.normalize();
      const dot = THREE.MathUtils.clamp(a.dot(b), -1, 1);
      const angle = Math.acos(dot);
      if (angle < 1e-8) {
        continue;
      }
      const tangent = b.clone().addScaledVector(a, -dot);
      if (tangent.lengthSq() < 1e-18) {
        // Antipodal vectors have no unique shortest arc. Pick a deterministic
        // orthogonal plane; ordinary source vectors are much shorter than this.
        const axis = Math.abs(a.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
        tangent.crossVectors(axis, a);
      }
      tangent.normalize();
      // A disconnected packet must not invent a bridge or reset its moving head.
      if (parts.length && parts[parts.length - 1].b.distanceToSquared(a) > 1e-10) {
        break;
      }
      parts.push({
        a,
        b,
        tangent,
        angle,
        heightA: nonnegative(lines.heights[source * 2]),
        heightB: nonnegative(lines.heights[source * 2 + 1]),
        start: distance,
        end: distance + angle,
      });
      distance += angle;
    }
    if (!parts.length) {
      continue;
    }
    for (const part of parts) {
      part.start /= distance;
      part.end /= distance;
    }
    paths.push({
      parts,
      angle: distance,
      speed: Math.min(1, nonnegative(lines.pathSpeeds?.[sourcePath] ?? 1)),
    });
  }
  const positions: number[] = [];
  const coordinates: number[] = [];
  const ranks: number[] = [];
  const phases: number[] = [];
  const speeds: number[] = [];
  const flat = appearance.projection === 'map';
  const heightScale = appearance.relief / handle.config.radius;
  const mapScale = mapReliefScale(appearance.mapStyle);
  // A coprime permutation distributes low density over the entire packet rather
  // than drawing only its first few (often spatially adjacent) paths.
  let stride = Math.max(1, Math.floor(paths.length * 0.61803398875));
  while (greatestCommonDivisor(stride, Math.max(1, paths.length)) !== 1) {
    stride++;
  }
  let currentRank = 0;
  let currentPhase = 0;
  let currentSpeed = 1;
  const push = (x: number, y: number, z: number, t: number) => {
    positions.push(x, y, z);
    coordinates.push(t);
    ranks.push(currentRank);
    phases.push(currentPhase);
    speeds.push(currentSpeed);
  };
  const mapVertex = (sample: MapSample) => {
    const lift = sample.height * heightScale * mapScale;
    push(sample.x, sample.y + lift * MAP_HEIGHT_SHEAR, lift + SURFACE_LIFT, sample.t);
  };
  const mapSegment = (a: MapSample, b: MapSample) => {
    // +pi and -pi are the same physical meridian. Float32 endpoint signs can
    // alternate along it; there is no longitude interval to divide by. Draw
    // both map borders with identical history rather than a NaN seam fraction.
    if (Math.abs(Math.abs(a.x) - Math.PI) < 1e-9 && Math.abs(Math.abs(b.x) - Math.PI) < 1e-9) {
      for (const x of [-Math.PI, Math.PI]) {
        mapVertex({ ...a, x });
        mapVertex({ ...b, x });
      }
      return;
    }
    if (Math.abs(b.x - a.x) <= Math.PI) {
      mapVertex(a);
      mapVertex(b);
      return;
    }
    const unwrapped = b.x + (a.x > 0 ? 2 * Math.PI : -2 * Math.PI);
    const boundary = a.x > 0 ? Math.PI : -Math.PI;
    const fraction = (boundary - a.x) / (unwrapped - a.x);
    const seam = {
      x: boundary,
      y: THREE.MathUtils.lerp(a.y, b.y, fraction),
      height: THREE.MathUtils.lerp(a.height, b.height, fraction),
      t: THREE.MathUtils.lerp(a.t, b.t, fraction),
    };
    mapVertex(a);
    mapVertex(seam);
    mapVertex({ ...seam, x: -boundary });
    mapVertex(b);
  };
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  for (let pathIndex = 0; pathIndex < paths.length; pathIndex++) {
    const streamline = paths[pathIndex];
    const seed = streamline.parts[0].a;
    currentRank = (pathIndex * stride) % paths.length;
    // Stable geographic phase avoids a synchronized marching stripe pattern.
    currentPhase = THREE.MathUtils.euclideanModulo(
      seed.x * 12.9898 + seed.y * 78.233 + seed.z * 37.719,
      1,
    );
    currentSpeed = streamline.speed;
    const perPartLimit = Math.max(1, Math.floor(FLOW_TRAIL_MAX_STEPS / streamline.parts.length));
    // Use one conservative lift for the entire path: adjacent parts must meet
    // exactly even when their lengths and tessellation counts differ.
    const stepCounts = streamline.parts.map((part) =>
      Math.max(1, Math.min(perPartLimit, Math.ceil(part.angle / ANGULAR_STEP))),
    );
    const maxStep = Math.max(...streamline.parts.map((part, i) => part.angle / stepCounts[i]));
    const globeLift = SURFACE_LIFT + 1 / Math.cos(maxStep / 2) - 1;
    for (let partIndex = 0; partIndex < streamline.parts.length; partIndex++) {
      const path = streamline.parts[partIndex];
      const steps = stepCounts[partIndex];
      // A line primitive is still a chord between tessellated samples. Compensate
      // its maximum sag so sea-level currents stay above the spherical sea even
      // when a deliberately oversized input reaches the subdivision bound.
      for (let step = 0; step < steps; step++) {
        const startT = step / steps;
        const endT = (step + 1) / steps;
        sampleDirection(path, startT, a);
        sampleDirection(path, endT, b);
        const heightA = THREE.MathUtils.lerp(path.heightA, path.heightB, startT);
        const heightB = THREE.MathUtils.lerp(path.heightA, path.heightB, endT);
        const coordinateA = THREE.MathUtils.lerp(path.start, path.end, startT);
        const coordinateB = THREE.MathUtils.lerp(path.start, path.end, endT);
        if (!flat) {
          const radiusA = 1 + heightA * heightScale + globeLift;
          const radiusB = 1 + heightB * heightScale + globeLift;
          push(a.x * radiusA, a.y * radiusA, a.z * radiusA, coordinateA);
          push(b.x * radiusB, b.y * radiusB, b.z * radiusB, coordinateB);
          continue;
        }
        const [initialLonA, latA] = mapPoint(a.x, a.y, a.z);
        const [initialLonB, latB] = mapPoint(b.x, b.y, b.z);
        let lonA = initialLonA;
        let lonB = initialLonB;
        const horizontalA = Math.hypot(a.x, a.z);
        const horizontalB = Math.hypot(b.x, b.z);
        if (horizontalA < 1e-8) {
          lonA = lonB;
        }
        if (horizontalB < 1e-8) {
          lonB = lonA;
        }
        const first = { x: lonA, y: latA, height: heightA, t: coordinateA };
        const last = { x: lonB, y: latB, height: heightB, t: coordinateB };
        // At a true pole crossing longitude is undefined. Split into the two
        // meridians meeting that pole, instead of drawing a horizontal map bridge.
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const horizontalLength = dx * dx + dz * dz;
        const fraction = horizontalLength > 0 ? -(a.x * dx + a.z * dz) / horizontalLength : -1;
        const crossesPole =
          horizontalA >= 1e-8 &&
          horizontalB >= 1e-8 &&
          fraction > 0 &&
          fraction < 1 &&
          Math.hypot(a.x + fraction * dx, a.z + fraction * dz) < 1e-8;
        if (crossesPole) {
          const poleY = Math.sign(a.y + (b.y - a.y) * fraction);
          const poleT = startT + Math.acos(THREE.MathUtils.clamp(a.y * poleY, -1, 1)) / path.angle;
          const pole = {
            y: (poleY * Math.PI) / 2,
            height: THREE.MathUtils.lerp(path.heightA, path.heightB, poleT),
            t: THREE.MathUtils.lerp(path.start, path.end, poleT),
          };
          mapSegment(first, { ...pole, x: lonA });
          mapSegment({ ...pole, x: lonB }, last);
        } else {
          mapSegment(first, last);
        }
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('pathCoordinate', new THREE.Float32BufferAttribute(coordinates, 1));
  geometry.setAttribute('pathRank', new THREE.Float32BufferAttribute(ranks, 1));
  geometry.setAttribute('pathPhase', new THREE.Float32BufferAttribute(phases, 1));
  geometry.setAttribute('pathSpeed', new THREE.Float32BufferAttribute(speeds, 1));
  geometry.computeBoundingSphere();
  return { geometry, pathCount: paths.length };
}

/** Ordinary indexed quads give trails a consistent pixel width on all WebGL
 * implementations; native GL lines commonly ignore widths greater than one. */
function ribbonGeometry(centerline: THREE.BufferGeometry) {
  const points = centerline.getAttribute('position');
  const segments = points.count / 2;
  const geometry = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(centerline.attributes)) {
    const data = new Float32Array(attribute.array.length * 2);
    for (let vertex = 0; vertex < attribute.count; vertex++) {
      for (let side = 0; side < 2; side++) {
        for (let axis = 0; axis < attribute.itemSize; axis++) {
          data[(vertex * 2 + side) * attribute.itemSize + axis] =
            attribute.array[vertex * attribute.itemSize + axis];
        }
      }
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(data, attribute.itemSize));
  }
  const other = new Float32Array(segments * 12);
  const side = new Float32Array(segments * 8);
  const indices = new Uint32Array(segments * 6);
  for (let segment = 0; segment < segments; segment++) {
    for (let vertex = 0; vertex < 4; vertex++) {
      const opposite = segment * 2 + (vertex < 2 ? 1 : 0);
      other.set(
        [points.getX(opposite), points.getY(opposite), points.getZ(opposite)],
        (segment * 4 + vertex) * 3,
      );
      // Opposite endpoint reverses tangent direction; keep physical left/right.
      side[(segment * 4 + vertex) * 2] = vertex % 2 ? 1 : -1;
      side[(segment * 4 + vertex) * 2 + 1] = vertex < 2 ? 1 : -1;
    }
    const v = segment * 4;
    indices.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], segment * 6);
  }
  geometry.setAttribute('otherPosition', new THREE.BufferAttribute(other, 3));
  geometry.setAttribute('lineSide', new THREE.BufferAttribute(side, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  centerline.dispose();
  return geometry;
}

export class PagedFlowTrails {
  readonly object: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly pathCount: number;
  private lastSeconds: number | null = null;
  private integratedTime = 0;
  private particleCount = 0;
  private disposed = false;
  constructor(
    lines: OverlayLines,
    handle: WorldHandle,
    appearance: PagedFlowAppearance,
    initialTime = 0,
  ) {
    const { geometry, pathCount } = flowTrailGeometry(lines, handle, appearance);
    this.pathCount = pathCount;
    const material = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        particleCount: { value: 0 },
        pathCount: { value: Math.max(1, pathCount) },
        flatView: { value: appearance.projection === 'map' },
        viewport: { value: new THREE.Vector2(1, 1) },
        lineWidth: { value: 2.4 },
        ink: { value: new THREE.Color(appearance.kind === 'current' ? '#95f4ee' : '#fff2ca') },
      },
      vertexShader: /* glsl */ `
        attribute float pathCoordinate; attribute float pathRank; attribute float pathPhase; attribute float pathSpeed;
        attribute vec3 otherPosition; attribute vec2 lineSide;
        uniform vec2 viewport; uniform float lineWidth;
        varying vec3 displayPoint; varying float coordinate; varying float rank; varying float phase;
        varying float across; varying float velocity;
        void main() {
          displayPoint = position; coordinate = pathCoordinate; rank = pathRank; phase = pathPhase;
          across = lineSide.x; velocity = pathSpeed;
          vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          vec4 other = projectionMatrix * modelViewMatrix * vec4(otherPosition, 1.0);
          vec2 delta = (other.xy / other.w - clip.xy / clip.w) * viewport;
          vec2 normal = vec2(-delta.y, delta.x) / max(length(delta), 1e-8);
          clip.xy += normal * lineSide.x * lineSide.y * lineWidth / viewport * clip.w;
          gl_Position = clip;
        }`,
      fragmentShader: /* glsl */ `
        uniform float time; uniform float particleCount; uniform float pathCount;
        uniform bool flatView; uniform vec3 ink;
        varying vec3 displayPoint; varying float coordinate; varying float rank; varying float phase;
        varying float across; varying float velocity;
        void main() {
          if (flatView) {
            if (abs(displayPoint.x) > 3.141593 || abs(displayPoint.y) > 1.570797) discard;
          } else {
            vec3 surfacePoint = normalize(displayPoint) * max(1.0, length(displayPoint));
            vec3 ray = surfacePoint - cameraPosition;
            float closestT = clamp(-dot(cameraPosition, ray) / max(dot(ray, ray), 1e-20), 0.0, 1.0);
            vec3 closest = cameraPosition + closestT * ray;
            if (closestT > 0.0 && closestT < 1.0 && dot(closest, closest) < 0.9999999) discard;
          }
          float repeatCount = floor(particleCount / pathCount);
          repeatCount += 1.0 - step(mod(particleCount, pathCount), rank);
          if (repeatCount < .5) discard;
          // A bright head travels start -> end, leaving a smooth fading tail.
          float behindHead = fract(phase + time * mix(.12, .28, velocity) * repeatCount - coordinate * repeatCount) / repeatCount;
          // Tail size is measured along the path, not inside one repeated head
          // interval. Keep a dark gap at high density instead of merging heads.
          float tailLength = min(.30, .70 / repeatCount);
          float fade = 1.0 - smoothstep(0.0, tailLength, behindHead);
          fade *= smoothstep(0.0, .035, coordinate) * (1.0 - smoothstep(.965, 1.0, coordinate));
          if (fade < .002) discard;
          float edge = 1.0 - smoothstep(.45, 1.0, abs(across));
          gl_FragColor = vec4(ink, edge * fade * .96);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      depthTest: appearance.kind === 'current',
      side: THREE.DoubleSide,
    });
    this.object = new THREE.Mesh(ribbonGeometry(geometry), material);
    this.object.name = 'flow-trails';
    this.object.renderOrder = 4;
    this.time = initialTime;
    this.setParticleCount(appearance.particleCount);
  }
  setViewport(width: number, height: number) {
    this.object.material.uniforms.viewport.value.set(Math.max(1, width), Math.max(1, height));
  }
  get time() {
    return this.integratedTime;
  }
  set time(value: number) {
    this.integratedTime = nonnegative(value);
    this.object.material.uniforms.time.value = this.integratedTime;
    this.lastSeconds = null;
  }
  get hasParticles() {
    return !this.disposed && this.pathCount > 0 && this.particleCount > 0;
  }
  setParticleCount(value: number) {
    this.particleCount = Math.min(MAX_PARTICLES, Math.floor(nonnegative(value)));
    this.object.material.uniforms.particleCount.value = this.particleCount;
    this.object.geometry.setDrawRange(0, this.particleCount ? Infinity : 0);
  }
  /** Integrate elapsed time, rather than multiplying an absolute clock by speed.
   * Pausing or changing speed cannot relocate a trail. Hidden/paused callers
   * still supply timestamps, preventing catch-up jumps on resume. */
  animate(seconds: number, enabled: boolean, speed: number) {
    if (this.disposed || !Number.isFinite(seconds)) {
      return;
    }
    if (this.lastSeconds !== null && enabled && this.hasParticles) {
      this.integratedTime += Math.max(0, seconds - this.lastSeconds) * nonnegative(speed);
      this.object.material.uniforms.time.value = this.integratedTime;
    }
    this.lastSeconds = seconds;
  }
  get bytes() {
    return (
      (this.object.geometry.index?.array.byteLength ?? 0) * 2 +
      Object.values(this.object.geometry.attributes).reduce(
        (sum, attribute) => sum + attribute.array.byteLength * 2,
        0,
      )
    );
  }
  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.object.removeFromParent();
    this.object.geometry.dispose();
    this.object.material.dispose();
  }
}
