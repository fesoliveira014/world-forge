import * as THREE from 'three';
import type { PhysicalMeshPacket } from '../core/view/physical-mesh-types';
import type { WorldHandle } from '../core/view/types';
import type { FantasyMapStyle } from './FantasyStyle';
import { FantasyRidgeField } from './FantasyRidges';
import { FantasyForestField, FantasyWaterMask } from './FantasyLandCover';
import {
  createFantasySymbolAtlas,
  FANTASY_ATLAS_COLUMNS,
  FANTASY_ATLAS_ROWS,
  FANTASY_SYMBOL_ANCHOR,
  FANTASY_SYMBOL_GROUPS,
} from './FantasySymbolAtlas';

const PI = Math.PI;
const TAU = PI * 2;
const DEGREE = PI / 180;

export interface FantasySymbol {
  direction: readonly [number, number, number];
  height: number;
  width: number;
  sizeY: number;
  rotation: number;
  tile: number;
  kind: 'mountain' | 'forest';
}

type FantasySymbolPlacement = Pick<
  FantasySymbol,
  'direction' | 'width' | 'sizeY' | 'rotation' | 'tile'
>;

/** Completed geographic placements only: no packets, collector or GPU assets.
 * Private Float64 storage preserves seam-copy decisions before GPU conversion. */
export class FantasySymbolPlacements implements Iterable<FantasySymbolPlacement> {
  readonly #values: Float64Array;
  readonly #tiles: Uint8Array;
  constructor(symbols: readonly FantasySymbol[]) {
    this.#values = new Float64Array(symbols.length * 6);
    this.#tiles = new Uint8Array(symbols.length);
    for (let index = 0; index < symbols.length; index++) {
      const symbol = symbols[index];
      this.#values.set(
        [...symbol.direction, symbol.width, symbol.sizeY, symbol.rotation],
        index * 6,
      );
      this.#tiles[index] = symbol.tile;
    }
  }
  get count() {
    return this.#tiles.length;
  }
  get bytes() {
    return this.#values.byteLength + this.#tiles.byteLength;
  }
  *[Symbol.iterator](): IterableIterator<FantasySymbolPlacement> {
    for (let index = 0; index < this.count; index++) {
      const offset = index * 6;
      yield {
        direction: [this.#values[offset], this.#values[offset + 1], this.#values[offset + 2]],
        width: this.#values[offset + 3],
        sizeY: this.#values[offset + 4],
        rotation: this.#values[offset + 5],
        tile: this.#tiles[index],
      };
    }
  }
}

const latitude = (x: number, y: number, z: number) => Math.atan2(y, Math.hypot(x, z));
const angularDistance = (a: readonly number[], b: readonly number[]) =>
  Math.atan2(
    Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]),
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  );

/** Bounded stream collector. Stable triangle-interior canopy samples and
 * rendered water footprints remain independent of packet order and mesh density. */
export class FantasySymbolCandidates {
  private readonly ridges: FantasyRidgeField;
  private readonly forests = new FantasyForestField();
  private readonly water = new FantasyWaterMask();
  constructor(radius: number, maximumHeight: number) {
    const minimumMountainHeight = Math.max(450, Math.min(1400, maximumHeight * 0.14));
    this.ridges = new FantasyRidgeField(radius, minimumMountainHeight);
  }
  get bytes() {
    return this.ridges.bytes + this.forests.bytes + this.water.bytes;
  }
  addPacket(packet: PhysicalMeshPacket) {
    this.ridges.addPacket(packet);
    if (
      packet.mode !== 'primal' ||
      !packet.materials[0] ||
      !packet.materials[1] ||
      !packet.materials[4]
    ) {
      return;
    }
    for (let face = 0; face < packet.indices.length; face += 3) {
      const ids = [packet.indices[face], packet.indices[face + 1], packet.indices[face + 2]];
      const points = ids.map((id) => {
        const offset = id * 3;
        const x = packet.directions[offset];
        const y = packet.directions[offset + 1];
        const z = packet.directions[offset + 2];
        const length = Math.hypot(x, y, z);
        return [x / length, y / length, z / length];
      });
      this.forests.addTriangle(packet, ids, points);
      this.water.addTriangle(packet, ids, points);
    }
  }
  finish(): FantasySymbol[] {
    const output: FantasySymbol[] = [];
    for (const symbol of this.ridges.finish()) {
      const [widthScale, heightScale] = this.water.fitMountain(
        symbol.direction,
        symbol.width,
        symbol.sizeY,
        symbol.rotation,
      );
      if (Math.min(widthScale, heightScale) < 0.3) {
        continue;
      }
      output.push({
        ...symbol,
        width: symbol.width * widthScale,
        sizeY: symbol.sizeY * heightScale,
      });
    }
    // Broad-phase spatial buckets keep forest exclusion proportional to local
    // ridge density rather than checking every peak on the whole globe.
    const mountainBuckets = new Map<number, FantasySymbol[]>();
    const bucketSize = 0.06;
    const bucket = (p: readonly number[]) => p.map((v) => Math.floor((v + 1) / bucketSize));
    const bucketKey = (x: number, y: number, z: number) => (x * 40 + y) * 40 + z;
    for (const symbol of output) {
      const [x, y, z] = bucket(symbol.direction);
      const key = bucketKey(x, y, z);
      const contents = mountainBuckets.get(key) ?? [];
      contents.push(symbol);
      mountainBuckets.set(key, contents);
    }
    const overlapsMountain = (direction: readonly number[]) => {
      const [x, y, z] = bucket(direction);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            for (const symbol of mountainBuckets.get(bucketKey(x + dx, y + dy, z + dz)) ?? []) {
              if (angularDistance(direction, symbol.direction) < symbol.width * 0.65) {
                return true;
              }
            }
          }
        }
      }
      return false;
    };
    for (const forest of this.forests.finish()) {
      const { direction, height: h } = forest;
      if (overlapsMountain(direction)) {
        continue;
      }
      let width = forest.width;
      let sizeY = width * 0.8;
      const footprint = Math.hypot(width * 0.57, sizeY * 0.98);
      const scale = Math.min(
        1,
        this.water.clearance(direction, footprint + this.water.step) / footprint,
      );
      if (scale < 0.42) {
        continue;
      }
      width *= scale;
      sizeY *= scale;
      const variants =
        Math.abs(latitude(...direction)) > 50 * DEGREE || h > 1500
          ? FANTASY_SYMBOL_GROUPS.conifers
          : FANTASY_SYMBOL_GROUPS.broadleaf;
      const tile =
        variants[Math.min(variants.length - 1, Math.floor(forest.variant * variants.length))];
      output.push({ direction, height: h, width, sizeY, rotation: 0, tile, kind: 'forest' });
    }
    // Northern/back peaks are painted first so overlapping southern foreground
    // silhouettes cover their bases, rather than cutting across their summits.
    output.sort(
      (a, b) =>
        b.direction[1] - a.direction[1] ||
        a.direction[0] - b.direction[0] ||
        a.direction[2] - b.direction[2] ||
        a.tile - b.tile,
    );
    return output;
  }
}

/** Copied immutable instance arrays, suitable for tests without a Canvas/DOM. */
export function fantasySymbolGeometry(
  symbols: Iterable<FantasySymbolPlacement>,
  projection: 'map' | 'globe',
) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const anchors: number[] = [];
  const sizes: number[] = [];
  const shifts: number[] = [];
  for (const symbol of symbols) {
    const lon = Math.atan2(symbol.direction[2], symbol.direction[0]);
    const latitudeScale = Math.max(0.12, Math.hypot(symbol.direction[0], symbol.direction[2]));
    const extent = Math.hypot(symbol.width / 2, symbol.sizeY) / latitudeScale;
    const copies =
      projection === 'map'
        ? [0, ...(lon + extent > PI ? [-TAU] : []), ...(lon - extent < -PI ? [TAU] : [])]
        : [0];
    for (const shift of copies) {
      anchors.push(...symbol.direction, 1.00004);
      sizes.push(symbol.width, symbol.sizeY, symbol.rotation, symbol.tile);
      shifts.push(shift);
    }
  }
  geometry.setAttribute(
    'symbolAnchor',
    new THREE.InstancedBufferAttribute(Float32Array.from(anchors), 4),
  );
  geometry.setAttribute(
    'symbolSize',
    new THREE.InstancedBufferAttribute(Float32Array.from(sizes), 4),
  );
  geometry.setAttribute(
    'longitudeShift',
    new THREE.InstancedBufferAttribute(Float32Array.from(shifts), 1),
  );
  geometry.instanceCount = shifts.length;
  return geometry;
}

function symbolMaterial(texture: THREE.Texture, flat: boolean) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: { atlas: { value: texture }, viewport: { value: new THREE.Vector2(1000, 700) } },
    vertexShader: /* glsl */ `
      attribute vec4 symbolAnchor; attribute vec4 symbolSize; attribute float longitudeShift;
      uniform vec2 viewport;
      varying vec2 glyphUv; varying vec2 mapCoordinate; varying vec3 worldPoint; varying float opacity;
      void main() {
        vec3 d = normalize(symbolAnchor.xyz);
        float longitude = length(d.xz) > 0.00000001 ? atan(d.z, d.x) : 0.0;
        float latitude = atan(d.y, length(d.xz));
        vec3 east = vec3(-sin(longitude), 0.0, cos(longitude));
        vec3 north = vec3(-d.y*cos(longitude), length(d.xz), -d.y*sin(longitude));
        // Center mountain ink over the sampled crest. Foot-anchored tall peaks
        // were displaced entirely northward, erasing north-facing coastal ranges.
        float anchorY = symbolSize.w < 6.0 ? 0.4 : ${FANTASY_SYMBOL_ANCHOR[1]};
        vec2 local = (position.xy - vec2(${FANTASY_SYMBOL_ANCHOR[0]}, anchorY)) * symbolSize.xy;
        local = mat2(cos(symbolSize.z), sin(symbolSize.z), -sin(symbolSize.z), cos(symbolSize.z)) * local;
        vec3 anchor = ${flat ? 'vec3(longitude + longitudeShift, latitude, 0.02)' : 'd * symbolAnchor.w'};
        vec4 center = projectionMatrix * modelViewMatrix * vec4(anchor, 1.0);
        float pixels = symbolSize.x * abs(projectionMatrix[1][1]) * viewport.y * 0.5 / max(0.0001, abs(center.w));
        // Size is geographic until an extreme closeup. Capping never moves its
        // saved anchor and low-size fading suppresses illegible distant ink.
        float cap = symbolSize.w < 6.0 ? 1.0 : min(1.0, 128.0 / max(1.0, pixels));
        local *= cap;
        // Canopy clusters remain readable at regional scale; hiding each small
        // tree at the old mountain threshold left whole rainforests blank.
        opacity = (symbolSize.w < 6.0 ? smoothstep(8.0, 16.0, pixels) : smoothstep(2.5, 7.0, pixels)) * step(0.0, center.w);
        vec3 point = ${flat ? 'anchor + vec3(local.x / max(0.12, length(d.xz)), local.y, 0.0)' : 'normalize(d + east * local.x + north * local.y) * symbolAnchor.w'};
        mapCoordinate = point.xy;
        worldPoint = (modelMatrix * vec4(point, 1.0)).xyz;
        glyphUv = (vec2(mod(symbolSize.w, ${FANTASY_ATLAS_COLUMNS}.0), ${FANTASY_ATLAS_ROWS - 1}.0 - floor(symbolSize.w / ${FANTASY_ATLAS_COLUMNS}.0)) + position.xy) / vec2(${FANTASY_ATLAS_COLUMNS}.0, ${FANTASY_ATLAS_ROWS}.0);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(point, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D atlas;
      varying vec2 glyphUv; varying vec2 mapCoordinate; varying vec3 worldPoint; varying float opacity;
      void main() {
        float visibility = opacity;
        ${
          flat
            ? 'if (abs(mapCoordinate.x) > 3.141592654 || abs(mapCoordinate.y) > 1.570796327) discard;'
            : `
          vec3 ray = cameraPosition - worldPoint;
          float distanceToCamera = length(ray);
          vec3 viewDirection = ray / max(distanceToCamera, 0.00001);
          float nearDistance = -dot(worldPoint, viewDirection);
          float discriminant = pow(dot(worldPoint, viewDirection), 2.0) - dot(worldPoint, worldPoint) + 1.0;
          if (discriminant > 0.0 && nearDistance - sqrt(discriminant) > 0.00001 && nearDistance - sqrt(discriminant) < distanceToCamera) discard;
          visibility *= smoothstep(-0.015, 0.12, dot(normalize(worldPoint), viewDirection));
        `
        }
        vec4 ink = texture2D(atlas, glyphUv);
        gl_FragColor = vec4(ink.rgb, ink.a * visibility);
        if (gl_FragColor.a < 0.003) discard;
        #include <colorspace_fragment>
      }
    `,
  });
}

/** One geographic illustration asset per fantasy appearance. Bounded selection
 * storage is released once its single atlas/instanced draw has been prepared. */
export class FantasySymbols extends THREE.Group {
  private collector: FantasySymbolCandidates | null;
  private prepared: FantasySymbolPlacements | null;
  readonly reusedPlacements: boolean;
  private texture: THREE.Texture | null = null;
  private geometry: THREE.InstancedBufferGeometry | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private symbolCount = 0;
  private finished = false;
  private disposed = false;
  constructor(
    handle: WorldHandle,
    private readonly appearance: { projection: 'globe' | 'map'; mapStyle: FantasyMapStyle },
    placements: FantasySymbolPlacements | null = null,
  ) {
    super();
    this.name = 'FantasySymbols';
    this.renderOrder = 0;
    this.prepared = placements;
    this.reusedPlacements = placements !== null;
    this.collector = placements
      ? null
      : new FantasySymbolCandidates(handle.config.radius, handle.summary.maximumHeight);
  }
  addPacket(packet: PhysicalMeshPacket) {
    if (!this.finished && !this.disposed) {
      this.collector?.addPacket(packet);
    }
  }
  finish() {
    if (this.finished || this.disposed) {
      return;
    }
    this.prepared ??= new FantasySymbolPlacements(this.collector!.finish());
    this.collector = null;
    this.symbolCount = this.prepared.count;
    if (!this.symbolCount) {
      this.finished = true;
      return;
    }
    const texture = createFantasySymbolAtlas(this.appearance.mapStyle);
    this.texture = texture;
    this.geometry = fantasySymbolGeometry(this.prepared, this.appearance.projection);
    this.material = symbolMaterial(texture, this.appearance.projection === 'map');
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.name = 'FantasySymbolInstances';
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    mesh.onBeforeRender = (renderer) => {
      renderer.getDrawingBufferSize(this.material!.uniforms.viewport.value);
    };
    this.add(mesh);
    this.finished = true;
  }
  get ready() {
    return this.finished;
  }
  get count() {
    return this.symbolCount;
  }
  /** Published only after completion; disposed or partial views cannot be cached. */
  get placements() {
    return this.finished && !this.disposed ? this.prepared : null;
  }
  /** View-owned allocations; shared placements are counted by the packet cache. */
  get bytes() {
    let bytes = this.collector?.bytes ?? 0;
    if (this.geometry) {
      for (const attribute of Object.values(this.geometry.attributes)) {
        bytes += attribute.array.byteLength * 2;
      }
      bytes += (this.geometry.index?.array.byteLength ?? 0) * 2;
    }
    if (this.texture) {
      const image = this.texture.image as { width: number; height: number };
      const baseBytes = image.width * image.height * 4;
      bytes += baseBytes * (this.texture.generateMipmaps ? 7 / 3 : 2);
    }
    return bytes;
  }
  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.collector = null;
    this.prepared = null;
    this.geometry?.dispose();
    this.material?.dispose();
    this.texture?.dispose();
    this.geometry = null;
    this.material = null;
    this.texture = null;
    this.removeFromParent();
    this.clear();
  }
}
