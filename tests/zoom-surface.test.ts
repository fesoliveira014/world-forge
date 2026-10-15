import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { buildGrid } from '../src/core/grid/build';
import { DEFAULT_CONFIG } from '../src/core/model';
import {
  PHYSICAL_MATERIAL_FIELD_COUNT,
  type PhysicalMeshManifest,
  type PhysicalMeshPacket,
} from '../src/core/view/physical-mesh-types';
import type { WorldHandle } from '../src/core/view/types';
import { buildZoomTopology } from '../src/core/view/zoom-subdivision';
import {
  decodeZoomNormal,
  prepareZoomTriangle,
  sampleZoomHeightCorrection,
} from '../src/core/view/zoom-reconstruction';
import { FixedSurface, type FixedSurfaceAppearance } from '../src/render/FixedSurface';
import { mapReliefScale } from '../src/render/MapStyle';
import { MAP_HEIGHT_SHEAR } from '../src/render/projection';
import type { ZoomFaceCandidate } from '../src/render/ZoomSelection';
import {
  buildZoomSurface,
  enableZoomSurfaceMaterial,
  ZOOM_BATCH_BUDGET,
  ZOOM_VERTEX_BUDGET,
} from '../src/render/ZoomSurface';

const radius = 1e6;
const handle = { config: { ...DEFAULT_CONFIG, radius } } as WorldHandle;
const banks = new THREE.DataTexture(new Uint8Array(4), 1, 1);
const rivers = { attenuation: () => 1 };

function encodeNormal(normal: THREE.Vector3) {
  const sum = Math.abs(normal.x) + Math.abs(normal.y) + Math.abs(normal.z);
  let x = normal.x / sum;
  let y = normal.y / sum;
  if (normal.z < 0) {
    const previous = x;
    x = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
    y = (1 - Math.abs(previous)) * (y >= 0 ? 1 : -1);
  }
  return [Math.round(x * 32767), Math.round(y * 32767)];
}

function fixture(
  projection: 'globe' | 'map',
  level = 1,
  mapStyle: 'natural' | 'relief' = 'natural',
) {
  const grid = buildGrid(level, 'zoom-surface-tests', 0.3);
  const heights = new Float32Array(grid.count);
  const normals = new Int16Array(grid.count * 2);
  const materials = Array.from({ length: PHYSICAL_MATERIAL_FIELD_COUNT }, (_, field) =>
    Uint8Array.from({ length: grid.count * 4 }, (_, index) => (index * 71 + field * 41) % 256),
  );
  for (let vertex = 0; vertex < grid.count; vertex++) {
    const direction = new THREE.Vector3().fromArray(grid.positions, vertex * 3).normalize();
    heights[vertex] = 1400 + direction.x * 500 + direction.y ** 2 * 300;
    const gradient = new THREE.Vector3(500, 600 * direction.y, 0);
    gradient.addScaledVector(direction, -gradient.dot(direction));
    const normal = direction
      .clone()
      .addScaledVector(gradient, -1 / (radius + heights[vertex]))
      .normalize();
    normals.set(encodeNormal(normal), vertex * 2);
    materials[4][vertex * 4 + 2] = materials[4][vertex * 4 + 3] = 0;
    // Include low-byte carries: bytewise rounding would change these scalars.
    materials[0][vertex * 4] = vertex % 3;
    materials[0][vertex * 4 + 1] = vertex % 3 === 0 ? 255 : 0;
  }
  const packet: PhysicalMeshPacket = {
    batch: 0,
    mode: 'primal',
    directions: Float32Array.from(grid.positions),
    heights,
    normals,
    colors: new Uint8Array(),
    materials,
    indices: Uint16Array.from(grid.triangles),
    bytes: 0,
  };
  const manifest: PhysicalMeshManifest = {
    format: 'atlas-physical-mesh/v1',
    layer: 'world',
    season: 0,
    mode: 'primal',
    batches: 1,
    triangles: packet.indices.length / 3,
    physicalVertices: grid.count,
    elevationRange: [-12000, 9000],
    estimatedBytes: 0,
  };
  const appearance: FixedSurfaceAppearance = {
    projection,
    mapStyle,
    relief: 26,
    coastlines: true,
  };
  const surface = new FixedSurface(packet, handle, manifest, appearance, banks);
  const candidates: ZoomFaceCandidate[] = [];
  for (let face = 0; face < packet.indices.length / 3; face++) {
    const ids = Array.from(packet.indices.subarray(face * 3, face * 3 + 3)) as [
      number,
      number,
      number,
    ];
    if (!ids.every((id, corner) => surface.geometry.index!.getX(face * 3 + corner) === id)) {
      continue;
    }
    if (prepareZoomTriangle(packet, ids, radius).reconstructable) {
      candidates.push({ batch: 0, face, segments: 8, priority: candidates.length });
    }
  }
  assert.ok(candidates.length > 3);
  return { packet, surface, appearance, candidates };
}

function finish(generator: ReturnType<typeof buildZoomSurface>) {
  let result = generator.next();
  let steps = 0;
  while (!result.done) {
    steps++;
    assert.ok(steps < 10000, 'bounded cooperative builder completes');
    result = generator.next();
  }
  return { patch: result.value, steps };
}

function expectedNormal(
  packet: PhysicalMeshPacket,
  id: number,
  appearance: FixedSurfaceAppearance,
) {
  // Evaluate the existing fixed-material vertex expression at an ORIGINAL
  // corner, independently of the patch builder's new interpolation.
  const d = new THREE.Vector3().fromArray(packet.directions, id * 3).normalize();
  const n = new THREE.Vector3(...decodeZoomNormal(packet.normals, id));
  const tangent = d.clone().sub(n.multiplyScalar(1 / Math.max(0.05, n.dot(d))));
  const height = packet.heights[id];
  const baseRadius = 1 + height / radius;
  if (appearance.projection === 'globe') {
    return d
      .addScaledVector(
        tangent,
        (-appearance.relief * baseRadius) / (1 + (height / radius) * appearance.relief),
      )
      .normalize();
  }
  const horizontal = Math.max(0.00001, Math.hypot(d.x, d.z));
  const east = new THREE.Vector3(-d.z / horizontal, 0, d.x / horizontal);
  const north = new THREE.Vector3().crossVectors(east, d);
  const factor = baseRadius * appearance.relief * mapReliefScale(appearance.mapStyle);
  const sx = tangent.dot(east) * factor * horizontal;
  const sy = tangent.dot(north) * factor;
  return new THREE.Vector3(-sx, -sy, 1 + MAP_HEIGHT_SHEAR * sy).normalize();
}

test('zero-morph patches retain original material and normal interpolation in both projections', () => {
  for (const [projection, mapStyle] of [
    ['globe', 'natural'],
    ['map', 'natural'],
    ['map', 'relief'],
  ] as const) {
    const { packet, surface, appearance, candidates } = fixture(projection, 1, mapStyle);
    const before = structuredClone(packet);
    const chosen = candidates.slice(0, 2);
    const { patch, steps } = finish(
      buildZoomSurface(chosen, [surface], [packet], radius, appearance, surface.material, rivers),
    );
    assert.ok(patch);
    assert.ok(steps > 0);
    const topology = buildZoomTopology(packet, chosen, ZOOM_VERTEX_BUDGET);
    const geometry = patch.mesh.geometry;
    const position = geometry.getAttribute('position');
    const original = surface.geometry.getAttribute('position');
    const directions = geometry.getAttribute('spherePosition');
    const normal = geometry.getAttribute('zoomNormal');
    const offset = geometry.getAttribute('zoomOffset');
    assert.equal(position.count, topology.vertexCount);
    assert.equal(geometry.getAttribute('material5'), undefined);
    assert.equal(
      Object.keys(geometry.attributes).filter((name) => /^material\d+$/.test(name)).length,
      PHYSICAL_MATERIAL_FIELD_COUNT,
    );
    let largestOffset = 0;
    let moved = 0;
    for (let vertex = 0; vertex < topology.vertexCount; vertex++) {
      const face = topology.sourceFaces[vertex];
      const ids = Array.from(packet.indices.subarray(face * 3, face * 3 + 3)) as [
        number,
        number,
        number,
      ];
      const weights = topology.barycentrics.subarray(vertex * 3, vertex * 3 + 3);
      const corners = ids.map((id) =>
        new THREE.Vector3().fromArray(packet.directions, id * 3).normalize(),
      );
      const cornerNormals = ids.map((id) => expectedNormal(packet, id, appearance));
      for (let axis = 0; axis < 3; axis++) {
        const expectedPosition = ids.reduce(
          (sum, id, corner) => sum + original.getComponent(id, axis) * weights[corner],
          0,
        );
        const expectedDirection = corners.reduce(
          (sum, direction, corner) => sum + direction.getComponent(axis) * weights[corner],
          0,
        );
        const expectedLighting = cornerNormals.reduce(
          (sum, n, corner) => sum + n.getComponent(axis) * weights[corner],
          0,
        );
        assert.ok(Math.abs(position.getComponent(vertex, axis) - expectedPosition) < 3e-7);
        assert.ok(Math.abs(directions.getComponent(vertex, axis) - expectedDirection) < 2e-7);
        assert.ok(Math.abs(normal.getComponent(vertex, axis) - expectedLighting) < 2e-7);
      }
      for (let field = 0; field < PHYSICAL_MATERIAL_FIELD_COUNT; field++) {
        const attribute = geometry.getAttribute(`material${field}`);
        assert.ok(attribute.array instanceof Float32Array);
        for (let component = 0; component < 4; component++) {
          const pair =
            (field === 0 && component === 0) ||
            (field === 1 && component === 1) ||
            (field === 3 && component === 0);
          if (pair) {
            const actual =
              (attribute.getComponent(vertex, component) * 65280 +
                attribute.getComponent(vertex, component + 1) * 255) /
              65535;
            const expected = ids.reduce(
              (sum, id, corner) =>
                sum +
                ((packet.materials[field][id * 4 + component] * 256 +
                  packet.materials[field][id * 4 + component + 1]) /
                  65535) *
                  weights[corner],
              0,
            );
            assert.ok(
              Math.abs(actual - expected) < 2e-7,
              'decoded 16-bit fields interpolate without byte rounding',
            );
            component++;
          } else {
            const expected = ids.reduce(
              (sum, id, corner) =>
                sum + (packet.materials[field][id * 4 + component] / 255) * weights[corner],
              0,
            );
            assert.ok(Math.abs(attribute.getComponent(vertex, component) - expected) < 2e-7);
          }
        }
      }
      const correction = sampleZoomHeightCorrection(
        prepareZoomTriangle(packet, ids, radius),
        weights,
      );
      const shift = (correction / radius) * appearance.relief;
      const actualOffset = new THREE.Vector3(
        offset.getX(vertex),
        offset.getY(vertex),
        offset.getZ(vertex),
      );
      largestOffset = Math.max(
        largestOffset,
        Math.hypot(actualOffset.x, actualOffset.y, actualOffset.z),
      );
      for (const blend of [0, 0.25, 0.5, 1]) {
        assert.ok(actualOffset.length() * blend <= patch.maximumDisplacement + 1e-15);
      }
      const expectedOffset =
        projection === 'globe'
          ? new THREE.Vector3(
              directions.getX(vertex),
              directions.getY(vertex),
              directions.getZ(vertex),
            )
              .normalize()
              .multiplyScalar(shift)
          : new THREE.Vector3(
              0,
              shift * mapReliefScale(appearance.mapStyle) * MAP_HEIGHT_SHEAR,
              shift * mapReliefScale(appearance.mapStyle),
            );
      assert.ok(actualOffset.distanceTo(expectedOffset) < 1e-8);
      if (weights.some((weight) => weight === 1)) {
        const corner = weights.findIndex((weight) => weight === 1);
        assert.deepEqual(
          [position.getX(vertex), position.getY(vertex), position.getZ(vertex)],
          [original.getX(ids[corner]), original.getY(ids[corner]), original.getZ(ids[corner])],
        );
        assert.equal(actualOffset.length(), 0, 'original boundaries never move');
      } else if (actualOffset.length() > 0) {
        moved++;
      }
      const final = new THREE.Vector3().fromBufferAttribute(position, vertex).add(actualOffset);
      assert.ok(
        geometry.boundingBox!.containsPoint(final),
        'shader displacement stays in conservative culling bounds',
      );
    }
    if (projection === 'globe' || mapReliefScale(mapStyle) > 0) {
      assert.ok(moved > 0, 'the fixture exercises actual reconstruction, not an unchanged mesh');
    } else {
      assert.equal(moved, 0, 'Natural flat-map display has no geometric relief');
    }
    assert.deepEqual(packet, before);
    assert.equal(patch.maximumDisplacement, largestOffset);
    patch.dispose();
    surface.dispose();
  }
});

test('mask lifecycle preserves shared terrain buffers and all appended map seam/pole triangles', () => {
  for (const projection of ['globe', 'map'] as const) {
    const { packet, surface, appearance, candidates } = fixture(
      projection,
      1,
      projection === 'map' ? 'relief' : 'natural',
    );
    const chosen = candidates.slice(0, 2);
    const patch = finish(
      buildZoomSurface(chosen, [surface], [packet], radius, appearance, surface.material, rivers),
    ).patch!;
    const originalIndex = surface.geometry.index!;
    const originalAttributes = { ...surface.geometry.attributes };
    const originalArray = originalIndex.array.slice();
    const group = new THREE.Group();
    group.add(surface);
    let materialDisposals = 0;
    let baseDisposals = 0;
    let patchDisposals = 0;
    surface.material.addEventListener('dispose', () => materialDisposals++);
    surface.geometry.addEventListener('dispose', () => baseDisposals++);
    patch.mesh.geometry.addEventListener('dispose', () => patchDisposals++);
    patch.install(group);
    patch.install(group);
    assert.equal(group.children.length, 3, 'installation is idempotent');
    assert.equal(surface.visible, false);
    const mask = group.children.find((child) => child.name === 'zoom-base-0') as THREE.Mesh;
    assert.ok(mask);
    assert.equal(patch.isMasked(surface), true);
    patch.applyBaseVisibility((base) => {
      assert.equal(base, surface);
      return false;
    });
    assert.equal(mask.visible, false);
    assert.equal(surface.visible, false);
    patch.applyBaseVisibility(() => true);
    assert.equal(mask.visible, true);
    assert.equal(surface.visible, false, 'culling never restores replaced base triangles');
    assert.equal(mask.material, surface.material);
    assert.notEqual(mask.geometry.index, originalIndex);
    assert.equal(mask.geometry.boundingBox, surface.geometry.boundingBox);
    assert.equal(mask.geometry.boundingSphere, surface.geometry.boundingSphere);
    for (const [name, attribute] of Object.entries(originalAttributes)) {
      assert.equal(mask.geometry.attributes[name], attribute);
    }
    const selected = new Set(chosen.map((candidate) => candidate.face));
    const expected = Array.from(originalArray).filter(
      (_, offset) => !selected.has(Math.floor(offset / 3)),
    );
    assert.deepEqual(Array.from(mask.geometry.index!.array), expected);
    if (projection === 'map') {
      assert.ok(
        originalIndex.count > packet.indices.length,
        'fixture contains actual seam/pole expansion',
      );
      assert.deepEqual(
        Array.from(mask.geometry.index!.array).slice(
          -(originalIndex.count - packet.indices.length),
        ),
        Array.from(originalArray).slice(packet.indices.length),
      );
    }
    let maskDisposals = 0;
    mask.geometry.addEventListener('dispose', () => {
      maskDisposals++;
      assert.deepEqual(
        Object.keys(mask.geometry.attributes),
        [],
        'borrowed GPU attributes detach BEFORE mask disposal',
      );
      assert.ok(mask.geometry.index, 'private mask index remains attached for GPU release');
    });
    patch.dispose();
    patch.dispose();
    patch.install(group);
    assert.equal(surface.visible, true);
    assert.equal(patch.isMasked(surface), false);
    assert.deepEqual(group.children, [surface]);
    assert.equal(surface.geometry.index, originalIndex);
    assert.deepEqual(originalIndex.array, originalArray);
    for (const [name, attribute] of Object.entries(originalAttributes)) {
      assert.equal(surface.geometry.attributes[name], attribute);
    }
    assert.deepEqual(
      [maskDisposals, patchDisposals, materialDisposals, baseDisposals],
      [1, 1, 0, 0],
    );
    surface.dispose();
  }
});

test('cancelled or protected builds leave the active base untouched and additions obey both budgets', () => {
  const { packet, surface, appearance, candidates } = fixture('globe', 3);
  const sourceIndex = surface.geometry.index;
  const generator = buildZoomSurface(
    candidates,
    [surface],
    [packet],
    radius,
    appearance,
    surface.material,
    rivers,
  );
  assert.equal(generator.next().done, false);
  generator.return(null);
  assert.equal(surface.visible, true);
  assert.equal(surface.geometry.index, sourceIndex);
  const protectedResult = finish(
    buildZoomSurface(candidates, [surface], [packet], radius, appearance, surface.material, {
      attenuation: () => 0,
    }),
  );
  assert.equal(protectedResult.patch, null);
  const dense = candidates
    .slice(0, 384)
    .map((candidate) => ({ ...candidate, segments: 16 as const }));
  const patch = finish(
    buildZoomSurface(dense, [surface], [packet], radius, appearance, surface.material, rivers),
  ).patch!;
  assert.ok(patch.vertices <= ZOOM_VERTEX_BUDGET);
  assert.ok(patch.selections.length < dense.length, 'fixture exceeds the additional vertex budget');
  patch.dispose();
  assert.equal(
    surface.visible,
    true,
    'disposing an uninstalled result never hides or restores other geometry',
  );
  const batchCount = ZOOM_BATCH_BUDGET + 4;
  const many = Array.from({ length: batchCount }, (_, batch) => ({ ...candidates[0], batch }));
  const across = finish(
    buildZoomSurface(
      many,
      Array(batchCount).fill(surface),
      Array(batchCount).fill(packet),
      radius,
      appearance,
      surface.material,
      rivers,
    ),
  ).patch!;
  assert.equal(
    new Set(across.selections.map((candidate) => candidate.batch)).size,
    ZOOM_BATCH_BUDGET,
  );
  across.dispose();
  surface.dispose();
});

test('batched masks borrow CPU arrays but own and release their GPU attribute wrappers', () => {
  for (const projection of ['globe', 'map'] as const) {
    const { packet, surface, appearance, candidates } = fixture(projection, 1, 'relief');
    surface.userData.terrainBatched = true;
    const patch = finish(
      buildZoomSurface(
        candidates.slice(0, 2),
        [surface],
        [packet],
        radius,
        appearance,
        surface.material,
        rivers,
      ),
    ).patch!;
    const group = new THREE.Group();
    group.add(surface);
    patch.install(group);
    const mask = group.children.find((child) => child.name === 'zoom-base-0') as THREE.Mesh;
    let attributeBytes = 0;
    for (const [name, attribute] of Object.entries(surface.geometry.attributes)) {
      const own = mask.geometry.getAttribute(name);
      assert.notEqual(own, attribute, 'batched source has no shared GPU attribute ownership');
      assert.equal(own.array, attribute.array, 'immutable CPU arrays are never duplicated');
      assert.equal(own.itemSize, attribute.itemSize);
      assert.equal(own.normalized, attribute.normalized);
      attributeBytes += own.array.byteLength;
    }
    assert.equal(patch.maskBytes, mask.geometry.index!.array.byteLength * 2 + attributeBytes);
    let disposals = 0;
    const wrappers = { ...mask.geometry.attributes };
    mask.geometry.addEventListener('dispose', () => {
      disposals++;
      assert.deepEqual(
        mask.geometry.attributes,
        wrappers,
        'owned GPU buffers stay attached for disposal',
      );
    });
    patch.dispose();
    patch.dispose();
    assert.equal(disposals, 1);
    assert.equal(patch.maskBytes, 0);
    for (const [name, attribute] of Object.entries(surface.geometry.attributes)) {
      assert.equal(attribute.array, wrappers[name].array);
    }
    surface.dispose();
  }
});

test('shared shader activates patch varyings without changing the defaults for ordinary terrain', () => {
  for (const [projection, style] of [
    ['globe', 'natural'],
    ['globe', 'relief'],
    ['map', 'relief'],
  ] as const) {
    const { surface } = fixture(projection, 1, style);
    enableZoomSurfaceMaterial(surface.material, projection === 'map');
    const shader = surface.material.vertexShader;
    assert.equal(surface.material.uniforms.zoomBlend.value, 0);
    const defaults = surface.material.defaultAttributeValues as Record<string, number[]>;
    assert.deepEqual(defaults.zoomOffset, [0, 0, 0, 0]);
    assert.deepEqual(defaults.zoomNormal, [0, 0, 0]);
    assert.match(shader, /position \+ zoomOffset\.xyz \* zoomBlend/);
    assert.match(shader, /normalMatrix \* zoomNormal/);
    if (style === 'natural') {
      assert.match(shader, /vSphere = mix\(vSphere, spherePosition, zoomOffset\.w\)/);
      assert.match(shader, /vSurfaceNormal = mix\(vSurfaceNormal,/);
      assert.doesNotMatch(shader, /fixedViewNormal = mix/);
    } else {
      assert.doesNotMatch(shader, /\bvSphere\b|\bvSurfaceNormal\b/);
      assert.match(
        shader,
        /sphereDirection = mix\(sphereDirection, spherePosition, zoomOffset\.w\)/,
      );
      assert.match(shader, /fixedViewNormal = mix\(fixedViewNormal,/);
      assert.match(shader, /viewUp = mix\(viewUp,/);
      if (projection === 'map') {
        assert.match(shader, /normalMatrix \* vec3\(0\.0, 0\.0, 1\.0\)/);
      } else {
        assert.match(shader, /normalMatrix \* spherePosition/);
      }
    }
    enableZoomSurfaceMaterial(surface.material, projection === 'map');
    assert.equal(surface.material.vertexShader, shader);
    surface.dispose();
  }
});
