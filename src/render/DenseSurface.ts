import * as THREE from 'three';
import type { CellSampleBatch, WorldHandle, WorldViewSource } from '../core/view/types';
import { tileBounds, type RenderTile } from './TileGeometry';

/** Six RGBA8 maps retain every material field. Elevation, temperature and incision
 * use two channels each; decoding is linear, so GPU filtering is still correct.
 * All other fields are fractions (or a wetland kind in [0,4]). This is display
 * quantization only; physical data and inspection retain their original values. */
export interface DenseSurface {
  textures: THREE.DataTexture[];
  width: number;
  height: number;
  elevationRange: [number, number];
  bytes: number;
  borders: Uint8Array[][];
  edgeSignature: string;
  dispose(): void;
}
export const MAX_MATERIAL_QUERY = 16384;
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** Rectangular, shared-boundary samples. Integer dyadic coordinates match across
 * neighbors, the dateline and mixed resolutions; every pole sample is identical. */
export function materialDirections(
  tile: RenderTile,
  width: number,
  height: number,
  firstRow = 0,
  rows = height,
) {
  const result = new Float32Array(width * rows * 3);
  const count = 2 ** tile.z;
  const totalX = (width - 1) * count;
  const totalY = (height - 1) * count;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < width; x++) {
      const u = (tile.x * (width - 1) + x) / totalX;
      const v = (tile.y * (height - 1) + firstRow + y) / totalY;
      const longitude = u * Math.PI * 2 - Math.PI;
      const latitude = v * Math.PI - Math.PI / 2;
      const horizontal = v === 0 || v === 1 ? 0 : Math.cos(latitude);
      const i = (y * width + x) * 3;
      result[i] = horizontal === 0 ? 0 : horizontal * Math.cos(longitude);
      result[i + 1] = Math.sin(latitude);
      result[i + 2] = horizontal === 0 || u === 0 || u === 1 ? 0 : horizontal * Math.sin(longitude);
    }
  }
  return result;
}

function encode16(value: number, low: number, high: number): [number, number] {
  const integer = Math.round(clamp01((value - low) / (high - low)) * 65535);
  return [integer >> 8, integer & 255];
}
export function packMaterialFields(
  fields: CellSampleBatch,
  maps: Uint8Array[],
  offset: number,
  elevationRange: [number, number],
) {
  const byte = (value: number) => Math.round(clamp01(value) * 255);
  for (let i = 0; i < fields.heights.length; i++) {
    const terrain = fields.surfaceTerrain;
    const climate = fields.surfaceClimate;
    const habitat = fields.surfaceHabitat;
    const elevation = encode16(terrain[i * 4], ...elevationRange);
    const temperature = encode16(climate[i * 4], -128, 128);
    const incision = encode16(habitat[i * 3 + 2], 0, 65535);
    const values = [
      ...elevation,
      byte(terrain[i * 4 + 1]),
      byte(terrain[i * 4 + 2]),
      byte(terrain[i * 4 + 3]),
      ...temperature,
      byte(climate[i * 4 + 1]),
      byte(climate[i * 4 + 2]),
      byte(climate[i * 4 + 3]),
      byte(habitat[i * 3] / 4),
      byte(habitat[i * 3 + 1]),
      ...incision,
      byte(fields.surfaceDelta[i * 4]),
      byte(fields.surfaceDelta[i * 4 + 1]),
      byte(fields.surfaceDelta[i * 4 + 2]),
      byte(fields.surfaceDelta[i * 4 + 3]),
      byte(fields.surfaceWater[i * 2]),
      byte(fields.surfaceWater[i * 2 + 1]),
      byte(fields.surfaceBank[i * 4]),
      byte(fields.surfaceBank[i * 4 + 1]),
      byte(fields.surfaceBank[i * 4 + 2]),
      byte(fields.surfaceBank[i * 4 + 3]),
    ];
    for (let map = 0; map < 6; map++) {
      for (let component = 0; component < 4; component++) {
        maps[map][(offset + i) * 4 + component] = values[map * 4 + component];
      }
    }
  }
}

export async function loadDenseSurface(
  tile: RenderTile,
  handle: WorldHandle,
  source: WorldViewSource,
  season: number,
  width = 129,
  height = 65,
  precomputedFields?: CellSampleBatch,
): Promise<DenseSurface> {
  if (
    ![17, 33, 65, 129, 257].includes(width) ||
    ![17, 33, 65, 129, 257].includes(height) ||
    (width - 1) * (height - 1) > 32768
  ) {
    throw new Error('Material grids must have a bounded dyadic number of intervals.');
  }
  if (precomputedFields && precomputedFields.heights.length !== width * height) {
    throw new Error('Precomputed material fields must match the shared-boundary sample grid.');
  }
  const elevationRange: [number, number] = [
    Math.min(-12000, handle.summary?.minimumHeight ?? -32768),
    Math.max(9000, handle.summary?.maximumHeight ?? 32767),
  ];
  const maps = Array.from({ length: 6 }, () => new Uint8Array(width * height * 4));
  if (precomputedFields) {
    // Coarse first coverage shares the geometry's exact boundary samples. Reuse
    // those fields instead of repeating expensive cold snapshot reads.
    packMaterialFields(precomputedFields, maps, 0, elevationRange);
  } else {
    const rowsPerQuery = Math.floor(MAX_MATERIAL_QUERY / width);
    for (let firstRow = 0; firstRow < height; firstRow += rowsPerQuery) {
      const rows = Math.min(rowsPerQuery, height - firstRow);
      const fields = await source.sample(
        materialDirections(tile, width, height, firstRow, rows),
        'world',
        season,
      );
      packMaterialFields(fields, maps, firstRow * width, elevationRange);
    }
  }
  const textures = maps.map((data) => {
    const texture = new THREE.DataTexture(data, width, height);
    texture.magFilter = texture.minFilter = THREE.LinearFilter;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
  });
  const borders = maps.map((data) => [
    Uint8Array.from(
      { length: height * 4 },
      (_, i) => data[Math.floor(i / 4) * width * 4 + (i % 4)],
    ),
    Uint8Array.from(
      { length: height * 4 },
      (_, i) => data[(Math.floor(i / 4) * width + width - 1) * 4 + (i % 4)],
    ),
    data.slice(0, width * 4),
    data.slice((height - 1) * width * 4),
  ]);
  return {
    textures,
    width,
    height,
    elevationRange,
    borders,
    edgeSignature: '',
    bytes: width * height * 24 * 2 + 48 * (width + height),
    dispose() {
      for (const texture of textures) {
        texture.dispose();
      }
    },
  };
}

const texelTransform = (surface: DenseSurface) =>
  new THREE.Vector4(
    (surface.width - 1) / surface.width,
    (surface.height - 1) / surface.height,
    0.5 / surface.width,
    0.5 / surface.height,
  );
export function bindDenseSurface(
  material: THREE.ShaderMaterial,
  surface: DenseSurface,
  tile: RenderTile,
) {
  const bounds = tileBounds(tile);
  const uniforms = material.uniforms;
  for (let i = 0; i < 6; i++) {
    uniforms[`surfaceMap${i}`] = { value: surface.textures[i] };
    uniforms[`surfaceParent${i}`] = { value: surface.textures[i] };
  }
  uniforms.surfaceTexels = { value: texelTransform(surface) };
  uniforms.surfaceParentTexels = { value: texelTransform(surface) };
  uniforms.surfaceParentUv = { value: new THREE.Vector4(1, 1, 0, 0) };
  uniforms.surfaceBounds = {
    value: new THREE.Vector4(
      (bounds.west + bounds.east) / 2,
      bounds.south,
      bounds.east - bounds.west,
      bounds.north - bounds.south,
    ),
  };
  uniforms.surfaceElevationRange = { value: new THREE.Vector2(...surface.elevationRange) };
  uniforms.surfaceBlend = { value: 1 };
  uniforms.surfaceCoastlines = { value: 0 };
  uniforms.surfaceHeightScale = { value: 0 };
  uniforms.surfaceHeightShear = { value: 0 };
}
export function bindDenseParent(
  material: THREE.ShaderMaterial,
  parent: DenseSurface,
  tile: RenderTile,
  parentTile: RenderTile,
) {
  const uniforms = material.uniforms;
  const factor = 2 ** (tile.z - parentTile.z);
  for (let i = 0; i < 6; i++) {
    uniforms[`surfaceParent${i}`].value = parent.textures[i];
  }
  uniforms.surfaceParentTexels.value = texelTransform(parent);
  uniforms.surfaceParentUv.value.set(
    1 / factor,
    1 / factor,
    tile.x / factor - parentTile.x,
    tile.y / factor - parentTile.y,
  );
  uniforms.surfaceBlend.value = 0;
}
export function releaseDenseParent(material: THREE.ShaderMaterial, surface: DenseSurface) {
  for (let i = 0; i < 6; i++) {
    material.uniforms[`surfaceParent${i}`].value = surface.textures[i];
  }
  material.uniforms.surfaceParentTexels.value = texelTransform(surface);
  material.uniforms.surfaceParentUv.value.set(1, 1, 0, 0);
  material.uniforms.surfaceBlend.value = 1;
}

export function geographicMaterialUv(tile: RenderTile, point: readonly number[]): [number, number] {
  const bounds = tileBounds(tile);
  const length = Math.hypot(...point);
  const center = (bounds.west + bounds.east) / 2;
  const longitude =
    point[0] ** 2 + point[2] ** 2 > 1e-18 * length * length
      ? Math.atan2(point[2], point[0])
      : center;
  const offset = Math.atan2(Math.sin(longitude - center), Math.cos(longitude - center));
  return [
    clamp01(offset / (bounds.east - bounds.west) + 0.5),
    clamp01(
      (Math.atan2(point[1], Math.hypot(point[0], point[2])) - bounds.south) /
        (bounds.north - bounds.south),
    ),
  ];
}
export const GEOGRAPHIC_MATERIAL_UV = `
  vec2 geographicMaterialUv(vec3 direction, vec4 bounds) {
    float longitude = dot(direction.xz, direction.xz) > 1e-18 ? atan(direction.z, direction.x) : bounds.x;
    float deltaLongitude = atan(sin(longitude - bounds.x), cos(longitude - bounds.x));
    return clamp(vec2(deltaLongitude / bounds.z + .5,
      (atan(direction.y, length(direction.xz)) - bounds.y) / bounds.w), 0.0, 1.0);
  }
`;

/** Decode a texel for numerical validation or display diagnostics. Matches GLSL. */
export function decodeMaterialFields(
  maps: ArrayLike<number>[],
  index: number,
  elevationRange: [number, number],
) {
  const m = maps.flatMap((map) => Array.from({ length: 4 }, (_, c) => map[index * 4 + c] / 255));
  const decoded = (i: number) => (m[i] * 256 + m[i + 1]) / 257;
  return {
    terrain: [
      elevationRange[0] + decoded(0) * (elevationRange[1] - elevationRange[0]),
      m[2],
      m[3],
      m[4],
    ],
    climate: [-128 + decoded(5) * 256, m[7], m[8], m[9]],
    habitat: [m[10] * 4, m[11], decoded(12) * 65535],
    delta: m.slice(14, 18),
    water: m.slice(18, 20),
    bank: m.slice(20, 24),
  };
}

/** Match a material border to the lower-resolution geographic edge, regardless
 * of geometric LOD. Read immutable originals so update order cannot change it. */
export function updateDenseEdges(
  surface: DenseSurface,
  tile: RenderTile,
  neighbors: { tile: RenderTile; surface: DenseSurface }[],
) {
  const signature = neighbors
    .map(
      (neighbor) =>
        `${neighbor.tile.z}/${neighbor.tile.x}/${neighbor.tile.y}:${neighbor.surface.width}/${neighbor.surface.height}`,
    )
    .sort()
    .join(',');
  if (surface.edgeSignature === signature) {
    return;
  }
  surface.edgeSignature = signature;
  const n = 2 ** tile.z;
  for (let edge = 0; edge < 4; edge++) {
    const vertical = edge < 2;
    const samples = vertical ? surface.height : surface.width;
    const alongStart = (vertical ? tile.y : tile.x) / n;
    const across = (vertical ? tile.x + edge : tile.y + edge - 2) / n;
    const sources = neighbors.filter((neighbor) => {
      const m = 2 ** neighbor.tile.z;
      const oppositeAcross =
        (vertical ? neighbor.tile.x + (1 - edge) : neighbor.tile.y + (3 - edge)) / m;
      return (
        (vertical ? (oppositeAcross - across) % 1 === 0 : oppositeAcross === across) &&
        (vertical ? neighbor.surface.height - 1 : neighbor.surface.width - 1) * m <
          (samples - 1) * n
      );
    });
    for (let i = 0; i < samples; i++) {
      const along = alongStart + i / (samples - 1) / n;
      const source = sources.find((neighbor) => {
        const start = (vertical ? neighbor.tile.y : neighbor.tile.x) / 2 ** neighbor.tile.z;
        return along >= start && along <= start + 1 / 2 ** neighbor.tile.z;
      });
      for (let map = 0; map < 6; map++) {
        const data = surface.textures[map].image.data!;
        const pixel = vertical
          ? i * surface.width + (edge === 1 ? surface.width - 1 : 0)
          : i + (edge === 3 ? (surface.height - 1) * surface.width : 0);
        for (let c = 0; c < 4; c++) {
          let value = surface.borders[map][edge][i * 4 + c];
          if (source) {
            const coordinate =
              (along * 2 ** source.tile.z - (vertical ? source.tile.y : source.tile.x)) *
              (vertical ? source.surface.height - 1 : source.surface.width - 1);
            const lower = Math.max(0, Math.floor(coordinate));
            const upper = Math.min(
              (vertical ? source.surface.height : source.surface.width) - 1,
              lower + 1,
            );
            const fraction = coordinate - lower;
            const border = source.surface.borders[map][edge ^ 1];
            const pair = map === 0 || map === 3 ? 0 : map === 1 ? 1 : -1;
            if (pair >= 0 && (c === pair || c === pair + 1)) {
              const a = border[lower * 4 + pair] * 256 + border[lower * 4 + pair + 1];
              const b = border[upper * 4 + pair] * 256 + border[upper * 4 + pair + 1];
              const encoded = Math.round(a * (1 - fraction) + b * fraction);
              value = c === pair ? encoded >> 8 : encoded & 255;
            } else {
              value = Math.round(
                border[lower * 4 + c] * (1 - fraction) + border[upper * 4 + c] * fraction,
              );
            }
          }
          data[pixel * 4 + c] = value;
        }
      }
    }
  }
  for (const texture of surface.textures) {
    texture.needsUpdate = true;
  }
}

/** The sphere's collapsed pole fans cannot carry linear longitude UVs. Recover
 * actual geographic coordinates per fragment; flat maps already carry those UVs. */
export function denseSurfaceShader(flat: boolean) {
  return `
    varying vec2 vMaterialUv;
    ${GEOGRAPHIC_MATERIAL_UV}
    ${Array.from({ length: 6 }, (_, i) => `uniform sampler2D surfaceMap${i}; uniform sampler2D surfaceParent${i};`).join('\n')}
    uniform vec4 surfaceTexels;
    uniform vec4 surfaceParentTexels;
    uniform vec4 surfaceParentUv;
    uniform vec4 surfaceBounds;
    uniform vec2 surfaceElevationRange;
    uniform float surfaceBlend;
    uniform float surfaceCoastlines;
    uniform vec3 surfaceCoastColor;
    uniform float surfaceHeightScale;
    uniform float surfaceHeightShear;
    uniform mat3 normalMatrix;
    struct DenseFields { vec4 terrain; vec4 climate; vec3 habitat; vec4 delta; vec2 water; vec4 bank; };
    float decodeMaterial16(vec2 bytes) { return dot(bytes, vec2(256.0 / 257.0, 1.0 / 257.0)); }
    // Differentiate the physical displaced surface, not the coarse display face.
    // This uses the height already fetched above, with no extra texture reads.
    vec3 denseSurfaceNormal(vec3 direction, float elevation, float detailHeight) {
      float height = max(0.0, elevation) * surfaceHeightScale + detailHeight;
      float hx = dFdx(height), hy = dFdy(height);
      ${
        flat
          ? `vec3 up = vec3(0.0, 0.0, 1.0);
      vec2 ux = dFdx(vMaterialUv) * surfaceBounds.zw;
      vec2 uy = dFdy(vMaterialUv) * surfaceBounds.zw;
      vec3 tx = vec3(ux.x, ux.y + hx * surfaceHeightShear, hx);
      vec3 ty = vec3(uy.x, uy.y + hy * surfaceHeightShear, hy);`
          : `vec3 up = direction;
      vec3 tx = dFdx(direction) * (1.0 + height) + direction * hx;
      vec3 ty = dFdy(direction) * (1.0 + height) + direction * hy;`
      }
      // Normalize tangents first: metre-scale views have tiny but valid derivatives.
      tx /= max(length(tx), 1e-30); ty /= max(length(ty), 1e-30);
      vec3 slope = cross(tx, ty);
      if (dot(slope, slope) < 1e-12) slope = up;
      else { slope = normalize(slope); slope *= dot(slope, up) < 0.0 ? -1.0 : 1.0; }
      return normalize(normalMatrix * slope);
    }
    DenseFields sampleDenseSurface(vec3 direction) {
      vec2 localUv = vMaterialUv;
      ${flat ? '' : 'localUv = geographicMaterialUv(direction, surfaceBounds);'}
      localUv = clamp(localUv, 0.0, 1.0);
      // Boundary values already match the displayed neighbor. Keep them fixed
      // while interiors blend, including a neighbor whose stitch just changed.
      vec2 edgePixels = min(localUv, 1.0 - localUv) * surfaceTexels.xy / (2.0 * surfaceTexels.zw);
      float blendAmount = max(surfaceBlend, 1.0 - smoothstep(0.0, 2.0, min(edgePixels.x, edgePixels.y)));
      vec2 here = localUv * surfaceTexels.xy + surfaceTexels.zw;
      vec2 parent = (localUv * surfaceParentUv.xy + surfaceParentUv.zw) * surfaceParentTexels.xy + surfaceParentTexels.zw;
      ${Array.from(
        { length: 6 },
        (_, i) => `vec4 m${i} = texture2D(surfaceMap${i}, here);
      if (surfaceBlend < 1.0) m${i} = mix(texture2D(surfaceParent${i}, parent), m${i}, blendAmount);`,
      ).join('\n')}
      DenseFields fields;
      fields.terrain = vec4(mix(surfaceElevationRange.x, surfaceElevationRange.y, decodeMaterial16(m0.rg)), m0.ba, m1.r);
      fields.climate = vec4(mix(-128.0, 128.0, decodeMaterial16(m1.gb)), m1.a, m2.rg);
      fields.habitat = vec3(m2.b * 4.0, m2.a, decodeMaterial16(m3.rg) * 65535.0);
      fields.delta = vec4(m3.ba, m4.rg);
      fields.water = m4.ba;
      fields.bank = m5;
      return fields;
    }
  `;
}

/** Categorical values stay nearest-filtered, but their coordinates must respect
 * the actual meridian on a collapsed globe pole fan. */
export function configureCategoryCoordinates(
  material: THREE.MeshBasicMaterial,
  tile: RenderTile,
  texture: THREE.DataTexture,
  flat: boolean,
) {
  const bounds = tileBounds(tile);
  const image = texture.image;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.categoryBounds = {
      value: new THREE.Vector4(
        (bounds.west + bounds.east) / 2,
        bounds.south,
        bounds.east - bounds.west,
        bounds.north - bounds.south,
      ),
    };
    shader.uniforms.categoryTexels = {
      value: new THREE.Vector4(
        (image.width - 1) / image.width,
        (image.height - 1) / image.height,
        0.5 / image.width,
        0.5 / image.height,
      ),
    };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec3 spherePosition; varying vec3 categorySphere;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\ncategorySphere = spherePosition;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec3 categorySphere; uniform vec4 categoryBounds; uniform vec4 categoryTexels;\n${GEOGRAPHIC_MATERIAL_UV}`,
      )
      .replace(
        '#include <map_fragment>',
        `vec2 categoryUv = ${flat ? 'vMapUv' : 'geographicMaterialUv(normalize(categorySphere), categoryBounds)'};
        diffuseColor *= texture2D(map, categoryUv * categoryTexels.xy + categoryTexels.zw);`,
      );
  };
  material.customProgramCacheKey = () => `paged-category-geographic-${flat ? 'map' : 'globe'}`;
}
