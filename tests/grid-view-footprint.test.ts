import assert from 'node:assert/strict';
import test from 'node:test';
import { PerspectiveCamera, Raycaster, Vector2, Vector3 } from 'three';
import { globeGridFootprint } from '../src/render/TileGeometry';

const fov = (38 * Math.PI) / 180;

test('grid cap size is invariant under globe rotation, including pole-crossing views', () => {
  const equatorial = globeGridFootprint(0.7, 0, 2.5, fov, 1.5, 2, 1.04);
  for (const latitude of [-1.4, -1, 0.5, 1, 1.4]) {
    for (const longitude of [0.7, Math.PI - 0.01, -Math.PI + 0.01]) {
      const cap = globeGridFootprint(longitude, latitude, 2.5, fov, 1.5, 2, 1.04);
      assert.equal(cap.radius, equatorial.radius);
      assert.ok(Math.abs(Math.hypot(...cap.center) - 1) < 1e-14);
    }
  }
});

test('raised grid beyond the base horizon is included when visible in the camera frustum', () => {
  const radius = 1.12;
  const camera = new Vector3(3, 0, 0);
  const point = new Vector3(0, 0, radius);
  const ray = point.clone().sub(camera);
  const closest = camera.clone().addScaledVector(ray, -camera.dot(ray) / ray.lengthSq());
  assert.ok(closest.length() > 1, 'the entire segment clears the base sphere');
  assert.ok(Math.atan(radius / camera.x) < Math.atan(Math.tan(fov / 2) * 1.5));
  assert.ok(point.clone().normalize().dot(camera.clone().sub(point)) < 0);
  const ordinary = globeGridFootprint(0, 0, 3, fov, 1.5, 1);
  const raised = globeGridFootprint(0, 0, 3, fov, 1.5, 1, radius);
  assert.ok(ordinary.radius < Math.PI / 2, 'the base-only cap would omit this grid point');
  assert.ok(raised.radius > Math.PI / 2);
});

test('the cap encloses unoccluded raised sphere intersections across the camera viewport', () => {
  let checked = 0;
  let beyondBaseHorizon = 0;
  for (const [longitude, latitude] of [
    [0.7, 0],
    [3.13, 1],
    [-3.13, -1.4],
  ]) {
    const axis = new Vector3(
      Math.cos(latitude) * Math.cos(longitude),
      Math.sin(latitude),
      Math.cos(latitude) * Math.sin(longitude),
    );
    for (const [distance, maximumRadius] of [
      [1.05, 1.04],
      [1.3, 1.12],
      [3, 1.12],
    ]) {
      for (const zoom of [1, 2, 16]) {
        const camera = new PerspectiveCamera(38, 1.5, 0.00001, 100);
        camera.position.copy(axis).multiplyScalar(distance);
        camera.zoom = zoom;
        camera.lookAt(0, 0, 0);
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();
        const cap = globeGridFootprint(
          longitude,
          latitude,
          distance,
          fov,
          1.5,
          zoom,
          maximumRadius,
        );
        const raycaster = new Raycaster();
        for (let y = -16; y <= 16; y++) {
          for (let x = -16; x <= 16; x++) {
            raycaster.setFromCamera(new Vector2(x / 16, y / 16), camera);
            const { origin, direction } = raycaster.ray;
            const b = origin.dot(direction);
            const baseDiscriminant = b * b - origin.lengthSq() + 1;
            const baseEntry = baseDiscriminant >= 0 ? -b - Math.sqrt(baseDiscriminant) : Infinity;
            for (const radius of [1, (1 + maximumRadius) / 2, maximumRadius]) {
              const discriminant = b * b - origin.lengthSq() + radius * radius;
              if (discriminant < 0) {
                continue;
              }
              for (const length of [-b - Math.sqrt(discriminant), -b + Math.sqrt(discriminant)]) {
                if (length < 0 || baseEntry < length - 1e-8) {
                  continue;
                }
                const point = raycaster.ray.at(length, new Vector3());
                const angle = Math.acos(Math.min(1, Math.max(-1, point.normalize().dot(axis))));
                assert.ok(
                  angle <= cap.radius + 1e-9,
                  `visible angle ${angle} exceeds ${cap.radius}`,
                );
                if (angle > Math.acos(1 / distance)) {
                  beyondBaseHorizon++;
                }
                checked++;
              }
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 10000);
  assert.ok(beyondBaseHorizon > 100, 'exercise raised points beyond the ordinary globe limb');
});
