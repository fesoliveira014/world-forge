import test from 'node:test';
import assert from 'node:assert/strict';
import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';
import { buildGrid, nearestCell } from '../src/core/grid/build';
import {
  mapPoint,
  projectMesh,
  spherePoint,
  updateMapAttributes,
  writeMapSegment,
  MAP_HEIGHT_SHEAR,
} from '../src/render/projection';

test('oblique relief preserves sea-level geography and interpolates height across the map seam', () => {
  const grid = buildGrid(2, 'oblique-map', 0.5);
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute(
      Array.from(grid.positions, (value) => value * 1.03),
      3,
    ),
  );
  geometry.setIndex(Array.from(grid.triangles));
  projectMesh(geometry, 0, 4);
  const position = geometry.getAttribute('position');
  for (let cell = 0; cell < grid.count; cell++) {
    const [longitude, latitude] = mapPoint(
      ...(Array.from(grid.positions.slice(cell * 3, cell * 3 + 3)) as [number, number, number]),
    );
    assert.ok(Math.abs(position.getX(cell) - longitude) < 1e-6);
    assert.ok(Math.abs(position.getY(cell) - latitude - 0.12 * MAP_HEIGHT_SHEAR) < 1e-6);
    assert.ok(Math.abs(position.getZ(cell) - 0.12) < 1e-6);
  }
  const first = spherePoint(Math.PI - 0.1, 0.2, new Vector3()).multiplyScalar(1.02);
  const second = spherePoint(-Math.PI + 0.1, 0.4, new Vector3()).multiplyScalar(1.04);
  const output = new Float32Array(12);
  writeMapSegment([...first.toArray(), ...second.toArray()], 0, 3, output, 0, 0, 4);
  assert.ok(Math.abs(output[3] - Math.PI) < 1e-6);
  assert.ok(Math.abs(output[6] + Math.PI) < 1e-6);
  assert.ok(Math.abs(output[5] - 0.12) < 1e-6);
  assert.equal(output[5], output[8]);
  assert.equal(output[4], output[7]);
});

test('map coordinates preserve north/east and pick the original spherical cell', () => {
  const grid = buildGrid(2, 'map-picking', 0.7);
  const p = new Vector3();

  for (let i = 0; i < grid.count; i++) {
    const lonlat = mapPoint(
      grid.positions[i * 3],
      grid.positions[i * 3 + 1],
      grid.positions[i * 3 + 2],
    );
    spherePoint(...lonlat, p);
    assert.equal(nearestCell(grid, p.x, p.y, p.z), i);
  }

  assert.deepEqual(mapPoint(1, 0, 0), [0, 0]);
  assert.equal(mapPoint(0, 0, 1)[0], Math.PI / 2);
  assert.equal(mapPoint(0, 1, 0)[1], Math.PI / 2);
});

type Point = [number, number];

// The material clips at ±π. Integrate its visible triangles to detect missing polar
// sectors or triangles incorrectly covering the entire map, without a browser harness.
function visibleArea(points: Point[]) {
  for (const sign of [-1, 1]) {
    const clipped: Point[] = [];

    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const insideA = sign * a[0] <= Math.PI;
      const insideB = sign * b[0] <= Math.PI;

      if (insideA) {
        clipped.push(a);
      }

      if (insideA !== insideB) {
        const x = sign * Math.PI;
        const t = (x - a[0]) / (b[0] - a[0]);
        clipped.push([x, a[1] + t * (b[1] - a[1])]);
      }
    }

    points = clipped;
  }

  return (
    Math.abs(
      points.reduce((area, p, i) => {
        const q = points[(i + 1) % points.length];

        return area + p[0] * q[1] - q[0] * p[1];
      }, 0),
    ) / 2
  );
}

test('regular and jittered meshes cover the complete map, including both poles and the seam', () => {
  for (const irregularity of [0, 0.7]) {
    const grid = buildGrid(2, 'map-surface', irregularity);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(grid.positions, 3));
    const field = new Float32Array(grid.count).fill(1);
    geometry.setAttribute('field', new Float32BufferAttribute(field, 1));
    geometry.setIndex(Array.from(grid.triangles));
    projectMesh(geometry);
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex()!;
    assert.ok(Array.from(position.array).every(Number.isFinite));
    let area = 0;

    for (let i = 0; i < index.count; i += 3) {
      const triangle = [0, 1, 2].map((d) => {
        const j = index.getX(i + d);

        return [position.getX(j), position.getY(j)] as Point;
      });
      assert.ok(
        Math.max(...triangle.map((p) => p[0])) - Math.min(...triangle.map((p) => p[0])) <=
          Math.PI + 1e-6,
      );
      area += visibleArea(triangle);
    }

    assert.ok(Math.abs(area - 2 * Math.PI ** 2) < 1e-5, `visible map area = ${area}`);

    // A field change must also reach seam copies and the interpolated polar values.
    for (let i = 0; i < grid.count; i++) {
      geometry.getAttribute('field').setX(i, 7);
    }

    updateMapAttributes(geometry, ['field']);
    assert.ok(
      Array.from(geometry.getAttribute('field').array).every((v) => Math.abs(v - 7) < 1e-5),
    );
    geometry.dispose();
  }
});

test('flow segments cross the dateline at the two map edges, never through its center', () => {
  const a = spherePoint((179 * Math.PI) / 180, 0.2, new Vector3());
  const b = spherePoint((-179 * Math.PI) / 180, 0.4, new Vector3());
  const source = new Float32Array([...a.toArray(), ...b.toArray()]);
  const output = new Float32Array(12);
  writeMapSegment(source, 0, 3, output, 0, 0.01);
  assert.ok(Math.abs(output[3] - Math.PI) < 1e-6);
  assert.ok(Math.abs(output[6] + Math.PI) < 1e-6);
  assert.ok(Math.abs(output[4] - 0.3) < 1e-6 && output[4] === output[7]);
  assert.ok(Math.abs(output[0] - output[3]) < 0.04 && Math.abs(output[6] - output[9]) < 0.04);
  writeMapSegment(source, 3, 0, output, 0, 0.01);
  assert.ok(Math.abs(output[3] + Math.PI) < 1e-6);
  assert.ok(Math.abs(output[6] - Math.PI) < 1e-6);
});
