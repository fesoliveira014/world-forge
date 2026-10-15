import test from 'node:test';
import assert from 'node:assert/strict';
import { DataTexture, MeshBasicMaterial, NearestFilter, ShaderMaterial, Vector3 } from 'three';
import type { CellSampleBatch, WorldHandle, WorldViewSource } from '../src/core/view/types';
import { loadSurfaceTile, TILE_TRANSITION_MS } from '../src/render/PagedTile';
import { ROOT_TILES, tileChildren, tileDirections } from '../src/render/TileGeometry';
import { loadDenseSurface, materialDirections } from '../src/render/DenseSurface';
import { regionRing } from '../src/render/PagedOverlays';

const handle = { config: { radius: 6371000, seed: 'tiles' } } as unknown as WorldHandle;
function sample(directions: Float32Array): CellSampleBatch {
  const n = directions.length / 3;
  const fields: CellSampleBatch = {
    cellIds: new Uint32Array(n),
    heights: new Float32Array(n),
    colors: new Float32Array(n * 3),
    bankLand: new Float32Array(n),
    surfaceTerrain: new Float32Array(n * 4),
    surfaceClimate: new Float32Array(n * 4),
    surfaceHabitat: new Float32Array(n * 3),
    surfaceDelta: new Float32Array(n * 4),
    surfaceWater: new Float32Array(n * 2),
    surfaceBank: new Float32Array(n * 4),
  };
  for (let i = 0; i < n; i++) {
    fields.heights[i] = 2000 + 1000 * directions[i * 3 + 1];
    fields.colors[i * 3 + (directions[i * 3] > 0 ? 0 : 2)] = 1;
    fields.surfaceTerrain[i * 4] = fields.heights[i];
    fields.surfaceTerrain[i * 4 + 1] = 1;
  }
  return fields;
}
const source = {
  sample: async (directions: Float32Array) => sample(directions),
} as unknown as WorldViewSource;
const appearance = {
  layer: 'world' as const,
  season: -1,
  mapStyle: 'natural' as const,
  projection: 'globe' as const,
  relief: 26,
};

test('first-coverage material reuses the exact geometry samples, including poles and dateline', async () => {
  for (const tile of [...ROOT_TILES, { z: 9, x: 0, y: 511 }, { z: 9, x: 511, y: 0 }]) {
    assert.deepEqual(materialDirections(tile, 17, 17), tileDirections(tile));
    const requests: number[] = [];
    const local = {
      sample: async (directions: Float32Array) => {
        requests.push(directions.length / 3);
        return sample(directions);
      },
    } as unknown as WorldViewSource;
    const surface = await loadSurfaceTile(tile, handle, local, {
      ...appearance,
      materialWidth: 17,
      materialHeight: 17,
    });
    assert.deepEqual(requests, [289], 'initial coverage must need only one snapshot query');
    const separatelySampled = await loadDenseSurface(
      tile,
      handle,
      source,
      appearance.season,
      17,
      17,
    );
    assert.deepEqual(surface.materialSize, { width: 17, height: 17 });
    for (let i = 0; i < 6; i++) {
      assert.deepEqual(
        surface.materialSurface!.textures[i].image.data,
        separatelySampled.textures[i].image.data,
      );
    }
    surface.dispose();
    separatelySampled.dispose();
  }
});

test('paged relief shares identical displaced positions between parent and child edges', async () => {
  const tile = { z: 3, x: 3, y: 4 };
  const parent = await loadSurfaceTile(tile, handle, source, appearance);
  const child = await loadSurfaceTile(tileChildren(tile)[0], handle, source, appearance);
  const a = parent.mesh.geometry.getAttribute('position');
  const b = child.mesh.geometry.getAttribute('position');
  for (let i = 0; i <= 8; i++) {
    for (let axis = 0; axis < 3; axis++) {
      assert.equal(a.getComponent(i, axis), b.getComponent(i * 2, axis));
    }
  }
  const bytes = parent.bytes;
  parent.updateEdges(15);
  assert.equal(parent.bytes, bytes);
  assert.ok(parent.mesh.geometry.drawRange.count < 16 * 16 * 6);
  let geometryDisposed = false;
  let materialDisposed = false;
  parent.mesh.geometry.addEventListener('dispose', () => {
    geometryDisposed = true;
  });
  (parent.mesh.material as MeshBasicMaterial).addEventListener('dispose', () => {
    materialDisposed = true;
  });
  parent.dispose();
  child.dispose();
  assert.ok(geometryDisposed && materialDisposed);
});

test('categorical tile colors retain category values and nearest texture filtering', async () => {
  const requests: number[] = [];
  const local = {
    sample: async (directions: Float32Array) => {
      requests.push(directions.length / 3);
      return sample(directions);
    },
  } as unknown as WorldViewSource;
  const tile = await loadSurfaceTile({ z: 1, x: 0, y: 1 }, handle, local, {
    ...appearance,
    layer: 'biomes',
    projection: 'map',
  });
  assert.deepEqual(requests, [289, 4225]);
  const texture = (tile.mesh.material as MeshBasicMaterial).map as DataTexture;
  assert.equal(texture.magFilter, NearestFilter);
  assert.equal(texture.minFilter, NearestFilter);
  const pixels = texture.image.data;
  assert.ok(pixels);
  const classes = new Set<string>();
  for (let i = 0; i < pixels.length; i += 4) {
    classes.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
  }
  assert.deepEqual(classes, new Set(['0,0,255', '255,0,0']));
  const positions = tile.mesh.geometry.getAttribute('position');
  for (let i = 0; i < positions.count; i++) {
    assert.ok(positions.getX(i) >= -Math.PI - 1e-6 && positions.getX(i) <= 0);
    assert.ok(Number.isFinite(positions.getY(i)));
  }
  tile.dispose();
});

test('regional preview keeps the requested geodesic radius at poles and across the dateline', () => {
  for (const center of [
    [0, 1, 0],
    [-1, 0, 0],
  ] as [number, number, number][]) {
    const line = regionRing(center, 100000, 6371000);
    const points = line.geometry.getAttribute('position');
    const anchor = new Vector3(...center);
    for (let i = 0; i < points.count; i++) {
      const distance = anchor.angleTo(new Vector3().fromBufferAttribute(points, i)) * 6371000;
      assert.ok(Math.abs(distance - 100000) < 0.02);
    }
    line.geometry.dispose();
    (line.material as MeshBasicMaterial).dispose();
  }
});

test('new detail morphs from the displayed parent and stops at exact sampled values', async () => {
  for (const projection of ['globe', 'map'] as const) {
    const tile = { z: 3, x: 3, y: 4 };
    const parent = await loadSurfaceTile(tile, handle, source, { ...appearance, projection });
    const child = await loadSurfaceTile(tileChildren(tile)[0], handle, source, {
      ...appearance,
      projection,
    });
    const geometry = child.mesh.geometry;
    const targets = Object.fromEntries(
      Object.entries(geometry.attributes).map(([name, attribute]) => [
        name,
        attribute.array.slice(),
      ]),
    );
    const retainedBytes = child.bytes;
    child.beginTransition(parent, 100);
    assert.ok(child.transitioning);
    const uniforms = (child.mesh.material as ShaderMaterial).uniforms;
    assert.equal(uniforms.surfaceBlend.value, 0);
    assert.equal(uniforms.surfaceParent0.value, parent.materialSurface!.textures[0]);
    assert.deepEqual(uniforms.surfaceParentUv.value.toArray(), [0.5, 0.5, 0, 0]);
    const vertex = 7 * 17 + 5;
    // Child (5,7) lies at the midpoint of the parent's (3,3)-(2,4) diagonal.
    for (const name of ['position', 'color', 'surfaceTerrain']) {
      const coarse = parent.mesh.geometry.getAttribute(name);
      const fine = geometry.getAttribute(name);
      for (let axis = 0; axis < fine.itemSize; axis++) {
        const expected = Math.fround(
          (coarse.getComponent(3 * 17 + 3, axis) + coarse.getComponent(4 * 17 + 2, axis)) / 2,
        );
        assert.equal(fine.getComponent(vertex, axis), expected, `${projection} ${name}`);
      }
    }
    const start = geometry.getAttribute('position').array.slice();
    assert.notDeepEqual(start, targets.position, 'fixture must introduce real geometric detail');
    // Geographic texture coordinates never follow the morphing/chord-interpolated mesh.
    assert.deepEqual(geometry.getAttribute('spherePosition').array, targets.spherePosition);
    assert.deepEqual(geometry.getAttribute('uv').array, targets.uv);
    child.updateTransition(100 + TILE_TRANSITION_MS / 2);
    const position = geometry.getAttribute('position');
    for (let axis = 0; axis < 3; axis++) {
      const i = vertex * 3 + axis;
      assert.equal(position.array[i], Math.fround((start[i] + targets.position[i]) / 2));
    }
    // Outer edges stay fixed against neighbors while their interiors transition.
    for (let y = 0; y <= 16; y++) {
      for (let x = 0; x <= 16; x++) {
        if (x !== 0 && x !== 16 && y !== 0 && y !== 16) {
          continue;
        }
        for (let axis = 0; axis < 3; axis++) {
          const i = (y * 17 + x) * 3 + axis;
          assert.equal(position.array[i], targets.position[i]);
        }
      }
    }
    assert.equal(child.bytes, retainedBytes, 'transition storage is reserved in the cache budget');
    assert.ok(child.updateTransition(100 + TILE_TRANSITION_MS));
    assert.equal(child.transitioning, false);
    assert.equal(uniforms.surfaceBlend.value, 1);
    assert.equal(
      uniforms.surfaceParent0.value,
      child.materialSurface!.textures[0],
      'completed transition releases parent texture references',
    );
    for (const [name, target] of Object.entries(targets)) {
      assert.deepEqual(geometry.getAttribute(name).array, target);
    }
    assert.equal(child.updateTransition(1000), false, 'idle tiles do not demand another frame');
    parent.dispose();
    child.dispose();
  }
});

test('rapid successive refinements start from the displayed intermediate surface', async () => {
  const tile = { z: 3, x: 3, y: 4 };
  const parent = await loadSurfaceTile(tile, handle, source, appearance);
  const child = await loadSurfaceTile(tileChildren(tile)[0], handle, source, appearance);
  const grandchild = await loadSurfaceTile(
    tileChildren(tileChildren(tile)[0])[0],
    handle,
    source,
    appearance,
  );
  child.beginTransition(parent, 100);
  child.updateTransition(160);
  grandchild.beginTransition(child, 160);
  const a = child.mesh.geometry.getAttribute('position');
  const b = grandchild.mesh.geometry.getAttribute('position');
  for (let axis = 0; axis < 3; axis++) {
    assert.equal(
      b.getComponent(7 * 17 + 5, axis),
      Math.fround((a.getComponent(3 * 17 + 3, axis) + a.getComponent(4 * 17 + 2, axis)) / 2),
    );
  }
  child.finishTransition();
  assert.equal(child.transitioning, false);
  assert.equal(grandchild.transitioning, true);
  grandchild.updateTransition(400);
  assert.equal(grandchild.transitioning, false);
  parent.dispose();
  child.dispose();
  grandchild.dispose();
});

test('continuous dense coastline toggle updates every world style without texture reallocation', async () => {
  for (const mapStyle of ['natural', 'relief', 'illustrated'] as const) {
    const tile = await loadSurfaceTile({ z: 3, x: 3, y: 4 }, handle, source, {
      ...appearance,
      mapStyle,
    });
    const uniforms = (tile.mesh.material as ShaderMaterial).uniforms;
    const textures = tile.materialSurface!.textures.map((texture) => texture.uuid);
    const bytes = tile.bytes;
    assert.equal(uniforms.surfaceCoastlines.value, 0);
    tile.setCoastlines(true);
    assert.equal(uniforms.surfaceCoastlines.value, 1);
    tile.setCoastlines(false);
    assert.equal(uniforms.surfaceCoastlines.value, 0);
    assert.equal(tile.bytes, bytes);
    assert.deepEqual(
      tile.materialSurface!.textures.map((texture) => texture.uuid),
      textures,
    );
    tile.dispose();
  }
});

test('dense slope lighting uses the displayed physical relief and map shear scales', async () => {
  for (const projection of ['globe', 'map'] as const) {
    for (const mapStyle of ['natural', 'relief', 'illustrated'] as const) {
      const tile = await loadSurfaceTile({ z: 3, x: 3, y: 4 }, handle, source, {
        ...appearance,
        projection,
        mapStyle,
      });
      const uniforms = (tile.mesh.material as ShaderMaterial).uniforms;
      const expected =
        (appearance.relief / handle.config.radius) *
        (projection === 'globe' ? 1 : mapStyle === 'relief' ? 4 : 0);
      assert.equal(uniforms.surfaceHeightScale.value, expected);
      assert.equal(uniforms.surfaceHeightShear.value, projection === 'map' ? 0.8 : 0);
      tile.dispose();
    }
  }
});
