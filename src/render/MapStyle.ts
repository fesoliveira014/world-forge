import * as THREE from 'three';
import { createSeededRandom } from '../core/math';
import { BANK_SHADER } from './RiverbankTexture';

export type MapStyle = 'natural' | 'relief' | 'illustrated';

export const MAP_STYLES: { id: MapStyle; name: string; description: string; stops?: string[] }[] = [
  { id: 'natural', name: 'Natural', description: 'Seasonal terrain, water, and vegetation.' },
  {
    id: 'relief',
    name: 'Shaded relief',
    stops: ['#467e95', '#efe8cc', '#648d61', '#c7b794', '#f5f5e9'],
    description: 'Sculpted terrain, shaded slopes, and blue waterways.',
  },
  {
    id: 'illustrated',
    name: 'Ink atlas',
    stops: ['#b7c5bf', '#efe8cc', '#d6d9b6', '#393b31', '#f5f5e9'],
    description: 'Paper, inked shores, and terrain and forest symbols.',
  },
];

/** Display scale only: the simulation's heights, areas, and water are untouched. */
export function mapReliefScale(style: MapStyle) {
  return style === 'relief' ? 4 : 0;
}

/** Both art styles use the natural view's land, lake, snow, and habitat fields. */
export function createArtMaterial(
  seed: string,
  style: Exclude<MapStyle, 'natural'>,
  flat: boolean,
  bankTexture: THREE.Texture,
) {
  const random = createSeededRandom(`${seed}:map-ink`);
  const illustrated = style === 'illustrated';
  const color = (hex: string) => ({ value: new THREE.Color(hex) });
  return new THREE.ShaderMaterial({
    uniforms: {
      illustrated: { value: illustrated },
      seedOffset: { value: new THREE.Vector3(random() * 30, random() * 30, random() * 30) },
      paperColor: color('#efe8cc'),
      inkColor: color('#393b31'),
      oceanColor: color(illustrated ? '#b7c5bf' : '#467e95'),
      shoreColor: color(illustrated ? '#d0d6c5' : '#9dc6c7'),
      meadowColor: color(illustrated ? '#d6d9b6' : '#a9ba78'),
      forestColor: color(illustrated ? '#c0c7a0' : '#648d61'),
      rockColor: color(illustrated ? '#ded5b7' : '#c7b794'),
      snowColor: color('#f5f5e9'),
      riverbankMap: { value: bankTexture },
    },
    vertexShader: /* glsl */ `
      ${flat ? 'attribute vec3 spherePosition;' : ''}
      attribute vec4 surfaceTerrain;
      attribute vec4 surfaceClimate;
      attribute vec3 surfaceHabitat;
      attribute vec4 surfaceDelta;
      attribute vec2 surfaceWater;
      varying vec4 terrain;
      varying vec4 climate;
      varying vec4 delta;
      varying vec2 waterCoverage;
      varying vec3 habitat;
      varying vec3 sphereDirection;
      varying vec3 viewPosition;
      varying vec3 viewUp;

      void main() {
        terrain = surfaceTerrain;
        climate = surfaceClimate;
        habitat = surfaceHabitat;
        delta = surfaceDelta;
        waterCoverage = surfaceWater;
        sphereDirection = normalize(${flat ? 'spherePosition' : 'position'});
        viewUp = normalize(normalMatrix * ${flat ? 'vec3(0.0, 0.0, 1.0)' : 'sphereDirection'});
        vec4 point = modelViewMatrix * vec4(position, 1.0);
        viewPosition = point.xyz;
        gl_Position = projectionMatrix * point;
      }
    `,
    fragmentShader: /* glsl */ `
      ${BANK_SHADER}
      uniform bool illustrated;
      uniform vec3 seedOffset;
      uniform vec3 paperColor;
      uniform vec3 inkColor;
      uniform vec3 oceanColor;
      uniform vec3 shoreColor;
      uniform vec3 meadowColor;
      uniform vec3 forestColor;
      uniform vec3 rockColor;
      uniform vec3 snowColor;
      varying vec4 terrain;
      varying vec4 climate;
      varying vec4 delta;
      varying vec2 waterCoverage;
      varying vec3 habitat;
      varying vec3 sphereDirection;
      varying vec3 viewPosition;
      varying vec3 viewUp;

      float hashPoint(vec3 point) {
        return fract(sin(dot(point, vec3(127.1, 311.7, 74.7))) * 43758.5453);
      }

      float pigment(vec3 point, float scale) {
        vec3 coordinate = point * scale + seedOffset;
        vec3 corner = floor(coordinate);
        vec3 blend = smoothstep(0.0, 1.0, fract(coordinate));
        float value = mix(
          mix(mix(hashPoint(corner), hashPoint(corner + vec3(1, 0, 0)), blend.x),
              mix(hashPoint(corner + vec3(0, 1, 0)), hashPoint(corner + vec3(1, 1, 0)), blend.x), blend.y),
          mix(mix(hashPoint(corner + vec3(0, 0, 1)), hashPoint(corner + vec3(1, 0, 1)), blend.x),
              mix(hashPoint(corner + vec3(0, 1, 1)), hashPoint(corner + vec3(1, 1, 1)), blend.x), blend.y),
          blend.z);
        float footprint = max(length(dFdx(point)), length(dFdy(point))) * scale;
        return mix(value, 0.5, smoothstep(0.4, 1.2, footprint));
      }

      // Euclidean screen derivatives keep the pen width the same on diagonal
      // and horizontal coasts. Uniform wet interiors must not acquire an outline.
      float distanceToShore(float wetFraction) {
        float gradient = length(vec2(dFdx(wetFraction), dFdy(wetFraction)));
        if (gradient < 0.00001) return wetFraction < 0.5 ? 10000.0 : -10000.0;
        return (0.5 - wetFraction) / gradient;
      }

      float shoreStroke(float distance, float center, float halfWidth) {
        return 1.0 - smoothstep(halfWidth, halfWidth + 0.7, abs(distance - center));
      }

      void main() {
        vec3 direction = normalize(sphereDirection);
        float wash = pigment(direction, 65.0);
        float grain = pigment(direction, 1700.0);
        float elevation = max(0.0, terrain.x);
        float mountains = smoothstep(900.0, 3800.0, elevation);
        float canopy = smoothstep(0.1, 0.85, terrain.w) * smoothstep(0.15, 0.7, terrain.z);
        vec3 land = mix(paperColor, meadowColor, clamp(terrain.z, 0.0, 1.0));
        land = mix(land, forestColor, canopy * 0.8);
        land = mix(land, rockColor, mountains * (illustrated ? 0.3 : 0.9));
        land *= 0.95 + wash * 0.08 + grain * 0.025;
        vec4 bank = riverbankSample(direction);
        // The existing local footprint controls the watercolor wash too.
        vec3 bankPigment = illustrated ? meadowColor * 0.94 : bank.rgb / max(bank.a, 0.001);
        land = mix(land, bankPigment, bank.a * (illustrated ? 0.5 : 0.7));
        land = mix(land, mix(meadowColor, shoreColor, 0.45), habitat.y * 0.35);
        vec3 deltaPigment = illustrated ? mix(meadowColor, shoreColor, 0.6) : delta.rgb / max(delta.a, 0.001);
        land = mix(land, deltaPigment, delta.a * 0.65);
        float snow = smoothstep(0.12, 0.85, clamp(climate.z + climate.w, 0.0, 1.0));
        land = mix(land, snowColor, snow);
        float shallow = exp(-max(0.0, -terrain.x) / 850.0);
        vec3 water = mix(oceanColor, shoreColor, shallow * (illustrated ? 0.25 : 0.55));
        water *= 0.975 + wash * 0.045 + grain * 0.018;
        water = mix(water, snowColor, smoothstep(0.12, 0.9, climate.z));

        float boundaryWidth = max(fwidth(terrain.y), 0.0001);
        float oceanEdge = max(fwidth(waterCoverage.x), 0.0001);
        float oceanMask = smoothstep(0.5 - oceanEdge * 0.6, 0.5 + oceanEdge * 0.6, waterCoverage.x);
        float landMask = (1.0 - oceanMask) * (1.0 - clamp(waterCoverage.y, 0.0, 1.0));
        vec3 albedo = mix(water, land, landMask);
        vec3 faceNormal = normalize(cross(dFdx(viewPosition), dFdy(viewPosition)));
        vec3 up = normalize(viewUp);
        // Unwrapping the sphere reverses triangle winding on the map. Orient
        // lighting toward the geographic surface, regardless of that winding.
        faceNormal *= dot(faceNormal, up) < 0.0 ? -1.0 : 1.0;
        // Remove broad globe curvature from the relief lighting. Local slopes
        // remain legible on both the near and far side of the visible hemisphere.
        vec3 slopeNormal = normalize(vec3(0.0, 0.0, 1.0) + (faceNormal - up) * 1.8);
        vec3 light = normalize(vec3(-0.55, 0.7, 1.0));
        float slopeLight = dot(slopeNormal, light);
        float daylight = smoothstep(-0.3, 0.85, slopeLight);
        float illumination = illustrated ? 0.98 + daylight * 0.04 : 0.62 + daylight * 0.46;
        albedo *= mix(1.0, illumination, landMask * (illustrated ? 0.35 : 1.0));

        if (illustrated) {
          // Ocean and seasonal inland water use their own actual coverage
          // fields. The nearest boundary defines the union of both water types.
          float shoreDistance = min(distanceToShore(waterCoverage.x), distanceToShore(waterCoverage.y));
          float waterSide = 1.0 - smoothstep(-0.3, 0.6, shoreDistance);
          float shoreWash = (1.0 - smoothstep(0.0, 11.0, -shoreDistance)) * waterSide;
          albedo = mix(albedo, shoreColor, shoreWash * 0.28);
          float landRim = shoreStroke(shoreDistance, 1.2, 0.15) * (1.0 - waterSide);
          albedo = mix(albedo, paperColor, landRim * 0.24);
          float penVariation = 0.86 + wash * 0.14;
          float outline = shoreStroke(shoreDistance, 0.0, 0.3) * 0.84;
          // Two quiet water-side contours replace the broad, broken zigzag band.
          float waterLines = shoreStroke(shoreDistance, -4.0, 0.12) * 0.23
                           + shoreStroke(shoreDistance, -8.0, 0.08) * 0.12;
          albedo = mix(albedo, inkColor, (outline + waterLines * waterSide) * penVariation);
        } else {
          float shoreDistance = (terrain.y - 0.5) / boundaryWidth;
          float inkEdge = 1.0 - smoothstep(0.45, 1.0, abs(shoreDistance));
          albedo = mix(albedo, inkColor * 1.3, inkEdge * 0.3);
          float folds = smoothstep(0.15, 0.5, length(faceNormal - up));
          albedo = mix(albedo, albedo * vec3(0.73, 0.79, 0.81), folds * (1.0 - daylight) * mountains * landMask);
        }
        gl_FragColor = vec4(albedo, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
}
