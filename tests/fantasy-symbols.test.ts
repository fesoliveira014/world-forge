import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { PhysicalMeshPacket } from '../src/core/view/physical-mesh-types';
import type { WorldHandle } from '../src/core/view/types';
import { FantasyWaterMask } from '../src/render/FantasyLandCover';
import {
  FantasySymbolCandidates,
  FantasySymbols,
  fantasySymbolGeometry,
} from '../src/render/FantasySymbols';

const degree = Math.PI / 180;
function packet(
  points: number[][],
  options: {
    forest?: boolean;
    vegetation?: number;
    wet?: number;
    ocean?: boolean;
    slope?: number;
    triangles?: number[];
  } = {},
): PhysicalMeshPacket {
  const directions: number[] = [];
  const heights: number[] = [];
  const normals: number[] = [];
  const materials = Array.from({ length: 5 }, () => new Uint8Array(points.length * 4));
  for (let vertex = 0; vertex < points.length; vertex++) {
    const [longitude, latitude, height] = points[vertex];
    const lon = longitude * degree;
    const lat = latitude * degree;
    const d = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)];
    directions.push(...d);
    heights.push(height);
    const n = [
      d[0] - (options.slope ?? 0) * Math.sin(lon),
      d[1],
      d[2] + (options.slope ?? 0) * Math.cos(lon),
    ];
    const sum = Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]);
    let x = n[0] / sum;
    let y = n[1] / sum;
    if (n[2] < 0) {
      const previousX = x;
      x = (1 - Math.abs(y)) * (x < 0 ? -1 : 1);
      y = (1 - Math.abs(previousX)) * (y < 0 ? -1 : 1);
    }
    normals.push(Math.round(x * 32767), Math.round(y * 32767));
    materials[0][vertex * 4 + 2] = options.ocean || options.wet ? 0 : 255;
    materials[0][vertex * 4 + 3] = options.vegetation ?? 255;
    materials[1][vertex * 4] = options.forest ? 255 : 0;
    materials[1][vertex * 4 + 1] = 145;
    materials[4][vertex * 4 + 2] = options.ocean ? 255 : 0;
    materials[4][vertex * 4 + 3] = options.wet ?? 0;
  }
  return {
    batch: 0,
    mode: 'primal',
    directions: Float32Array.from(directions),
    heights: Float32Array.from(heights),
    normals: Int16Array.from(normals),
    colors: new Uint8Array(),
    materials,
    indices: Uint16Array.from(options.triangles ?? [0, 1, 2]),
    bytes: 0,
  };
}
const mountain = () => {
  const points: number[][] = [];
  const triangles: number[] = [];
  const size = 24;
  for (let y = 0; y <= size; y++) {
    for (let x = 0; x <= size; x++) {
      const lon = -6 + x * 0.5;
      const lat = -6 + y * 0.5;
      points.push([lon, lat, 500 + 4200 * Math.exp(-((lat - Math.sin(lon / 3)) ** 2))]);
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = y * (size + 1) + x;
      const b = a + 1;
      const c = a + size + 1;
      const d = c + 1;
      triangles.push(a, b, c, b, d, c);
    }
  }
  return packet(points, { triangles });
};
const forest = () =>
  packet(
    [
      [12, 3, 120],
      [15, 3, 120],
      [15, 6, 120],
      [12, 6, 120],
    ],
    { forest: true, triangles: [0, 1, 2, 0, 2, 3] },
  );
function collect(...packets: PhysicalMeshPacket[]) {
  const collector = new FantasySymbolCandidates(6371000, 7000);
  for (const item of packets) {
    collector.addPacket(item);
  }
  return collector.finish();
}

test('fantasy selection distinguishes mountain relief, flat plateaus and real forest vegetation', () => {
  const mountains = collect(mountain());
  assert.ok(mountains.length > 3);
  assert.equal(mountains[0].kind, 'mountain');
  assert.ok(
    mountains[0].width > degree && mountains[0].width < 3 * degree,
    'connected ridges use smaller overlapping peaks',
  );
  assert.deepEqual(
    collect(
      packet([
        [0.4, 0.4, 5000],
        [1.3, 0.5, 5000],
        [0.8, 1.2, 5000],
      ]),
    ),
    [],
    'a high flat plateau does not turn into a mountain field',
  );
  assert.equal(
    collect(
      packet(
        [
          [0.4, 0.4, 5000],
          [1.3, 0.5, 5000],
          [0.8, 1.2, 5000],
        ],
        { slope: 0.03 },
      ),
    ).length,
    0,
    'slope normals alone cannot invent a ridge without surrounding height support',
  );
  assert.equal(collect(forest())[0].kind, 'forest');
  const noClass = forest();
  noClass.materials[1].fill(0);
  assert.deepEqual(collect(noClass), [], 'vegetation alone cannot invent forest');
  const bare = forest();
  for (let v = 0; v < bare.heights.length; v++) {
    bare.materials[0][v * 4 + 3] = 80;
  }
  assert.deepEqual(collect(bare), [], 'forest class also requires meaningful cover');
  const partialLake = forest();
  for (let v = 0; v < partialLake.heights.length; v++) {
    partialLake.materials[4][v * 4 + 3] = 1;
  }
  assert.deepEqual(
    collect(partialLake),
    collect(forest()),
    'a 1/255 lake fraction does not erase dry forest',
  );
  for (let v = 0; v < partialLake.heights.length; v++) {
    partialLake.materials[4][v * 4 + 3] = 200;
  }
  assert.deepEqual(collect(partialLake), [], 'the rendered lake interior is protected');
});

test('tree identities stay seasonal-invariant and degenerate polar triangles invent no forest area', () => {
  const summer = forest();
  const winter = structuredClone(summer);
  for (let v = 0; v < winter.heights.length; v++) {
    winter.materials[1][v * 4 + 1] = 75;
    winter.materials[1][v * 4 + 2] = 12;
  }
  assert.deepEqual(
    collect(winter),
    collect(summer),
    'seasonal temperature changes do not switch tree illustrations',
  );
  const pole = packet(
    [
      [0, 90, 50],
      [120, 90, 50],
      [-120, 90, 50],
    ],
    { forest: true },
  );
  const symbols = collect(pole);
  assert.equal(symbols.length, 0);
});

test('fixed geographic winners are independent of packet order, duplicates and source mutations', () => {
  const a = mountain();
  const b = forest();
  const before = structuredClone([a, b]);
  const result = collect(a, b);
  assert.deepEqual(collect(b, a, b, a), result);
  const collector = new FantasySymbolCandidates(6371000, 7000);
  const retainedBytes = collector.bytes;
  collector.addPacket(a);
  collector.addPacket(b);
  assert.equal(
    collector.bytes,
    retainedBytes,
    'bounded typed bins do not grow with physical vertex count',
  );
  assert.ok(retainedBytes < 8 * 1024 * 1024);
  assert.deepEqual([a, b], before);
  a.directions.fill(0);
  a.heights.fill(0);
  b.materials.forEach((field) => field.fill(0));
  assert.deepEqual(collector.finish(), result, 'only copied candidate data is retained');
});

test('late wet triangles protect complete glyph footprints across refinement, datelines and polar arcs', () => {
  const land = packet(
    [
      [0.4, 0.4, 120],
      [1.3, 0.5, 120],
      [0.8, 1.2, 120],
    ],
    { forest: true },
  );
  const wet = packet(
    [
      [0.5, 0.5, 0],
      [1.5, 0.5, 0],
      [1, 1.5, 0],
    ],
    { ocean: true },
  );
  assert.equal(collect(land).length, 1);
  assert.deepEqual(collect(land, wet), []);
  assert.deepEqual(collect(wet, land), []);
  const subdivided = packet(
    [
      [0.5, 0.5, 0],
      [1.5, 0.5, 0],
      [1, 1.5, 0],
      [1, 0.5, 0],
      [1.25, 1, 0],
      [0.75, 1, 0],
    ],
    { ocean: true, triangles: [0, 3, 5, 3, 1, 4, 5, 4, 2, 3, 4, 5] },
  );
  assert.deepEqual(
    collect(land, subdivided),
    [],
    'refining wet cells never weakens fixed-distance clearance',
  );
  const datelineLand = packet(
    [
      [179, 0, 120],
      [181, 0, 120],
      [180, 2, 120],
    ],
    { forest: true },
  );
  const datelineWater = packet(
    [
      [178, -1, 0],
      [182, -1, 0],
      [180, 4, 0],
    ],
    { ocean: true },
  );
  assert.ok(collect(datelineLand).length > 0);
  assert.deepEqual(collect(datelineLand, datelineWater), []);
  // These vertices lie at80N, but their geodesic triangle covers the pole.
  const polarWater = packet(
    [
      [-120, 80, 0],
      [0, 80, 0],
      [120, 80, 0],
    ],
    { ocean: true },
  );
  const polarLand = packet(
    [
      [-120, 88, 120],
      [0, 88, 120],
      [120, 88, 120],
    ],
    { forest: true },
  );
  assert.ok(collect(polarLand).length > 0);
  assert.deepEqual(collect(polarWater, polarLand), []);
});

test('single instanced geometry preserves smooth globe anchors and clips dateline copies without world-sized quads', () => {
  const symbols = [
    {
      direction: [Math.cos(179.8 * degree), 0, Math.sin(179.8 * degree)] as const,
      width: 2 * degree,
      sizeY: degree,
      rotation: 0,
      tile: 10,
    },
  ];
  const globe = fantasySymbolGeometry(symbols, 'globe');
  const map = fantasySymbolGeometry(symbols, 'map');
  assert.equal(globe.instanceCount, symbols.length);
  assert.equal(map.instanceCount, symbols.length * 2);
  assert.equal(globe.getAttribute('position').count, 4);
  assert.equal(globe.index!.count, 6);
  for (let i = 0; i < globe.instanceCount; i++) {
    assert.equal(globe.getAttribute('symbolAnchor').getW(i), Math.fround(1.00004));
  }
  assert.deepEqual(Array.from(map.getAttribute('longitudeShift').array), [
    0,
    Math.fround(-Math.PI * 2),
  ]);
  for (const item of [globe, map]) {
    for (const field of Object.values(item.attributes)) {
      assert.ok(Array.from(field.array).every(Number.isFinite));
    }
    item.dispose();
  }
});

test('symbol lifecycle owns one atlas/draw, releases temporary bins and detaches cleanly', () => {
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
    const handle = { config: { radius: 6371000 }, summary: { maximumHeight: 7000 } } as WorldHandle;
    const symbols = new FantasySymbols(handle, { projection: 'map', mapStyle: 'parchment' });
    const scene = new THREE.Scene();
    scene.add(symbols);
    symbols.addPacket(mountain());
    symbols.addPacket(forest());
    symbols.finish();
    symbols.finish();
    assert.equal(symbols.ready, true);
    assert.ok(symbols.count > 3);
    assert.equal(symbols.children.length, 1);
    assert.equal(symbols.renderOrder, 0);
    const mesh = symbols.children[0] as THREE.Mesh<
      THREE.InstancedBufferGeometry,
      THREE.ShaderMaterial
    >;
    assert.equal(mesh.renderOrder, 1, 'ink draws before rivers/grid order2');
    assert.ok(
      symbols.bytes > 9 * 1024 * 1024 && symbols.bytes < 10 * 1024 * 1024,
      'CPU atlas plus GPU mip chain and instance arrays are counted',
    );
    const geometry = mesh.geometry;
    const anchors = geometry.getAttribute('symbolAnchor').array.slice();
    let disposed = 0;
    geometry.addEventListener('dispose', () => disposed++);
    mesh.material.addEventListener('dispose', () => disposed++);
    (mesh.material.uniforms.atlas.value as THREE.Texture).addEventListener(
      'dispose',
      () => disposed++,
    );
    const count = symbols.count;
    symbols.addPacket(mountain());
    assert.equal(symbols.count, count);
    assert.deepEqual(geometry.getAttribute('symbolAnchor').array, anchors);
    symbols.dispose();
    symbols.dispose();
    assert.equal(disposed, 3);
    assert.equal(symbols.parent, null);
    assert.equal(symbols.children.length, 0);
    assert.equal(symbols.bytes, 0);
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, 'document', descriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }
  }
});

function forestRegion(size = 12, vegetation = 255, subdivisions = 1, height = 120) {
  const points: number[][] = [];
  const triangles: number[] = [];
  for (let y = 0; y <= subdivisions; y++) {
    for (let x = 0; x <= subdivisions; x++) {
      points.push([
        -size / 2 + (x * size) / subdivisions,
        -size / 2 + (y * size) / subdivisions,
        height,
      ]);
    }
  }
  for (let y = 0; y < subdivisions; y++) {
    for (let x = 0; x < subdivisions; x++) {
      const a = y * (subdivisions + 1) + x;
      const b = a + 1;
      const c = a + subdivisions + 1;
      triangles.push(a, b, c, b, c + 1, c);
    }
  }
  return packet(points, { forest: true, vegetation, slope: 0.04, triangles });
}

test('rainforest area fills with a stable canopy, woodland density tracks cover and highland forest remains present', () => {
  const rainforest = collect(forestRegion());
  const woodland = collect(forestRegion(12, 115));
  const highland = collect(forestRegion(12, 255, 1, 1700));
  assert.ok(
    rainforest.length >= 230,
    `closed canopy should cover the whole 12-degree region, got ${rainforest.length}`,
  );
  assert.ok(
    woodland.length > rainforest.length * 0.25 && woodland.length < rainforest.length * 0.65,
  );
  assert.equal(
    highland.length,
    rainforest.length,
    'slope/height does not erase real forest on mountain shoulders and plateaus',
  );
  for (const symbol of highland) {
    assert.ok(symbol.tile >= 6 && symbol.tile <= 9);
  }
  for (const symbol of rainforest) {
    assert.ok(symbol.tile >= 10 && symbol.tile <= 13);
  }
  // Eight 1.5-degree bands each contain a canopy: density is area coverage,
  // not a few disconnected highest-vegetation winners across large bins.
  for (let band = 0; band < 8; band++) {
    assert.ok(
      rainforest.filter((symbol) => {
        const latitude = Math.asin(symbol.direction[1]) / degree;
        return latitude >= -6 + band * 1.5 && latitude < -6 + (band + 1) * 1.5;
      }).length >= 24,
    );
  }
});

test('forest anchors and density survive exact physical triangle subdivision', () => {
  const coarse = forestRegion();
  const points = Array.from({ length: coarse.heights.length }, (_, id) =>
    Array.from(coarse.directions.subarray(id * 3, id * 3 + 3)),
  );
  const indices: number[] = [];
  for (let face = 0; face < coarse.indices.length; face += 3) {
    const ids = Array.from(coarse.indices.subarray(face, face + 3));
    const mid = ids.map((id, i) => {
      const next = ids[(i + 1) % 3];
      const p = points[id].map((v, axis) => v + points[next][axis]);
      const length = Math.hypot(...p);
      points.push(p.map((v) => v / length));
      return points.length - 1;
    });
    indices.push(ids[0], mid[0], mid[2], mid[0], ids[1], mid[1], mid[2], mid[1], ids[2], ...mid);
  }
  const refined = packet(
    points.map((p) => [
      Math.atan2(p[2], p[0]) / degree,
      Math.atan2(p[1], Math.hypot(p[0], p[2])) / degree,
      120,
    ]),
    { forest: true, triangles: indices },
  );
  assert.deepEqual(collect(refined), collect(coarse));
  assert.deepEqual(collect(refined, coarse, refined), collect(coarse));
});

test('a mixed coastal triangle protects its wet portion without erasing nearby dry forests', () => {
  const dryForest = forest();
  const mixed = packet(
    [
      [10, 0, 100],
      [30, 0, -100],
      [10, 20, 100],
    ],
    { triangles: [0, 1, 2] },
  );
  mixed.materials[4][1 * 4 + 2] = 255;
  mixed.materials[0][1 * 4 + 2] = 0;
  const original = collect(dryForest);
  assert.ok(original.length >= 10);
  assert.deepEqual(
    collect(mixed, dryForest),
    original,
    'a far wet corner must not cover the whole coastal triangle with water',
  );
  assert.deepEqual(collect(dryForest, mixed), original);
});

test('forest and vegetation from different corners support real interior canopy', () => {
  const mixed = packet(
    [
      [-6, -6, 120],
      [6, -6, 120],
      [0, 6, 120],
    ],
    { forest: true },
  );
  mixed.materials[0][3] = 80;
  mixed.materials[1][4] = 80;
  mixed.materials[1][8] = 80;
  const result = collect(mixed);
  assert.ok(
    result.length > 10,
    `triangle-interior canopy should survive separate attribute maxima, got ${result.length}`,
  );
  assert.ok(result.every((symbol) => symbol.kind === 'forest'));
});

test('complete placement keeps continuous coastal ranges while their visible ink stays on land', () => {
  for (const side of [-1, 1]) {
    const points: number[][] = [];
    const triangles: number[] = [];
    const columns = 57;
    const rows = 41;
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const lon = -14 + column * 0.5;
        const lat = -10 + row * 0.5;
        const taper = Math.exp(-(Math.max(0, Math.abs(lon) - 10) ** 2) / 5);
        const height = 180 + 4400 * Math.exp(-(((lat + side * 1.1) / 1.2) ** 2)) * taper;
        points.push([lon, lat, height]);
        if (row + 1 < rows && column + 1 < columns) {
          const a = row * columns + column;
          triangles.push(a, a + 1, a + columns, a + 1, a + columns + 1, a + columns);
        }
      }
    }
    const coastal = packet(points, { triangles });
    for (let id = 0; id < points.length; id++) {
      const ocean = Math.round(Math.max(0, Math.min(1, (points[id][1] * side + 0.25) / 0.5)) * 255);
      coastal.materials[4][id * 4 + 2] = ocean;
      coastal.materials[0][id * 4 + 2] = 255 - ocean;
    }
    const symbols = collect(coastal);
    assert.ok(
      symbols.length >= 24,
      `coastal range ${side} retained only ${symbols.length} symbols`,
    );
    const longitudes = symbols
      .map((symbol) => Math.atan2(symbol.direction[2], symbol.direction[0]) / degree)
      .sort((a, b) => a - b);
    assert.ok(longitudes[0] < -10 && longitudes.at(-1)! > 10);
    assert.ok(
      longitudes.slice(1).every((lon, index) => lon - longitudes[index] < 1.8),
      'water clearance must preserve a connected coastline range',
    );
    for (const symbol of symbols) {
      const lat = Math.asin(symbol.direction[1]);
      for (const x of [-0.44, 0.44]) {
        for (const y of [-0.33, 0.54]) {
          const north =
            Math.sin(symbol.rotation) * x * symbol.width +
            Math.cos(symbol.rotation) * y * symbol.sizeY;
          assert.ok(
            (lat + north) * side < 0,
            'the full conservative ink rectangle stays on the dry side of the coast',
          );
        }
      }
    }
  }
});

test('coastal mountain footprints fit both flat and globe projections at the pole', () => {
  const polarAngle = 89 * degree;
  const rotate = (p: readonly number[]) => [
    p[0] * Math.cos(polarAngle) - p[1] * Math.sin(polarAngle),
    p[0] * Math.sin(polarAngle) + p[1] * Math.cos(polarAngle),
    p[2],
  ];
  const spherical = (lon: number, lat: number) => [
    Math.cos(lat) * Math.cos(lon),
    Math.sin(lat),
    Math.cos(lat) * Math.sin(lon),
  ];
  const waterPoints = [
    [-14, 0],
    [14, 0],
    [14, 10],
    [-14, 10],
  ].map(([lon, lat]) => rotate(spherical(lon * degree, lat * degree)));
  const water = packet(
    waterPoints.map((p) => [
      Math.atan2(p[2], p[0]) / degree,
      Math.atan2(p[1], Math.hypot(p[0], p[2])) / degree,
      0,
    ]),
    { ocean: true, triangles: [0, 1, 2, 0, 2, 3] },
  );
  const mask = new FantasyWaterMask();
  for (const ids of [
    [0, 1, 2],
    [0, 2, 3],
  ]) {
    mask.addTriangle(
      water,
      ids,
      ids.map((id) => waterPoints[id]),
    );
  }
  for (const longitude of [-10, -5, 0, 5, 10]) {
    const anchor = rotate(spherical(longitude * degree, -1.1 * degree));
    const lon = Math.atan2(anchor[2], anchor[0]);
    const lat = Math.atan2(anchor[1], Math.hypot(anchor[0], anchor[2]));
    const east = [-Math.sin(lon), 0, Math.cos(lon)];
    const north = [
      -anchor[1] * Math.cos(lon),
      Math.hypot(anchor[0], anchor[2]),
      -anchor[1] * Math.sin(lon),
    ];
    const [widthScale, heightScale] = mask.fitMountain(anchor, 4 * degree, 4 * degree, 0);
    assert.ok(widthScale > 0 && heightScale > 0);
    for (let row = 0; row <= 8; row++) {
      for (let column = 0; column <= 8; column++) {
        const x = (-0.44 + (column * 0.88) / 8) * 4 * degree * widthScale;
        const y = (-0.33 + (row * 0.87) / 8) * 4 * degree * heightScale;
        const globe = anchor.map((v, axis) => v + east[axis] * x + north[axis] * y);
        const projections = [globe];
        if (Math.abs(lat + y) <= Math.PI / 2) {
          projections.push(spherical(lon + x / Math.max(0.12, Math.cos(lat)), lat + y));
        }
        for (const point of projections) {
          const coastNorth = -point[0] * Math.sin(polarAngle) + point[1] * Math.cos(polarAngle);
          assert.ok(
            coastNorth < 0,
            `ink crossed the same coast under a different projection at longitude ${longitude}`,
          );
        }
      }
    }
  }
});
