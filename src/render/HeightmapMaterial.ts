import * as THREE from 'three';
import { clipMapMaterial } from './projection';

function finiteRange(
  range: readonly [number, number],
  fallback: readonly [number, number],
): [number, number] {
  const [minimum, maximum] = range;
  return minimum <= maximum &&
    [minimum, maximum, maximum - minimum].every((value) => Number.isFinite(Math.fround(value)))
    ? [minimum, maximum]
    : [...fallback];
}

/** A display heightmap uses bed elevation, including below sea/lake level.
 * The physical world already carries that scalar in material0's normalized RG
 * bytes; neither displaced geometry nor a quantized RGB palette is needed. */
export function createHeightmapMaterial(
  sourceRange: readonly [number, number],
  heightRange: readonly [number, number],
  flat: boolean,
): THREE.ShaderMaterial {
  const encoding = finiteRange(sourceRange, [-1, 1]);
  const [minimum, maximum] = finiteRange(heightRange, encoding);
  const material = new THREE.ShaderMaterial({
    name: 'World heightmap',
    uniforms: {
      elevationRange: { value: new THREE.Vector2(...encoding) },
      // A constant-height world has no relative low/high: show neutral gray.
      heightmapRange: { value: new THREE.Vector2(minimum, maximum) },
    },
    vertexShader: /* glsl */ `
      attribute vec4 material0;
      uniform vec2 elevationRange;
      varying float heightmapElevation;
      void main() {
        float encodedHeight = dot(material0.rg, vec2(65280.0, 255.0)) / 65535.0;
        heightmapElevation = mix(elevationRange.x, elevationRange.y, encodedHeight);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec2 heightmapRange;
      varying float heightmapElevation;
      void main() {
        float span = heightmapRange.y - heightmapRange.x;
        float gray = span > 0.0 ? clamp((heightmapElevation - heightmapRange.x) / span, 0.0, 1.0) : 0.5;
        gl_FragColor = vec4(vec3(gray), 1.0);
      }
    `,
    side: flat ? THREE.DoubleSide : THREE.FrontSide,
    lights: false,
    fog: false,
    toneMapped: false,
  });
  // Output is intentionally display grayscale: the halfway elevation must be
  // 128/255, not the brighter result of applying the sRGB transform to 0.5.
  // Decode before interpolation, normalize/clamp afterward so coastlines and
  // arbitrary triangle interiors retain all 16 bits of source height detail.
  if (flat) {
    clipMapMaterial(material);
  }
  material.userData.fixedSurfacePacketOrder = true;
  return material;
}
