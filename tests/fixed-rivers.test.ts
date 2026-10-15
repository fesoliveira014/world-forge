import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Color, Mesh, ShaderMaterial, Vector3 } from 'three';
import type { FixedRiverBatch } from '../src/core/view/river-render-types';
import { riverCurvatureLimits } from '../src/core/view/river-width-limits';
import type { WorldHandle } from '../src/core/view/types';
import {
  buildFixedRiverGeometry,
  FixedRivers,
  paintFixedRiverBanks,
  type FixedRiverAppearance,
} from '../src/render/FixedRivers';
import { RiverRibbon } from '../src/render/RiverRibbon';
import type { WaterSurface } from '../src/render/WaterSurface';
import { FANTASY_PALETTES } from '../src/render/FantasyStyle';

const radius = 6371000;
const handle = { config: { radius } } as WorldHandle;
const appearance: FixedRiverAppearance = {
  projection: 'globe',
  relief: 24,
  mapStyle: 'natural',
  layer: 'world',
  riverWidth: 1,
};
const point = (longitude: number, latitude = 0) => [
  Math.cos(latitude) * Math.cos(longitude),
  Math.sin(latitude),
  Math.cos(latitude) * Math.sin(longitude),
];

function packet(paths: number[][][], kinds = paths.map(() => 0)): FixedRiverBatch {
  const points = paths.flat();
  const offsets = [0];
  for (const path of paths) {
    offsets.push(offsets[offsets.length - 1] + path.length);
  }
  return {
    batch: 0,
    totalBatches: 1,
    totalBytes: 0,
    totalPaths: paths.length,
    totalPoints: points.length,
    offsets: Uint32Array.from(offsets),
    incoming: new Float32Array(paths.length * 3),
    positions: Float32Array.from(points.flat()),
    heights: new Float32Array(points.length).fill(125),
    halfWidths: new Float32Array(points.length).fill(0.002),
    phase: Float32Array.from(points.map((_, index) => -0.5 + index * 0.05)),
    activity: Float32Array.from(points.map((_, index) => 0.25 + index * 0.1)),
    sources: new Uint8Array(points.length).fill(4),
    kinds: Uint8Array.from(kinds),
    bankWidths: new Float32Array(points.length * 2),
    bankColors: new Float32Array(points.length * 8),
  };
}

test('straight persistent ribbons retain original widths and all styling attributes', () => {
  const batch = packet([[point(-0.3), point(-0.15), point(0), point(0.1)]]);
  const geometry = buildFixedRiverGeometry(batch, radius, appearance);
  const oldRibbon = new RiverRibbon({
    place(value: Vector3, lift: number) {
      return value.normalize().multiplyScalar(1 + (125 / radius) * appearance.relief + lift);
    },
  } as WaterSurface);
  oldRibbon.addPath(
    Array.from(batch.heights, (_, index) => ({
      position: new Vector3().fromArray(batch.positions, index * 3).normalize(),
      width: batch.halfWidths[index],
      phase: batch.phase[index],
      activity: batch.activity[index],
      source: batch.sources[index],
    })),
  );
  const original = oldRibbon.buildGeometry();
  assert.deepEqual(Array.from(geometry.index!.array), Array.from(original.index!.array));
  assert.ok(geometry.index!.array instanceof Uint16Array, 'small meshes keep compact indices');
  for (const name of ['position', 'uv', 'activity', 'sourceId']) {
    const actual = geometry.getAttribute(name).array;
    const expected = original.getAttribute(name).array;
    assert.equal(actual.length, expected.length);
    for (let component = 0; component < actual.length; component++) {
      assert.ok(Math.abs(actual[component] - expected[component]) < 1e-7, `${name} ${component}`);
    }
  }
  assert.equal(geometry.userData.paths, 1);
  assert.equal(geometry.userData.segments, 3);
  assert.equal(geometry.index!.count, 18, 'three connected spans share their cross-sections');
  original.dispose();
  geometry.dispose();
});

test('large connected batches retain all indices beyond the 16-bit vertex limit', () => {
  const path = Array.from({ length: 22000 }, (_, index) =>
    point(-0.7 + index * 0.0001, index % 2 ? 0.0002 : -0.0002),
  );
  const geometry = buildFixedRiverGeometry(packet([path]), radius, appearance);
  assert.ok(geometry.getAttribute('position').count > 65535);
  assert.ok(geometry.index!.array instanceof Uint32Array);
  let maximumIndex = 0;
  for (const index of geometry.index!.array) {
    maximumIndex = Math.max(maximumIndex, index);
  }
  assert.equal(maximumIndex, geometry.getAttribute('position').count - 1);
  assert.equal(geometry.userData.segments, path.length - 1);
  geometry.dispose();
});

test('wide high-resolution meanders respect geometric width limits without dropping path or styling samples', () => {
  // Actual 2.6M-cell regression: 19 km half-widths previously overpainted bends
  // whose radius was only 2.2 km, exposing large animated triangular overlaps.
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/tight-river.json', import.meta.url), 'utf8'),
  ) as { positions: number[]; halfWidths: number[] };
  const path = Array.from({ length: fixture.positions.length / 3 }, (_, index) =>
    fixture.positions.slice(index * 3, index * 3 + 3),
  );
  const batch = packet([path]);
  batch.halfWidths.set(fixture.halfWidths);
  batch.activity.fill(1);
  const originalPositions = batch.positions.slice();
  const limits = riverCurvatureLimits(batch.positions);
  assert.ok(Math.max(...limits) < 0.001, 'the whole short meander needs a narrower stroke');
  const geometry = buildFixedRiverGeometry(batch, radius, { ...appearance, riverWidth: 3 });
  const positions = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  const center = new Vector3();
  const edge = new Vector3();
  const tangent = new Vector3();
  const guide = new Vector3();
  const normal = new Vector3();
  const seen = new Set<number>();
  for (let vertex = 0; vertex < positions.count; vertex++) {
    const pointIndex = Math.round((uv.getX(vertex) + 0.5) / 0.05);
    seen.add(pointIndex);
    center.fromArray(batch.positions, pointIndex * 3).normalize();
    edge.fromBufferAttribute(positions, vertex).normalize();
    tangent.copy(edge).divideScalar(center.dot(edge)).sub(center);
    for (const neighbor of [pointIndex - 1, pointIndex + 1]) {
      if (neighbor >= 0 && neighbor < path.length) {
        guide.fromArray(batch.positions, neighbor * 3).normalize();
        normal.crossVectors(guide, center).normalize();
        assert.ok(
          Math.abs(tangent.dot(normal)) <= limits[pointIndex] + 1e-7,
          'the slider cannot widen a span beyond its curvature ceiling',
        );
      }
    }
    assert.equal(geometry.getAttribute('sourceId').getX(vertex), batch.sources[pointIndex]);
    assert.equal(geometry.getAttribute('activity').getX(vertex), batch.activity[pointIndex]);
  }
  assert.equal(seen.size, path.length);
  assert.equal(geometry.userData.segments, path.length - 1);
  assert.deepEqual(batch.positions, originalPositions);
  assert.ok(
    batch.halfWidths.every((width) => width === Math.fround(0.003)),
    'physical packet widths stay immutable',
  );
  geometry.dispose();

  // Independent coverage oracle: a joined water strip paints each interior
  // location once. The old inner bevel/rectangles covered some pixels five times.
  const map = buildFixedRiverGeometry(batch, radius, { ...appearance, projection: 'map' });
  const mapped = map.getAttribute('position');
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let vertex = 0; vertex < mapped.count; vertex++) {
    minX = Math.min(minX, mapped.getX(vertex));
    maxX = Math.max(maxX, mapped.getX(vertex));
    minY = Math.min(minY, mapped.getY(vertex));
    maxY = Math.max(maxY, mapped.getY(vertex));
  }
  let covered = 0;
  let maximumCoverage = 0;
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 128; x++) {
      const px = minX + ((x + 0.37) / 128) * (maxX - minX);
      const py = minY + ((y + 0.59) / 128) * (maxY - minY);
      let coverage = 0;
      for (let face = 0; face < map.index!.count; face += 3) {
        const a = map.index!.getX(face);
        const b = map.index!.getX(face + 1);
        const c = map.index!.getX(face + 2);
        const ax = mapped.getX(a);
        const ay = mapped.getY(a);
        const bx = mapped.getX(b);
        const by = mapped.getY(b);
        const cx = mapped.getX(c);
        const cy = mapped.getY(c);
        const determinant = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(determinant) < 1e-20) {
          continue;
        }
        const first = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / determinant;
        const second = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / determinant;
        if (Math.min(first, second, 1 - first - second) > 1e-8) {
          coverage++;
        }
      }
      if (coverage > 0) {
        covered++;
        maximumCoverage = Math.max(maximumCoverage, coverage);
      }
    }
  }
  assert.ok(covered > 100, 'the coverage oracle samples a substantial part of the stroke');
  assert.equal(
    maximumCoverage,
    1,
    'adjacent spans and the outside bevel never overpaint an interior',
  );
  map.dispose();
});

test('subdividing a straight channel does not reduce its original display width', () => {
  for (const count of [2, 129]) {
    const batch = packet([
      Array.from({ length: count }, (_, index) => point(0.3 + (0.001 * index) / (count - 1))),
    ]);
    batch.halfWidths.fill(0.003);
    const geometry = buildFixedRiverGeometry(batch, radius, appearance);
    const positions = geometry.getAttribute('position');
    const center = new Vector3().fromArray(batch.positions).normalize();
    const edge = new Vector3().fromBufferAttribute(positions, 0).normalize();
    const angle = Math.atan2(new Vector3().crossVectors(center, edge).length(), center.dot(edge));
    assert.ok(Math.abs(angle - Math.atan(0.003)) < 1e-7);
    assert.equal(geometry.userData.segments, count - 1);
    geometry.dispose();
  }
});

test('batch continuation fills the same junction as an unsplit connected path', () => {
  const path = [point(-0.2), point(0, 0.1), point(0.2)];
  const whole = buildFixedRiverGeometry(packet([path]), radius, appearance);
  const firstPacket = packet([path.slice(0, 2)]);
  firstPacket.outgoing = Float32Array.from(path[2]);
  const first = buildFixedRiverGeometry(firstPacket, radius, appearance);
  const nextPacket = packet([path.slice(1)]);
  nextPacket.incoming.set(path[0]);
  const next = buildFixedRiverGeometry(nextPacket, radius, appearance);
  assert.equal(first.index!.count + next.index!.count, whole.index!.count);
  const trianglePositions = (geometry: typeof whole) => {
    const positions = geometry.getAttribute('position');
    return Array.from(geometry.index!.array, (vertex) => [
      positions.getX(vertex),
      positions.getY(vertex),
      positions.getZ(vertex),
    ]).flat();
  };
  const actual = [...trianglePositions(first), ...trianglePositions(next)];
  const expected = trianglePositions(whole);
  assert.equal(actual.length, expected.length);
  for (let component = 0; component < actual.length; component++) {
    assert.ok(Math.abs(actual[component] - expected[component]) < 1e-7);
  }
  for (const geometry of [whole, first, next]) {
    geometry.dispose();
  }
});

test('prepared tight-meander limits preserve triangles and flow coordinates across batch boundaries', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/tight-river.json', import.meta.url), 'utf8'),
  ) as { positions: number[]; halfWidths: number[] };
  const path = Array.from({ length: fixture.positions.length / 3 }, (_, index) =>
    fixture.positions.slice(index * 3, index * 3 + 3),
  );
  const complete = packet([path]);
  complete.halfWidths.set(fixture.halfWidths);
  complete.curvatureLimits = riverCurvatureLimits(complete.positions);
  const slice = (start: number, end: number) => {
    const batch = packet([path.slice(start, end)]);
    batch.heights = complete.heights.slice(start, end);
    batch.halfWidths = complete.halfWidths.slice(start, end);
    batch.curvatureLimits = complete.curvatureLimits!.slice(start, end);
    batch.phase = complete.phase.slice(start, end);
    batch.activity = complete.activity.slice(start, end);
    batch.sources = complete.sources.slice(start, end);
    if (start > 0) {
      batch.incoming.set(path[start - 1]);
    }
    batch.outgoing = Float32Array.from(end < path.length ? path[end] : [0, 0, 0]);
    return batch;
  };
  const firstPacket = slice(0, 14);
  const nextPacket = slice(13, path.length);
  assert.equal(firstPacket.curvatureLimits![13], nextPacket.curvatureLimits![0]);
  assert.ok(nextPacket.curvatureLimits![0] < nextPacket.halfWidths[0]);

  for (const projection of ['globe', 'map'] as const) {
    const options = { ...appearance, projection, riverWidth: 3 };
    const whole = buildFixedRiverGeometry(complete, radius, options);
    const first = buildFixedRiverGeometry(firstPacket, radius, options);
    const next = buildFixedRiverGeometry(nextPacket, radius, options);
    assert.equal(first.index!.count + next.index!.count, whole.index!.count);
    for (const name of ['position', 'uv', 'activity', 'sourceId']) {
      const triangleValues = (geometry: typeof whole) => {
        const attribute = geometry.getAttribute(name);
        return Array.from(geometry.index!.array, (vertex) =>
          Array.from({ length: attribute.itemSize }, (_, component) =>
            attribute.getComponent(vertex, component),
          ),
        ).flat();
      };
      assert.deepEqual(
        [...triangleValues(first), ...triangleValues(next)],
        triangleValues(whole),
        `${projection} ${name} is unchanged when a capped bend crosses a batch boundary`,
      );
    }
    for (const geometry of [whole, first, next]) {
      geometry.dispose();
    }
  }
});

test('unequal refined spans partition concave quads without reversed triangles or batch seams', () => {
  // Actual AETHER-6389 refinement: an 8.3 m span carries a 1.54 km display
  // half-width. Trimming its inner joins makes the span quad concave.
  const path = [
    [-0.05254016071557999, 0.7079535126686096, 0.7043020129203796],
    [-0.05253662168979645, 0.7079499363899231, 0.70430588722229],
    [-0.05253591388463974, 0.7079492211341858, 0.7043067216873169],
    [-0.05253520980477333, 0.7079484462738037, 0.704307496547699],
  ];
  const complete = packet([path]);
  complete.heights.set([
    1024.4771728515625, 1024.30029296875, 1024.2642822265625, 1024.2286376953125,
  ]);
  complete.halfWidths.set([
    0.00037751064519397914, 0.00039048175676725805, 0.0003930934180971235, 0.00039568651118315756,
  ]);
  complete.curvatureLimits = Float32Array.from([
    0.00024114253756124526, 0.0002409520384389907, 0.0002409128355793655, 0.00024087377823889256,
  ]);
  const slice = (start: number, end: number) => ({
    ...complete,
    offsets: Uint32Array.from([0, end - start]),
    positions: complete.positions.slice(start * 3, end * 3),
    heights: complete.heights.slice(start, end),
    halfWidths: complete.halfWidths.slice(start, end),
    curvatureLimits: complete.curvatureLimits!.slice(start, end),
    phase: complete.phase.slice(start, end),
    activity: complete.activity.slice(start, end),
    sources: complete.sources.slice(start, end),
    incoming: Float32Array.from(start ? path[start - 1] : [0, 0, 0]),
    outgoing: Float32Array.from(end < path.length ? path[end] : [0, 0, 0]),
  });
  for (const projection of ['globe', 'map'] as const) {
    const options = { ...appearance, projection, relief: 26 };
    const whole = buildFixedRiverGeometry(complete, radius, options);
    const first = buildFixedRiverGeometry(slice(0, 2), radius, options);
    const next = buildFixedRiverGeometry(slice(1, 4), radius, options);
    const positions = whole.getAttribute('position');
    for (let face = 0; face < whole.index!.count; face += 3) {
      const [a, b, c] = [0, 1, 2].map((corner) =>
        new Vector3().fromBufferAttribute(positions, whole.index!.getX(face + corner)),
      );
      const normal = b.sub(a).cross(c.sub(a));
      assert.ok(
        projection === 'globe' ? normal.dot(a) <= 0 : normal.z >= 0,
        `${projection} faces partition the span with consistent winding`,
      );
    }
    assert.equal(whole.userData.segments, 3);
    for (const name of ['position', 'uv', 'activity', 'sourceId', 'riverKind']) {
      const triangleValues = (geometry: typeof whole) => {
        const attribute = geometry.getAttribute(name);
        return Array.from(geometry.index!.array, (vertex) =>
          Array.from({ length: attribute.itemSize }, (_, component) =>
            attribute.getComponent(vertex, component),
          ),
        ).flat();
      };
      assert.deepEqual(
        [...triangleValues(first), ...triangleValues(next)],
        triangleValues(whole),
        `${projection} ${name} remains identical across the concave span's batch boundary`,
      );
    }
    for (const geometry of [whole, first, next]) {
      geometry.dispose();
    }
  }
});

test('map seam and polar ribbons remain local and finite, and coincident anchors allocate no spans', () => {
  const batch = packet([
    [point(3.12, 0.1), point(-3.12, 0.12), point(-3.05, 0.16)],
    [point(0, Math.PI / 2 - 0.03), point(1, Math.PI / 2), point(2, Math.PI / 2 - 0.03)],
    [point(1), point(1), point(1)],
  ]);
  const geometry = buildFixedRiverGeometry(batch, radius, { ...appearance, projection: 'map' });
  assert.equal(geometry.userData.paths, 2);
  assert.equal(geometry.userData.segments, 4);
  const positions = geometry.getAttribute('position');
  for (const attribute of Object.values(geometry.attributes)) {
    for (const component of attribute.array) {
      assert.ok(Number.isFinite(component));
    }
  }
  for (let face = 0; face < geometry.index!.count; face += 3) {
    const longitudes = [0, 1, 2].map((corner) =>
      positions.getX(geometry.index!.getX(face + corner)),
    );
    assert.ok(
      Math.max(...longitudes) - Math.min(...longitudes) <= Math.PI + 1e-6,
      'no face stretches across the map interior',
    );
  }
  assert.equal(geometry.userData.mapCopies, undefined, 'immutable meshes release seam recipes');
  geometry.dispose();
});

test('physical bank atlas is asymmetric, interpolated, local, premultiplied and idempotent', () => {
  const batch = packet([[point(-0.35), point(0.35)]]);
  batch.bankWidths.set([0.15, 0.05, 0.15, 0.05]);
  batch.bankColors.set([1, 0, 0, 0.86, 0, 0, 1, 0.86, 0, 1, 0, 0.86, 0, 0, 1, 0.86]);
  const width = 512;
  const height = 256;
  const data = new Uint8Array(width * height * 4);
  paintFixedRiverBanks(data, width, height, batch);
  let painted = 0;
  let below = 0;
  let above = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const alpha = data[offset + 3];
      if (alpha) {
        painted++;
        if (y < height / 2) {
          below++;
        } else {
          above++;
        }
      }
      assert.ok(data[offset] <= alpha && data[offset + 1] <= alpha && data[offset + 2] <= alpha);
    }
  }
  assert.ok(painted > 500 && painted < width * height * 0.03, 'only the curve corridor is colored');
  assert.ok(below > above * 2, 'left and right physical bank widths remain distinct');
  const centerBelow = ((height / 2 - 2) * width + width / 2) * 4;
  assert.ok(
    data[centerBelow] > 80 && data[centerBelow + 1] > 80 && data[centerBelow + 2] === 0,
    'habitat pigment interpolates along the bank',
  );
  const centerAbove = ((height / 2 + 1) * width + width / 2) * 4;
  assert.ok(data[centerAbove + 2] > 100 && data[centerAbove] === 0);
  const copy = data.slice();
  paintFixedRiverBanks(data, width, height, batch);
  assert.deepEqual(data, copy, 'overlapping arrivals do not accumulate darker banks');
});

test('bank capsules wrap at the dateline without coloring the map interior', () => {
  const batch = packet([[point(3.1, 0.2), point(-3.1, 0.2)]]);
  batch.bankWidths.fill(0.08);
  batch.bankColors.fill(0.8);
  const width = 512;
  const height = 256;
  const data = new Uint8Array(width * height * 4);
  paintFixedRiverBanks(data, width, height, batch);
  let west = 0;
  let east = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]) {
        assert.ok(x < 15 || x > width - 15);
        if (x < width / 2) {
          west++;
        } else {
          east++;
        }
      }
    }
  }
  assert.ok(west > 0 && east > 0);
});

test('bank-only batches paint without water geometry and defer GPU uploads until flushed', () => {
  const batch = packet([[point(-0.2), point(0, 0.1), point(0.2)]], [4]);
  batch.bankWidths.fill(0.01);
  batch.bankColors.fill(0.8);
  const rivers = new FixedRivers(handle, appearance);
  const version = rivers.bankTexture.version;
  rivers.addBatch(batch, { deferBankUpload: true });
  assert.equal(rivers.children.length, 0, 'bank-only packets create no empty draw objects');
  assert.equal(rivers.pathCount, 0);
  assert.equal(rivers.segmentCount, 0);
  const data = rivers.bankTexture.image.data as Uint8Array;
  assert.ok(
    data.some((component) => component > 0),
    'bank-only curves still paint the atlas',
  );
  assert.equal(rivers.bankTexture.version, version, 'CPU arrivals do not request GPU uploads');
  assert.equal(rivers.flushBanks(), true);
  assert.equal(rivers.bankTexture.version, version + 1);
  assert.equal(rivers.flushBanks(), false);
  assert.equal(rivers.bankTexture.version, version + 1, 'unchanged atlases do not rebuild mipmaps');

  const unchanged = { ...batch, batch: 1 };
  rivers.addBatch(unchanged);
  assert.equal(rivers.bankTexture.version, version + 1, 'identical coverage needs no upload');
  const additional = packet([[point(0.5), point(0.7)]], [4]);
  additional.batch = 2;
  additional.bankWidths.fill(0.01);
  additional.bankColors.fill(0.8);
  rivers.addBatch(additional);
  assert.equal(rivers.bankTexture.version, version + 2, 'standalone batches upload by default');
  rivers.setAppearance({ ...appearance, projection: 'map', riverWidth: 3 });
  assert.equal(rivers.children.length, 0);
  assert.equal(rivers.pathCount, 0);
  assert.equal(rivers.segmentCount, 0);
  rivers.dispose();
  assert.equal(rivers.flushBanks(), false);
});

test('persistent owner updates appearance locally, freezes animation and disposes all owned resources', () => {
  const batch = packet(
    [
      [point(-0.2), point(0, 0.1), point(0.2)],
      [point(-0.2, -0.2), point(0.2, -0.2)],
    ],
    [0, 2],
  );
  const rivers = new FixedRivers(handle, appearance);
  rivers.addBatch(batch);
  rivers.addBatch(batch);
  assert.equal(rivers.children.length, 1, 'batch arrivals are idempotent');
  assert.equal(rivers.pathCount, 2);
  assert.equal(rivers.segmentCount, 3);
  const mesh = rivers.children[0] as Mesh;
  const material = mesh.material as ShaderMaterial;
  const original = mesh.geometry;
  const originalPositions = Array.from(original.getAttribute('position').array);
  const kind = original.getAttribute('riverKind');
  const atlas = rivers.bankTexture;
  let replaced = 0;
  original.addEventListener('dispose', () => replaced++);
  rivers.setAppearance({ ...appearance, riverWidth: 3, layer: 'sources' });
  assert.equal(replaced, 1);
  const widened = mesh.geometry.getAttribute('position');
  let changedRiver = false;
  for (let vertex = 0; vertex < kind.count; vertex++) {
    for (let component = 0; component < 3; component++) {
      const before = originalPositions[vertex * 3 + component];
      const after = widened.getComponent(vertex, component);
      if (kind.getX(vertex) === 2) {
        assert.equal(after, before, 'the display width slider does not widen physical oxbow scars');
      } else if (after !== before) {
        changedRiver = true;
      }
    }
  }
  assert.ok(changedRiver);
  assert.equal(material.uniforms.sourceMode.value, true);
  const globeGeometry = mesh.geometry;
  rivers.setAppearance({ ...appearance, riverWidth: 3, mapStyle: 'relief' });
  assert.equal(
    mesh.geometry,
    globeGeometry,
    'globe style changes update uniforms without rebuilding geometry',
  );
  assert.equal(material.uniforms.reliefMode.value, true);
  assert.equal(material.depthTest, false);
  assert.equal(material.depthWrite, false);
  assert.match(
    material.fragmentShader,
    /dot\(normalize\(surfacePoint\), cameraPosition - surfacePoint\) <= 0\.0/,
  );
  rivers.animate(1);
  rivers.animate(2, false);
  assert.equal(material.uniforms.time.value, 1);
  rivers.animate(3, true, 2);
  assert.equal(material.uniforms.time.value, 3);
  rivers.setAppearance({ ...appearance, projection: 'map', mapStyle: 'illustrated' });
  assert.equal(material.uniforms.flatView.value, true);
  assert.equal(material.uniforms.inkMode.value, true);
  assert.equal(rivers.bankTexture, atlas);
  assert.ok(rivers.bytes > 4096 * 2048 * 4 * 2);
  let geometryDisposed = 0;
  let materialDisposed = 0;
  let atlasDisposed = 0;
  mesh.geometry.addEventListener('dispose', () => geometryDisposed++);
  material.addEventListener('dispose', () => materialDisposed++);
  atlas.addEventListener('dispose', () => atlasDisposed++);
  rivers.dispose();
  rivers.dispose();
  assert.equal(geometryDisposed, 1);
  assert.equal(materialDisposed, 1);
  assert.equal(atlasDisposed, 1);
  assert.equal(atlas.image.data?.length, 0);
  assert.equal(rivers.children.length, 0);
  assert.equal(rivers.bytes, 0);
});

test('fantasy river palettes reuse the same asset and geometry without overriding source diagnostics', () => {
  const batch = packet([[point(-0.1), point(0, 0.03), point(0.1)]]);
  const flatAppearance = { ...appearance, relief: 0 };
  const rivers = new FixedRivers(handle, flatAppearance);
  rivers.addBatch(batch);
  const mesh = rivers.children[0] as Mesh;
  const material = mesh.material as ShaderMaterial;
  const geometry = mesh.geometry;
  const atlas = rivers.bankTexture;
  const savedHeights = rivers.asset.packets[0].heights.slice();
  for (const mapStyle of ['parchment', 'engraved', 'painted'] as const) {
    rivers.setAppearance({ ...flatAppearance, mapStyle });
    assert.equal(mesh.geometry, geometry);
    assert.equal(mesh.material, material);
    assert.equal(rivers.bankTexture, atlas);
    assert.equal(material.uniforms.fantasyMode.value, true);
    assert.equal(material.uniforms.sourceMode.value, false);
    assert.ok(
      material.uniforms.fantasyRiver.value.equals(new Color(FANTASY_PALETTES[mapStyle].river)),
    );
    assert.ok(
      material.uniforms.fantasyHighlight.value.equals(
        new Color(FANTASY_PALETTES[mapStyle].riverHighlight),
      ),
    );
  }
  rivers.setAppearance({ ...flatAppearance, mapStyle: 'painted', layer: 'sources' });
  assert.equal(material.uniforms.fantasyMode.value, false);
  assert.equal(material.uniforms.sourceMode.value, true);
  rivers.setAppearance(appearance);
  assert.equal(material.uniforms.fantasyMode.value, false);
  assert.equal(material.uniforms.sourceMode.value, false);
  assert.notEqual(
    mesh.geometry,
    geometry,
    'returning to relief rebuilds positions from retained heights',
  );
  assert.deepEqual(rivers.asset.packets[0].heights, savedHeights);
  assert.equal(rivers.bankTexture, atlas);
  rivers.dispose();
});
