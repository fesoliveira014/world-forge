import * as THREE from 'three';
import { tileBounds, type RenderTile } from './TileGeometry';

export const MATERIAL_PIXEL_SPACING = 1.5;
export const MAX_MATERIAL_INTERVALS = 32768;

/** Material resolution follows screen pixels independently of the shape grid.
 * The globe estimate is deliberately invariant under rotation: a tile loaded at
 * the limb must already have enough detail when it rotates into the foreground.
 * Its latitude bounds still account for the convergence of meridians at poles.
 */
export function tileMaterialSize(
  tile: RenderTile,
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  width: number,
  height: number,
  pixelRatio: number,
): { materialWidth: number; materialHeight: number } {
  // Reuse the already sampled shape fields for the first complete view. Dense
  // child materials refine this fallback without delaying first paint on large saves.
  if (tile.z === 1) {
    return { materialWidth: 17, materialHeight: 17 };
  }
  const bounds = tileBounds(tile);
  let pixelsX: number;
  let pixelsY: number;
  const flat = camera instanceof THREE.OrthographicCamera;
  if (flat) {
    pixelsX = ((bounds.east - bounds.west) * width * camera.zoom) / (camera.right - camera.left);
    pixelsY = ((bounds.north - bounds.south) * height * camera.zoom) / (camera.top - camera.bottom);
  } else {
    const nearest = Math.max(0.00001, camera.position.length() - 1);
    const scale =
      (height * camera.zoom) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * nearest);
    const latitude = Math.max(bounds.south, Math.min(bounds.north, 0));
    pixelsX = (bounds.east - bounds.west) * Math.cos(latitude) * scale;
    pixelsY = (bounds.north - bounds.south) * scale;
  }
  pixelsX *= pixelRatio;
  pixelsY *= pixelRatio;
  let x = tile.z >= 3 && flat ? 128 : 64;
  let y = tile.z >= 3 ? 64 : 32;
  // Broad fallback parents arrive promptly. Their detailed children replace them
  // progressively; retaining a huge texture for every ancestor wastes residency.
  const maximum = tile.z === 2 ? 128 : 256;
  while (true) {
    const growX =
      x < maximum && x * y * 2 <= MAX_MATERIAL_INTERVALS && pixelsX / x > MATERIAL_PIXEL_SPACING;
    const growY =
      y < maximum && x * y * 2 <= MAX_MATERIAL_INTERVALS && pixelsY / y > MATERIAL_PIXEL_SPACING;
    if (!growX && !growY) {
      break;
    }
    if (growX && (!growY || pixelsX / x >= pixelsY / y)) {
      x *= 2;
    } else {
      y *= 2;
    }
  }
  return { materialWidth: x + 1, materialHeight: y + 1 };
}
