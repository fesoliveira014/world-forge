import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { buildGrid } from '../src/core/grid/build';
import { createRegionSpacing, refineGrid } from '../src/core/grid/refine';
import {
  FIXED_GRID_EDGES_PER_BATCH,
  FIXED_GRID_TEXTURE_WIDTH,
  type FixedGridPacket,
} from '../src/core/view/fixed-grid-types';
import { FixedGrid } from '../src/render/FixedGrid';
import { MAP_HEIGHT_SHEAR } from '../src/render/projection';

const radius = 1e6;
const appearance = { projection: 'globe' as const, relief: 20, mapStyle: 'relief' as const };
const radians = (degrees: number) => (degrees * Math.PI) / 180;
function direction(longitude: number, latitude: number) {
  return new THREE.Vector3(
    Math.cos(latitude) * Math.cos(longitude),
    Math.sin(latitude),
    Math.cos(latitude) * Math.sin(longitude),
  );
}
function packet(
  points: THREE.Vector3[],
  heights = points.map(() => 0),
  batch = 0,
  indices?: number[],
): FixedGridPacket {
  const width = Math.min(FIXED_GRID_TEXTURE_WIDTH, points.length);
  const count = Math.ceil(points.length / width) * width;
  const vertices = new Float32Array(count * 4);
  const landCoverage = new Uint8Array(count);
  for (let i = 0; i < points.length; i++) {
    vertices.set(points[i].toArray(), i * 4);
    vertices[i * 4 + 3] = heights[i];
    landCoverage[i] = heights[i] > 0 ? 255 : 0;
  }
  const rawIndices = Uint16Array.from(indices ?? points.map((_, index) => index));
  const edgeCount = rawIndices.length / 2;
  const edgeWidth = Math.min(FIXED_GRID_TEXTURE_WIDTH, edgeCount);
  const edgeIndices = new Uint16Array(Math.ceil(edgeCount / edgeWidth) * edgeWidth * 2);
  edgeIndices.set(rawIndices);
  const result = {
    edgeCount,
    batch,
    firstEdge: 0,
    vertexCount: points.length,
    vertices,
    landCoverage,
    indices: edgeIndices,
    bytes: 0,
  };
  result.bytes =
    result.vertices.byteLength + result.landCoverage.byteLength + result.indices.byteLength;
  return result;
}
function lines(grid: FixedGrid) {
  return grid.children as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[];
}
function corners(geometry: THREE.BufferGeometry) {
  return new THREE.BufferAttribute(geometry.userData.cornerTexture.image.data as Float32Array, 4);
}
function edgeIndices(geometry: THREE.BufferGeometry) {
  const attribute = new THREE.BufferAttribute(geometry.userData.edgeTexture.image.data, 1);
  Object.defineProperty(attribute, 'count', { value: geometry.userData.edgeCount * 2 });
  return attribute;
}
const sharedBytes = 12 + FIXED_GRID_EDGES_PER_BATCH * 12 * 2;

function cameraAt(position: THREE.Vector3, zoom = 1) {
  const camera = new THREE.PerspectiveCamera(70, 1.4, 0.000001, 100);
  camera.position.copy(position);
  camera.zoom = zoom;
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return camera;
}

test('globe grid shares every canonical array, retains all refined edges, and never rebuilds on camera/toggle', () => {
  const seed = buildGrid(2, 'persistent-refined-grid', 0.6);
  const refined = refineGrid(
    seed,
    radius,
    'persistent-refined-grid/detail',
    createRegionSpacing(radius, 400000, [
      { center: [1, 0, 0], radiusMetres: 180000, targetSpacingMetres: 45000 },
    ]),
  );
  assert.ok(refined.count > seed.count);
  const input = packet(
    Array.from({ length: refined.corners.length / 3 }, (_, id) =>
      new THREE.Vector3().fromArray(refined.corners, id * 3),
    ),
    undefined,
    0,
    Array.from(refined.edgeCorners),
  );
  const before = structuredClone(input);
  const grid = new FixedGrid(radius, appearance);
  assert.equal(grid.addBatch(input), true);
  assert.equal(grid.addBatch(input), false);
  const line = lines(grid)[0];
  const geometry = line.geometry;
  assert.equal(corners(geometry).array, input.vertices);
  assert.equal(edgeIndices(geometry).array, input.indices);
  assert.equal(grid.segments, refined.edgeCorners.length / 2);
  assert.equal(grid.renderSegments, grid.segments);
  assert.equal(grid.sourceBytes, input.bytes);
  assert.equal(grid.additionalCpuBytes, sharedBytes);
  assert.equal(grid.gpuBytes, input.bytes + sharedBytes);
  assert.equal(grid.retainedBytes, input.bytes * 2 + sharedBytes * 2);
  const attributes = Object.values(geometry.attributes);
  const index = geometry.index;
  for (let view = 0; view < 32; view++) {
    grid.visible = view % 4 !== 0;
    const camera = cameraAt(
      direction(view / 5, Math.sin(view) * 1.4).multiplyScalar(view % 2 ? 1.02 : 30),
      view % 3 ? 1 : 16,
    );
    const visibility = grid.updateVisibility(camera);
    if (!grid.visible) {
      assert.equal(visibility.drawCalls, 0);
    }
    assert.equal(lines(grid)[0].geometry, geometry);
    assert.equal(geometry.index, index);
    assert.deepEqual(Object.values(geometry.attributes), attributes);
  }
  grid.visible = true;
  assert.equal(
    grid.updateVisibility(cameraAt(new THREE.Vector3(30, 0, 0))).drawCalls,
    1,
    'overview has no zoom-out cutoff',
  );
  assert.deepEqual(input, before);
  grid.dispose();
});

test('one shared material and each owned GPU geometry are disposed once without consuming source packets', () => {
  const first = packet([direction(-0.03, 0), direction(0.03, 0)], [0, 1000], 0);
  const second = packet([direction(0.1, 0.1), direction(0.13, 0.1)], [2000, 3000], 1);
  const before = [structuredClone(first), structuredClone(second)];
  const grid = new FixedGrid(radius, appearance);
  grid.addBatch(first);
  grid.addBatch(second);
  assert.equal(grid.batches, 2);
  const geometries = lines(grid).map((line) => line.geometry);
  for (const line of lines(grid)) {
    assert.equal(line.material, grid.material);
  }
  let materialsDisposed = 0;
  let geometriesDisposed = 0;
  grid.material.addEventListener('dispose', () => materialsDisposed++);
  for (const geometry of geometries) {
    geometry.addEventListener('dispose', () => geometriesDisposed++);
  }
  grid.dispose();
  grid.dispose();
  assert.equal(materialsDisposed, 1);
  assert.equal(geometriesDisposed, 2);
  assert.equal(grid.retainedBytes, 0);
  assert.equal(grid.children.length, 0);
  assert.equal(grid.addBatch(first), false);
  assert.deepEqual([first, second], before);
  const rebuilt = new FixedGrid(radius, { ...appearance, projection: 'map' });
  assert.equal(rebuilt.addBatch(first), true, 'same retained asset supports a projection rebuild');
  rebuilt.dispose();
});

test('indexed map geometry adds only necessary seam/pole pieces and accounts for distinct arrays', () => {
  const ordinary = packet(
    [direction(0.1, 0.2), direction(0.2, 0.3), direction(0.3, 0.2)],
    [100, 200, 300],
    0,
    [0, 1, 1, 2],
  );
  const original = structuredClone(ordinary);
  const grid = new FixedGrid(radius, { ...appearance, projection: 'map' });
  grid.addBatch(ordinary);
  const geometry = lines(grid)[0].geometry;
  assert.equal(edgeIndices(geometry).array, ordinary.indices);
  assert.equal(corners(geometry).count, ordinary.vertexCount);
  const positionBytes = ordinary.vertexCount * 16;
  assert.equal(grid.sourceBytes, ordinary.bytes);
  assert.equal(grid.additionalCpuBytes, positionBytes + sharedBytes);
  assert.equal(
    grid.gpuBytes,
    positionBytes + ordinary.landCoverage.byteLength + ordinary.indices.byteLength + sharedBytes,
  );
  assert.equal(
    grid.retainedBytes,
    ordinary.bytes +
      positionBytes * 2 +
      ordinary.landCoverage.byteLength +
      ordinary.indices.byteLength +
      sharedBytes * 2,
  );
  assert.deepEqual(ordinary, original);
  grid.dispose();

  for (const sign of [1, -1]) {
    const cases = [
      packet(
        [direction(radians(170), radians(sign * 20)), direction(radians(-170), radians(sign * 40))],
        [100, 300],
      ),
      packet([direction(-1.2, radians(sign * 80)), new THREE.Vector3(0, sign, 0)], [0, 0]),
      packet(
        [direction(radians(15), radians(sign * 70)), direction(radians(-165), radians(sign * 80))],
        [0, 0],
      ),
    ];
    for (let scenario = 0; scenario < cases.length; scenario++) {
      const input = cases[scenario];
      const map = new FixedGrid(radius, { ...appearance, projection: 'map' });
      map.addBatch(input);
      const output = lines(map)[0].geometry;
      const positions = corners(output);
      const index = edgeIndices(output);
      assert.ok(Array.from(positions.array).every(Number.isFinite));
      assert.ok(Number.isFinite(output.boundingSphere!.radius));
      assert.equal(map.segments, 1);
      assert.equal(map.renderSegments, scenario === 1 ? 1 : 2);
      for (let edge = 0; edge < index.count; edge += 2) {
        const a = index.getX(edge);
        const b = index.getX(edge + 1);
        assert.ok(
          Math.abs(positions.getX(a) - positions.getX(b)) < Math.PI,
          'no spurious map-width line',
        );
        if (scenario > 0) {
          assert.ok(
            Math.abs(positions.getX(a) - positions.getX(b)) < 1e-6,
            'polar edges keep their own meridians',
          );
        }
      }
      if (scenario === 0) {
        const a = index.getX(1);
        const b = index.getX(2);
        assert.ok(Math.abs(positions.getX(a) + positions.getX(b)) < 1e-6);
        assert.equal(positions.getY(a), positions.getY(b));
        assert.equal(positions.getZ(a), positions.getZ(b));
      }
      map.dispose();
    }
  }
});

test('signed-zero dateline edges remain finite on both borders and raised pole clipping uses geographic latitude', () => {
  const seam = packet(
    [new THREE.Vector3(-1, 0.1, 0).normalize(), new THREE.Vector3(-1, 0.2, -0).normalize()],
    [1200, 1800],
  );
  const map = new FixedGrid(radius, { ...appearance, projection: 'map' });
  map.addBatch(seam);
  const geometry = lines(map)[0].geometry;
  const positions = corners(geometry);
  assert.equal(map.renderSegments, 2);
  assert.ok(Array.from(positions.array).every(Number.isFinite));
  for (let edge = 0; edge < edgeIndices(geometry).count; edge += 2) {
    const first = edgeIndices(geometry).getX(edge);
    const second = edgeIndices(geometry).getX(edge + 1);
    assert.equal(positions.getX(first), positions.getX(second));
    assert.ok(Math.abs(Math.abs(positions.getX(first)) - Math.PI) < 1e-6);
    assert.notEqual(positions.getY(first), positions.getY(second));
  }
  map.dispose();

  const polar = packet([direction(0.2, radians(89.9)), new THREE.Vector3(0, 1, 0)], [3000, 3000]);
  const raised = new FixedGrid(radius, { ...appearance, projection: 'map' });
  raised.addBatch(polar);
  const points = corners(lines(raised)[0].geometry);
  assert.ok(points.getY(0) > Math.PI / 2, 'fixture extends above the displayed north-pole line');
  const latitude = points.getY(0) - (points.getZ(0) - 0.00003) * MAP_HEIGHT_SHEAR;
  assert.ok(latitude < Math.PI / 2);
  assert.match(raised.material.fragmentShader, /abs\(point\.y - \(point\.z - 0\.00003\) \* 0\.8\)/);
  raised.dispose();
});

test('whole-batch horizon culling keeps raised limbs and rejects only complete far-side batches', () => {
  const grid = new FixedGrid(radius, appearance);
  grid.addBatch(packet([direction(-0.01, 0), direction(0.01, 0)], undefined, 0));
  grid.addBatch(
    packet([direction(Math.PI - 0.01, 0), direction(-Math.PI + 0.01, 0)], undefined, 1),
  );
  grid.addBatch(
    packet([direction(Math.PI / 2 - 0.01, 0), direction(Math.PI / 2 + 0.01, 0)], [6000, 6000], 2),
  );
  const stats = grid.updateVisibility(cameraAt(new THREE.Vector3(3, 0, 0)));
  assert.equal(lines(grid)[0].visible, true);
  assert.equal(lines(grid)[1].visible, false);
  assert.equal(
    lines(grid)[2].visible,
    true,
    'raised points beyond the ordinary surface horizon can clear the globe',
  );
  assert.equal(stats.visibleBatches, 2);
  assert.equal(stats.culledBatches, 1);
  const lifted = lines(grid)[2].geometry;
  for (let vertex = 0; vertex < 2; vertex++) {
    const point = new THREE.Vector3()
      .fromBufferAttribute(corners(lifted), vertex)
      .multiplyScalar(1.120018);
    assert.ok(
      lifted.boundingBox!.containsPoint(point),
      'bounds contain the shader-raised geometry',
    );
  }
  grid.dispose();
});

/** Independent point visibility: solve camera-to-point ray/sphere intersection,
 * and clip the actual chord position using homogeneous camera coordinates.
 */
function visibleSample(point: THREE.Vector3, camera: THREE.PerspectiveCamera) {
  const clip = new THREE.Vector4(point.x, point.y, point.z, 1)
    .applyMatrix4(camera.matrixWorldInverse)
    .applyMatrix4(camera.projectionMatrix);
  if (clip.w <= 0 || Math.max(Math.abs(clip.x), Math.abs(clip.y), Math.abs(clip.z)) > clip.w) {
    return false;
  }
  const raised = point.clone().normalize().multiplyScalar(Math.max(1, point.length()));
  const ray = raised.sub(camera.position);
  const length = ray.length();
  ray.multiplyScalar(1 / length);
  const b = camera.position.dot(ray);
  const discriminant = b * b - camera.position.lengthSq() + 1;
  if (discriminant <= 0) {
    return true;
  }
  const first = -b - Math.sqrt(discriminant);
  return first < 0 || first >= length - 2e-7;
}

test('conservative cap/frustum culling never removes an independently visible chord sample', () => {
  const grid = new FixedGrid(radius, appearance);
  const packets: FixedGridPacket[] = [];
  for (let batch = 0; batch < 24; batch++) {
    const longitude = batch * 2.399963229728653;
    const latitude = Math.asin(-0.92 + (batch / 23) * 1.84);
    const span = batch % 4 === 0 ? 2.5 : 0.15;
    const points = [
      direction(longitude - span, latitude),
      direction(longitude + span, latitude),
      direction(longitude, Math.max(-1.5, latitude - 0.2)),
      direction(longitude + span / 2, Math.min(1.5, latitude + 0.2)),
    ];
    const input = packet(
      points,
      points.map((_, vertex) => ((batch + vertex) % 3 === 0 ? 10000 : 0)),
      batch,
    );
    packets.push(input);
    grid.addBatch(input);
  }
  let checked = 0;
  let culls = 0;
  for (const distance of [1.02, 1.3, 3, 12]) {
    for (let view = 0; view < 12; view++) {
      const camera = cameraAt(
        direction(view * 0.7, Math.sin(view) * 1.4).multiplyScalar(distance),
        view % 3 === 0 ? 8 : 1,
      );
      culls += grid.updateVisibility(camera).culledBatches;
      for (let batch = 0; batch < packets.length; batch++) {
        const input = packets[batch];
        for (let edge = 0; edge < input.edgeCount * 2; edge += 2) {
          const endpoints = [0, 1].map((slot) => {
            const vertex = input.indices[edge + slot];
            return new THREE.Vector3()
              .fromArray(input.vertices, vertex * 4)
              .multiplyScalar(
                1 + (input.vertices[vertex * 4 + 3] / radius) * appearance.relief + 0.000018,
              );
          });
          for (let step = 0; step <= 32; step++) {
            if (visibleSample(endpoints[0].clone().lerp(endpoints[1], step / 32), camera)) {
              checked++;
              assert.equal(
                lines(grid)[batch].visible,
                true,
                `visible edge ${edge / 2} in batch ${batch} was removed`,
              );
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 1000, 'oracle exercises actual visible chord interiors');
  assert.ok(culls > 100, 'test also exercises rejected batches');
  grid.dispose();
});

test('land strokes use shared corner and edge textures with one ordinary triangle draw and screen-pixel widths', () => {
  for (const projection of ['map', 'globe'] as const) {
    const input = packet([direction(0.1, 0.2), direction(0.15, 0.25)], [500, 500]);
    input.landCoverage.set([255, 0]);
    const grid = new FixedGrid(radius, { ...appearance, projection });
    grid.addBatch(input);
    grid.addBatch({ ...input, batch: 1 });
    const [first, second] = lines(grid);
    assert.equal(first.geometry.userData.landTexture.image.data, input.landCoverage);
    assert.equal(first.geometry.getAttribute('position'), second.geometry.getAttribute('position'));
    assert.equal(first.geometry.index, second.geometry.index);
    assert.equal(first.geometry.drawRange.count, input.edgeCount * 6);
    assert.equal(edgeIndices(first.geometry).array, input.indices);
    assert.equal(grid.material.uniforms.opacity.value, 0.13, 'water opacity remains unchanged');
    assert.ok(grid.material.uniforms.landOpacity.value > grid.material.uniforms.opacity.value);
    assert.ok(grid.material.uniforms.landWidth.value > grid.material.uniforms.waterWidth.value);
    const land = grid.material.uniforms.landInk.value as THREE.Color;
    const water = grid.material.uniforms.ink.value as THREE.Color;
    assert.ok(land.r + land.g + land.b < water.r + water.g + water.b);
    const camera = cameraAt(new THREE.Vector3(3, 0, 0));
    for (const [width, height] of [
      [1920, 1080],
      [800, 600],
    ]) {
      const renderer = {
        getCurrentViewport(target: THREE.Vector4) {
          target.set(0, 0, width, height);
        },
      };
      first.onBeforeRender(
        renderer as THREE.WebGLRenderer,
        new THREE.Scene(),
        camera,
        first.geometry,
        grid.material,
        null as never,
      );
      assert.deepEqual(grid.material.uniforms.viewportSize.value.toArray(), [width, height]);
      assert.equal(grid.material.uniforms.vertexData.value, first.geometry.userData.cornerTexture);
      assert.equal(grid.material.uniforms.landData.value, first.geometry.userData.landTexture);
    }
    assert.equal(grid.children.length, 2, 'one draw object per bounded batch');
    let texturesDisposed = 0;
    for (const mesh of lines(grid)) {
      for (const key of ['cornerTexture', 'landTexture', 'edgeTexture']) {
        mesh.geometry.userData[key].addEventListener('dispose', () => texturesDisposed++);
      }
    }
    grid.dispose();
    assert.equal(texturesDisposed, 6);
  }
});

test('map seam splits interpolate the same dry-land mask on both borders', () => {
  const input = packet([direction(radians(170), 0.2), direction(radians(-170), 0.3)], [200, 200]);
  input.landCoverage.set([255, 0]);
  const grid = new FixedGrid(radius, { ...appearance, projection: 'map' });
  grid.addBatch(input);
  const geometry = lines(grid)[0].geometry;
  const coverage = new THREE.BufferAttribute(geometry.userData.landTexture.image.data, 1, true);
  const left = edgeIndices(geometry).getX(1);
  const right = edgeIndices(geometry).getX(2);
  assert.equal(coverage.getX(left), coverage.getX(right));
  assert.ok(Math.abs(coverage.getX(left) - 0.5) < 0.01);
  grid.dispose();
});

test('a maximum all-seam packet uses shared Uint32 indices without the WebGL2 restart sentinel', () => {
  const small = packet([direction(0.1, 0.2), direction(0.2, 0.3)], [100, 100], 0);
  const seamPoints = Array.from({ length: FIXED_GRID_EDGES_PER_BATCH * 2 }, (_, index) =>
    direction(
      radians(index % 2 === 0 ? 170 : -170),
      -0.8 + (index / 2 / FIXED_GRID_EDGES_PER_BATCH) * 1.6,
    ),
  );
  const full = packet(seamPoints, undefined, 1);
  const map = new FixedGrid(radius, { ...appearance, projection: 'map' });
  map.addBatch(small);
  assert.ok(lines(map)[0].geometry.index!.array instanceof Uint16Array);
  map.addBatch(full);
  const first = lines(map)[1].geometry;
  assert.equal(first.userData.edgeCount, FIXED_GRID_EDGES_PER_BATCH * 2);
  assert.ok(first.index!.array instanceof Uint32Array);
  assert.equal(first.index!.getX(first.drawRange.count - 1), 65535);
  assert.equal(
    first.index!.array.slice(0, first.drawRange.count).includes(0xffffffff),
    false,
    'every corner is an ordinary index for the selected Uint32 draw type',
  );
  const before = { cpu: map.additionalCpuBytes, gpu: map.gpuBytes };
  map.addBatch({ ...full, batch: 2 });
  const second = lines(map)[2].geometry;
  assert.equal(first.index, second.index, 'large packets share the same lazily allocated fallback');
  const displayBytes =
    second.userData.cornerTexture.image.data.byteLength +
    second.userData.landTexture.image.data.byteLength +
    second.userData.edgeTexture.image.data.byteLength;
  assert.equal(
    map.additionalCpuBytes - before.cpu,
    displayBytes,
    'fallback CPU bytes counted once',
  );
  assert.equal(map.gpuBytes - before.gpu, displayBytes, 'fallback GPU bytes counted once');
  let disposed = 0;
  for (const mesh of lines(map)) {
    mesh.geometry.addEventListener('dispose', () => disposed++);
  }
  map.dispose();
  map.dispose();
  assert.equal(disposed, 3);
  assert.equal(map.retainedBytes, 0);
});
