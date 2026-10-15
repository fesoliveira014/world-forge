import { denseSurfaceShader } from './DenseSurface';
import * as THREE from 'three';
import type { World } from '../core/model';
import { clamp, createSeededRandom } from '../core/math';
import { updateMapAttributes } from './projection';
import { getDeltaCells, sampleDeltaColor } from './SurfaceHabitats';
import { lakeCoverageAt } from '../core/generation/lake-state';
import { BANK_SHADER } from './RiverbankTexture';

/** Display-only fields. Analytic layers retain their original colors and geometry. */
export function updateNaturalSurface(geometry: THREE.BufferGeometry, world: World, season: number) {
  if (geometry.userData.naturalSeason === season) {
    return;
  }

  const count = world.grid.count;

  for (const name of ['surfaceTerrain', 'surfaceClimate', 'surfaceDelta']) {
    if (!geometry.hasAttribute(name)) {
      geometry.setAttribute(name, new THREE.BufferAttribute(new Float32Array(count * 4), 4));
    }
  }

  if (!geometry.hasAttribute('surfaceHabitat')) {
    geometry.setAttribute(
      'surfaceHabitat',
      new THREE.BufferAttribute(new Float32Array(count * 3), 3),
    );
  }
  if (!geometry.hasAttribute('surfaceWater')) {
    geometry.setAttribute(
      'surfaceWater',
      new THREE.BufferAttribute(new Float32Array(count * 2), 2),
    );
  }

  const terrain = geometry.getAttribute('surfaceTerrain') as THREE.BufferAttribute;
  const climate = geometry.getAttribute('surfaceClimate') as THREE.BufferAttribute;
  const habitat = geometry.getAttribute('surfaceHabitat') as THREE.BufferAttribute;
  const delta = geometry.getAttribute('surfaceDelta') as THREE.BufferAttribute;
  const water = geometry.getAttribute('surfaceWater') as THREE.BufferAttribute;
  const deltas = getDeltaCells(world);
  const tint = new THREE.Color();

  for (let cellIndex = 0; cellIndex < count; cellIndex++) {
    const biome = world.ecology.biome[cellIndex];
    const temperature =
      season < 0
        ? world.water.temperature[cellIndex]
        : world.water.seasonalTemperature[season][cellIndex];
    const ocean = world.terrain.ocean[cellIndex];
    const wetFraction = lakeCoverageAt(world.drainage, cellIndex, season);
    const landFraction = ocean ? 0 : 1 - wetFraction;
    const isWaterCell = landFraction < 1e-6;
    water.setXY(cellIndex, ocean, wetFraction);
    const forest = biome === 3 || biome === 4 || biome === 8 || biome === 9;
    terrain.setXYZW(
      cellIndex,
      world.terrain.height[cellIndex],
      landFraction,
      world.ecology.vegetation[cellIndex],
      forest ? 1 : 0,
    );
    const permanentIce =
      biome === 1 ? 1 : ocean || wetFraction > 0 ? clamp((-temperature - 1) / 12) : 0;
    const snow = isWaterCell
      ? 0
      : clamp(world.water.snow[cellIndex] / 160) * clamp((3 - temperature) / 9);
    climate.setXYZW(cellIndex, temperature, world.water.aridity[cellIndex], permanentIce, snow);
    habitat.setXYZ(
      cellIndex,
      world.ecology.wetland[cellIndex],
      world.ecology.wetlandFraction[cellIndex],
      world.terrain.fluvialIncision[cellIndex],
    );

    if (deltas[cellIndex]) {
      sampleDeltaColor(world, cellIndex, season, tint);
      delta.setXYZW(cellIndex, tint.r * 0.85, tint.g * 0.85, tint.b * 0.85, 0.85);
    } else {
      delta.setXYZW(cellIndex, 0, 0, 0, 0);
    }
  }

  terrain.needsUpdate =
    climate.needsUpdate =
    habitat.needsUpdate =
    delta.needsUpdate =
    water.needsUpdate =
      true;
  updateMapAttributes(geometry, [
    'surfaceTerrain',
    'surfaceClimate',
    'surfaceHabitat',
    'surfaceDelta',
    'surfaceWater',
  ]);
  geometry.userData.naturalSeason = season;
}

/** Seamless fragment shading adds visual detail without increasing simulation cells.
 * Noise changes pigment and tiny normal variations, never coastlines or drainage heights.
 */
export function createNaturalMaterial(
  seed: string,
  flat = false,
  bankTexture: THREE.Texture | null = null,
  paged = false,
  dense = false,
) {
  const randomNumber = createSeededRandom(`${seed}:surface`);

  const color = (hex: string) => ({ value: new THREE.Color(hex) });

  return new THREE.ShaderMaterial({
    uniforms: {
      seedOffset: {
        value: new THREE.Vector3(randomNumber() * 70, randomNumber() * 70, randomNumber() * 70),
      },
      sunDirection: { value: new THREE.Vector3(-3, 5, 5).normalize() },
      sandColor: color('#c2b185'),
      grassColor: color('#6c873d'),
      forestColor: color('#285a3c'),
      tundraColor: color('#939783'),
      rockColor: color('#91877b'),
      snowColor: color('#e3edf0'),
      oceanColor: color('#0a2948'),
      shelfColor: color('#287b8c'),
      lakeColor: color('#287388'),
      riverbankMap: { value: bankTexture },
      surfaceCoastColor: color('#aecbd0'),
    },
    vertexShader: /* glsl */ `
      ${flat || paged ? 'attribute vec3 spherePosition;' : ''}
      ${dense ? 'varying vec2 vMaterialUv;' : ''}
      attribute vec4 surfaceTerrain;
      attribute vec4 surfaceClimate;
      attribute vec3 surfaceHabitat;
      attribute vec4 surfaceDelta;
      attribute vec2 surfaceWater;
      ${paged ? 'attribute vec4 surfaceBank;' : ''}
      varying vec4 vTerrain;
      varying vec4 vClimate;
      varying vec3 vHabitat;
      varying vec4 vDelta;
      varying vec2 vWater;
      ${paged ? 'varying vec4 vBank;' : ''}
      varying vec3 vSphere;
      varying vec3 vSurfaceNormal;
      varying vec3 vSurfacePosition;
      void main() {
        ${dense ? 'vMaterialUv = uv;' : ''}
        vTerrain = surfaceTerrain;
        vClimate = surfaceClimate;
        vHabitat = surfaceHabitat;
        vDelta = surfaceDelta;
        vWater = surfaceWater;
        ${paged ? 'vBank = surfaceBank;' : ''}
        vSphere = normalize(${flat || paged ? 'spherePosition' : 'position'});
        vSurfaceNormal = ${flat ? 'vec3(0.0, 0.0, 1.0)' : 'normalize(normalMatrix * normal)'};
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vSurfacePosition = viewPosition.xyz;
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      ${BANK_SHADER}
      uniform vec3 seedOffset;
      uniform vec3 sunDirection;
      uniform vec3 sandColor;
      uniform vec3 grassColor;
      uniform vec3 forestColor;
      uniform vec3 tundraColor;
      uniform vec3 rockColor;
      uniform vec3 snowColor;
      uniform vec3 oceanColor;
      uniform vec3 shelfColor;
      uniform vec3 lakeColor;
      ${
        dense
          ? denseSurfaceShader(flat)
          : `
      varying vec4 vTerrain;
      varying vec4 vClimate;
      varying vec3 vHabitat;
      varying vec4 vDelta;
      varying vec2 vWater;
      ${paged ? 'varying vec4 vBank;' : ''}
      `
      }
      varying vec3 vSphere;
      varying vec3 vSurfaceNormal;
      varying vec3 vSurfacePosition;

      float hashPoint(vec3 position) {
        return fract(sin(dot(position, vec3(127.1, 311.7, 74.7))) * 43758.5453);
      }

      float noise3(vec3 position) {
        vec3 latticeCorner = floor(position);
        vec3 blend = fract(position);
        blend = blend * blend * (3.0 - 2.0 * blend);
        return mix(
          mix(
            mix(hashPoint(latticeCorner), hashPoint(latticeCorner + vec3(1, 0, 0)), blend.x),
            mix(hashPoint(latticeCorner + vec3(0, 1, 0)), hashPoint(latticeCorner + vec3(1, 1, 0)), blend.x),
            blend.y
          ),
          mix(
            mix(hashPoint(latticeCorner + vec3(0, 0, 1)), hashPoint(latticeCorner + vec3(1, 0, 1)), blend.x),
            mix(hashPoint(latticeCorner + vec3(0, 1, 1)), hashPoint(latticeCorner + vec3(1, 1, 1)), blend.x),
            blend.y
          ),
          blend.z
        );
      }

      // Fade detail below a pixel rather than letting fine noise shimmer while orbiting.
      float detailNoise(vec3 position, float frequency) {
        float footprint = max(length(dFdx(position)), length(dFdy(position))) * frequency;
        return mix(noise3(position * frequency + seedOffset), 0.5, smoothstep(0.35, 1.0, footprint));
      }

      vec3 detailNormal(vec3 baseNormal, float height) {
        vec3 positionDerivativeX = dFdx(vSurfacePosition);
        vec3 positionDerivativeY = dFdy(vSurfacePosition);
        vec3 tangentX = cross(positionDerivativeY, baseNormal);
        vec3 tangentY = cross(baseNormal, positionDerivativeX);
        float determinant = dot(positionDerivativeX, tangentX);
        vec3 gradient = sign(determinant) * (dFdx(height) * tangentX + dFdy(height) * tangentY);
        vec3 perturbed = abs(determinant) * baseNormal - gradient;
        return dot(perturbed, perturbed) > 1e-24 ? normalize(perturbed) : baseNormal;
      }

      void main() {
        vec3 surfaceDirection = normalize(vSphere);
        ${
          dense
            ? `DenseFields sampled = sampleDenseSurface(surfaceDirection);
        vec4 vTerrain = sampled.terrain; vec4 vClimate = sampled.climate;
        vec3 vHabitat = sampled.habitat; vec4 vDelta = sampled.delta;
        vec2 vWater = sampled.water; vec4 vBank = sampled.bank;`
            : ''
        }
        float broad = detailNoise(surfaceDirection, 38.0);
        float grain = detailNoise(surfaceDirection, 220.0);
        float fine = detailNoise(surfaceDirection, 1150.0);
        float ridges = 1.0 - abs(grain * 2.0 - 1.0);
        float elevation = max(0.0, vTerrain.x);
        float mountain = smoothstep(1100.0, 4300.0, elevation);
        float cover = clamp(vTerrain.z + (broad - 0.5) * 0.07, 0.0, 1.0);
        float canopy = smoothstep(0.05, 0.95, vTerrain.w) * smoothstep(0.15, 0.7, cover);
        // Cover already includes water stress. Applying aridity here a second time
        // made dry grasslands look like bare sand even when the soil supported plants.
        vec3 land = mix(sandColor, grassColor, cover);
        land = mix(land, forestColor, canopy * (0.82 + grain * 0.16));
        float cold = (1.0 - smoothstep(0.0, 10.0, vClimate.x)) * (1.0 - canopy);
        land = mix(land, tundraColor, cold * 0.65);
        land = mix(land, rockColor * (0.82 + ridges * 0.3), mountain * (0.6 + grain * 0.3));
        // Habitat fractions affect local material; they do not change the regional biome.
        vec3 wetland = vHabitat.x > 3.5 ? vec3(0.30, 0.27, 0.13)
          : vHabitat.x > 2.5 ? vec3(0.28, 0.39, 0.22)
          : vHabitat.x > 1.5 ? vec3(0.07, 0.20, 0.14)
          : vec3(0.15, 0.34, 0.26);
        land = mix(land, wetland * (0.88 + grain * 0.24), vHabitat.y * 0.85);
        land = mix(
          land,
          rockColor * (0.7 + ridges * 0.25),
          smoothstep(60.0, 400.0, vHabitat.z) * (1.0 - cover) * 0.55
        );
        land *= 0.86 + broad * 0.16 + grain * 0.1 + fine * 0.08;
        // One filtered surface mask joins the entire river corridor. There is no
        // raised green geometry, even where reaches bend, merge, or end.
        vec4 bank = ${paged ? 'vBank' : 'riverbankSample(surfaceDirection)'};
        land = land * (1.0 - bank.a) + bank.rgb * (0.95 + grain * 0.1);
        land = land * (1.0 - vDelta.a) + vDelta.rgb * (0.92 + grain * 0.16);
        float snow = clamp(vClimate.z + vClimate.w, 0.0, 1.0);
        land = mix(land, snowColor * (0.94 + fine * 0.1), smoothstep(0.12, 0.85, snow));

        float shelf = exp(-max(0.0, -vTerrain.x) / 650.0);
        vec3 water = mix(oceanColor, shelfColor, shelf * 0.75);
        water = mix(water, lakeColor, step(0.0, vTerrain.x));
        water *= 0.97 + broad * 0.06;
        water = mix(water, snowColor, smoothstep(0.12, 0.9, vClimate.z));
        // Ocean coasts stay crisp. Inland shores preserve the modeled wet fraction.
        float edge = max(fwidth(vWater.x), 0.0001);
        float oceanMask = smoothstep(0.5 - edge * 0.6, 0.5 + edge * 0.6, vWater.x);
        float landMask = (1.0 - oceanMask) * (1.0 - clamp(vWater.y, 0.0, 1.0));
        vec3 albedo = mix(water, land, landMask);

        float bump = landMask * (mountain * ridges * 0.00013 + canopy * fine * 0.000025);
        vec3 baseNormal = normalize(vSurfaceNormal);
        ${
          paged && !dense
            ? `// Paged samples carry a geographic radial normal. Recover the displayed
        // relief slope from the actual view-space triangle, with either winding.
        vec3 slopeNormal = cross(dFdx(vSurfacePosition), dFdy(vSurfacePosition));
        if (dot(slopeNormal, slopeNormal) > 1e-20) {
          slopeNormal = normalize(slopeNormal);
          slopeNormal *= dot(slopeNormal, baseNormal) < 0.0 ? -1.0 : 1.0;
          baseNormal = normalize(mix(baseNormal, slopeNormal, landMask));
        }`
            : ''
        }
        vec3 normal = ${dense ? 'normalize(mix(baseNormal, denseSurfaceNormal(surfaceDirection, vTerrain.x, bump), landMask))' : 'detailNormal(baseNormal, bump)'};
        vec3 light = normalize(mat3(viewMatrix) * sunDirection);
        vec3 viewDirection = normalize(-vSurfacePosition);
        float daylight = max(dot(normal, light), 0.0);
        vec3 illumination = vec3(0.53, 0.59, 0.64) + vec3(0.58, 0.56, 0.49) * daylight;
        vec3 shaded = albedo * illumination;
        float glint = pow(max(dot(normal, normalize(light + viewDirection)), 0.0), 180.0);
        shaded += vec3(0.38, 0.48, 0.52) * glint * (1.0 - landMask) * (1.0 - vClimate.z) * 0.28;
        ${
          dense
            ? `// Continuous physical ocean boundary; independent of vector segment quotas.
        float coastDistance = abs(vWater.x - .5) / max(fwidth(vWater.x), .0001);
        float coastCoverage = (1.0 - smoothstep(.45, 1.25, coastDistance)) * surfaceCoastlines;
        shaded = mix(shaded, surfaceCoastColor, coastCoverage * .82);`
            : ''
        }
        gl_FragColor = vec4(shaded, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
}
