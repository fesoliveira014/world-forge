import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { PhysicalMeshPacket } from '../src/core/view/physical-mesh-types';
import type { WorldHandle } from '../src/core/view/types';
import {
  FantasySymbolCandidates,
  FantasySymbolPlacements,
  FantasySymbols,
  fantasySymbolGeometry,
  type FantasySymbol,
} from '../src/render/FantasySymbols';

const handle = {
  config: { radius: 6371000 },
  summary: { maximumHeight: 7000 },
} as WorldHandle;
const styles = ['parchment', 'engraved', 'painted'] as const;
const projections = ['globe', 'map'] as const;
type MutableSymbol = Omit<FantasySymbol, 'direction'> & { direction: [number, number, number] };

function direction(longitude: number, latitude: number): [number, number, number] {
  return [
    Math.cos(latitude) * Math.cos(longitude),
    Math.sin(latitude),
    Math.cos(latitude) * Math.sin(longitude),
  ];
}

function fixture(): MutableSymbol[] {
  const width = 0.04;
  const sizeY = 0.03;
  const latitude = 0.2;
  const extent = Math.hypot(width / 2, sizeY) / Math.cos(latitude);
  return [
    [0.3, -0.4],
    [Math.PI - extent - 1e-10, latitude],
    [Math.PI - extent + 1e-10, latitude],
    [-Math.PI + extent - 1e-10, latitude],
    [-Math.PI + extent + 1e-10, latitude],
    [1.4, Math.PI / 2],
  ].map(([longitude, lat], index) => ({
    direction: direction(longitude, lat),
    height: 1200 + index * 100,
    width,
    sizeY,
    rotation: index * 0.025,
    tile: index,
    kind: 'mountain',
  }));
}

function renderValues(symbols: readonly FantasySymbol[]) {
  return symbols.map(({ direction, width, sizeY, rotation, tile }) => ({
    direction: [...direction],
    width,
    sizeY,
    rotation,
    tile,
  }));
}

const placementsOf = (view: FantasySymbols) => view.placements;

function geometryData(geometry: THREE.InstancedBufferGeometry) {
  return {
    instanceCount: geometry.instanceCount,
    index: geometry.index!.array.slice(),
    attributes: Object.fromEntries(
      Object.entries(geometry.attributes).map(([name, attribute]) => [
        name,
        {
          itemSize: attribute.itemSize,
          normalized: attribute.normalized,
          data: attribute.array.slice(),
        },
      ]),
    ),
  };
}

function withCanvas(run: () => void) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const context = new Proxy(
    {},
    {
      get: (_target, property) =>
        property === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => undefined,
      set: () => true,
    },
  );
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => ({ width: 0, height: 0, getContext: () => context }) },
  });
  try {
    run();
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, 'document', descriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }
  }
}

function forestPacket(wet = false): PhysicalMeshPacket {
  const points = [
    [0.004, 0.004],
    [0.018, 0.006],
    [0.01, 0.019],
  ];
  const materials = Array.from({ length: 5 }, () => new Uint8Array(12));
  for (let vertex = 0; vertex < 3; vertex++) {
    materials[0][vertex * 4 + 2] = wet ? 0 : 255;
    materials[0][vertex * 4 + 3] = 255;
    materials[1][vertex * 4] = 255;
    materials[4][vertex * 4 + 2] = wet ? 255 : 0;
  }
  return {
    batch: wet ? 1 : 0,
    mode: 'primal',
    directions: Float32Array.from(points.flatMap(([lon, lat]) => direction(lon, lat))),
    heights: new Float32Array(3).fill(wet ? 0 : 120),
    normals: new Int16Array(),
    colors: new Uint8Array(),
    materials,
    indices: new Uint16Array([0, 1, 2]),
    bytes: 0,
  };
}

test('prepared placements copy full-precision values and preserve projection geometry at seam thresholds', () => {
  const symbols = fixture();
  const expected = renderValues(symbols);
  const placements = new FantasySymbolPlacements(symbols);
  assert.equal(placements.count, symbols.length);
  assert.equal(placements.bytes, symbols.length * 49);
  assert.deepEqual(Array.from(placements), expected);
  for (const projection of projections) {
    const original = fantasySymbolGeometry(symbols, projection);
    const prepared = fantasySymbolGeometry(placements, projection);
    assert.deepEqual(geometryData(prepared), geometryData(original));
    if (projection === 'map') {
      assert.equal(
        original.instanceCount,
        symbols.length + 2,
        'only the two crossing footprints wrap',
      );
    }
    original.dispose();
    prepared.dispose();
  }
  for (const symbol of symbols) {
    symbol.direction.fill(0);
    symbol.width = 0;
    symbol.tile = 15;
  }
  assert.deepEqual(
    Array.from(placements),
    expected,
    'the completed asset retains no source objects',
  );
});

test('all fantasy styles and projections reuse completed placements without collecting or selecting again', () => {
  withCanvas(() => {
    const symbols = fixture();
    const placements = new FantasySymbolPlacements(symbols);
    const before = Array.from(placements);
    const addPacket = FantasySymbolCandidates.prototype.addPacket;
    const finish = FantasySymbolCandidates.prototype.finish;
    FantasySymbolCandidates.prototype.addPacket = () =>
      assert.fail('cached views must not collect packets');
    FantasySymbolCandidates.prototype.finish = () =>
      assert.fail('cached views must not select symbols');
    try {
      for (const mapStyle of styles) {
        for (const projection of projections) {
          const view = new FantasySymbols(handle, { mapStyle, projection }, placements);
          assert.equal(view.reusedPlacements, true);
          assert.equal(
            view.bytes,
            0,
            'cache hits allocate no collector or duplicate placement storage',
          );
          assert.equal(
            view.placements,
            null,
            'the view publishes only after successful completion',
          );
          view.addPacket(forestPacket());
          view.finish();
          view.finish();
          assert.equal(view.ready, true);
          assert.equal(view.placements, placements);
          assert.equal(view.count, placements.count);
          assert.equal(view.children.length, 1);
          const mesh = view.children[0] as THREE.Mesh<
            THREE.InstancedBufferGeometry,
            THREE.ShaderMaterial
          >;
          const expected = fantasySymbolGeometry(symbols, projection);
          assert.deepEqual(geometryData(mesh.geometry), geometryData(expected));
          expected.dispose();
          const texture = mesh.material.uniforms.atlas.value as THREE.Texture;
          assert.equal(texture.name, `fantasy-symbols-${mapStyle}`);
          let disposed = 0;
          mesh.geometry.addEventListener('dispose', () => disposed++);
          mesh.material.addEventListener('dispose', () => disposed++);
          texture.addEventListener('dispose', () => disposed++);
          view.dispose();
          view.dispose();
          assert.equal(
            disposed,
            3,
            'each view disposes its own geometry, material, and atlas once',
          );
          assert.equal(view.placements, null);
          assert.equal(view.bytes, 0);
          assert.deepEqual(
            Array.from(placements),
            before,
            'view teardown leaves the shared asset intact',
          );
        }
      }
    } finally {
      FantasySymbolCandidates.prototype.addPacket = addPacket;
      FantasySymbolCandidates.prototype.finish = finish;
    }
  });
});

test('partial and aborted streams never expose a reusable placement asset', () => {
  withCanvas(() => {
    const aborted = new FantasySymbols(handle, { projection: 'globe', mapStyle: 'parchment' });
    assert.equal(aborted.placements, null);
    assert.equal(aborted.reusedPlacements, false);
    aborted.addPacket(forestPacket());
    assert.equal(aborted.ready, false);
    assert.equal(aborted.placements, null);
    aborted.dispose();
    aborted.finish();
    assert.equal(aborted.placements, null);
    assert.equal(aborted.bytes, 0);

    const completed = new FantasySymbols(handle, { projection: 'globe', mapStyle: 'parchment' });
    completed.addPacket(forestPacket());
    assert.equal(completed.placements, null);
    completed.finish();
    const asset = placementsOf(completed);
    assert.ok(asset && asset.count > 0);
    assert.ok(completed.bytes < 10 * 1024 * 1024, 'completion releases the temporary collector');
    completed.finish();
    assert.equal(completed.placements, asset, 'completion publishes exactly one asset');
    completed.dispose();
    assert.ok(asset.count > 0, 'the cache owner can retain completed data after view teardown');
  });
});

test('failed view preparation never publishes its internally completed selection', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => ({ width: 0, height: 0, getContext: () => null }) },
  });
  const view = new FantasySymbols(handle, { projection: 'globe', mapStyle: 'parchment' });
  try {
    view.addPacket(forestPacket());
    assert.throws(() => view.finish(), /2D canvas is required/);
    assert.equal(view.ready, false);
    assert.equal(view.placements, null);
  } finally {
    view.dispose();
    if (descriptor) {
      Object.defineProperty(globalThis, 'document', descriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }
  }
});

test('late water protection completes before publication and an empty completed result remains reusable', () => {
  withCanvas(() => {
    const view = new FantasySymbols(handle, { projection: 'map', mapStyle: 'painted' });
    view.addPacket(forestPacket());
    assert.equal(view.placements, null);
    view.addPacket(forestPacket(true));
    view.finish();
    const asset = placementsOf(view);
    assert.ok(asset);
    assert.equal(asset.count, 0);
    assert.equal(asset.bytes, 0);
    assert.equal(view.count, 0);
    assert.equal(view.children.length, 0);
    assert.equal(view.bytes, 0, 'completed empty selection releases its collector');
    view.dispose();
    const reused = new FantasySymbols(handle, { projection: 'globe', mapStyle: 'engraved' }, asset);
    assert.equal(reused.reusedPlacements, true);
    reused.addPacket(forestPacket());
    reused.finish();
    assert.equal(reused.placements, asset);
    assert.equal(reused.count, 0, 'empty cache hits cannot restart selection');
    assert.equal(reused.bytes, 0);
    reused.dispose();
  });
});
