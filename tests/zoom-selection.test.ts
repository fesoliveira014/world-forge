import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  PHYSICAL_MATERIAL_FIELD_COUNT,
  type PhysicalMeshPacket,
} from '../src/core/view/physical-mesh-types';
import type { FixedSurface } from '../src/render/FixedSurface';
import {
  maximumZoomEdgePixels,
  selectZoomFaces,
  type ZoomFaceCandidate,
} from '../src/render/ZoomSelection';

function fixture(points: number[][], flat = true) {
  const packet: PhysicalMeshPacket = {
    batch: 42,
    mode: 'primal',
    directions: Float32Array.from(points.flat()),
    heights: Float32Array.from(points, (_, index) => 100 + (index % 3) * 10),
    normals: new Int16Array(points.length * 2),
    colors: new Uint8Array(),
    materials: Array.from(
      { length: PHYSICAL_MATERIAL_FIELD_COUNT },
      () => new Uint8Array(points.length * 4),
    ),
    indices: Uint16Array.from(points, (_, index) => index),
    bytes: 0,
  };
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(packet.directions, 3));
  geometry.setIndex(new THREE.BufferAttribute(packet.indices.slice(), 1));
  geometry.computeBoundingSphere();
  if (flat) {
    geometry.userData.mapCopies = { first: points.length, vertices: [] };
  }
  const surface = new THREE.Mesh(geometry, new THREE.ShaderMaterial()) as FixedSurface;
  surface.updateMatrixWorld();
  return { surface, packet };
}

function camera() {
  const result = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  result.position.z = 3;
  result.updateMatrixWorld();
  return result;
}

function finish(generator: ReturnType<typeof selectZoomFaces>) {
  let step = generator.next();
  while (!step.done) {
    step = generator.next();
  }
  return step.value;
}

function triangle(edgePixels: number, x = 0): number[][] {
  const size = edgePixels / 500;
  return [
    [x - size / 2, (-size * Math.sqrt(3)) / 6, 0],
    [x + size / 2, (-size * Math.sqrt(3)) / 6, 0],
    [x, (size * Math.sqrt(3)) / 3, 0],
  ];
}

test('selection uses visible base geometry and excludes globe backsides and altered map faces', () => {
  const globe = fixture(
    [
      [-0.2, -0.2, 1],
      [0.2, -0.2, 1],
      [0, 0.2, 1],
      [-0.2, -0.2, -1],
      [0, 0.2, -1],
      [0.2, -0.2, -1],
      [20, 0, 1],
      [20.2, 0, 1],
      [20, 0.2, 1],
    ],
    false,
  );
  const view = new THREE.PerspectiveCamera(45, 1, 0.1, 10);
  view.position.z = 3;
  view.updateMatrixWorld();
  assert.deepEqual(
    finish(selectZoomFaces([globe.surface], [globe.packet], view, 1000, 1000)).map(
      (item) => item.face,
    ),
    [0],
  );
  const map = fixture([...triangle(80), ...triangle(80, 0.2)]);
  map.surface.visible = false; // An installed patch hides the original mesh.
  map.surface.geometry.index!.setX(3, 0); // A seam/pole triangle was rewritten.
  const before = structuredClone(map.packet);
  assert.deepEqual(
    finish(selectZoomFaces([map.surface], [map.packet], camera(), 1000, 1000)).map(
      (item) => item.face,
    ),
    [0],
  );
  assert.deepEqual(map.packet, before);
});

test('water, flat terrain, non-world fields, and categorical polygons never consume candidate slots', () => {
  for (const kind of ['ocean', 'lake', 'zero', 'flat', 'category', 'analytical']) {
    const item = fixture(triangle(80));
    if (kind === 'ocean') {
      item.packet.materials[4][2] = 1;
    }
    if (kind === 'lake') {
      item.packet.materials[4][7] = 1;
    }
    if (kind === 'zero') {
      item.packet.heights[0] = 0;
    }
    if (kind === 'flat') {
      item.packet.heights.fill(100);
    }
    if (kind === 'category') {
      item.packet.mode = 'dual';
    }
    if (kind === 'analytical') {
      item.packet.colors = new Uint8Array(12);
    }
    assert.deepEqual(
      finish(selectZoomFaces([item.surface], [item.packet], camera(), 1000, 1000)),
      [],
      kind,
    );
  }
});

test('face and subdivision hysteresis prevent threshold chatter', () => {
  const select = (pixels: number, previous: ZoomFaceCandidate[] = []) => {
    const item = fixture(triangle(pixels));
    return finish(selectZoomFaces([item.surface], [item.packet], camera(), 1000, 1000, previous));
  };
  const previous = [{ batch: 0, face: 0, segments: 4 as const, priority: 0 }];
  assert.equal(select(31).length, 0);
  assert.equal(select(31, previous).length, 1);
  assert.equal(select(25, previous).length, 0);
  assert.equal(select(80)[0].segments, 8);
  assert.equal(select(80, previous)[0].segments, 4);
  assert.equal(select(90, previous)[0].segments, 8);
  const finer = [{ ...previous[0], segments: 8 as const }];
  assert.equal(select(64, finer)[0].segments, 8);
  assert.equal(select(55, finer)[0].segments, 4);
});

test('cooperative scanning keeps only the nearest 384 faces and freezes its camera snapshot', () => {
  const count = 600;
  const item = fixture(
    Array.from({ length: count }, (_, index) => triangle(80, (index - 299.5) / 500)).flat(),
  );
  const view = camera();
  const baseline = finish(selectZoomFaces([item.surface], [item.packet], view, 1000, 1000));
  const scan = selectZoomFaces([item.surface], [item.packet], view, 1000, 1000);
  const progress = scan.next();
  assert.equal(progress.done, false);
  assert.equal((progress.value as { scannedFaces: number }).scannedFaces, 256);
  view.position.x = 100;
  view.zoom = 100;
  view.updateMatrixWorld();
  view.updateProjectionMatrix();
  const selected = finish(scan);
  assert.deepEqual(selected, baseline, 'camera changes do not mix two views within one scan');
  assert.equal(selected.length, 384);
  assert.ok(selected.every((item) => item.batch === 0 && [2, 4, 8, 16].includes(item.segments)));
  assert.ok(
    selected.every((item, index) => index === 0 || item.priority >= selected[index - 1].priority),
  );
  assert.deepEqual(
    selected.map((item) => item.face).sort((a, b) => a - b),
    Array.from({ length: 384 }, (_, index) => 108 + index),
    'a bounded heap selects the central faces even though they arrive after distant faces',
  );
});

test('cached tiny-edge bounds bypass an entire batch without losing retained 26px faces', () => {
  const tiny = fixture(Array.from({ length: 600 }, () => triangle(20)).flat());
  Object.defineProperty(tiny.surface, 'maximumEdgeLength', { value: 20 / 500 });
  const scan = selectZoomFaces([tiny.surface], [tiny.packet], camera(), 1000, 1000);
  assert.deepEqual(scan.next(), { value: { scannedFaces: 600 }, done: false });
  assert.deepEqual(finish(scan), []);
  const retained = fixture(triangle(27));
  Object.defineProperty(retained.surface, 'maximumEdgeLength', { value: 27 / 500 });
  assert.equal(
    finish(
      selectZoomFaces([retained.surface], [retained.packet], camera(), 1000, 1000, [
        { batch: 0, face: 0, segments: 2, priority: 0 },
      ]),
    ).length,
    1,
    'a conservative margin keeps every face above the lower hysteresis threshold',
  );
});

test('pixel bounds include depth changes, oblique edges and nonuniform/sheared transforms', () => {
  const view = new THREE.PerspectiveCamera(38, 16 / 9, 0.1, 100);
  view.setViewOffset(1600, 900, 100, 50, 1600, 900);
  const orthographic = new THREE.OrthographicCamera(-2, 2, 1, -1, 0.1, 100);
  const modelView = new THREE.Matrix4().set(
    1.2,
    0.5,
    0.1,
    0.6,
    -0.2,
    0.7,
    0.2,
    0.5,
    0.1,
    0.2,
    1.5,
    -3,
    0,
    0,
    0,
    1,
  );
  for (let example = 0; example < 128; example++) {
    const angle = example * 2.399963229728653;
    const points = [
      new THREE.Vector3(Math.cos(angle) * 0.3, Math.sin(angle) * 0.3, -0.25),
      new THREE.Vector3(Math.sin(angle) * 0.3, Math.cos(angle) * 0.3, 0.4),
      new THREE.Vector3(-0.3, 0.1, -0.1),
    ];
    const sphere = new THREE.Box3().setFromPoints(points).getBoundingSphere(new THREE.Sphere());
    const maximumEdge = Math.max(...points.map((p, i) => p.distanceTo(points[(i + 1) % 3])));
    for (const projection of [view.projectionMatrix, orthographic.projectionMatrix]) {
      const bound = maximumZoomEdgePixels(
        maximumEdge,
        sphere,
        modelView,
        projection,
        1600,
        900,
        0.1,
      );
      assert.ok(Number.isFinite(bound));
      const projected = points.map((p) =>
        p.clone().applyMatrix4(modelView).applyMatrix4(projection),
      );
      for (let edge = 0; edge < 3; edge++) {
        const a = projected[edge];
        const b = projected[(edge + 1) % 3];
        const pixels = Math.hypot((a.x - b.x) * 800, (a.y - b.y) * 450);
        assert.ok(pixels <= bound, `projected edge ${pixels} exceeds bound ${bound}`);
      }
    }
  }
});

test('near-plane crossings, missing cache and unsupported projections retain the full scan', () => {
  const view = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  const sphere = new THREE.Sphere(new THREE.Vector3(0, 0, -0.11), 0.02);
  const identity = new THREE.Matrix4();
  assert.equal(
    maximumZoomEdgePixels(0.0001, sphere, identity, view.projectionMatrix, 1000, 1000, 0.1),
    Infinity,
  );
  assert.equal(
    maximumZoomEdgePixels(Number.NaN, sphere, identity, view.projectionMatrix, 1000, 1000),
    Infinity,
  );
  const unsupported = view.projectionMatrix.clone();
  unsupported.elements[12] = 0.5;
  assert.equal(maximumZoomEdgePixels(0.0001, sphere, identity, unsupported, 1000, 1000), Infinity);
  const uncached = fixture(Array.from({ length: 600 }, () => triangle(20)).flat());
  assert.deepEqual(
    selectZoomFaces([uncached.surface], [uncached.packet], camera(), 1000, 1000).next(),
    { value: { scannedFaces: 256 }, done: false },
  );
});
