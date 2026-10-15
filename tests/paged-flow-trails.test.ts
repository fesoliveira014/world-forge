import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { OverlayLines, WorldHandle } from '../src/core/view/types';
import {
  FLOW_TRAIL_MAX_PATHS,
  FLOW_TRAIL_MAX_STEPS,
  PagedFlowTrails,
  flowTrailGeometry,
  type PagedFlowAppearance,
} from '../src/render/PagedFlowTrails';

const handle = { config: { radius: 6371000 } } as WorldHandle;
const appearance: PagedFlowAppearance = {
  projection: 'globe',
  relief: 26,
  mapStyle: 'natural',
  kind: 'wind',
  particleCount: 1200,
};
function direction(longitude: number, latitude = 0): [number, number, number] {
  return [
    Math.cos(latitude) * Math.cos(longitude),
    Math.sin(latitude),
    Math.cos(latitude) * Math.sin(longitude),
  ];
}
function lines(paths: [number, number, number][][], heights?: number[]): OverlayLines {
  return {
    positions: new Float32Array(paths.flat(2)),
    heights: new Float32Array(heights ?? paths.flatMap(() => [0, 0])),
    widths: new Float32Array(paths.length),
    discharge: new Float32Array(paths.length),
  };
}
const ordinary = () => lines([[direction(0), direction(0.097)]]);

test('flow trails tessellate complete forward geodesics whose chords stay above sea level', () => {
  const source = ordinary();
  const original = source.positions.slice();
  const { geometry, pathCount } = flowTrailGeometry(source, handle, appearance);
  assert.equal(pathCount, 1);
  const position = geometry.getAttribute('position');
  const coordinate = geometry.getAttribute('pathCoordinate');
  assert.ok(position.count > 4, 'A short flow vector must become a trail, not one buried chord');
  assert.equal(coordinate.getX(0), 0);
  assert.equal(coordinate.getX(coordinate.count - 1), 1);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  let previous = 0;
  for (let i = 0; i < position.count; i += 2) {
    a.fromBufferAttribute(position, i);
    b.fromBufferAttribute(position, i + 1);
    assert.ok(coordinate.getX(i) >= previous);
    assert.ok(coordinate.getX(i + 1) > coordinate.getX(i));
    assert.ok(a.angleTo(b) <= 0.004001);
    assert.ok(a.add(b).multiplyScalar(0.5).length() > 1.000018);
    previous = coordinate.getX(i + 1);
  }
  assert.deepEqual(source.positions, original);
  geometry.dispose();
});

test('dateline pieces meet with identical phase and do not bridge the map', () => {
  const { geometry } = flowTrailGeometry(
    lines([[direction(Math.PI - 0.041), direction(-Math.PI + 0.052)]]),
    handle,
    { ...appearance, projection: 'map' },
  );
  const positions = geometry.getAttribute('position');
  const coordinate = geometry.getAttribute('pathCoordinate');
  const phases = geometry.getAttribute('pathPhase');
  let seams = 0;
  for (let i = 0; i < positions.count; i += 2) {
    assert.ok(Math.abs(positions.getX(i + 1) - positions.getX(i)) < 0.005);
    assert.ok(coordinate.getX(i + 1) >= coordinate.getX(i));
    if (i + 2 < positions.count && Math.abs(positions.getX(i + 1) - positions.getX(i + 2)) > 6) {
      seams++;
      assert.equal(coordinate.getX(i + 1), coordinate.getX(i + 2));
      assert.equal(phases.getX(i + 1), phases.getX(i + 2));
      assert.equal(positions.getY(i + 1), positions.getY(i + 2));
    }
  }
  assert.equal(seams, 1);
  geometry.dispose();
});

test('north/south pole crossings keep separate incident meridians with continuous path history', () => {
  for (const sign of [-1, 1]) {
    // An unequal arc places the exact pole inside a subdivision rather than at
    // its endpoint, exercising true pole splitting as well as normal samples.
    const { geometry } = flowTrailGeometry(
      lines([[direction(0, sign * 1.52), direction(Math.PI, sign * 1.54)]]),
      handle,
      { ...appearance, projection: 'map' },
    );
    const positions = geometry.getAttribute('position');
    const coordinate = geometry.getAttribute('pathCoordinate');
    let polePieces = 0;
    const poleCoordinates = new Set<number>();
    for (let i = 0; i < positions.count; i += 2) {
      assert.ok(
        Math.abs(positions.getX(i + 1) - positions.getX(i)) < 1e-6,
        'No horizontal line across the pole',
      );
      for (const vertex of [i, i + 1]) {
        assert.ok(Number.isFinite(positions.getY(vertex)));
        if (Math.abs(Math.abs(positions.getY(vertex)) - Math.PI / 2) < 1e-6) {
          polePieces++;
          poleCoordinates.add(coordinate.getX(vertex));
        }
      }
      assert.ok(coordinate.getX(i + 1) >= coordinate.getX(i));
    }
    assert.ok(polePieces >= 2);
    assert.equal(poleCoordinates.size, 1, 'Both pole meridians retain the same path coordinate');
    geometry.dispose();
  }
});

test('density is a local uniform change, zero suppresses draws, and path ranks distribute it without new geometry', () => {
  const source = lines(
    Array.from({ length: 7 }, (_, i) => [direction(i * 0.1), direction(i * 0.1 + 0.04)]),
  );
  const trails = new PagedFlowTrails(source, handle, appearance);
  const geometry = trails.object.geometry;
  const original = geometry.getAttribute('position').array;
  assert.equal(trails.hasParticles, true);
  trails.object.visible = false;
  trails.setParticleCount(0);
  assert.equal(trails.hasParticles, false);
  assert.equal(geometry.drawRange.count, 0);
  assert.equal(trails.object.visible, false, 'Layer visibility belongs to the caller');
  trails.setParticleCount(3);
  assert.equal(trails.hasParticles, true);
  assert.equal(geometry.drawRange.count, Infinity);
  assert.equal(geometry.getAttribute('position').array, original);
  const ranks = new Set(Array.from(geometry.getAttribute('pathRank').array));
  assert.deepEqual(
    [...ranks].sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5, 6],
  );
  const heads = [...ranks].map(
    (rank) => Math.floor(3 / ranks.size) + Number(rank < 3 % ranks.size),
  );
  assert.equal(
    heads.reduce((a, b) => a + b),
    3,
  );
  trails.dispose();
});

test('clock pause, zero speed, speed changes, and active packet replacement preserve continuous phase', () => {
  const trails = new PagedFlowTrails(ordinary(), handle, appearance);
  trails.animate(100, true, 1);
  assert.equal(trails.time, 0);
  trails.animate(101, true, 1);
  assert.equal(trails.time, 1);
  trails.animate(101, true, 3);
  assert.equal(trails.time, 1, 'Changing speed at the same instant must not reposition trails');
  trails.animate(102, true, 3);
  assert.equal(trails.time, 4);
  trails.animate(120, false, 3);
  trails.animate(130, false, 3);
  assert.equal(trails.time, 4);
  assert.equal(trails.object.visible, true, 'Paused trails remain visible');
  trails.animate(131, true, 1);
  assert.equal(trails.time, 5);
  trails.animate(140, true, 0);
  assert.equal(trails.time, 5);
  trails.animate(141, true, 2);
  assert.equal(trails.time, 7);
  const replacement = new PagedFlowTrails(ordinary(), handle, appearance, trails.time);
  replacement.animate(1000, true, 1);
  assert.equal(
    replacement.time,
    7,
    'No absolute-clock catchup during an active packet replacement',
  );
  replacement.animate(1001, true, 1);
  assert.equal(replacement.time, 8);
  replacement.time = trails.time;
  replacement.animate(2000, false, 3);
  assert.equal(replacement.time, 7);
  trails.dispose();
  replacement.dispose();
});

test('current trails use terrain depth while wind stays readable over relief; both reject the far hemisphere', () => {
  for (const projection of ['globe', 'map'] as const) {
    const wind = new PagedFlowTrails(ordinary(), handle, {
      ...appearance,
      projection,
      kind: 'wind',
    });
    const current = new PagedFlowTrails(ordinary(), handle, {
      ...appearance,
      projection,
      kind: 'current',
    });
    assert.equal(wind.object.material.depthTest, false);
    assert.equal(current.object.material.depthTest, true);
    assert.equal(wind.object.material.depthWrite, false);
    assert.match(current.object.material.fragmentShader, /closestT > 0\.0 && closestT < 1\.0/);
    wind.dispose();
    current.dispose();
  }
});

test('oversized and malformed vector packets remain bounded, finite, and safely disposable', () => {
  const oversized = lines(Array.from({ length: 1024 }, () => [direction(0), direction(Math.PI)]));
  const trails = new PagedFlowTrails(oversized, handle, appearance);
  assert.equal(trails.pathCount, FLOW_TRAIL_MAX_PATHS);
  assert.ok(
    trails.object.geometry.getAttribute('position').count <=
      FLOW_TRAIL_MAX_PATHS * FLOW_TRAIL_MAX_STEPS * 4,
  );
  for (const value of trails.object.geometry.getAttribute('position').array) {
    assert.ok(Number.isFinite(value));
  }
  let disposals = 0;
  trails.object.geometry.addEventListener('dispose', () => disposals++);
  trails.object.material.addEventListener('dispose', () => disposals++);
  trails.dispose();
  trails.dispose();
  assert.equal(disposals, 2);
  assert.equal(trails.hasParticles, false);
  const empty = new PagedFlowTrails(
    lines([
      [
        [NaN, 0, 0],
        [0, 1, 0],
      ],
      [
        [1, 0, 0],
        [1, 0, 0],
      ],
    ]),
    handle,
    appearance,
  );
  assert.equal(empty.pathCount, 0);
  assert.equal(empty.hasParticles, false);
  empty.dispose();
});

test('curved field paths carry one continuous moving-head coordinate through every sampled segment', () => {
  const points = [
    direction(0),
    direction(0.035, 0.01),
    direction(0.06, 0.04),
    direction(0.07, 0.07),
  ];
  const packet = lines(points.slice(1).map((point, i) => [points[i], point]));
  packet.pathOffsets = new Uint32Array([0, 3]);
  packet.pathSpeeds = new Float32Array([0.6]);
  for (const projection of ['globe', 'map'] as const) {
    const { geometry, pathCount } = flowTrailGeometry(packet, handle, {
      ...appearance,
      projection,
    });
    assert.equal(pathCount, 1);
    const positions = geometry.getAttribute('position');
    const coordinate = geometry.getAttribute('pathCoordinate');
    assert.equal(coordinate.getX(0), 0);
    assert.equal(coordinate.getX(coordinate.count - 1), 1);
    for (let i = 1; i < positions.count - 1; i += 2) {
      assert.equal(
        coordinate.getX(i),
        coordinate.getX(i + 1),
        'History cannot restart at a field sample',
      );
      for (const axis of ['getX', 'getY', 'getZ'] as const) {
        assert.ok(
          Math.abs(positions[axis](i) - positions[axis](i + 1)) < 1e-7,
          'Adjacent parts must meet, including their globe lift',
        );
      }
    }
    assert.equal(new Set(geometry.getAttribute('pathPhase').array).size, 1);
    assert.equal(new Set(geometry.getAttribute('pathRank').array).size, 1);
    geometry.dispose();
  }
});

test('flow trails use one indexed ribbon draw with stable screen width across viewport changes', () => {
  const trails = new PagedFlowTrails(ordinary(), handle, appearance);
  assert.ok(trails.object.isMesh);
  const geometry = trails.object.geometry;
  assert.ok(geometry.index);
  assert.equal(geometry.index.count / 6, geometry.getAttribute('position').count / 4);
  trails.setViewport(1440, 900);
  assert.deepEqual(trails.object.material.uniforms.viewport.value.toArray(), [1440, 900]);
  const width = trails.object.material.uniforms.lineWidth.value;
  assert.ok(width >= 2, 'Native one-pixel hairlines are not readable trails');
  trails.setViewport(720, 450);
  assert.equal(trails.object.geometry, geometry, 'Resizing must not rebuild paths');
  assert.equal(trails.object.material.uniforms.lineWidth.value, width);
  assert.ok(trails.bytes >= geometry.index.array.byteLength * 2);
  trails.dispose();
});

test('antimeridian-aligned paths keep finite identical history on both map borders', () => {
  for (const startLatitude of [-0.5, 0.5]) {
    const { geometry } = flowTrailGeometry(
      lines([[direction(Math.PI, startLatitude), direction(-Math.PI, startLatitude + 0.01)]]),
      handle,
      { ...appearance, projection: 'map' },
    );
    const positions = geometry.getAttribute('position');
    const coordinates = geometry.getAttribute('pathCoordinate');
    assert.ok(Number.isFinite(geometry.boundingSphere!.radius));
    for (const attribute of Object.values(geometry.attributes)) {
      assert.ok([...attribute.array].every(Number.isFinite));
    }
    assert.equal(positions.count % 4, 0);
    for (let i = 0; i < positions.count; i += 4) {
      assert.ok(Math.abs(positions.getX(i) + Math.PI) < 1e-6);
      assert.ok(Math.abs(positions.getX(i + 2) - Math.PI) < 1e-6);
      assert.equal(coordinates.getX(i), coordinates.getX(i + 2));
      assert.equal(coordinates.getX(i + 1), coordinates.getX(i + 3));
      assert.equal(positions.getY(i), positions.getY(i + 2));
      assert.equal(positions.getY(i + 1), positions.getY(i + 3));
    }
    geometry.dispose();
  }
});
