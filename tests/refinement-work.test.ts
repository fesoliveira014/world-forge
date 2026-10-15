import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGrid } from '../src/core/grid/build';
import { createRegionSpacing, refineGrid } from '../src/core/grid/refine';
import { estimateRefinementWork } from '../src/core/grid/refinement-work';
import {
  refinementGeometryHash,
  type ResolvedRefinementPlan,
} from '../src/core/grid/refinement-plan';
import type { Grid } from '../src/core/model';

const radius = 1000;
const grid = buildGrid(2, 'refinement-work', 0.65);

function planFor(pilot: Grid, target = 500): ResolvedRefinementPlan {
  return {
    format: 'atlas-refinement-plan/v1',
    geometryHash: refinementGeometryHash(pilot),
    configSignature: 'estimator-fixture',
    cellCount: pilot.count,
    radiusMetres: radius,
    baseSpacingMetres: 500,
    gradation: 0.35,
    targetSpacingMetres: Array(pilot.count).fill(target),
    // The complete sphere is a constant target for these analytic density cases.
    sourceRadiiMetres: Array(pilot.count).fill(Math.PI * radius),
    volcanicCaps: [],
  };
}

test('uniform physical spacing predicts inverse-square work with rounded memory estimates', () => {
  const coarse = estimateRefinementWork(grid, planFor(grid, 50));
  const fine = estimateRefinementWork(grid, planFor(grid, 25));
  const physicalDensity = (4 * Math.PI * radius ** 2 * (2 / Math.sqrt(3)) * 1.3) / 50 ** 2;
  assert.ok(Math.abs(coarse.estimatedCells - physicalDensity) / physicalDensity < 0.02);
  assert.ok(Math.abs(fine.estimatedCells / coarse.estimatedCells - 4) < 0.1);
  assert.ok(Math.abs(coarse.estimatedRetainedMiB - coarse.estimatedCells / 1024) < 0.1);
  assert.ok(Math.abs(coarse.estimatedPeakMiB / coarse.estimatedRetainedMiB - 3) < 0.15);
  assert.equal(coarse.estimatedAddedCells, coarse.estimatedCells - grid.count);
  assert.equal(coarse.method, 'physical-spacing-quadrature');
});

test('an estimate retains every existing seed and leaves the plan and mesh unchanged', () => {
  const plan = planFor(grid);
  const before = JSON.stringify(plan);
  const positions = grid.positions.slice();
  const estimate = estimateRefinementWork(grid, plan);
  assert.equal(estimate.estimatedCells, grid.count);
  assert.equal(estimate.estimatedAddedCells, 0);
  assert.equal(JSON.stringify(plan), before);
  assert.deepEqual(grid.positions, positions);
});

test('sparse sub-pilot caps contribute work and duplicate footprints are not counted twice', () => {
  const plan = planFor(grid);
  plan.volcanicCaps.push({ position: [1, 0, 0], radiusMetres: 5, targetSpacingMetres: 1 });
  const estimate = estimateRefinementWork(grid, plan);
  const repeated = estimateRefinementWork(grid, {
    ...plan,
    volcanicCaps: [...plan.volcanicCaps, structuredClone(plan.volcanicCaps[0])],
  });
  assert.ok(
    estimate.estimatedAddedCells > 100,
    'fine caps between coarse sample locations must not disappear',
  );
  assert.deepEqual(repeated, estimate);
  const actual = refineGrid(
    grid,
    radius,
    'refinement-work',
    createRegionSpacing(500, radius, [
      {
        center: [1, 0, 0],
        radiusMetres: 5,
        targetSpacingMetres: 1,
      },
    ]),
  );
  assert.ok(estimate.estimatedCells > actual.count * 0.5);
  assert.ok(estimate.estimatedCells < actual.count * 2);
});

test('overlapping caps use their union instead of adding coincident density', () => {
  const fullSphere = planFor(grid);
  fullSphere.volcanicCaps = [
    { position: [1, 0, 0], radiusMetres: Math.PI * radius, targetSpacingMetres: 30 },
  ];
  const sameSphereFromOppositePole = {
    ...fullSphere,
    volcanicCaps: [
      ...fullSphere.volcanicCaps,
      {
        position: [-1, 0, 0] as [number, number, number],
        radiusMetres: Math.PI * radius,
        targetSpacingMetres: 30,
      },
    ],
  };
  const single = estimateRefinementWork(grid, fullSphere);
  const overlap = estimateRefinementWork(grid, sameSphereFromOppositePole);
  assert.equal(overlap.estimatedCells, single.estimatedCells);
  assert.equal(overlap.estimatedRetainedMiB, single.estimatedRetainedMiB);
});

test('extreme physical requests are reported without constructing or capping the mesh', () => {
  const plan = planFor(grid, 100);
  plan.radiusMetres = 6371000;
  plan.sourceRadiiMetres.fill(Math.PI * plan.radiusMetres);
  const estimate = estimateRefinementWork(grid, plan);
  assert.ok(estimate.estimatedCells > 5e10);
  assert.ok(estimate.estimatedRetainedMiB > 5e7);
  assert.equal(estimate.sampledDirections, grid.count + grid.corners.length / 3);
  assert.equal(grid.count, 162);
});

test('work estimation rejects a plan from a differently sized pilot mesh', () => {
  assert.throws(
    () => estimateRefinementWork(buildGrid(1, 'wrong-pilot', 0.65), planFor(grid)),
    /pilot mesh/,
  );
});

test('many retained provinces use bounded quadrature and preserve overlapping coverage', () => {
  const plan = planFor(grid);
  for (let index = 0; index < 20000; index++) {
    const y = 1 - (2 * (index + 0.5)) / 20000;
    const longitude = index * Math.PI * (3 - Math.sqrt(5));
    const horizontal = Math.sqrt(1 - y * y);
    plan.volcanicCaps.push({
      position: [horizontal * Math.cos(longitude), y, horizontal * Math.sin(longitude)],
      radiusMetres: Math.PI * radius,
      targetSpacingMetres: 30,
    });
  }
  const singleCap = estimateRefinementWork(grid, { ...plan, volcanicCaps: [plan.volcanicCaps[0]] });
  const manyCaps = estimateRefinementWork(grid, plan);
  assert.equal(manyCaps.estimatedCells, singleCap.estimatedCells);
  assert.ok(manyCaps.sampledCaps <= 32);
  assert.equal(manyCaps.totalCaps, 20000);
  assert.ok(manyCaps.sampledDirections < 2000);
  assert.equal(manyCaps.uncertainty, 'order-of-magnitude');
});
