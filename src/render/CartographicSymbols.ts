import * as THREE from 'three';
import type { World } from '../core/model';
import { clamp, createSeededRandom } from '../core/math';
import { isLakeCell } from './SurfaceHabitats';
import { exposedLandFraction } from '../core/generation/lake-state';
import { mapPoint, type Projection } from './projection';
import { surfaceRadius } from './WaterSurface';

export interface MapSymbol {
  cell: number;
  variant: number;
  width: number;
}

/** Separate pigment from the RGB sheet before filtering; otherwise small ink
 * strokes disappear when the original background is averaged into mip levels.
 */
export function createInkMask(pixels: ArrayLike<number>) {
  const mask = new Uint8Array(pixels.length);
  const smooth = (low: number, high: number, value: number) => {
    const fraction = clamp((value - low) / (high - low));
    return fraction * fraction * (3 - 2 * fraction);
  };
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const red = pixels[offset] / 255;
    const green = pixels[offset + 1] / 255;
    const blue = pixels[offset + 2] / 255;
    const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
    mask[offset] = Math.round(255 * (1 - smooth(0.22, 0.43, luminance)));
    mask[offset + 1] = Math.round(
      255 * smooth(0.045, 0.1, red - blue) * smooth(0.55, 0.8, luminance),
    );
    mask[offset + 3] = 255;
  }
  return mask;
}

export function loadSymbolAtlas() {
  const texture = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  let disposed = false;
  texture.addEventListener('dispose', () => {
    disposed = true;
  });
  new THREE.ImageLoader().load('/art/ink-symbol-atlas.png', (image) => {
    if (disposed) {
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    texture.image = {
      data: createInkMask(context.getImageData(0, 0, image.width, image.height).data),
      width: image.width,
      height: image.height,
    };
    texture.needsUpdate = true;
  });
  return texture;
}

const symbolCache = new WeakMap<World, MapSymbol[]>();

/** Symbol footprints reserve a little more paper around scattered hill groups. */
function symbolSpacing(symbol: MapSymbol): number {
  return symbol.width * (symbol.variant === 3 ? 1.05 : symbol.variant < 3 ? 0.62 : 0.52);
}

function minimumSymbolDistance(first: MapSymbol, second: MapSymbol, radius: number): number {
  if (first.variant < 3 && second.variant < 3) {
    // Peaks illustrate a shared range: their bases may overlap. A large summit
    // must not erase its neighboring peaks just because its drawing is wider.
    return 0.028 * radius;
  }
  return (symbolSpacing(first) + symbolSpacing(second)) * radius;
}

/** A bounded, elevation-prioritized cartographic sample. The spherical spacing
 * test works across the dateline and poles and stays fixed as the camera moves.
 * Symbols summarize landforms; they are not additional simulated peaks.
 */
export function selectMapSymbols(world: World): MapSymbol[] {
  const cached = symbolCache.get(world);
  if (cached) {
    return cached;
  }
  const random = createSeededRandom(`${world.config.seed}:cartographic-symbols`);
  const candidates: (MapSymbol & { priority: number })[] = [];
  const { grid, terrain, ecology, config } = world;

  for (let cell = 0; cell < grid.count; cell++) {
    // Sample by represented area, so adding small cells cannot turn a refined
    // coastline or mountain range into a denser carpet of symbols.
    const probability = Math.min(1, (18000 * grid.areas[cell]) / (4 * Math.PI));
    const chance = random();
    const variation = random();
    const landFraction = exposedLandFraction(terrain, world.drainage, cell);
    if (landFraction < 0.8 || chance > probability * landFraction) {
      continue;
    }
    const height = terrain.height[cell];
    const biome = ecology.biome[cell];
    const forest = [3, 4, 8, 9].includes(biome) && ecology.vegetation[cell] > 0.28;
    if (height < 650 && !forest) {
      continue;
    }
    const mountain = height >= 1400;
    const hill = !mountain && !forest;
    // Hills are sparse accents. Broad high plains should not become a carpet
    // of hill symbols simply because their elevation exceeds sea level.
    if (hill && chance > probability * landFraction * 0.3) {
      continue;
    }
    const mountainScale = Math.pow(clamp((height - 1400) / 5000), 0.7);
    const width =
      (mountain ? 0.045 + 0.047 * mountainScale : hill ? 0.032 : 0.033) * (0.94 + variation * 0.12);
    if (terrain.coastDistance[cell] < width * config.radius * 0.6) {
      continue;
    }
    let touchesWater = false;
    let maximumSlope = 0;
    let neighborHeight = 0;
    for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
      const neighbor = grid.neighbors[offset];
      const corner = grid.cellCorners[offset];
      if (
        terrain.ocean[neighbor] ||
        isLakeCell(world, neighbor) ||
        (world.rivers.channel[corner] && world.drainage.discharge[corner] > 20)
      ) {
        touchesWater = true;
        break;
      }
      const distance = grid.edgeDistance[grid.arcEdges[offset]] * config.radius;
      maximumSlope = Math.max(maximumSlope, Math.abs(height - terrain.height[neighbor]) / distance);
      neighborHeight += terrain.height[neighbor];
    }
    if (touchesWater || (hill && maximumSlope < 0.0015)) {
      continue;
    }
    const prominence = height - neighborHeight / (grid.offsets[cell + 1] - grid.offsets[cell]);
    const variant = mountain
      ? height > 3600
        ? variation < 0.75
          ? 1
          : 0
        : height > 2200
          ? variation < 0.6
            ? 0
            : 1
          : variation < 0.7
            ? 2
            : 0
      : hill
        ? 3
        : biome === 3
          ? 5
          : biome === 4
            ? 6
            : variation < 0.75
              ? 4
              : 7;
    candidates.push({
      cell,
      variant,
      width,
      priority:
        (mountain ? 20000 + height + Math.max(0, prominence) : hill ? 10000 : 0) + variation,
    });
  }

  candidates.sort((first, second) => second.priority - first.priority);
  const symbols: MapSymbol[] = [];
  // Larger than the sum of any two symbol spacing radii; only 27 nearby bins
  // need checking. The padding keeps neighbor-bin keys distinct at cube edges.
  const bucketSize = 0.14;
  const bucketStride = Math.ceil(2 / bucketSize) + 3;
  const buckets = new Map<number, MapSymbol[]>();
  const bucketKey = (x: number, y: number, z: number) =>
    x + 1 + bucketStride * (y + 1 + bucketStride * (z + 1));

  for (const candidate of candidates) {
    const positionOffset = candidate.cell * 3;
    const x = grid.positions[positionOffset];
    const y = grid.positions[positionOffset + 1];
    const z = grid.positions[positionOffset + 2];
    const bucketX = Math.floor((x + 1) / bucketSize);
    const bucketY = Math.floor((y + 1) / bucketSize);
    const bucketZ = Math.floor((z + 1) / bucketSize);
    let crowded = false;
    for (let dx = -1; dx <= 1 && !crowded; dx++) {
      for (let dy = -1; dy <= 1 && !crowded; dy++) {
        for (let dz = -1; dz <= 1 && !crowded; dz++) {
          const neighbors = buckets.get(bucketKey(bucketX + dx, bucketY + dy, bucketZ + dz));
          if (!neighbors) {
            continue;
          }
          for (const neighbor of neighbors) {
            const offset = neighbor.cell * 3;
            const minimumDistance = minimumSymbolDistance(candidate, neighbor, config.radius);
            const distanceSquared =
              ((x - grid.positions[offset]) ** 2 +
                (y - grid.positions[offset + 1]) ** 2 +
                (z - grid.positions[offset + 2]) ** 2) *
              config.radius ** 2;
            if (distanceSquared < minimumDistance * minimumDistance) {
              crowded = true;
              break;
            }
          }
        }
      }
    }
    if (crowded) {
      continue;
    }
    const symbol = { cell: candidate.cell, variant: candidate.variant, width: candidate.width };
    symbols.push(symbol);
    const key = bucketKey(bucketX, bucketY, bucketZ);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(symbol);
    } else {
      buckets.set(key, [symbol]);
    }
    if (symbols.length === 12000) {
      break;
    }
  }
  symbolCache.set(world, symbols);
  return symbols;
}

/** One instanced draw for the ink symbols, including wrap copies on the map. */
export class CartographicSymbols extends THREE.Mesh<
  THREE.InstancedBufferGeometry,
  THREE.ShaderMaterial
> {
  private viewport = new THREE.Vector2();

  constructor(
    world: World,
    relief: number,
    season: number,
    projection: Projection,
    atlas: THREE.Texture,
  ) {
    const flat = projection === 'map';
    const symbols = selectMapSymbols(world);
    const count = symbols.length * (flat ? 3 : 1);
    const positions = new Float32Array(count * 3);
    const widths = new Float32Array(count);
    const variants = new Float32Array(count);
    const tints = new Float32Array(count * 3);
    const paper = new THREE.Color('#efe8cc');
    const snow = new THREE.Color('#f5f5e9');
    const summer = new THREE.Color('#d4d8b6');
    const tint = new THREE.Color();
    let instance = 0;
    for (const symbol of symbols) {
      const offset = symbol.cell * 3;
      const x = world.grid.positions[offset];
      const y = world.grid.positions[offset + 1];
      const z = world.grid.positions[offset + 2];
      const temperature =
        season < 0
          ? world.water.temperature[symbol.cell]
          : world.water.seasonalTemperature[season][symbol.cell];
      tint.copy(symbol.variant < 4 ? paper : summer);
      tint.lerp(snow, clamp((2 - temperature) / 12));
      const radius = surfaceRadius(world, symbol.cell, relief) + 0.002;
      const [longitude, latitude] = mapPoint(x, y, z);
      for (const shift of flat ? [-2 * Math.PI, 0, 2 * Math.PI] : [0]) {
        positions.set(
          flat ? [longitude + shift, latitude, 0.003] : [x * radius, y * radius, z * radius],
          instance * 3,
        );
        widths[instance] = symbol.width;
        variants[instance] = symbol.variant;
        tints.set([tint.r, tint.g, tint.b], instance * 3);
        instance++;
      }
    }
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [-0.5, -0.16, 0, 0.5, -0.16, 0, 0.5, 0.84, 0, -0.5, 0.84, 0],
        3,
      ),
    );
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute('anchor', new THREE.InstancedBufferAttribute(positions, 3));
    geometry.setAttribute('symbolWidth', new THREE.InstancedBufferAttribute(widths, 1));
    geometry.setAttribute('symbolVariant', new THREE.InstancedBufferAttribute(variants, 1));
    geometry.setAttribute('paperTint', new THREE.InstancedBufferAttribute(tints, 3));
    geometry.instanceCount = count;
    const material = new THREE.ShaderMaterial({
      uniforms: { atlas: { value: atlas }, viewportHeight: { value: 1 }, ready: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute vec3 anchor;
        attribute float symbolWidth;
        attribute float symbolVariant;
        attribute vec3 paperTint;
        uniform float viewportHeight;
        varying vec2 atlasUV;
        varying vec3 tint;
        varying float visibility;
        varying vec2 mapCoordinate;
        void main() {
          vec4 point = modelViewMatrix * vec4(anchor, 1.0);
          float pixelSize = symbolWidth * projectionMatrix[1][1] * viewportHeight * 0.5 / ${flat ? '1.0' : 'max(0.01, -point.z)'};
          // Preserve the height hierarchy when zoomed in; taller mountains also
          // have a larger pixel cap rather than all flattening to one size.
          float pixelCap = symbolVariant < 3.0 ? mix(64.0, 118.0, clamp((symbolWidth - 0.045) / 0.05, 0.0, 1.0)) : 56.0;
          float size = symbolWidth * min(1.0, pixelCap / max(pixelSize, 1.0));
          vec3 normal = normalize(normalMatrix * normalize(anchor));
          visibility = ${flat ? '1.0' : 'smoothstep(0.08, 0.3, dot(normal, normalize(-point.xyz)))'};
          visibility *= smoothstep(1.6, 4.0, pixelSize);
          point.xy += position.xy * size;
          mapCoordinate = anchor.xy + position.xy * size;
          atlasUV = (uv + vec2(mod(symbolVariant, 4.0), 1.0 - floor(symbolVariant / 4.0))) / vec2(4.0, 2.0);
          // Canvas rows are top-down; typed texture rows are uploaded unchanged.
          atlasUV.y = 1.0 - atlasUV.y;
          tint = paperTint;
          gl_Position = projectionMatrix * point;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D atlas;
        uniform float ready;
        varying vec2 atlasUV;
        varying vec3 tint;
        varying float visibility;
        varying vec2 mapCoordinate;
        void main() {
          ${flat ? 'if (abs(mapCoordinate.x) > 3.14159265 || abs(mapCoordinate.y) > 1.57079633) discard;' : ''}
          vec2 pigment = texture2D(atlas, atlasUV).rg;
          float ink = pigment.r;
          float paper = pigment.g * 0.94;
          float opacity = min(1.0, ink + paper);
          float coverage = opacity * visibility * ready;
          if (coverage < 0.01) discard;
          vec3 color = (tint * paper + vec3(0.037, 0.040, 0.028) * ink) / max(0.001, ink + paper);
          gl_FragColor = vec4(color, coverage);
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    super(geometry, material);
    this.frustumCulled = false;
    this.renderOrder = 1;
  }

  updateViewport(renderer: THREE.WebGLRenderer) {
    renderer.getSize(this.viewport);
    this.material.uniforms.viewportHeight.value = this.viewport.y;
    this.material.uniforms.ready.value =
      this.material.uniforms.atlas.value.image?.width > 1 ? 1 : 0;
  }
}
