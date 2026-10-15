import assert from 'node:assert/strict';
import test from 'node:test';
import { DataTexture } from 'three';
import { buildGrid } from '../src/core/grid/build';
import { DEFAULT_CONFIG } from '../src/core/model';
import type { WorldHandle } from '../src/core/view/types';
import {
  PHYSICAL_MATERIAL_FIELD_COUNT,
  type PhysicalMeshManifest,
  type PhysicalMeshPacket,
} from '../src/core/view/physical-mesh-types';
import {
  FixedSurface,
  fixedSurfaceGeometry,
  createFixedSurfaceMaterial,
  setFixedSurfaceBanks,
  setFixedSurfaceCoastlines,
  worldSurfaceAppearance,
} from '../src/render/FixedSurface';

const handle = { config: DEFAULT_CONFIG } as WorldHandle;
function packet(): PhysicalMeshPacket {
  const grid = buildGrid(1, 'physical-render-test', 0.3);
  const materials = Array.from({ length: PHYSICAL_MATERIAL_FIELD_COUNT }, () =>
    new Uint8Array(grid.count * 4).fill(127),
  );
  const result = {
    batch: 0,
    mode: 'primal' as const,
    directions: Float32Array.from(grid.positions),
    heights: new Float32Array(grid.count).fill(1200),
    normals: new Int16Array(grid.count * 2),
    colors: new Uint8Array(),
    materials,
    indices: Uint16Array.from(grid.triangles),
    bytes: 0,
  };
  result.bytes = [
    result.directions,
    result.heights,
    result.normals,
    result.colors,
    result.indices,
    ...materials,
  ].reduce((sum, array) => sum + array.byteLength, 0);
  return result;
}
const appearance = {
  projection: 'globe' as const,
  mapStyle: 'natural' as const,
  relief: 26,
  coastlines: true,
};
const manifest: PhysicalMeshManifest = {
  format: 'atlas-physical-mesh/v1',
  layer: 'world',
  season: 0,
  mode: 'primal',
  batches: 1,
  triangles: 80,
  physicalVertices: 42,
  elevationRange: [-12000, 9000],
  estimatedBytes: 0,
};

test('heightmap uses actual terrain extrema and flat geometry without water or lighting', () => {
  const world = {
    ...handle,
    summary: { minimumHeight: -8300, maximumHeight: 15400 },
  } as WorldHandle;
  const banks = new DataTexture(new Uint8Array(4), 1, 1);
  const input = packet();
  for (const projection of ['globe', 'map'] as const) {
    const options = {
      ...appearance,
      projection,
      ...worldSurfaceAppearance('world', 'heightmap', 60),
    };
    assert.equal(options.relief, 0);
    const material = createFixedSurfaceMaterial(world, manifest, options, banks);
    assert.deepEqual(material.uniforms.elevationRange.value.toArray(), manifest.elevationRange);
    assert.deepEqual(material.uniforms.heightmapRange.value.toArray(), [-8300, 15400]);
    assert.equal(material.uniforms.riverbankMap, undefined);
    assert.equal(material.uniforms.fixedCoastlines, undefined);
    assert.equal(material.lights, false);
    assert.equal(material.toneMapped, false);
    assert.equal(material.userData.fixedSurfacePacketOrder, true);
    const geometry = fixedSurfaceGeometry(input, DEFAULT_CONFIG.radius, options);
    const position = geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      if (projection === 'map') {
        assert.equal(position.getZ(i), 0);
      } else {
        assert.ok(
          Math.abs(Math.hypot(position.getX(i), position.getY(i), position.getZ(i)) - 1) < 2e-7,
        );
      }
    }
    material.dispose();
    geometry.dispose();
  }
  assert.deepEqual(worldSurfaceAppearance('elevation', 'heightmap', 26), {
    mapStyle: 'natural',
    relief: 26,
  });
  banks.dispose();
});

test('fixed surface preserves physical topology and input buffers across relief and map rebuilds', () => {
  const input = packet();
  const before = structuredClone(input);
  const globe = fixedSurfaceGeometry(input, DEFAULT_CONFIG.radius, appearance);
  assert.equal(globe.index!.count, input.indices.length);
  assert.equal(globe.getAttribute('position').count, input.heights.length);
  assert.equal(
    Object.keys(globe.attributes).filter((name) => /^material\d+$/.test(name)).length,
    PHYSICAL_MATERIAL_FIELD_COUNT,
  );
  assert.equal(globe.getAttribute('material5'), undefined);
  for (let field = 0; field < PHYSICAL_MATERIAL_FIELD_COUNT; field++) {
    assert.equal(globe.getAttribute(`material${field}`).array, input.materials[field]);
  }
  const position = globe.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    assert.ok(
      Math.abs(
        Math.hypot(position.getX(i), position.getY(i), position.getZ(i)) -
          (1 + (1200 / DEFAULT_CONFIG.radius) * 26),
      ) < 2e-7,
    );
  }
  const map = fixedSurfaceGeometry(input, DEFAULT_CONFIG.radius, {
    ...appearance,
    projection: 'map',
    mapStyle: 'relief',
  });
  assert.ok(Array.from(map.getAttribute('position').array).every(Number.isFinite));
  assert.ok(map.getAttribute('material0').array instanceof Uint8Array);
  assert.equal(map.getAttribute('material0').normalized, true);
  assert.ok(map.getAttribute('packedNormal').array instanceof Int16Array);
  assert.equal(map.getAttribute('normal'), undefined);
  assert.deepEqual(input, before);
  globe.dispose();
  map.dispose();
});

test('fixed material styles retain bank texture and togglable physical coast contour', () => {
  const banks = new DataTexture(new Uint8Array(4), 1, 1);
  const nextBanks = new DataTexture(new Uint8Array(4), 1, 1);
  for (const projection of ['globe', 'map'] as const) {
    for (const mapStyle of [
      'natural',
      'relief',
      'illustrated',
      'parchment',
      'engraved',
      'painted',
    ] as const) {
      const surface = new FixedSurface(
        packet(),
        handle,
        manifest,
        {
          ...appearance,
          projection,
          ...worldSurfaceAppearance('world', mapStyle, appearance.relief),
        },
        banks,
      );
      assert.equal(surface.material.uniforms.riverbankMap.value, banks);
      assert.doesNotMatch(surface.material.vertexShader, /\bmaterial5\b/);
      assert.equal(surface.geometry.getAttribute('material5'), undefined);
      assert.equal(surface.material.userData.fixedSurfacePacketOrder, true);
      surface.setBankTexture(nextBanks);
      assert.equal(surface.material.uniforms.riverbankMap.value, nextBanks);
      surface.setCoastlines(false);
      assert.equal(surface.material.uniforms.fixedCoastlines.value, 0);
      assert.ok(surface.retainedBytes >= packet().bytes * 2);
      surface.dispose();
    }
  }
  const categorical = createFixedSurfaceMaterial(
    handle,
    { ...manifest, layer: 'biomes', mode: 'dual' },
    appearance,
    banks,
  );
  assert.equal(categorical.userData.fixedSurfacePacketOrder, true);
  categorical.dispose();
  banks.dispose();
  nextBanks.dispose();
});

test('fantasy display removes geometry relief while preserving saved heights and diagnostic settings', () => {
  const input = packet();
  const saved = structuredClone(input);
  for (const mapStyle of ['parchment', 'engraved', 'painted'] as const) {
    for (const projection of ['globe', 'map'] as const) {
      const low = fixedSurfaceGeometry(input, DEFAULT_CONFIG.radius, {
        ...appearance,
        projection,
        ...worldSurfaceAppearance('world', mapStyle, 1),
      });
      const high = fixedSurfaceGeometry(input, DEFAULT_CONFIG.radius, {
        ...appearance,
        projection,
        ...worldSurfaceAppearance('world', mapStyle, 60),
      });
      assert.deepEqual(low.getAttribute('position').array, high.getAttribute('position').array);
      const positions = low.getAttribute('position');
      for (let vertex = 0; vertex < positions.count; vertex++) {
        if (projection === 'map') {
          assert.equal(positions.getZ(vertex), 0);
        } else {
          assert.ok(
            Math.abs(
              Math.hypot(positions.getX(vertex), positions.getY(vertex), positions.getZ(vertex)) -
                1,
            ) < 1e-7,
          );
        }
      }
      low.dispose();
      high.dispose();
    }
    assert.deepEqual(worldSurfaceAppearance('biomes', mapStyle, 26), {
      mapStyle: 'natural',
      relief: 26,
    });
    assert.deepEqual(worldSurfaceAppearance('sources', mapStyle, 26), {
      mapStyle: 'natural',
      relief: 26,
    });
    assert.deepEqual(worldSurfaceAppearance('tectonics', mapStyle, 26), {
      mapStyle: 'natural',
      relief: 0,
    });
  }
  for (const mapStyle of ['natural', 'relief', 'illustrated'] as const) {
    assert.deepEqual(worldSurfaceAppearance('world', mapStyle, 26), { mapStyle, relief: 26 });
  }
  assert.deepEqual(input, saved);
});

test('appearance owner shares one material and releases it after all surface geometry', () => {
  const banks = new DataTexture(new Uint8Array(4), 1, 1);
  const nextBanks = new DataTexture(new Uint8Array(4), 1, 1);
  const shared = createFixedSurfaceMaterial(handle, manifest, appearance, banks);
  let materialDisposals = 0;
  shared.addEventListener('dispose', () => materialDisposals++);
  const first = new FixedSurface(packet(), handle, manifest, appearance, banks, shared);
  const second = new FixedSurface(packet(), handle, manifest, appearance, banks, shared);
  assert.equal(first.material, second.material);
  assert.notEqual(first.geometry, second.geometry);
  let firstGeometryDisposals = 0;
  first.geometry.addEventListener('dispose', () => firstGeometryDisposals++);
  first.dispose();
  first.dispose();
  assert.equal(firstGeometryDisposals, 1);
  assert.equal(materialDisposals, 0);
  setFixedSurfaceCoastlines(shared, false);
  setFixedSurfaceBanks(shared, nextBanks);
  assert.equal(second.material.uniforms.fixedCoastlines.value, 0);
  assert.equal(second.material.uniforms.riverbankMap.value, nextBanks);
  second.dispose();
  assert.equal(materialDisposals, 0);
  shared.dispose();
  assert.equal(materialDisposals, 1);
  banks.dispose();
  nextBanks.dispose();
});

test('standalone surface retains idempotent ownership of its private material', () => {
  const banks = new DataTexture(new Uint8Array(4), 1, 1);
  const surface = new FixedSurface(packet(), handle, manifest, appearance, banks);
  let disposed = 0;
  surface.material.addEventListener('dispose', () => disposed++);
  surface.dispose();
  surface.dispose();
  assert.equal(disposed, 1);
  banks.dispose();
});

test('maximum edge cache uses actual displaced and projected geometry without extra packet arrays', () => {
  const input = packet();
  for (let vertex = 0; vertex < input.heights.length; vertex++) {
    input.heights[vertex] = vertex % 3 === 0 ? 9000 : -100;
  }
  const before = structuredClone(input);
  const banks = new DataTexture(new Uint8Array(4), 1, 1);
  for (const projection of ['globe', 'map'] as const) {
    const surface = new FixedSurface(
      input,
      handle,
      manifest,
      {
        ...appearance,
        projection,
        mapStyle: 'relief',
        relief: 80,
      },
      banks,
    );
    const position = surface.geometry.getAttribute('position');
    const index = surface.geometry.index!;
    let measured = 0;
    for (let offset = 0; offset < index.count; offset += 3) {
      for (let edge = 0; edge < 3; edge++) {
        const a = index.getX(offset + edge);
        const b = index.getX(offset + ((edge + 1) % 3));
        measured = Math.max(
          measured,
          Math.hypot(
            position.getX(a) - position.getX(b),
            position.getY(a) - position.getY(b),
            position.getZ(a) - position.getZ(b),
          ),
        );
      }
    }
    assert.ok(Math.abs(surface.maximumEdgeLength - measured) < measured * 1e-14);
    assert.ok(surface.maximumEdgeLength > 0);
    surface.dispose();
  }
  assert.deepEqual(input, before);
  banks.dispose();
});
