import assert from 'node:assert/strict';
import test from 'node:test';
import { globeViewBounds } from '../src/render/TileGeometry';
import type { ViewBounds } from '../src/core/view/types';

const fov = (38 * Math.PI) / 180;
const width = (bounds: ViewBounds) =>
  bounds.east >= bounds.west ? bounds.east - bounds.west : 2 * Math.PI + bounds.east - bounds.west;

test('globe overlay bounds shrink with optical zoom at a fixed camera distance', () => {
  const ordinary = globeViewBounds(0, 0, 1.02, fov, 1.5, 1);
  const close = globeViewBounds(0, 0, 1.02, fov, 1.5, 128);
  assert.ok(width(close) < width(ordinary) / 100);
  assert.ok(close.north - close.south < (ordinary.north - ordinary.south) / 100);
  assert.ok(close.west < 0 && close.east > 0 && close.south < 0 && close.north > 0);
});

test('globe overlay bounds wrap the dateline and include whole longitude rings at poles', () => {
  const seam = globeViewBounds(Math.PI - 1e-6, 0.2, 1.02, fov, 1.5, 128);
  assert.ok(seam.west > seam.east);
  for (const sign of [-1, 1]) {
    const polar = globeViewBounds(0.7, sign * (Math.PI / 2 - 1e-6), 1.02, fov, 1.5, 128);
    assert.equal(polar.west, -Math.PI);
    assert.equal(polar.east, Math.PI);
    assert.equal(sign > 0 ? polar.north : polar.south, (sign * Math.PI) / 2);
  }
});

test('the paged overlay footprint contains sphere intersections throughout the camera frustum', () => {
  for (const longitude of [0.4, Math.PI - 0.01]) {
    for (const latitude of [-1.5, 0, 1.2]) {
      const radial = [
        Math.cos(latitude) * Math.cos(longitude),
        Math.sin(latitude),
        Math.cos(latitude) * Math.sin(longitude),
      ];
      const east = [-Math.sin(longitude), 0, Math.cos(longitude)];
      const north = [
        -Math.sin(latitude) * Math.cos(longitude),
        Math.cos(latitude),
        -Math.sin(latitude) * Math.sin(longitude),
      ];
      for (const distance of [1.02, 1.5, 3]) {
        for (const zoom of [1, 16, 128]) {
          const bounds = globeViewBounds(longitude, latitude, distance, fov, 1.5, zoom);
          for (const screenX of [-1, -0.5, 0, 0.5, 1]) {
            for (const screenY of [-1, -0.5, 0, 0.5, 1]) {
              const x = (screenX * Math.tan(fov / 2) * 1.5) / zoom;
              const y = (screenY * Math.tan(fov / 2)) / zoom;
              const vector = radial.map((value, axis) => -value + x * east[axis] + y * north[axis]);
              const length = Math.hypot(...vector);
              const direction = vector.map((value) => value / length);
              const dot = direction.reduce(
                (value, component, axis) => value + component * radial[axis] * distance,
                0,
              );
              const discriminant = dot ** 2 - distance ** 2 + 1;
              if (discriminant < 0) {
                continue;
              }
              const t = -dot - Math.sqrt(discriminant);
              const hit = radial.map((value, axis) => value * distance + direction[axis] * t);
              const lon = Math.atan2(hit[2], hit[0]);
              const lat = Math.atan2(hit[1], Math.hypot(hit[0], hit[2]));
              assert.ok(lat >= bounds.south - 1e-12 && lat <= bounds.north + 1e-12);
              assert.ok(
                bounds.west <= bounds.east
                  ? lon >= bounds.west - 1e-12 && lon <= bounds.east + 1e-12
                  : lon >= bounds.west - 1e-12 || lon <= bounds.east + 1e-12,
              );
            }
          }
        }
      }
    }
  }
});
