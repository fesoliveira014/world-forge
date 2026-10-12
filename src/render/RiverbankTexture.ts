import * as THREE from 'three';
import type { Layer, World } from '../core/model';
import { clamp } from '../core/math';
import { RiverGeometry, riverHalfWidth } from './RiverGeometry';

const BANK_COLORS = ['#344b4b', '#87a260', '#306c49', '#429183'];

export const BANK_LAYERS: Layer[] = ['world', 'biomes', 'vegetation', 'floodplains', 'wetlands'];

/** Paint soft round-ended capsules into one surface texture. Junctions use the
 * strongest coverage, so overlapping reaches neither darken nor form ribbon spikes.
 * Longitude wraps; distances use the local latitude metric. No bank mesh is built.
 */
export function createRiverbankTexture(
  world: World,
  season: number,
  width = world.grid.count > 100_000 ? 4096 : 2048,
) {
  const height = width / 2;
  const data = new Uint8Array(width * height * 4);
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  const network = new RiverGeometry(world);
  const floodplains = world.ecology.floodplains;
  const color = new THREE.Color();
  const blue = new THREE.Color('#65aabd');
  const cold = new THREE.Color('#a9b9ae');
  const scale = height / Math.PI;

  const sampleBankHabitat = (slot: number, cornerIndex: number) => {
    const flood =
      season < 0
        ? Math.max(...floodplains.seasonalFlood.map((seasonFlood) => seasonFlood[slot]))
        : floodplains.seasonalFlood[season][slot];
    let temperature = 0;

    for (let incidentIndex = 0; incidentIndex < 3; incidentIndex++) {
      const cellIndex = world.grid.triangles[cornerIndex * 3 + incidentIndex];
      temperature +=
        (season < 0
          ? world.water.temperature[cellIndex]
          : world.water.seasonalTemperature[season][cellIndex]) / 3;
    }

    color
      .set(BANK_COLORS[floodplains.habitat[slot]])
      .multiplyScalar(0.75 + floodplains.vegetation[slot] * 0.25)
      .lerp(blue, flood * 0.3)
      .lerp(cold, clamp((2 - temperature) / 12) * 0.8);

    return [color.r * 255, color.g * 255, color.b * 255];
  };

  for (const cornerIndex of floodplains.corner) {
    const slots = [network.getBankIndex(cornerIndex, 1), network.getBankIndex(cornerIndex, -1)];

    if (slots.some((bankSlot) => bankSlot < 0)) {
      continue;
    }

    // A narrow antialiasing skirt is visual only. Physical bank widths and area
    // fractions remain unchanged and are still reported by the inspector.
    const widths = slots.map((bankSlot) =>
      floodplains.width[bankSlot] > 0
        ? Math.max(
            1.1,
            (floodplains.width[bankSlot] / world.config.radius +
              riverHalfWidth(world.drainage.discharge[cornerIndex], 1)) *
              scale,
          )
        : 0,
    );

    if (!widths[0] && !widths[1]) {
      continue;
    }

    const colors = slots.map((bankSlot) => sampleBankHabitat(bankSlot, cornerIndex));
    const points = network.getCoursePoints(cornerIndex);

    for (let pointOffset = 3; pointOffset < points.length; pointOffset += 3) {
      const startX =
        (Math.atan2(points[pointOffset - 1], points[pointOffset - 3]) + Math.PI) * scale;
      const startY = (Math.asin(clamp(points[pointOffset - 2], -1, 1)) + Math.PI / 2) * scale;
      let endX = (Math.atan2(points[pointOffset + 2], points[pointOffset]) + Math.PI) * scale;
      const endY = (Math.asin(clamp(points[pointOffset + 1], -1, 1)) + Math.PI / 2) * scale;

      if (endX - startX > width / 2) {
        endX -= width;
      }

      if (endX - startX < -width / 2) {
        endX += width;
      }

      const cosine = Math.max(0.025, Math.cos((startY + endY) / (2 * scale) - Math.PI / 2));
      const directionX = (endX - startX) * cosine;
      const directionY = endY - startY;
      const segmentLengthSquared = directionX * directionX + directionY * directionY;

      if (segmentLengthSquared < 1e-12) {
        continue;
      }

      const radius = Math.max(...widths);
      const horizontalRadius = radius / cosine;
      const minX = Math.floor(Math.min(startX, endX) - horizontalRadius);
      const maxX = Math.ceil(Math.max(startX, endX) + horizontalRadius);
      const minY = Math.max(0, Math.floor(Math.min(startY, endY) - radius));
      const maxY = Math.min(height - 1, Math.ceil(Math.max(startY, endY) + radius));

      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const pixelOffsetX = (x + 0.5 - startX) * cosine;
          const pixelOffsetY = y + 0.5 - startY;
          const alongFraction = clamp(
            (pixelOffsetX * directionX + pixelOffsetY * directionY) / segmentLengthSquared,
          );
          // x,z longitude uses the opposite handedness to the xyz cross product.
          const side = directionX * pixelOffsetY - directionY * pixelOffsetX < 0 ? 0 : 1;
          const bankWidth = widths[side];

          if (!bankWidth) {
            continue;
          }

          const distance =
            Math.hypot(
              pixelOffsetX - directionX * alongFraction,
              pixelOffsetY - directionY * alongFraction,
            ) / bankWidth;

          if (distance >= 1) {
            continue;
          }

          const fade = clamp((distance - 0.18) / 0.82);
          const alpha = Math.round(220 * (1 - fade * fade * (3 - 2 * fade)));
          const pixelOffset = (y * width + (((x % width) + width) % width)) * 4;

          if (alpha <= data[pixelOffset + 3]) {
            continue;
          }

          data[pixelOffset] = colors[side][0];
          data[pixelOffset + 1] = colors[side][1];
          data[pixelOffset + 2] = colors[side][2];
          data[pixelOffset + 3] = alpha;
        }
      }
    }
  }

  // Premultiply before linear filtering: transparent texels must not introduce
  // dark seams around the soft edge. The shaders consume premultiplied RGB.
  for (let pixelOffset = 0; pixelOffset < data.length; pixelOffset += 4) {
    const alpha = data[pixelOffset + 3] / 255;
    data[pixelOffset] *= alpha;
    data[pixelOffset + 1] *= alpha;
    data[pixelOffset + 2] *= alpha;
  }

  texture.needsUpdate = true;

  return texture;
}

export const BANK_SHADER = /* glsl */ `
  uniform sampler2D riverbankMap;

  vec4 riverbankSample(vec3 direction) {
    vec3 surfaceDirection = normalize(direction);
    vec2 uv = vec2(
      atan(surfaceDirection.z, surfaceDirection.x) / 6.28318530718 + 0.5,
      asin(clamp(surfaceDirection.y, -1.0, 1.0)) / 3.14159265359 + 0.5
    );
    return texture2D(riverbankMap, uv);
  }
`;

/** The same texture works on cell-color layers, with a land mask preventing
 * vegetation from painting across lakes or ocean. It stays attached to the surface.
 */
export function createLayerMaterial(texture: THREE.DataTexture, flat: boolean) {
  const material = new THREE.MeshBasicMaterial({ vertexColors: true });
  material.customProgramCacheKey = () => `riverbank-layer:${flat ? 'map' : 'globe'}`;
  const enabled = { value: 0 };
  material.userData.bankEnabled = enabled;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.riverbankMap = { value: texture };
    shader.uniforms.bankEnabled = enabled;
    shader.vertexShader = /* glsl */ `${flat ? 'attribute vec3 spherePosition;' : ''}
      attribute float bankLand;
      varying float vBankLand;
      varying vec3 vBankSphere;
      ${shader.vertexShader}`.replace(
      '#include <begin_vertex>',
      /* glsl */ `#include <begin_vertex>
        vBankLand = bankLand;
        vBankSphere = ${flat ? 'spherePosition' : 'position'};`,
    );
    shader.fragmentShader = /* glsl */ `${BANK_SHADER}
      uniform float bankEnabled;
      varying float vBankLand;
      varying vec3 vBankSphere;
      ${shader.fragmentShader}`.replace(
      '#include <color_fragment>',
      /* glsl */ `#include <color_fragment>
        vec4 bank = riverbankSample(vBankSphere);
        float land = smoothstep(0.48, 0.52, vBankLand) * bankEnabled;
        diffuseColor.rgb = diffuseColor.rgb * (1.0 - bank.a * land) + bank.rgb * land;`,
    );
  };

  return material;
}
