import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Vector3 } from 'three';
import { curveRiverPath } from '../src/render/RiverCurve';
import { riverCurvatureLimits } from '../src/core/view/river-width-limits';

const radius = 6371000;
const pair = (a: Vector3, b: Vector3) => Float32Array.from([...a.toArray(), ...b.toArray()]);

test('an actual tiny refined reach shares smooth guides with both long neighbors', () => {
  // AETHER-6389: a straight 52.975 m routing edge between 28.46 km and 27.25 km
  // reaches formerly became a tiny S bend with a 5.64 m display-width cap.
  const nodes = [
    [0.019773321173532983, 0.6370676830166266, 0.770554205118365],
    [0.0187212781275497, 0.6337287517193129, 0.7733287677240208],
    [0.018726487272408356, 0.6337236775598761, 0.7733327997533936],
    [0.018856722437205153, 0.6304096420060853, 0.7760335735550914],
  ].map((point) => new Vector3().fromArray(point));
  const curves = nodes
    .slice(1)
    .map((_, index) =>
      curveRiverPath(
        pair(nodes[index], nodes[index + 1]),
        index ? nodes[index - 1] : null,
        index + 2 < nodes.length ? nodes[index + 2] : null,
      ),
    );
  for (let reach = 0; reach < curves.length; reach++) {
    const curve = curves[reach];
    assert.ok(curve.every(Number.isFinite));
    assert.deepEqual(Array.from(curve.slice(0, 3)), nodes[reach].toArray().map(Math.fround));
    assert.deepEqual(Array.from(curve.slice(-3)), nodes[reach + 1].toArray().map(Math.fround));
    const direction = nodes[reach + 1].clone().sub(nodes[reach]);
    for (let point = 1; point < curve.length / 3; point++) {
      const step = new Vector3()
        .fromArray(curve, point * 3)
        .sub(new Vector3().fromArray(curve, (point - 1) * 3));
      assert.ok(step.dot(direction) > 0, 'the interpolated reach never reverses downstream');
    }
    if (reach) {
      assert.deepEqual(curves[reach - 1].slice(-3), curve.slice(0, 3));
    }
  }
  const connected = Float32Array.from(
    curves.flatMap((curve, index) => Array.from(curve.subarray(index ? 3 : 0))),
  );
  assert.ok(
    riverCurvatureLimits(connected).every((limit) => limit * radius > 3000),
    'the artificial pinch is removed from the whole connected path, including both joins',
  );
});

test('ordinary reach spacing retains the exact existing curved geometry', () => {
  const nodes = [
    new Vector3(1, -0.02, -0.01).normalize(),
    new Vector3(1, 0, 0),
    new Vector3(1, 0.02, 0.01).normalize(),
    new Vector3(1, 0.035, 0).normalize(),
  ];
  const points = Float32Array.from([
    ...nodes[1].toArray(),
    ...new Vector3(1, 0.009, 0.007).normalize().toArray(),
    ...nodes[2].toArray(),
  ]);
  const curved = curveRiverPath(points, nodes[0], nodes[3]);
  assert.equal(
    createHash('sha256').update(new Uint8Array(curved.buffer)).digest('hex'),
    'd3cd894b752ee33da23c6108a9214efc1716fcc118e1dfa2d334c8849192c3e2',
    'verified against the existing implementation before the uneven-guide fix',
  );
});

test('coincident or opposing guides keep finite paths and exact routing endpoints', () => {
  const start = new Vector3(1, 0, 0);
  const end = new Vector3(1, 0.00001, 0).normalize();
  for (const [previous, next] of [
    [start, end],
    [new Vector3(1, 0.1, 0).normalize(), new Vector3(1, -0.1, 0).normalize()],
  ]) {
    const points = curveRiverPath(pair(start, end), previous, next);
    assert.ok(points.every(Number.isFinite));
    assert.deepEqual(Array.from(points.slice(0, 3)), start.toArray().map(Math.fround));
    assert.deepEqual(Array.from(points.slice(-3)), end.toArray().map(Math.fround));
    assert.ok(points.length >= 6);
  }
});
