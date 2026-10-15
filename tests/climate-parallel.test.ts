import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createNodeClimatePool } from '../scripts/climate-pool';
import { buildGrid } from '../src/core/grid/build';
import { solveClimate } from '../src/core/generation/climate';
import { DEFAULT_CONFIG, type World } from '../src/core/model';
import { generateWorld, generateWorldAsync, type ClimateRequest } from '../src/core/pipeline';

function fixture(): ClimateRequest {
  const config = { ...DEFAULT_CONFIG, seed: 'THREAD-SEASONS', moistureLifetime: 14 };
  const grid = buildGrid(2, config.seed, config.irregularity);
  const height = Float32Array.from(
    { length: grid.count },
    (_, cell) => 1500 * Math.sin(grid.positions[cell * 3] * 5) - 350,
  );
  const ocean = Uint8Array.from(height, (value) => +(value < 0));
  const referenceOcean = Uint8Array.from(height, (value) => +(value < 150));

  return { grid, height, ocean, referenceOcean, config };
}

function serialClimate(request: ClimateRequest) {
  return solveClimate(
    request.grid,
    request.height,
    request.ocean,
    request.config,
    request.referenceOcean,
    request.recycledEvapotranspiration,
  );
}

function physicalWorld(world: World) {
  const result = { ...world };
  result.timings = [];
  result.elapsed = 0;
  result.execution = { climateWorkers: 1 };

  return result;
}

test('real Node climate threads reproduce every serial buffer at one, two and four workers', async () => {
  const request = fixture();
  const feedback = {
    ...request,
    recycledEvapotranspiration: Float32Array.from(
      { length: request.grid.count },
      (_, cell) => 110 + (cell % 9) * 40,
    ),
  };
  const before = structuredClone(feedback);
  const expected = serialClimate(request);
  const expectedFeedback = serialClimate(feedback);

  for (const concurrency of [1, 2, 4]) {
    const pool = createNodeClimatePool(concurrency);

    try {
      // Simultaneous callers queue complete solves, while seasons run in actual
      // worker_threads. Reuse must replace, rather than retain, the old context.
      const [initial, recycled] = await Promise.all([pool.solve(request), pool.solve(feedback)]);
      assert.deepEqual(initial, expected);
      assert.deepEqual(recycled, expectedFeedback);
      assert.deepEqual(feedback, before, 'input buffers remain attached and unchanged');
    } finally {
      await pool.close();
    }
  }
});

test('parallel climate produces an exactly identical evolved adaptive world', async () => {
  const config = {
    ...DEFAULT_CONFIG,
    seed: 'THREAD-WORLD',
    surfaceLevel: 3,
    processLevel: 3,
    refinementStrength: 0.5,
    refinementMinSpacing: 600000,
    evolutionRefinements: 1,
    landscapeBatches: 2,
    tectonicDuration: 20,
    fluvialDuration: 0.25,
  };
  const serial = generateWorld(config);
  const pool = createNodeClimatePool(4);
  const progress: [number, number][] = [];

  try {
    const parallel = await generateWorldAsync(
      config,
      (_, completed, total) => progress.push([completed, total]),
      { solveClimate: pool.solve, climateConcurrency: 4 },
    );
    assert.equal(parallel.execution.climateWorkers, 4);
    assert.equal(serial.execution.climateWorkers, 1);
    assert.deepEqual(physicalWorld(parallel), physicalWorld(serial));
    assert.deepEqual(progress.at(-1), [parallel.timings.length, parallel.timings.length]);
  } finally {
    await pool.close();
  }
});

test('closing a pool rejects its active and queued solves and is idempotent', async () => {
  const pool = createNodeClimatePool(4);
  const request = fixture();
  const active = assert.rejects(pool.solve(request), /pool.*clos/);
  const queued = assert.rejects(pool.solve(request), /pool.*clos/);
  // The first solve creates real workers before cancellation.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const closing = pool.close();
  assert.equal(pool.close(), closing);
  await closing;
  await Promise.all([active, queued]);
  await assert.rejects(pool.solve(request), /closed/);
});

test('a season failure terminates every worker so its process exits without manual cleanup', async () => {
  const run = promisify(execFile);
  const source = `
    import assert from 'node:assert/strict';
    import { createNodeClimatePool } from './scripts/climate-pool.ts';
    import { buildGrid } from './src/core/grid/build.ts';
    import { DEFAULT_CONFIG } from './src/core/model.ts';
    const grid = buildGrid(1, 'failure-cleanup', 0.5);
    const height = Float32Array.from({ length: grid.count }, (_, cell) => grid.positions[cell * 3] * 900);
    const ocean = Uint8Array.from(height, height => +(height < 0));
    const request = { grid, height, ocean, referenceOcean: ocean, config: DEFAULT_CONFIG };
    const pool = createNodeClimatePool(4);
    await pool.solve(request);
    // Serializable but deliberately invalid: geometry preparation succeeds,
    // then the worker's seeded seasonal circulation cannot coerce this seed.
    const broken = { ...request, config: { ...DEFAULT_CONFIG, seed: { toString: 0, valueOf: 0 } } };
    await assert.rejects(pool.solve(broken), /Climate worker failed/);
    await assert.rejects(pool.solve(request), /Climate worker failed/);
    process.stdout.write('workers terminated');
  `;
  const { stdout, stderr } = await run(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', source],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      timeout: 20000,
    },
  );
  assert.equal(stdout, 'workers terminated');
  assert.equal(stderr, '');
});

test('climate concurrency is explicitly bounded to its four independent seasons', () => {
  for (const concurrency of [0, 5, 1.5, NaN]) {
    assert.throws(() => createNodeClimatePool(concurrency), /one to four/);
  }
});
