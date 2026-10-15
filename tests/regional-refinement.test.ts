import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWorld } from '../src/core/pipeline';
import {
  planRegionalRefinement,
  refineExistingWorld,
  replayRegionalRefinements,
} from '../src/core/regional-refinement';
import {
  DEFAULT_CONFIG,
  VERSION,
  type RegionalRefinementRequest,
  type World,
} from '../src/core/model';
import { readWorldProject, worldProject } from '../src/core/project';
import { solveSalinity } from '../src/core/generation/salinity';

const config = {
  ...DEFAULT_CONFIG,
  seed: 'regional-history-test',
  surfaceLevel: 3,
  processLevel: 3,
  radius: 3000000,
  tectonicDuration: 10,
  fluvialDuration: 0.2,
  landscapeBatches: 2,
};
const base = generateWorld(config);
let anchor = 0;
for (let cell = 1; cell < base.grid.count; cell++) {
  if (base.terrain.fluvialIncision[cell] > base.terrain.fluvialIncision[anchor]) {
    anchor = cell;
  }
}
const request: RegionalRefinementRequest = {
  kind: 'region',
  center: [
    base.grid.positions[anchor * 3],
    base.grid.positions[anchor * 3 + 1],
    base.grid.positions[anchor * 3 + 2],
  ],
  radiusMetres: 250000,
  targetSpacingMetres: 120000,
};

function inventory(world: World, field: Float32Array) {
  return field.reduce(
    (sum, value, cell) => sum + value * world.grid.areas[cell] * config.radius ** 2,
    0,
  );
}

test('regional insertion preserves evolved material, geological history and resource identity', () => {
  const before = structuredClone(base);
  const progress: [number, number][] = [];
  const refined = refineExistingWorld(base, request, {
    progress: (_, completed, total) => progress.push([completed, total]),
  });
  assert.ok(refined.grid.count > base.grid.count);
  assert.equal(refined.version, VERSION);
  assert.deepEqual(
    refined.grid.positions.subarray(0, base.grid.positions.length),
    base.grid.positions,
  );
  assert.deepEqual(refined.terrain.bedrock.subarray(0, base.grid.count), base.terrain.bedrock);
  assert.deepEqual(
    refined.terrain.surfaceChange.subarray(0, base.grid.count),
    base.terrain.surfaceChange,
  );
  for (const field of ['sediment', 'fluvialIncision', 'deltaSediment'] as const) {
    const initial = inventory(base, base.terrain[field]);
    const final = inventory(refined, refined.terrain[field]);
    assert.ok(Math.abs(final - initial) < Math.max(1, initial) * 1e-7, field);
  }
  assert.equal(refined.process, base.process);
  assert.equal(refined.geology, base.geology);
  assert.equal(refined.climate, base.climate);
  assert.equal(refined.evolution, base.evolution);
  assert.equal(refined.sedimentExport, base.sedimentExport);
  assert.equal(refined.resources.deposits, base.resources.deposits);
  assert.equal(refined.refinementPlans, base.refinementPlans);
  assert.equal(refined.regionalRefinements?.length, 1);
  assert.equal(refined.climateReferenceHeight?.length, base.process.count);
  assert.equal(refined.resources.fertility.length, refined.grid.count);
  assert.equal(refined.water.runoff.length, refined.grid.count);
  assert.equal(refined.drainage.receiver.length, refined.grid.corners.length / 3);
  assert.ok(refined.terrain.sediment.every((depth) => Number.isFinite(depth) && depth >= 0));
  const residual =
    refined.drainage.runoffTotal - refined.drainage.oceanDischarge - refined.drainage.lakeExchange;
  assert.ok(Math.abs(residual) / Math.max(1, refined.drainage.runoffTotal) < 1e-8);
  assert.deepEqual(progress.at(-1), [8, 8]);
  assert.deepEqual(base, before, 'the displayed source remains available for rollback');
});

test('refining a restored older snapshot records the current physics version', () => {
  const restored = { ...base, version: '2.17.0' };
  const refined = refineExistingWorld(restored, request);
  assert.equal(refined.version, VERSION);
  assert.equal(restored.version, '2.17.0');
  assert.equal(
    refineExistingWorld(restored, { ...request, targetSpacingMetres: 1e9 }),
    restored,
    'a no-op retains the original snapshot and its version',
  );
});

test('regional refinement preserves salt mass and age without replaying source inputs', () => {
  const salted = structuredClone(base);
  delete salted.terrain.saltParcels;
  salted.terrain.saltMass = Float64Array.from({ length: salted.grid.count }, (_, cell) =>
    salted.terrain.ocean[cell] ? 0 : (1 + (cell % 11)) * 1e10,
  );
  salted.terrain.saltAgeYears = 250;
  salted.config.salinityYears = 10000;
  salted.config.inheritedMarineSalinity = 35;
  const original = structuredClone(salted);
  const initial = salted.terrain.saltMass.reduce((sum, mass) => sum + mass, 0);
  const refined = refineExistingWorld(salted, request);
  assert.ok(refined.grid.count > salted.grid.count);
  assert.ok(refined.terrain.saltMass instanceof Float64Array);
  const final = refined.terrain.saltMass.reduce((sum, mass) => sum + mass, 0);
  assert.ok(
    Math.abs(final / initial - 1) < 1e-8,
    'new lake footprints only redistribute existing salt',
  );
  assert.equal(refined.terrain.saltAgeYears, 250);
  assert.deepEqual(salted, original, 'the source world remains unchanged for rollback');
  assert.ok(refined.drainage.lakes.every((lake) => !!lake.salinity));
});

test('refining a legacy snapshot does not invent a salt inventory or marine history', () => {
  const legacy = structuredClone(base);
  delete legacy.terrain.saltMass;
  delete legacy.terrain.saltParcels;
  delete legacy.terrain.saltAgeYears;
  for (const lake of legacy.drainage.lakes) {
    delete lake.salinity;
  }
  const refined = refineExistingWorld(legacy, request);
  assert.ok(refined.grid.count > legacy.grid.count);
  assert.equal(refined.terrain.saltMass, undefined);
  assert.equal(refined.terrain.saltParcels, undefined);
  assert.equal(refined.terrain.saltAgeYears, undefined);
  assert.ok(refined.drainage.lakes.every((lake) => lake.salinity === undefined));
});

test('remeshing retains immutable salt parcels and repeated reconciliation cannot exchange lake salt', () => {
  const refined = refineExistingWorld(base, request);
  assert.ok(base.terrain.saltParcels);
  assert.equal(refined.terrain.saltParcels, base.terrain.saltParcels);
  const parcels = structuredClone(refined.terrain.saltParcels);
  const lakes = structuredClone(refined.drainage.lakes);
  const inventory = new Float64Array(refined.terrain.saltMass!);
  for (let pass = 0; pass < 3; pass++) {
    solveSalinity(refined.grid, refined.terrain, refined.water, refined.drainage, refined.config, {
      advanceYears: 0,
    });
    assert.deepEqual(
      refined.drainage.lakes,
      lakes,
      'neighboring basins retain separate salt stores',
    );
    assert.deepEqual(
      refined.terrain.saltMass,
      inventory,
      'reconciliation cannot diffuse inventory',
    );
    assert.deepEqual(
      refined.terrain.saltParcels,
      parcels,
      'the geography and mass of each parcel stay fixed',
    );
  }
});

test('refining distant terrain does not alter an unchanged closed lake salt store', () => {
  const world = generateWorld({
    ...DEFAULT_CONFIG,
    seed: 'AETHER-2408',
    surfaceLevel: 3,
    processLevel: 3,
    tectonicDuration: 0,
    erosion: 0,
    refinementStrength: 0,
    featureRefinementPasses: 0,
  });
  const lake = world.drainage.lakes.find(
    (candidate) =>
      candidate.area > 0 && candidate.outflow === 0 && candidate.salinity!.dissolvedSalt > 0,
  );
  assert.ok(lake, 'fixture contains a wet closed basin');
  const sourceCorner = world.drainage.lakeId.findIndex(
    (id, corner) => id === lake.id && world.drainage.lakeFraction[corner] > 0,
  );
  assert.ok(sourceCorner >= 0);
  const point = world.grid.corners.subarray(sourceCorner * 3, sourceCorner * 3 + 3);
  const refined = refineExistingWorld(world, {
    ...request,
    center: [-point[0], -point[1], -point[2]],
  });
  assert.ok(refined.grid.count > world.grid.count);
  let corner = -1;
  let distance = Infinity;
  for (let candidate = 0; candidate < refined.drainage.receiver.length; candidate++) {
    const candidateDistance = Math.hypot(
      point[0] - refined.grid.corners[candidate * 3],
      point[1] - refined.grid.corners[candidate * 3 + 1],
      point[2] - refined.grid.corners[candidate * 3 + 2],
    );
    if (candidateDistance < distance) {
      distance = candidateDistance;
      corner = candidate;
    }
  }
  assert.ok(distance < 1e-12, 'the lake corner geometry is unchanged');
  const corresponding = refined.drainage.lakes[refined.drainage.lakeId[corner]];
  assert.ok(corresponding);
  const originalMass = lake.salinity!.dissolvedSalt + lake.salinity!.bedSalt;
  const retainedMass = corresponding.salinity!.dissolvedSalt + corresponding.salinity!.bedSalt;
  assert.ok(
    Math.abs(retainedMass / originalMass - 1) < 1e-10,
    'distant refinement cannot move salt between lakes',
  );
  assert.equal(corresponding.salinity!.elapsedYears, lake.salinity!.elapsedYears);
});

test('saved regional actions replay their chosen geography in sequence without extra elapsed time', () => {
  const first = refineExistingWorld(base, request);
  const next: RegionalRefinementRequest = {
    kind: 'region',
    center: [-request.center[0], -request.center[1], -request.center[2]],
    radiusMetres: 150000,
    targetSpacingMetres: 100000,
  };
  const estimate = planRegionalRefinement(first, next).estimate;
  assert.ok(estimate.estimatedAddedCells > 0, 'existing dense regions cannot hide new local work');
  assert.equal(estimate.estimatedCells, first.grid.count + estimate.estimatedAddedCells);
  const second = refineExistingWorld(first, next);
  assert.equal(second.regionalRefinements?.length, 2);
  assert.equal(second.climateReferenceHeight, first.climateReferenceHeight);
  const recipe = JSON.parse(JSON.stringify(worldProject(second)));
  const imported = readWorldProject(recipe);
  assert.deepEqual(imported.regionalRefinements, second.regionalRefinements);
  const regenerated = generateWorld(imported.config, undefined, {
    refinementPlans: imported.refinementPlans,
  });
  const replayed = replayRegionalRefinements(regenerated, imported.regionalRefinements);
  assert.deepEqual(replayed.grid.positions, second.grid.positions);
  assert.deepEqual(replayed.grid.triangles, second.grid.triangles);
  assert.deepEqual(replayed.terrain, second.terrain);
  assert.deepEqual(replayed.water, second.water);
  assert.deepEqual(replayed.drainage, second.drainage);
  assert.deepEqual(replayed.resources, second.resources);
  assert.deepEqual(replayed.evolution, base.evolution);
  assert.equal(replayed.sedimentExport, base.sedimentExport);
});

test('a selected watershed resolves its current final river system to geographic footprints', () => {
  let corner = 0;
  for (let candidate = 1; candidate < base.rivers.catchmentArea.length; candidate++) {
    if (base.rivers.catchmentArea[candidate] > base.rivers.catchmentArea[corner]) {
      corner = candidate;
    }
  }
  const plan = planRegionalRefinement(base, {
    kind: 'watershed',
    corner,
    targetSpacingMetres: 200000,
  });
  assert.ok(plan.resolved.caps.length > 1);
  assert.equal(plan.resolved.request.kind, 'watershed');
  const system = base.rivers.system[corner];
  const selected = new Set<number>();
  for (let candidate = 0; candidate < base.rivers.system.length; candidate++) {
    if (base.rivers.system[candidate] !== system) {
      continue;
    }
    for (let incident = 0; incident < 3; incident++) {
      const cell = base.grid.triangles[candidate * 3 + incident];
      if (!base.terrain.ocean[cell]) {
        selected.add(cell);
      }
    }
  }
  assert.deepEqual(
    plan.resolved.caps.map((cap) => cap.center),
    [...selected]
      .sort((first, second) => first - second)
      .map((cell) => Array.from(base.grid.positions.subarray(cell * 3, cell * 3 + 3))),
    'the saved footprint covers exactly the selected final river-system land cells',
  );
  const landCount = base.terrain.ocean.reduce((count, ocean) => count + (ocean ? 0 : 1), 0);
  assert.ok(selected.size < landCount, 'unrelated watersheds are excluded');
  for (const cap of plan.resolved.caps) {
    assert.ok(plan.spacingAt(...cap.center) <= 200000 * (1 + 1e-12));
  }
  assert.equal(plan.estimate.uncertainty, 'order-of-magnitude');
  assert.ok(plan.estimate.estimatedCells >= base.grid.count);
  assert.ok(plan.estimate.estimatedPeakMiB >= base.bytes / 1048576);
  const refined = refineExistingWorld(base, plan.resolved.request);
  const replayed = replayRegionalRefinements(base, refined.regionalRefinements);
  assert.deepEqual(replayed.grid.positions, refined.grid.positions);
  assert.deepEqual(replayed.terrain, refined.terrain);

  let deepOcean = -1;
  for (let candidate = 0; candidate < base.rivers.system.length; candidate++) {
    if (
      base.grid.triangles
        .subarray(candidate * 3, candidate * 3 + 3)
        .every((cell) => base.terrain.ocean[cell])
    ) {
      deepOcean = candidate;
      break;
    }
  }
  assert.ok(deepOcean >= 0);
  assert.throws(
    () =>
      planRegionalRefinement(base, {
        kind: 'watershed',
        corner: deepOcean,
        targetSpacingMetres: 200000,
      }),
    /no land watershed/,
  );
});

test('coarser requests are genuine no-ops and region validation uses spherical physical limits', () => {
  const unchanged = refineExistingWorld(base, {
    kind: 'region',
    center: [0, 2, 0],
    radiusMetres: Math.PI * config.radius,
    targetSpacingMetres: 2 * Math.PI * config.radius,
  });
  assert.equal(unchanged, base);
  assert.equal(base.regionalRefinements, undefined);
  for (const radiusMetres of [-1, Math.PI * config.radius + 1, NaN, Infinity]) {
    assert.throws(() => planRegionalRefinement(base, { ...request, radiusMetres }), /radius/);
  }
  for (const targetSpacingMetres of [0, -1, NaN, Infinity]) {
    assert.throws(
      () => planRegionalRefinement(base, { ...request, targetSpacingMetres }),
      /spacing/,
    );
  }
  assert.throws(() => planRegionalRefinement(base, { ...request, center: [0, 0, 0] }), /direction/);
  assert.throws(
    () => planRegionalRefinement(base, { ...request, targetSpacingMetres: 1e-10 }),
    /precision/,
  );
  assert.throws(
    () =>
      planRegionalRefinement(base, { kind: 'watershed', corner: -1, targetSpacingMetres: 100000 }),
    /corner/,
  );
});

test('saved regional history rejects malformed footprints and mismatched source states', () => {
  const plan = planRegionalRefinement(base, request).resolved;
  assert.throws(
    () => readWorldProject({ ...worldProject(base), regionalRefinements: {} }),
    /array/,
  );
  assert.throws(
    () => readWorldProject({ ...worldProject(base), regionalRefinements: [{}] }),
    /regional refinement/,
  );
  assert.throws(
    () => replayRegionalRefinements(base, [{ ...plan, sourceGeometryHash: 'different' }]),
    /does not match/,
  );
  assert.throws(
    () => replayRegionalRefinements({ ...base, config: { ...base.config, erosion: 0 } }, [plan]),
    /does not match/,
  );
});
