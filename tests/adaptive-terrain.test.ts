import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGrid } from '../src/core/grid/build';
import {
  DEFAULT_CONFIG,
  type Drainage,
  type Grid,
  type Rivers,
  type Terrain,
} from '../src/core/model';
import { angle, normalizeVector, readVector } from '../src/core/math';
import {
  createScalarSampler,
  createScalarStencilSampler,
} from '../src/core/operators/scalar-sampling';
import { buildTransfer } from '../src/core/operators/spatial';
import { buildGeology } from '../src/core/generation/geology';
import { evolveCrust } from '../src/core/generation/crust-evolution';
import { createTerrain, createTerrainHeightSampler } from '../src/core/generation/terrain';
import { createHotspots } from '../src/core/generation/volcanism';
import { buildDeltas } from '../src/core/generation/deltas';

function seamSamples(grid: Grid, edge: number, dual: boolean) {
  const coordinates = dual ? grid.corners : grid.positions;
  const endpoints = dual ? grid.edgeCorners : grid.edgeCells;
  const first = readVector(coordinates, endpoints[edge * 2]);
  const second = readVector(coordinates, endpoints[edge * 2 + 1]);
  const midpoint = normalizeVector(first.map((value, axis) => value + second[axis]));
  const normal = dual
    ? readVector(grid.edgeNormal, edge)
    : normalizeVector([
        first[1] * second[2] - first[2] * second[1],
        first[2] * second[0] - first[0] * second[2],
        first[0] * second[1] - first[1] * second[0],
      ]);

  return [-1, 1].map((side) =>
    normalizeVector(midpoint.map((value, axis) => value + side * normal[axis] * 1e-10)),
  );
}

test('scalar sampling is bounded, preserves coarse values, and does not depend on ownership', () => {
  const grid = buildGrid(2, 'SCALAR-STENCILS', 0.9);
  const field = Float32Array.from({ length: grid.count }, (_, cell) => Math.sin(cell * 3.2) * 900);
  const sample = createScalarSampler(grid, field);
  const locate = createScalarStencilSampler(grid);

  for (let cell = 0; cell < grid.count; cell++) {
    assert.ok(Math.abs(sample(...readVector(grid.positions, cell)) - field[cell]) < 1e-8);
  }

  for (let corner = 0; corner < grid.corners.length / 3; corner++) {
    const position = readVector(grid.corners, corner);
    const stencil = locate(...position);
    const bounds = [...stencil.cells].map((cell) => field[cell]);
    const value = sample(...position);
    assert.ok(value >= Math.min(...bounds) - 1e-8 && value <= Math.max(...bounds) + 1e-8);
    assert.ok(
      Math.abs([...stencil.weights].reduce((total, weight) => total + weight, 0) - 1) < 1e-12,
    );
    assert.ok(Math.abs(sample(...position, grid.count - 1) - value) < 1e-8);
  }

  for (let edge = 0; edge < grid.edgeLength.length; edge++) {
    for (const dual of [false, true]) {
      const [first, second] = seamSamples(grid, edge, dual);
      assert.ok(Math.abs(sample(...first) - sample(...second)) < 1e-4);
    }
  }
});

test('adaptive terrain is continuous across material ownership and interpolation edges', () => {
  const config = { ...DEFAULT_CONFIG, processLevel: 2, tectonicDuration: 40 };
  const process = buildGrid(config.processLevel, config.seed, config.irregularity);
  const geology = buildGeology(process, config);
  evolveCrust(process, geology, config);
  const sample = createTerrainHeightSampler(process, geology, config);
  assert.equal(sample.seaThreshold, geology.crust!.seaThreshold);
  let plateSeams = 0;

  for (let edge = 0; edge < process.edgeLength.length; edge++) {
    if (
      geology.plate[process.edgeCells[edge * 2]] !== geology.plate[process.edgeCells[edge * 2 + 1]]
    ) {
      plateSeams++;
    }

    for (const dual of [false, true]) {
      const [first, second] = seamSamples(process, edge, dual);
      const difference = Math.abs(sample.heightAt(...first) - sample.heightAt(...second));
      assert.ok(difference < 0.001, `Terrain seam ${edge}: ${difference} m`);
    }
  }

  assert.ok(plateSeams > 0);
});

test('surface resampling preserves the geological history, datum, and coarse elevations', () => {
  const config = { ...DEFAULT_CONFIG, processLevel: 2, tectonicDuration: 30 };
  const process = buildGrid(config.processLevel, config.seed, config.irregularity);
  const geology = buildGeology(process, config);
  const hotspots = geology.hotspots;
  assert.deepEqual(hotspots, createHotspots(config));
  evolveCrust(process, geology, config);
  assert.equal(geology.hotspots, hotspots);
  const snapshot = structuredClone(geology);
  const transfer = buildTransfer(process, process);
  const legacy = createTerrain(process, process, transfer, geology, config);
  const continuous = createTerrain(process, process, transfer, geology, config, {
    continuous: true,
  });

  for (let cell = 0; cell < process.count; cell++) {
    assert.ok(Math.abs(legacy.height[cell] - continuous.height[cell]) < 0.01);
  }

  const fine = buildGrid(3, config.seed, config.irregularity);
  const refined = createTerrain(fine, process, buildTransfer(process, fine), geology, config, {
    continuous: true,
  });
  assert.equal(refined.seaThreshold, continuous.seaThreshold);
  assert.deepEqual(geology, snapshot);
  assert.ok(refined.height.every(Number.isFinite));
});

test('adaptive delta neighborhoods cover their physical reach beyond 24 visited corners', () => {
  const grid = buildGrid(3, 'DELTA', 0.5);
  const cornerCount = grid.corners.length / 3;
  const receiver = grid.cornerNeighbors[0];
  const terrain = {
    ocean: new Uint8Array(grid.count).fill(1),
    height: new Float32Array(grid.count),
    deltaSediment: new Float32Array(grid.count).fill(100),
  } as Terrain;
  const drainage = {
    receiver: new Int32Array(cornerCount).fill(-1),
    discharge: new Float64Array(cornerCount),
    lakeFraction: new Float32Array(cornerCount),
    lakeId: new Int32Array(cornerCount).fill(-1),
    height: new Float32Array(cornerCount),
    lakeCoverage: new Float32Array(grid.count),
  } as Drainage;
  drainage.receiver[0] = receiver;
  drainage.discharge[0] = 500;
  const rivers = { channel: new Uint8Array(cornerCount) } as Rivers;
  rivers.channel[0] = 1;
  const config = { ...DEFAULT_CONFIG, radius: 100000 };
  const legacy = buildDeltas(grid, terrain, drainage, rivers, config)[0];
  const physical = buildDeltas(grid, terrain, drainage, rivers, config, {
    physicalNeighborhood: true,
  })[0];

  const reach = (points: Float32Array) =>
    angle(readVector(grid.corners, receiver), readVector(points, points.length / 3 - 1)) *
    config.radius;
  assert.ok(physical.sedimentVolume > legacy.sedimentVolume * 2);
  assert.ok(Math.max(...physical.branches.map((branch) => reach(branch.points))) > 50000);
  assert.ok(Math.max(...legacy.branches.map((branch) => reach(branch.points))) < 40000);
  assert.ok(physical.branches.every((branch) => reach(branch.points) < 65000));
  assert.equal(
    physical.branches.reduce((sum, branch) => sum + branch.fraction, 0),
    1,
  );
});
