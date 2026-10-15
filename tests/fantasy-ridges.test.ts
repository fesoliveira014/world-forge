import assert from 'node:assert/strict';
import test from 'node:test';
import type { PhysicalMeshPacket } from '../src/core/view/physical-mesh-types';
import { FantasyRidgeField } from '../src/render/FantasyRidges';
import { FANTASY_MOUNTAIN_SINGLE_TILES } from '../src/render/FantasySymbolAtlas';

const DEGREE = Math.PI / 180;
const RADIUS = 6371000;
type Height = (longitude: number, latitude: number) => number;
type Symbol = ReturnType<FantasyRidgeField['finish']>[number];
type Center = readonly [longitude: number, latitude: number];

function basis([longitude, latitude]: Center) {
  const lon = longitude * DEGREE;
  const lat = latitude * DEGREE;
  return [
    [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)],
    [-Math.sin(lat) * Math.cos(lon), Math.cos(lat), -Math.sin(lat) * Math.sin(lon)],
    [-Math.sin(lon), 0, Math.cos(lon)],
  ];
}

/** Analytic heights live on an ordinary saved spherical triangle mesh. Rotating
 * that same mesh tests the dateline/poles without changing its physical relief. */
function terrain(
  height: Height,
  options: { west?: number; east?: number; step?: number; center?: Center } = {},
): PhysicalMeshPacket {
  const west = options.west ?? -14;
  const east = options.east ?? 14;
  const step = options.step ?? 0.5;
  const columns = Math.round((east - west) / step) + 1;
  const rows = Math.round(20 / step) + 1;
  const count = columns * rows;
  const axes = basis(options.center ?? [0, 0]);
  const directions = new Float32Array(count * 3);
  const heights = new Float32Array(count);
  const materials = Array.from({ length: 5 }, () => new Uint8Array(count * 4));
  const indices: number[] = [];
  for (let row = 0; row < rows; row++) {
    const latitude = -10 + row * step;
    const lat = latitude * DEGREE;
    for (let column = 0; column < columns; column++) {
      const longitude = west + column * step;
      const lon = longitude * DEGREE;
      const vertex = row * columns + column;
      const local = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)];
      for (let axis = 0; axis < 3; axis++) {
        directions[vertex * 3 + axis] = local.reduce(
          (sum, component, componentIndex) => sum + component * axes[componentIndex][axis],
          0,
        );
      }
      heights[vertex] = height(longitude, latitude);
      materials[0][vertex * 4 + 2] = 255;
      if (row + 1 < rows && column + 1 < columns) {
        const a = vertex;
        const b = a + 1;
        const c = a + columns;
        const d = c + 1;
        // Longitude then latitude has inward winding in this coordinate basis.
        indices.push(a, c, d, a, d, b);
      }
    }
  }
  const result: PhysicalMeshPacket = {
    batch: 0,
    mode: 'primal',
    directions,
    heights,
    normals: new Int16Array(),
    colors: new Uint8Array(),
    materials,
    indices: Uint16Array.from(indices),
    bytes: 0,
  };
  result.bytes = [directions, heights, result.indices, ...materials].reduce(
    (sum, value) => sum + value.byteLength,
    0,
  );
  return result;
}

function coordinates(symbol: Symbol, center: Center = [0, 0]) {
  const local = basis(center).map((axis) =>
    axis.reduce((sum, component, index) => sum + component * symbol.direction[index], 0),
  );
  return [
    Math.atan2(local[2], local[0]) / DEGREE,
    Math.atan2(local[1], Math.hypot(local[0], local[2])) / DEGREE,
  ];
}

function collect(...packets: PhysicalMeshPacket[]) {
  const field = new FantasyRidgeField(RADIUS, 700);
  packets.forEach((packet) => field.addPacket(packet));
  return field.finish();
}

const ridgeLatitude = (longitude: number) => 2.8 * Math.sin(longitude / 4.5);
const taper = (longitude: number) => Math.exp(-(Math.max(0, Math.abs(longitude) - 10) ** 2) / 5);
const curvedRidge: Height = (longitude, latitude) =>
  180 +
  3800 *
    Math.exp(-((latitude - ridgeLatitude(longitude)) ** 2) / 2) *
    taper(longitude) *
    (0.9 + 0.1 * Math.cos(longitude / 5));

test('mountain marks follow a curved physical ridge instead of filling geographic rows', () => {
  const symbols = collect(terrain(curvedRidge));
  assert.ok(symbols.length >= 4, 'a long range contains multiple separated ridge marks');
  const points = symbols.map((symbol) => coordinates(symbol));
  assert.ok(points.some(([lon]) => lon < -5));
  assert.ok(points.some(([lon]) => lon > 5));
  assert.ok(Math.max(...points.map(([, lat]) => lat)) > 1.5);
  assert.ok(Math.min(...points.map(([, lat]) => lat)) < -1.5);
  for (let index = 0; index < symbols.length; index++) {
    const symbol = symbols[index];
    const [lon, lat] = points[index];
    assert.ok(Math.abs(lat - ridgeLatitude(lon)) < 1.5, 'anchor stays near the curved crest');
    assert.equal(symbol.kind, 'mountain');
    assert.ok(Math.abs(symbol.rotation) <= 20 * DEGREE + 1e-6, 'peaks remain upright');
    assert.ok(symbol.width > 0 && symbol.sizeY > 0);
    assert.ok(Number.isInteger(symbol.chain) && symbol.chain >= 0);
  }
});

test('parallel mountain ranges keep separate chains across a deep intervening valley', () => {
  const parallel: Height = (lon, lat) =>
    160 +
    3900 * Math.max(Math.exp(-((lat - 4) ** 2) / 2), Math.exp(-((lat + 4) ** 2) / 2)) * taper(lon);
  const symbols = collect(terrain(parallel));
  const northern = new Set<number>();
  const southern = new Set<number>();
  for (const symbol of symbols) {
    const [, lat] = coordinates(symbol);
    assert.ok(Math.abs(Math.abs(lat) - 4) < 1.5, 'no marks decorate the deep saddle');
    (lat > 0 ? northern : southern).add(symbol.chain);
  }
  assert.ok(northern.size > 0 && southern.size > 0, 'both physical ranges remain represented');
  assert.ok(
    [...northern].every((chain) => !southern.has(chain)),
    'paths never bridge the valley',
  );
});

test('flat plateaus and broad constant slopes do not become mountain carpets', () => {
  assert.deepEqual(collect(terrain(() => 4500)), [], 'altitude alone is not a ridge');
  assert.deepEqual(
    collect(terrain((lon) => 15000 + 500 * lon)),
    [],
    'a steep monotone plane has no bilateral crest prominence',
  );
});

test('an isolated dome produces a summit mark instead of an invented multi-peak range', () => {
  const dome: Height = (lon, lat) =>
    180 + 4800 * Math.exp(-((lon - 0.35) ** 2 + (lat + 0.25) ** 2) / (2 * 1.2 ** 2));
  for (const center of [
    [0, 0],
    [179, 0],
    [30, 82],
  ] as const) {
    const symbols = collect(terrain(dome, { center }));
    assert.equal(symbols.length, 1, `one physical summit remains one mark at ${center}`);
    const [lon, lat] = coordinates(symbols[0], center);
    assert.ok(Math.hypot(lon - 0.35, lat + 0.25) < 1.25, 'mark identifies the physical summit');
    assert.ok(
      (FANTASY_MOUNTAIN_SINGLE_TILES as readonly number[]).includes(symbols[0].tile),
      'an isolated summit uses a single-peak drawing',
    );
  }
});

test('ridge selection is packet-order independent, bounded, and owns copied geographic data', () => {
  const west = terrain(curvedRidge, { east: 0 });
  const east = terrain(curvedRidge, { west: 0 });
  const before = structuredClone([west, east]);
  const expected = collect(west, east);
  assert.ok(expected.length > 0);
  assert.deepEqual(collect(east, west, west, east), expected);
  const field = new FantasyRidgeField(RADIUS, 700);
  const initialBytes = field.bytes;
  field.addPacket(west);
  field.addPacket(east);
  assert.equal(field.bytes, initialBytes, 'retained storage does not grow with physical vertices');
  assert.ok(field.bytes <= 6 * 1024 * 1024, 'the global support field has a bounded memory budget');
  assert.deepEqual([west, east], before, 'stream collection never changes the saved packets');
  for (const packet of [west, east]) {
    packet.directions.fill(0);
    packet.heights.fill(0);
    packet.indices.fill(0);
    packet.materials.forEach((values) => values.fill(0));
  }
  assert.deepEqual(field.finish(), expected, 'completed selection retains no source buffers');
});

test('subdividing the same analytic range does not increase mountain density or move its chain', () => {
  const coarse = collect(terrain(curvedRidge));
  const refined = collect(terrain(curvedRidge, { step: 0.25 }));
  assert.ok(coarse.length > 0);
  assert.equal(refined.length, coarse.length, 'subdivision does not add mountain marks');
  assert.deepEqual(
    refined.map(({ tile, chain }) => ({ tile, chain })),
    coarse.map(({ tile, chain }) => ({ tile, chain })),
    'physical sample count cannot turn the fixed geographic ridge into a denser row of marks',
  );
  for (let index = 0; index < coarse.length; index++) {
    const distance = Math.hypot(
      ...coarse[index].direction.map((value, axis) => value - refined[index].direction[axis]),
    );
    assert.ok(
      distance < 1e-8,
      'continuous anchors agree within six centimetres on an Earth-sized sphere',
    );
  }
});

test('ridge selection remains geographic and finite at the dateline and near the pole', () => {
  for (const center of [
    [179, 0],
    [30, 82],
  ] as const) {
    const symbols = collect(terrain(curvedRidge, { center }));
    assert.ok(symbols.length >= 2, 'moving the same range does not erase it');
    for (const symbol of symbols) {
      assert.ok(
        [...symbol.direction, symbol.height, symbol.width, symbol.sizeY, symbol.rotation].every(
          Number.isFinite,
        ),
      );
      assert.ok(Math.abs(Math.hypot(...symbol.direction) - 1) < 1e-5);
      const [lon, lat] = coordinates(symbol, center);
      assert.ok(
        Math.abs(lat - ridgeLatitude(lon)) < 1.75,
        'projection seams do not move the crest',
      );
    }
    if (center[0] === 179) {
      assert.ok(symbols.some((symbol) => Math.atan2(symbol.direction[2], symbol.direction[0]) > 0));
      assert.ok(symbols.some((symbol) => Math.atan2(symbol.direction[2], symbol.direction[0]) < 0));
    }
  }
});

test('taller local summits along a narrow range remain part of long connected chains', () => {
  // Six taller peaks share one curved mountain belt, with high saddles between
  // them. A local height maximum must not be mistaken for an isolated dome.
  const periodicSummits: Height = (lon, lat) =>
    500 +
    (3500 + 1500 * (1 + Math.cos(lon * 1.2))) *
      Math.exp(-(((lat - 2 * Math.sin(lon / 5)) / 1.6) ** 2)) *
      Math.exp(-((lon / 16) ** 8));
  const symbols = collect(terrain(periodicSummits, { west: -20, east: 20 }));
  assert.ok(symbols.length > 0, 'the physical mountain belt remains represented');
  const chains = new Map<number, Symbol[]>();
  for (const symbol of symbols) {
    const members = chains.get(symbol.chain) ?? [];
    members.push(symbol);
    chains.set(symbol.chain, members);
  }
  let marksInLongChains = 0;
  for (const members of chains.values()) {
    const longitudes = members.map((symbol) => coordinates(symbol)[0]);
    // Ten degrees span several physical summits. This permits normal path
    // splitting while rejecting short fragments around each individual peak.
    if (Math.max(...longitudes) - Math.min(...longitudes) >= 10) {
      marksInLongChains += members.length;
    }
  }
  assert.ok(
    marksInLongChains / symbols.length >= 0.8,
    'most mountains must belong to ranges spanning several local summits',
  );
  const longitudes = symbols.map((symbol) => coordinates(symbol)[0]);
  assert.ok(Math.min(...longitudes) < -10 && Math.max(...longitudes) > 10);
});

test('broad mountain belts retain dense crests and high shoulders in both geographic orientations', () => {
  const crest = (along: number) => 1.3 * Math.sin(along / 6);
  for (const northSouth of [false, true]) {
    const broad: Height = (lon, lat) => {
      const along = northSouth ? lat : lon;
      const across = northSouth ? lon : lat;
      const end = northSouth
        ? Math.exp(-(Math.max(0, Math.abs(along) - 7) ** 2) / 5)
        : taper(along);
      return (
        180 +
        (4200 + 1000 * Math.cos(along * 0.65)) *
          Math.exp(-(((across - crest(along)) / 3.8) ** 2)) *
          end
      );
    };
    const symbols = collect(terrain(broad));
    const points = symbols.map((symbol) => {
      const [lon, lat] = coordinates(symbol);
      return northSouth ? [lat, lon] : [lon, lat];
    });
    // The saddles are part of a continuous high massif, rather than empty
    // gaps between the few individually prominent summits.
    for (let along = -7; along <= 7; along++) {
      assert.ok(
        points.some(([a, b]) => Math.hypot(a - along, b - crest(along)) < 1.5),
        `the ${northSouth ? 'north–south' : 'east–west'} crest remains represented at ${along}°`,
      );
    }
    const shoulders = points.filter(([a, b]) => Math.abs(a) < 7 && Math.abs(b - crest(a)) > 1);
    assert.ok(
      shoulders.length >= 15,
      'broad high shoulders receive subsidiary peaks, not one sparse centerline',
    );
    assert.ok(
      symbols.some((symbol) => symbol.sizeY > 2.5 * DEGREE),
      'primary mountain silhouettes are prominent at regional scale',
    );
    assert.ok(symbols.length < 300, 'coverage remains a bounded geographic illustration');
  }
});

test('finite high mountain caps retain their interior while an unbounded plateau stays empty', () => {
  const capped: Height = (lon, lat) =>
    180 +
    4500 *
      Math.exp(-(Math.max(0, Math.abs(lat) - 2.5) ** 2) / 2) *
      Math.exp(-(Math.max(0, Math.abs(lon) - 9) ** 2) / 3);
  const symbols = collect(terrain(capped));
  const points = symbols.map((symbol) => coordinates(symbol));
  for (let lon = -7; lon <= 7; lon += 2) {
    assert.ok(
      points.some(([x, y]) => Math.hypot(x - lon, y) < 1.6),
      `a high flat saddle within the bounded massif remains represented at ${lon}°`,
    );
  }
  assert.deepEqual(
    collect(terrain(() => 4680)),
    [],
    'height without surrounding mountain relief stays undecorated',
  );
});

test('coastal mountain profiles use the ocean-side relief without placing peaks in water', () => {
  const coastal = terrain(
    (lon, lat) => 180 + 4400 * Math.exp(-(((lat + 1.1) / 1.2) ** 2)) * taper(lon),
  );
  for (let vertex = 0; vertex < coastal.heights.length; vertex++) {
    const lat = Math.asin(coastal.directions[vertex * 3 + 1]) / DEGREE;
    const ocean = Math.round(Math.max(0, Math.min(1, (lat + 0.25) / 0.5)) * 255);
    coastal.materials[4][vertex * 4 + 2] = ocean;
    coastal.materials[0][vertex * 4 + 2] = 255 - ocean;
  }
  const symbols = collect(coastal);
  const points = symbols.map((symbol) => coordinates(symbol));
  assert.ok(
    symbols.length >= 20,
    'a long coastal mountain belt does not disappear when its cross-section reaches ocean',
  );
  assert.ok(points.some(([lon]) => lon < -7) && points.some(([lon]) => lon > 7));
  for (const [, lat] of points) {
    assert.ok(lat < 0, 'all anchors remain on the dry side of the shoreline');
  }
});

test('high mountain ranges remain disconnected across an intervening water body', () => {
  const divided = terrain((lon, lat) => 180 + 4600 * Math.exp(-((lat / 2) ** 2)) * taper(lon));
  for (let vertex = 0; vertex < divided.heights.length; vertex++) {
    const lon =
      Math.atan2(divided.directions[vertex * 3 + 2], divided.directions[vertex * 3]) / DEGREE;
    if (Math.abs(lon) <= 1.1) {
      divided.materials[4][vertex * 4 + 3] = 255;
    }
  }
  const symbols = collect(divided);
  const west = new Set<number>();
  const east = new Set<number>();
  for (const symbol of symbols) {
    const [lon] = coordinates(symbol);
    assert.ok(Math.abs(lon) > 1, 'water never becomes a supported saddle');
    (lon < 0 ? west : east).add(symbol.chain);
  }
  assert.ok(west.size > 0 && east.size > 0);
  assert.ok(
    [...west].every((chain) => !east.has(chain)),
    'no range connects across the lake',
  );
});
