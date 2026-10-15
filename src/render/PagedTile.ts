import * as THREE from 'three';
import type { WorldHandle, WorldViewSource } from '../core/view/types';
import type { Layer } from '../core/model';
import { CATEGORICAL } from './palette';
import {
  loadDenseSurface,
  bindDenseSurface,
  bindDenseParent,
  releaseDenseParent,
  updateDenseEdges,
  materialDirections,
  configureCategoryCoordinates,
  type DenseSurface,
} from './DenseSurface';
import { createNaturalMaterial } from './NaturalSurface';
import { createArtMaterial, mapReliefScale, type MapStyle } from './MapStyle';
import { MAP_HEIGHT_SHEAR, type Projection } from './projection';
import {
  TILE_SEGMENTS,
  tileBounds,
  tileDirections,
  tileIndices,
  tileInterpolationStencil,
  type RenderTile,
} from './TileGeometry';

export interface TileAppearance {
  layer: Layer;
  season: number;
  mapStyle: MapStyle;
  relief: number;
  projection: Projection;
  materialWidth?: number;
  materialHeight?: number;
}
export interface SurfaceTile {
  mesh: THREE.Mesh;
  bytes: number;
  edgeMask: number;
  readonly materialSize: { width: number; height: number } | null;
  readonly materialBytes: number;
  readonly materialSurface: DenseSurface | null;
  updateEdges(mask: number, neighbors?: SurfaceTile[]): void;
  readonly transitioning: boolean;
  beginTransition(parent: SurfaceTile, now: number): void;
  updateTransition(now: number): boolean;
  finishTransition(): void;
  setCoastlines(enabled: boolean): void;
  dispose(): void;
}
const CATEGORY_PIXELS = 65;
export const TILE_TRANSITION_MS = 240;
const MORPH_ATTRIBUTES = [
  'position',
  'color',
  'surfaceTerrain',
  'surfaceClimate',
  'surfaceHabitat',
  'surfaceDelta',
  'surfaceWater',
  'surfaceBank',
];

export async function loadSurfaceTile(
  tile: RenderTile,
  handle: WorldHandle,
  source: WorldViewSource,
  appearance: TileAppearance,
  symbolAtlas?: THREE.Texture | null,
): Promise<SurfaceTile> {
  const directions = tileDirections(tile);
  const fields = await source.sample(directions.slice(), appearance.layer, appearance.season);
  const categorical = CATEGORICAL.includes(appearance.layer);
  // Discrete categories are sampled as categories, never interpolated RGB at triangle vertices.
  const image = categorical
    ? await source.sample(
        materialDirections(tile, CATEGORY_PIXELS, CATEGORY_PIXELS),
        appearance.layer,
        appearance.season,
      )
    : null;
  const denseSurface =
    appearance.layer === 'world'
      ? await loadDenseSurface(
          tile,
          handle,
          source,
          appearance.season,
          appearance.materialWidth,
          appearance.materialHeight,
          appearance.materialWidth === TILE_SEGMENTS + 1 &&
            appearance.materialHeight === TILE_SEGMENTS + 1
            ? fields
            : undefined,
        )
      : null;
  const flat = appearance.projection === 'map';
  const style = appearance.layer === 'world' ? appearance.mapStyle : 'natural';
  const scale = mapReliefScale(style);
  const positions = new Float32Array(directions.length);
  const normals = new Float32Array(directions.length);
  const uv = new Float32Array(fields.heights.length * 2);
  const bounds = tileBounds(tile);
  const width = TILE_SEGMENTS + 1;
  for (let i = 0; i < fields.heights.length; i++) {
    const x = i % width;
    const y = Math.floor(i / width);
    const height = (Math.max(0, fields.heights[i]) / handle.config.radius) * appearance.relief;
    uv[i * 2] = x / TILE_SEGMENTS;
    uv[i * 2 + 1] = y / TILE_SEGMENTS;
    if (flat) {
      positions[i * 3] = bounds.west + ((bounds.east - bounds.west) * x) / TILE_SEGMENTS;
      positions[i * 3 + 1] =
        bounds.south +
        ((bounds.north - bounds.south) * y) / TILE_SEGMENTS +
        height * scale * MAP_HEIGHT_SHEAR;
      positions[i * 3 + 2] = height * scale;
      normals[i * 3 + 2] = 1;
    } else {
      for (let axis = 0; axis < 3; axis++) {
        positions[i * 3 + axis] = directions[i * 3 + axis] * (1 + height);
        normals[i * 3 + axis] = directions[i * 3 + axis];
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('spherePosition', new THREE.BufferAttribute(directions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setAttribute('color', new THREE.BufferAttribute(fields.colors, 3));
  geometry.setAttribute('surfaceTerrain', new THREE.BufferAttribute(fields.surfaceTerrain, 4));
  geometry.setAttribute('surfaceClimate', new THREE.BufferAttribute(fields.surfaceClimate, 4));
  geometry.setAttribute('surfaceHabitat', new THREE.BufferAttribute(fields.surfaceHabitat, 3));
  geometry.setAttribute('surfaceDelta', new THREE.BufferAttribute(fields.surfaceDelta, 4));
  geometry.setAttribute('surfaceWater', new THREE.BufferAttribute(fields.surfaceWater, 2));
  geometry.setAttribute('surfaceBank', new THREE.BufferAttribute(fields.surfaceBank, 4));
  geometry.setIndex(new THREE.BufferAttribute(tileIndices(), 1));
  const blank = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  blank.needsUpdate = true;
  let texture: THREE.DataTexture | null = null;
  let material: THREE.Material;
  if (image) {
    const pixels = new Uint8Array(CATEGORY_PIXELS * CATEGORY_PIXELS * 4);
    for (let i = 0; i < image.heights.length; i++) {
      for (let c = 0; c < 3; c++) {
        pixels[i * 4 + c] = Math.round(Math.max(0, Math.min(1, image.colors[i * 3 + c])) * 255);
      }
      pixels[i * 4 + 3] = 255;
    }
    texture = new THREE.DataTexture(pixels, CATEGORY_PIXELS, CATEGORY_PIXELS);
    texture.magFilter = texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    const categoryMaterial = new THREE.MeshBasicMaterial({ map: texture });
    configureCategoryCoordinates(categoryMaterial, tile, texture, flat);
    material = categoryMaterial;
  } else if (appearance.layer === 'world') {
    material =
      style === 'natural'
        ? createNaturalMaterial(handle.config.seed, flat, blank, true, true)
        : createArtMaterial(handle.config.seed, style, flat, blank, true, true);
  } else {
    material = new THREE.MeshBasicMaterial({ vertexColors: true });
  }
  if (denseSurface) {
    bindDenseSurface(material as THREE.ShaderMaterial, denseSurface, tile);
    const uniforms = (material as THREE.ShaderMaterial).uniforms;
    uniforms.surfaceHeightScale.value =
      (appearance.relief / handle.config.radius) * (flat ? scale : 1);
    uniforms.surfaceHeightShear.value = flat ? MAP_HEIGHT_SHEAR : 0;
  }
  material.side = THREE.DoubleSide;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = true;
  mesh.userData.tile = tile;
  const symbols =
    style === 'illustrated' && symbolAtlas
      ? tileSymbols(positions, fields.surfaceTerrain, fields.surfaceWater, symbolAtlas, flat)
      : null;
  if (symbols) {
    mesh.add(symbols);
  }
  let bytes = 0;
  for (const attribute of Object.values(geometry.attributes)) {
    bytes += attribute.array.byteLength;
  }
  if (symbols) {
    for (const attribute of Object.values(symbols.geometry.attributes)) {
      bytes += attribute.array.byteLength;
    }
  }
  bytes += geometry.index!.array.byteLength + (texture ? CATEGORY_PIXELS * CATEGORY_PIXELS * 4 : 4);
  // Account for both retained CPU attributes and GPU allocations.
  let edgeMask = 0;
  let transition: {
    start: number;
    fields: { attribute: THREE.BufferAttribute; from: Float32Array; to: Float32Array }[];
  } | null = null;
  const finishTransition = () => {
    if (denseSurface) {
      releaseDenseParent(material as THREE.ShaderMaterial, denseSurface);
    }
    if (!transition) {
      return;
    }
    for (const field of transition.fields) {
      (field.attribute.array as Float32Array).set(field.to);
      field.attribute.needsUpdate = true;
    }
    transition = null;
    geometry.computeBoundingSphere();
  };
  // Reserve the maximum temporary transition arrays in the cache accounting, even
  // while idle. A burst of ready children cannot exceed the advertised byte budget.
  const transitionBytes = MORPH_ATTRIBUTES.reduce(
    (sum, name) => sum + geometry.getAttribute(name).array.byteLength * 2,
    0,
  );
  return {
    mesh,
    bytes: bytes * 2 + transitionBytes + (denseSurface?.bytes ?? 0),
    materialSize: denseSurface ? { width: denseSurface.width, height: denseSurface.height } : null,
    materialBytes: denseSurface?.bytes ?? 0,
    materialSurface: denseSurface,
    setCoastlines(enabled) {
      if (denseSurface) {
        (material as THREE.ShaderMaterial).uniforms.surfaceCoastlines.value = enabled ? 1 : 0;
      }
    },
    get transitioning() {
      return transition !== null;
    },
    finishTransition,
    beginTransition(parent, now) {
      finishTransition();
      const parentTile = parent.mesh.userData.tile as RenderTile;
      const factor = 2 ** (tile.z - parentTile.z);
      if (
        factor <= 1 ||
        Math.floor(tile.x / factor) !== parentTile.x ||
        Math.floor(tile.y / factor) !== parentTile.y
      ) {
        return;
      }
      const parentGeometry = parent.mesh.geometry;
      const index = parentGeometry.index!;
      const indexCount = Math.min(index.count, parentGeometry.drawRange.count);
      const stencils = Array.from({ length: width * width }, (_, i) => {
        const x = i % width;
        const y = Math.floor(i / width);
        // Shared edges remain at their exact destination throughout a morph. This
        // preserves watertight seams against both existing neighbors and siblings.
        return x === 0 || y === 0 || x === TILE_SEGMENTS || y === TILE_SEGMENTS
          ? null
          : tileInterpolationStencil(
              ((tile.x - parentTile.x * factor) * TILE_SEGMENTS + x) / factor,
              ((tile.y - parentTile.y * factor) * TILE_SEGMENTS + y) / factor,
              index.array,
              indexCount,
            );
      });
      const fields = MORPH_ATTRIBUTES.map((name) => {
        const attribute = geometry.getAttribute(name) as THREE.BufferAttribute;
        const parentAttribute = parentGeometry.getAttribute(name);
        const to = (attribute.array as Float32Array).slice();
        const from = to.slice();
        for (let i = 0; i < stencils.length; i++) {
          const stencil = stencils[i];
          if (!stencil) {
            continue;
          }
          for (let axis = 0; axis < attribute.itemSize; axis++) {
            from[i * attribute.itemSize + axis] = stencil.vertices.reduce(
              (value, vertex, k) =>
                value + parentAttribute.getComponent(vertex, axis) * stencil.weights[k],
              0,
            );
          }
        }
        (attribute.array as Float32Array).set(from);
        attribute.needsUpdate = true;
        return { attribute, from, to };
      });
      transition = { start: now, fields };
      geometry.computeBoundingSphere();
      const initialBounds = geometry.boundingSphere!.clone();
      // Include the destination too, so culling is conservative throughout the morph.
      finishTransition();
      geometry.boundingSphere!.union(initialBounds);
      for (const field of fields) {
        (field.attribute.array as Float32Array).set(field.from);
      }
      transition = { start: now, fields };
      if (denseSurface && parent.materialSurface) {
        bindDenseParent(material as THREE.ShaderMaterial, parent.materialSurface, tile, parentTile);
      }
    },
    updateTransition(now) {
      if (!transition) {
        return false;
      }
      const linear = Math.max(0, Math.min(1, (now - transition.start) / TILE_TRANSITION_MS));
      if (linear === 1) {
        finishTransition();
        return true;
      }
      const amount = linear * linear * (3 - 2 * linear);
      if (denseSurface) {
        (material as THREE.ShaderMaterial).uniforms.surfaceBlend.value = amount;
      }
      for (const field of transition.fields) {
        const values = field.attribute.array as Float32Array;
        for (let i = 0; i < values.length; i++) {
          values[i] = field.from[i] + (field.to[i] - field.from[i]) * amount;
        }
        field.attribute.needsUpdate = true;
      }
      return true;
    },
    get edgeMask() {
      return edgeMask;
    },
    updateEdges(mask, neighbors = []) {
      if (denseSurface) {
        updateDenseEdges(
          denseSurface,
          tile,
          neighbors.flatMap((neighbor) =>
            neighbor.materialSurface
              ? [
                  {
                    tile: neighbor.mesh.userData.tile as RenderTile,
                    surface: neighbor.materialSurface,
                  },
                ]
              : [],
          ),
        );
      }
      if (mask === edgeMask) {
        return;
      }
      edgeMask = mask;
      const indices = tileIndices(mask);
      (geometry.index!.array as Uint16Array).set(indices);
      geometry.index!.needsUpdate = true;
      geometry.setDrawRange(0, indices.length);
    },
    dispose() {
      transition = null;
      mesh.removeFromParent();
      geometry.dispose();
      symbols?.geometry.dispose();
      if (symbols) {
        (symbols.material as THREE.Material).dispose();
      }
      material.dispose();
      texture?.dispose();
      denseSurface?.dispose();
      blank.dispose();
    },
  };
}

/** Bounded cartographic marks use sampled terrain, with density tied to display tiles. */
function tileSymbols(
  positions: Float32Array,
  terrain: Float32Array,
  water: Float32Array,
  atlas: THREE.Texture,
  flat: boolean,
) {
  const anchors: number[] = [];
  const variants: number[] = [];
  const width = TILE_SEGMENTS + 1;
  for (let y = 2; y < TILE_SEGMENTS; y += 4) {
    for (let x = 2; x < TILE_SEGMENTS; x += 4) {
      const i = y * width + x;
      const elevation = terrain[i * 4];
      const forest = terrain[i * 4 + 3];
      if (terrain[i * 4 + 1] < 0.92 || water[i * 2 + 1] > 0.02) {
        continue;
      }
      if (elevation < 650 && forest < 0.5) {
        continue;
      }
      const variant = elevation > 3000 ? 1 : elevation > 1400 ? 0 : forest > 0.5 ? 5 : 3;
      anchors.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      variants.push(variant);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(anchors, 3));
  geometry.setAttribute('variant', new THREE.Float32BufferAttribute(variants, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: { atlas: { value: atlas }, pixelRatio: { value: 1 } },
    vertexShader: `attribute float variant; uniform float pixelRatio; varying float mark; varying float visible;
      void main() { mark = variant; vec4 point = modelViewMatrix * vec4(position, 1.0);
        visible = ${flat ? '1.0' : 'smoothstep(.05, .3, dot(normalize(normalMatrix * normalize(position)), normalize(-point.xyz)))'};
        gl_Position = projectionMatrix * point; gl_PointSize = (variant < 3.0 ? 34.0 : 26.0) * pixelRatio;
      }`,
    fragmentShader: `uniform sampler2D atlas; varying float mark; varying float visible;
      void main() { vec2 uv = (vec2(gl_PointCoord.x, 1.0 - gl_PointCoord.y) + vec2(mod(mark, 4.0), 1.0 - floor(mark / 4.0))) / vec2(4.0, 2.0); uv.y = 1.0 - uv.y;
        vec2 pigment = texture2D(atlas, uv).rg; float coverage = min(1.0, pigment.r + pigment.g) * visible;
        if (coverage < .01) discard;
        vec3 color = (vec3(.86, .81, .65) * pigment.g + vec3(.037, .04, .028) * pigment.r) / max(.001, pigment.r + pigment.g);
        gl_FragColor = vec4(color, coverage);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
  });
  const points = new THREE.Points(geometry, material);
  points.renderOrder = 1;
  points.onBeforeRender = (renderer) => {
    material.uniforms.pixelRatio.value = renderer.getPixelRatio();
  };
  return points;
}
