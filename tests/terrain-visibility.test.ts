import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { buildGrid } from '../src/core/grid/build';
import { DEFAULT_CONFIG } from '../src/core/model';
import { generateWorld } from '../src/core/pipeline';
import { PhysicalMeshReader } from '../src/core/view/physical-mesh';
import { prepareWorldView } from '../src/core/view/prepare';
import type { PageValues } from '../src/core/view/spatial-index';
import { fixedSurfaceGeometry } from '../src/render/FixedSurface';
import { TerrainVisibility, terrainBoundOccluded } from '../src/render/TerrainVisibility';

const globe = { projection: 'globe' as const, complete: true, inwardDisplacement: 0 };

function cameraAt(x = 0, y = 0, z = 3) {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.0001, 100);
  camera.position.set(x, y, z);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

function surface(points: number[]) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  geometry.setIndex(Array.from({ length: points.length / 3 }, (_, index) => index));
  geometry.computeBoundingSphere();
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
}

function planet(level = 2, relief = false) {
  const grid = buildGrid(level, 'terrain-horizon', 0.25);
  const surfaces: ReturnType<typeof surface>[] = [];
  for (let face = 0; face < grid.triangles.length; face += 3) {
    const points: number[] = [];
    for (let corner = 0; corner < 3; corner++) {
      const id = grid.triangles[face + corner];
      const direction = new THREE.Vector3().fromArray(grid.positions, id * 3);
      const height = relief ? 0.6 * Math.max(0, direction.x) ** 8 : 0;
      points.push(...direction.multiplyScalar(1 + height).toArray());
    }
    surfaces.push(surface(points));
  }
  const visibility = new TerrainVisibility();
  for (const mesh of surfaces) {
    visibility.register(mesh);
  }
  return { visibility, surfaces };
}

function rayHitsSphereBefore(camera: THREE.Vector3, point: THREE.Vector3, radius: number) {
  const direction = point.clone().sub(camera);
  const distance = direction.length();
  direction.divideScalar(distance);
  const b = camera.dot(direction);
  const discriminant = b * b - (camera.lengthSq() - radius * radius);
  if (discriminant < 0) {
    return false;
  }
  const near = -b - Math.sqrt(discriminant);
  return near > 0 && near < distance;
}

test('terrain occluder follows coarse displayed facets, never the nominal unit sphere', () => {
  const visibility = new TerrainVisibility();
  const octahedron = new THREE.OctahedronGeometry(1, 0);
  const positions = octahedron.getAttribute('position');
  for (let i = 0; i < positions.count; i += 3) {
    const values = Array.from({ length: 3 }, (_, corner) =>
      new THREE.Vector3().fromBufferAttribute(positions, i + corner).toArray(),
    ).flat();
    visibility.register(surface(values));
  }
  const result = visibility.update(cameraAt(0, 0, 2), globe);
  assert.equal(result.enabled, true);
  assert.ok(Math.abs(result.inscribedRadius - 1 / Math.sqrt(3)) < 1e-7);
  assert.ok(result.occluderRadius < result.inscribedRadius);
  const visibleFacetPoint = new THREE.Sphere(new THREE.Vector3(0.7, 0, 0.3), 1e-5);
  const camera = new THREE.Vector3(0, 0, 2);
  assert.equal(terrainBoundOccluded(visibleFacetPoint, camera, 1), true);
  assert.equal(terrainBoundOccluded(visibleFacetPoint, camera, result.occluderRadius), false);
});

test('only a complete valid opaque globe enables culling, and every guard restores visibility', () => {
  const { visibility, surfaces } = planet(1);
  const camera = cameraAt();
  const assertDisabled = (options: typeof globe, reason: string) => {
    const result = visibility.update(camera, options);
    assert.equal(result.enabled, false);
    assert.equal(result.reason, reason);
    assert.equal(result.culledBatches, 0);
    assert.ok(surfaces.every((mesh) => visibility.isVisible(mesh)));
  };
  assertDisabled({ ...globe, complete: false }, 'incomplete');
  const active = visibility.update(camera, globe);
  assert.ok(active.culledBatches > 0);
  const map = visibility.update(camera, { ...globe, projection: 'map' });
  assert.equal(map.reason, 'map');
  assert.equal(map.culledBatches, 0);
  surfaces[0].material.transparent = true;
  assertDisabled(globe, 'non-opaque');
  surfaces[0].material.transparent = false;
  const group = new THREE.Group();
  group.add(...surfaces);
  group.position.x = 0.001;
  assertDisabled(globe, 'transformed');
  group.position.x = 0;
  assertDisabled({ ...globe, inwardDisplacement: NaN }, 'invalid-displacement');
  assertDisabled({ ...globe, inwardDisplacement: -0.1 }, 'invalid-displacement');
  assertDisabled({ ...globe, inwardDisplacement: 2 }, 'invalid-displacement');
  camera.position.set(0, 0, 0.1);
  assertDisabled(globe, 'invalid-camera');
  camera.position.set(0, 0, 3);
  surfaces[0].geometry.setDrawRange(3, 0);
  assertDisabled(globe, 'changed-geometry');
  surfaces[0].geometry.setDrawRange(0, Infinity);
  surfaces[0].geometry.getAttribute('position').needsUpdate = true;
  assertDisabled(globe, 'changed-geometry');

  const broken = planet(1);
  broken.visibility.register(surface([0, 0, 1, 0, 0, 1, 0, 0, 1]));
  assert.equal(broken.visibility.update(cameraAt(), globe).reason, 'invalid-geometry');
  const reverse = planet(1);
  reverse.visibility.register(surface([1, 0, 0, 0, 0, 1, 0, 1, 0]));
  assert.equal(reverse.visibility.update(cameraAt(), globe).reason, 'invalid-geometry');
});

test('raised terrain and tangent bounds survive while every culled sphere passes an independent ray oracle', () => {
  const camera = new THREE.Vector3(0, 0, 3);
  // Within the cone but ahead of its near surface: must remain visible.
  assert.equal(
    terrainBoundOccluded(new THREE.Sphere(new THREE.Vector3(0, 0, 2), 0.05), camera, 1),
    false,
  );
  // A raised summit extends beyond the otherwise occluded far-side silhouette.
  assert.equal(
    terrainBoundOccluded(new THREE.Sphere(new THREE.Vector3(1.5, 0, -0.1), 0.1), camera, 1),
    false,
  );
  // Broad batches straddling both hemispheres cannot be rejected.
  assert.equal(terrainBoundOccluded(new THREE.Sphere(new THREE.Vector3(), 1.1), camera, 1), false);
  assert.equal(
    terrainBoundOccluded(new THREE.Sphere(new THREE.Vector3(0, 0, -1), 0.1), camera, 1),
    true,
  );
  let rejected = 0;
  for (let i = 0; i < 500; i++) {
    const longitude = i * 2.399963229728653;
    const latitude = Math.asin(2 * (((i * 37) % 499) / 499) - 1);
    const height = 1 + (i % 9) / 18;
    const bound = new THREE.Sphere(
      new THREE.Vector3(
        Math.cos(latitude) * Math.cos(longitude),
        Math.sin(latitude),
        Math.cos(latitude) * Math.sin(longitude),
      ).multiplyScalar(height),
      0.005 + (i % 13) / 75,
    );
    if (!terrainBoundOccluded(bound, camera, 0.96)) {
      continue;
    }
    rejected++;
    for (let sample = 0; sample < 80; sample++) {
      const y = 1 - 2 * ((sample + 0.5) / 80);
      const angle = sample * 2.399963229728653;
      const point = new THREE.Vector3(
        Math.sqrt(1 - y * y) * Math.cos(angle),
        y,
        Math.sqrt(1 - y * y) * Math.sin(angle),
      )
        .multiplyScalar(bound.radius)
        .add(bound.center);
      assert.ok(rayHitsSphereBefore(camera, point, 0.96));
    }
  }
  assert.ok(rejected > 60);
});

test('all hidden relief triangles are behind the proven sphere across orbit, close zoom and zoom deformation', () => {
  const { visibility, surfaces } = planet(2, true);
  const camera = cameraAt();
  let rejected = 0;
  for (let view = 0; view < 24; view++) {
    const distance = view % 3 === 0 ? 1.03 : view % 3 === 1 ? 3 : 40;
    camera.position
      .set(Math.cos(view) * 0.8, Math.sin(view * 0.7) * 0.5, Math.sin(view) * 0.8)
      .normalize()
      .multiplyScalar(distance);
    const allowance = view % 2 ? 0.08 : 0;
    const stats = visibility.update(camera, { ...globe, inwardDisplacement: allowance });
    assert.equal(stats.enabled, true);
    assert.ok(
      Math.abs(stats.inscribedRadius - stats.occluderRadius - allowance - 2e-6 * 1.6) < 2e-7,
    );
    assert.equal(stats.visibleTriangles + stats.culledTriangles, surfaces.length);
    for (const mesh of surfaces) {
      if (visibility.isVisible(mesh)) {
        continue;
      }
      rejected++;
      const positions = mesh.geometry.getAttribute('position');
      const a = new THREE.Vector3().fromBufferAttribute(positions, 0);
      const b = new THREE.Vector3().fromBufferAttribute(positions, 1);
      const c = new THREE.Vector3().fromBufferAttribute(positions, 2);
      for (let i = 0; i <= 4; i++) {
        for (let j = 0; j <= 4 - i; j++) {
          const point = a
            .clone()
            .multiplyScalar(i / 4)
            .addScaledVector(b, j / 4)
            .addScaledVector(c, 1 - (i + j) / 4);
          assert.ok(rayHitsSphereBefore(camera.position, point, stats.occluderRadius));
        }
      }
    }
  }
  assert.ok(rejected > 500);
});

test('camera updates preserve buffers, visibility ownership and draw order without rescanning positions', () => {
  const { visibility, surfaces } = planet(1);
  const group = new THREE.Group();
  group.add(...surfaces);
  const camera = cameraAt();
  visibility.update(camera, globe);
  const originalOrder = [...group.children];
  const first = surfaces[0];
  first.visible = false; // A zoom mask owns this flag, not horizon metadata.
  const positions = first.geometry.getAttribute('position');
  const bytes = positions.array.slice();
  const oldGetX = positions.getX;
  positions.getX = () => {
    throw new Error('camera update rescanned positions');
  };
  for (let i = 0; i < 16; i++) {
    camera.position.set(Math.cos(i) * 3, Math.sin(i), Math.sin(i) * 3);
    const stats = visibility.update(camera, globe);
    assert.equal(stats.enabled, true);
  }
  positions.getX = oldGetX;
  assert.equal(first.visible, false);
  assert.deepEqual(group.children, originalOrder);
  assert.deepEqual(positions.array, bytes);
  assert.equal(visibility.register(first), false);
  const newSurface = surface([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.equal(visibility.isVisible(newSurface), true);
  visibility.register(newSurface);
  assert.ok(
    surfaces.every((mesh) => visibility.isVisible(mesh)),
    'new batches invalidate old proof before the next draw',
  );
  visibility.clear();
  assert.equal(visibility.update(camera, globe).registeredBatches, 0);
  assert.equal(visibility.isVisible(first), true);
});

test('actual adaptive primal and categorical packets produce a complete usable occluder', async () => {
  const world = generateWorld({
    ...DEFAULT_CONFIG,
    seed: 'adaptive-visibility-packets',
    surfaceLevel: 3,
    processLevel: 3,
    refinementMinSpacing: 600000,
    refinementStrength: 0.5,
    tectonicDuration: 0,
    fluvialDuration: 0,
    erosion: 0,
    landscapeBatches: 1,
  });
  assert.ok(world.grid.count > world.process.count);
  const { sidecars } = prepareWorldView(world);
  const root = { world, sidecars };
  const read = (path: string): unknown =>
    path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], root);
  const pages: PageValues = {
    async readValue(path) {
      return structuredClone(read(path));
    },
    async readRange(path, start, count) {
      const values = read(path) as ArrayLike<number>;
      return Float64Array.from({ length: count }, (_, i) => values[start + i]);
    },
    async readValues(path, ids) {
      const values = read(path) as ArrayLike<number>;
      return Float64Array.from(ids, (id) => values[id]);
    },
  };
  const reader = new PhysicalMeshReader(pages, sidecars.view.summary);
  for (const layer of ['world', 'biomes'] as const) {
    const manifest = await reader.manifest(layer, -1);
    assert.equal(manifest.mode, layer === 'world' ? 'primal' : 'dual');
    const visibility = new TerrainVisibility();
    let preparedTriangles = 0;
    for (let batch = 0; batch < manifest.batches; batch++) {
      const packet = await reader.batch(layer, -1, batch);
      preparedTriangles += packet.indices.length / 3;
      const geometry = fixedSurfaceGeometry(packet, world.config.radius, {
        projection: 'globe',
        mapStyle: 'natural',
        relief: 26,
        coastlines: false,
      });
      visibility.register(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
    }
    const result = visibility.update(cameraAt(), globe);
    assert.equal(result.reason, 'ready', `${layer}: ${result.reason}`);
    assert.ok(
      result.inscribedRadius > 0.9 && result.inscribedRadius < 1.1,
      `${layer}: radius ${result.inscribedRadius}`,
    );
    assert.equal(result.visibleTriangles + result.culledTriangles, preparedTriangles);
  }
});
