import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGrid } from '../src/core/grid/build';
import { createGradedSpacingField } from '../src/core/grid/graded-spacing';
import {
  createSeededRandom,
  cross,
  dot,
  normalizeVector,
  randomSpherePoint,
  readVector,
} from '../src/core/math';

test('spatial spacing envelope equals exhaustive geodesic cones at arbitrary directions', () => {
  const grid = buildGrid(3, 'graded-spacing', 0.9);
  const random = createSeededRandom('graded-spacing-samples');
  const targets = Float64Array.from({ length: grid.count }, () => 50 + random() * 950);
  const radius = 1000;
  const gradient = 0.35;
  const sourceRadii = Float64Array.from({ length: grid.count }, () => random() * 80);
  const sample = createGradedSpacingField(grid, targets, radius, 1000, gradient, sourceRadii);

  for (let query = 0; query < 200; query++) {
    const position = randomSpherePoint(random);
    let expected = 1000;

    for (let cell = 0; cell < grid.count; cell++) {
      const site = readVector(grid.positions, cell);
      const distance =
        Math.atan2(Math.hypot(...cross(position, site)), dot(position, site)) * radius;
      expected = Math.min(
        expected,
        targets[cell] + gradient * Math.max(0, distance - sourceRadii[cell]),
      );
    }

    assert.ok(Math.abs(sample(...position) - expected) < 1e-10);
  }
});

test('geodesic spacing envelope respects its physical gradient across cells, seams, and poles', () => {
  const grid = buildGrid(2, 'graded-spacing-gradient', 1);
  const random = createSeededRandom('graded-gradient-samples');
  const targets = Float64Array.from({ length: grid.count }, () => 50000 + random() * 950000);
  const radius = 6371000;
  const gradient = 0.35;
  const sample = createGradedSpacingField(grid, targets, radius, 1000000, gradient);
  let changingQueries = 0;
  const anchors = [
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    ...Array.from({ length: 100 }, () => randomSpherePoint(random)),
  ];

  for (const anchor of anchors) {
    const first = normalizeVector(anchor);
    const second = normalizeVector([
      first[0] + 1e-5 * random(),
      first[1] + 1e-5 * random(),
      first[2] + 1e-5 * random(),
    ]);
    const distance = Math.atan2(Math.hypot(...cross(first, second)), dot(first, second)) * radius;
    const difference = Math.abs(sample(...first) - sample(...second));
    assert.ok(difference <= gradient * distance + 1e-9);

    if (difference > 1e-4) {
      changingQueries++;
    }
  }

  assert.ok(changingQueries > 90);
});

test('finite source caps preserve broad equally important pilot regions at their target', () => {
  const grid = buildGrid(2, 'graded-spacing-plateau', 0.9);
  const radius = 1000;
  const sourceRadii = new Float64Array(grid.count);
  for (let cell = 0; cell < grid.count; cell++) {
    const site = readVector(grid.positions, cell);
    for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
      const corner = readVector(grid.corners, grid.cellCorners[offset]);
      sourceRadii[cell] = Math.max(
        sourceRadii[cell],
        radius * Math.atan2(Math.hypot(...cross(site, corner)), dot(site, corner)),
      );
    }
  }
  const targets = new Float64Array(grid.count).fill(60);
  const sample = createGradedSpacingField(grid, targets, radius, 500, 0.35, sourceRadii);
  const random = createSeededRandom('graded-spacing-plateau-samples');

  for (let query = 0; query < 300; query++) {
    assert.ok(Math.abs(sample(...randomSpherePoint(random)) - 60) < 1e-10);
  }

  for (let corner = 0; corner < grid.corners.length / 3; corner++) {
    assert.ok(Math.abs(sample(...readVector(grid.corners, corner)) - 60) < 1e-10);
  }
});
