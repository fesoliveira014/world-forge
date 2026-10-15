import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { riverCurvatureLimits } from '../src/core/view/river-width-limits';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/tight-river.json', import.meta.url), 'utf8'),
) as {
  positions: number[];
  halfWidths: number[];
};
const vector = (positions: Float32Array, point: number) =>
  new Vector3().fromArray(positions, point * 3).normalize();

test('actual high-resolution river curvature limits prevent unsafe offset widths with gradual transitions', () => {
  const positions = Float32Array.from(fixture.positions);
  const original = positions.slice();
  const limits = riverCurvatureLimits(positions);
  let unsafe = 0;
  for (let point = 1; point < limits.length - 1; point++) {
    const a = vector(positions, point - 1);
    const b = vector(positions, point);
    const c = vector(positions, point + 1);
    const ab = b.clone().sub(a);
    const ac = c.clone().sub(a);
    const radius =
      (ab.length() * b.distanceTo(c) * ac.length()) / (2 * Math.abs(ab.clone().cross(ac).dot(b)));
    if (fixture.halfWidths[point] > radius) {
      unsafe++;
    }
    assert.ok(
      limits[point] <= radius * 0.4 + 1e-10,
      'offset stays well inside local curvature radius',
    );
  }
  assert.equal(unsafe, 22, 'real failing path is far wider than its bends');
  for (let point = 1; point < limits.length; point++) {
    const distance = vector(positions, point).angleTo(vector(positions, point - 1));
    assert.ok(
      Math.abs(limits[point] - limits[point - 1]) <= distance * 0.03 + 1e-9,
      'no needle taper between consecutive points',
    );
  }
  assert.deepEqual(positions, original, 'the complete saved centerline is unchanged');
});

test('great-circle straight channels keep their widths after dense subdivision at arbitrary latitude', () => {
  const normal = new Vector3(0.3, 0.9, 0.4).normalize();
  const first = new Vector3(1, 0, 0).addScaledVector(normal, -normal.x).normalize();
  const second = normal.clone().cross(first).normalize();
  for (const segments of [4, 32, 1024]) {
    const positions = new Float32Array((segments + 1) * 3);
    for (let point = 0; point <= segments; point++) {
      const angle = (point / segments) * 0.01;
      first
        .clone()
        .multiplyScalar(Math.cos(angle))
        .addScaledVector(second, Math.sin(angle))
        .toArray(positions, point * 3);
    }
    assert.ok(
      riverCurvatureLimits(positions).every((limit) => limit === 1),
      'Float32 subdivision does not invent curvature',
    );
  }
});

test('the same spherical circular bend keeps its curvature bound under uniform and uneven resampling', () => {
  const angularRadius = 0.01;
  const expected = 0.4 * Math.tan(angularRadius);
  for (const fractions of [
    Array.from({ length: 9 }, (_, point) => point / 8),
    Array.from({ length: 65 }, (_, point) => point / 64),
    Array.from({ length: 257 }, (_, point) => point / 256),
    Array.from({ length: 513 }, (_, point) => point / 512),
    Array.from({ length: 1025 }, (_, point) => point / 1024),
    [0, 0.02, 0.12, 0.2, 0.55, 0.59, 0.8, 0.93, 1],
  ]) {
    const positions = Float32Array.from(
      fractions.flatMap((fraction) => [
        Math.cos(angularRadius),
        Math.sin(angularRadius) * Math.cos(fraction * 2),
        Math.sin(angularRadius) * Math.sin(fraction * 2),
      ]),
    );
    const limits = riverCurvatureLimits(positions);
    for (let point = 1; point < limits.length - 1; point++) {
      const endDistance = Math.min(
        vector(positions, point).angleTo(vector(positions, 0)),
        vector(positions, point).angleTo(vector(positions, limits.length - 1)),
      );
      // Rounded Float32 coordinates perturb inferred curvature by less than
      // 0.5% even at the densest sampling, far below the 60% safety margin.
      // Close to a true endpoint, a reliable symmetric support may not exist.
      // The distance envelope then extends the nearest reliable curvature cap.
      const endEnvelope = endDistance < 0.001 ? 0.03 * endDistance : 0;
      assert.ok(
        Math.abs(limits[point] - expected) < expected * 0.005 + endEnvelope,
        'curvature follows bend radius, with only the documented endpoint envelope',
      );
      assert.equal(Math.min(0.0001, limits[point]), 0.0001, 'a safe legacy width is unchanged');
    }
  }
});

test('a tight bend recovers display width with physical distance without constraining the whole path', () => {
  const direction = (longitude: number, latitude: number) => [
    Math.cos(latitude) * Math.cos(longitude),
    Math.sin(latitude),
    Math.cos(latitude) * Math.sin(longitude),
  ];
  const positions = Float32Array.from([
    ...direction(-0.0001, -0.0001),
    ...direction(0, 0),
    ...direction(0.0001, -0.0001),
    ...Array.from({ length: 40 }, (_, index) => direction(0.001 + index * 0.005, -0.0001)).flat(),
  ]);
  const limits = riverCurvatureLimits(positions);
  assert.ok(limits[1] < 0.0001, 'the tight bend remains width-limited');
  assert.ok(
    limits[limits.length - 1] > 0.003,
    'the distant straight trunk regains its original broad width',
  );
  assert.ok(
    limits[10] < limits[20] && limits[20] < limits[30],
    'recovery follows distance, rather than one global path minimum',
  );
});
