import type { GlobeGridFootprint, ViewBounds } from '../core/view/types';

export interface RenderTile {
  z: number;
  x: number;
  y: number;
}
export const TILE_SEGMENTS = 16;
export const ROOT_TILES: RenderTile[] = [
  { z: 1, x: 0, y: 0 },
  { z: 1, x: 1, y: 0 },
  { z: 1, x: 0, y: 1 },
  { z: 1, x: 1, y: 1 },
];
export const tileKey = (tile: RenderTile) => `${tile.z}/${tile.x}/${tile.y}`;
export function tileChildren(tile: RenderTile): RenderTile[] {
  return [0, 1, 2, 3].map((i) => ({
    z: tile.z + 1,
    x: tile.x * 2 + (i % 2),
    y: tile.y * 2 + (i >> 1),
  }));
}
export function tileParent(tile: RenderTile): RenderTile {
  return { z: tile.z - 1, x: tile.x >> 1, y: tile.y >> 1 };
}
export function tileBounds(tile: RenderTile): ViewBounds {
  const count = 2 ** tile.z;
  return {
    west: (tile.x / count) * 2 * Math.PI - Math.PI,
    east: ((tile.x + 1) / count) * 2 * Math.PI - Math.PI,
    south: (tile.y / count) * Math.PI - Math.PI / 2,
    north: ((tile.y + 1) / count) * Math.PI - Math.PI / 2,
  };
}
/** Integer dyadic coordinates give adjacent LODs identical shared sample directions. */
export function tileDirections(
  tile: RenderTile,
  segments = TILE_SEGMENTS,
  centers = false,
): Float32Array {
  const width = centers ? segments : segments + 1;
  const result = new Float32Array(width * width * 3);
  const total = segments * 2 ** tile.z;
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const u = (tile.x * segments + x + (centers ? 0.5 : 0)) / total;
      const v = (tile.y * segments + y + (centers ? 0.5 : 0)) / total;
      const longitude = u * 2 * Math.PI - Math.PI;
      const latitude = v * Math.PI - Math.PI / 2;
      const i = (y * width + x) * 3;
      const horizontal = v === 0 || v === 1 ? 0 : Math.cos(latitude);
      result[i] = horizontal === 0 ? 0 : horizontal * Math.cos(longitude);
      result[i + 1] = Math.sin(latitude);
      result[i + 2] = horizontal === 0 || u === 0 || u === 1 ? 0 : horizontal * Math.sin(longitude);
    }
  }
  return result;
}
/** W/E/S/N bits collapse odd boundary vertices onto an exactly matching coarse edge. */
export function tileIndices(mask = 0, segments = TILE_SEGMENTS): Uint16Array {
  if (segments % 2 || segments < 2) {
    throw new Error('Tile segments must be positive and even');
  }
  const result: number[] = [];
  const vertex = (x: number, y: number) => {
    if ((x === 0 && mask & 1) || (x === segments && mask & 2)) {
      y -= y % 2;
    }
    if ((y === 0 && mask & 4) || (y === segments && mask & 8)) {
      x -= x % 2;
    }
    return y * (segments + 1) + x;
  };
  const triangle = (a: number, b: number, c: number) => {
    if (a !== b && a !== c && b !== c) {
      result.push(a, b, c);
    }
  };
  for (let y = 0; y < segments; y++) {
    for (let x = 0; x < segments; x++) {
      // Longitude/latitude parameterization winds inward; reverse it on the sphere.
      const a = vertex(x, y);
      const b = vertex(x + 1, y);
      const c = vertex(x, y + 1);
      const d = vertex(x + 1, y + 1);
      triangle(a, c, b);
      triangle(b, c, d);
    }
  }
  return new Uint16Array(result);
}

/** Barycentric coordinates in the actual stitched parent triangulation. Used once
 * when activating a child so its first frame reproduces the displayed parent. */
export function tileInterpolationStencil(
  x: number,
  y: number,
  indices: ArrayLike<number>,
  count = indices.length,
): { vertices: [number, number, number]; weights: [number, number, number] } {
  const width = TILE_SEGMENTS + 1;
  for (let i = 0; i < count; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    const ax = a % width;
    const ay = Math.floor(a / width);
    const bx = b % width;
    const by = Math.floor(b / width);
    const cx = c % width;
    const cy = Math.floor(c / width);
    const determinant = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (!determinant) {
      continue;
    }
    const wa = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / determinant;
    const wb = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / determinant;
    const wc = 1 - wa - wb;
    if (Math.min(wa, wb, wc) >= -1e-8) {
      return { vertices: [a, b, c], weights: [wa, wb, wc] };
    }
  }
  throw new Error('Child vertex falls outside its parent tile');
}

export function leafAt(
  leaves: ReadonlyMap<string, RenderTile>,
  u: number,
  v: number,
): RenderTile | undefined {
  if (v < 0 || v >= 1) {
    return;
  }
  u = ((u % 1) + 1) % 1;
  for (let z = 1; z <= 20; z++) {
    const n = 2 ** z;
    const found = leaves.get(`${z}/${Math.floor(u * n)}/${Math.floor(v * n)}`);
    if (found) {
      return found;
    }
  }
}
export function tileNeighbors(tile: RenderTile, leaves: ReadonlyMap<string, RenderTile>) {
  const n = 2 ** tile.z;
  const epsilon = 1 / n / 1024;
  return [
    leafAt(leaves, tile.x / n - epsilon, (tile.y + 0.5) / n),
    leafAt(leaves, (tile.x + 1) / n + epsilon, (tile.y + 0.5) / n),
    leafAt(leaves, (tile.x + 0.5) / n, tile.y / n - epsilon),
    leafAt(leaves, (tile.x + 0.5) / n, (tile.y + 1) / n + epsilon),
  ];
}
/** All edge neighbors, including both fine leaves along a coarse edge. Dyadic
 * bounds compare exactly; longitude wraps and latitude stops at the poles. */
export function tileAdjacentLeaves(tile: RenderTile, leaves: ReadonlyMap<string, RenderTile>) {
  const n = 2 ** tile.z;
  const west = tile.x / n;
  const east = (tile.x + 1) / n;
  const south = tile.y / n;
  const north = (tile.y + 1) / n;
  return [...leaves.values()].filter((other) => {
    if (tileKey(other) === tileKey(tile)) {
      return false;
    }
    const m = 2 ** other.z;
    const w = other.x / m;
    const e = (other.x + 1) / m;
    const s = other.y / m;
    const t = (other.y + 1) / m;
    return (
      ((east % 1 === w % 1 || west % 1 === e % 1) && Math.max(south, s) < Math.min(north, t)) ||
      ((north === s || south === t) && Math.max(west, w) < Math.min(east, e))
    );
  });
}

export function tileEdgeMask(tile: RenderTile, leaves: ReadonlyMap<string, RenderTile>): number {
  return tileNeighbors(tile, leaves).reduce(
    (mask, neighbor, edge) => mask | (neighbor && neighbor.z < tile.z ? 1 << edge : 0),
    0,
  );
}

/** A rotation-independent cap enclosing the visible grid, including raised lines.
 * Rays inside the base globe's apparent limb meet its near surface before any
 * unoccluded elevated point. Outside that limb, the two tangent angles bound
 * every point visible above the base globe, up to the maximum displayed radius. */
export function globeGridFootprint(
  longitude: number,
  latitude: number,
  distance: number,
  verticalFovRadians: number,
  aspect: number,
  zoom: number,
  maximumRadius = 1,
): GlobeGridFootprint {
  const alpha = Math.atan((Math.tan(verticalFovRadians / 2) * Math.hypot(1, aspect)) / zoom);
  const horizon = Math.acos(Math.min(1, 1 / distance));
  const elevatedHorizon = Math.acos(1 / Math.max(1, maximumRadius));
  const radius = Math.min(
    Math.PI,
    (distance * Math.sin(alpha) >= 1
      ? horizon + elevatedHorizon
      : Math.asin(distance * Math.sin(alpha)) - alpha) *
      1.15 +
      1e-6,
  );
  return {
    center: [
      Math.cos(latitude) * Math.cos(longitude),
      Math.sin(latitude),
      Math.cos(latitude) * Math.sin(longitude),
    ],
    radius,
  };
}

/** Longitude bounds accelerate reads; the grid's actual eligibility uses its cap. */
export function globeViewBounds(
  longitude: number,
  latitude: number,
  distance: number,
  verticalFovRadians: number,
  aspect: number,
  zoom: number,
  maximumRadius = 1,
): ViewBounds {
  const { radius } = globeGridFootprint(
    longitude,
    latitude,
    distance,
    verticalFovRadians,
    aspect,
    zoom,
    maximumRadius,
  );
  const south = Math.max(-Math.PI / 2, latitude - radius);
  const north = Math.min(Math.PI / 2, latitude + radius);
  if (south === -Math.PI / 2 || north === Math.PI / 2) {
    return { west: -Math.PI, east: Math.PI, south, north };
  }
  const halfWidth = Math.asin(Math.min(1, Math.sin(radius) / Math.cos(latitude)));
  const wrap = (value: number) => ((value + Math.PI * 3) % (2 * Math.PI)) - Math.PI;
  return { west: wrap(longitude - halfWidth), east: wrap(longitude + halfWidth), south, north };
}
