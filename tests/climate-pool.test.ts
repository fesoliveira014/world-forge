import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  collectClimateBuffers,
  createClimatePool,
  type ClimateWorkerRequest,
  type ClimateWorkerResponse,
} from '../src/app/climate-pool';
import type { ClimateSeason, PreparedClimate } from '../src/core/generation/climate';

/** Exercise the browser protocol without duplicating the numerical climate tests.
 * Native structuredClone preserves the worker boundary's ownership semantics.
 */
function installWorkers(context: TestContext, options: { ready?: boolean; failAt?: number } = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const instances: TestWorker[] = [];
  class TestWorker {
    onmessage: ((event: MessageEvent<ClimateWorkerResponse>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    terminated = false;
    requests: ClimateWorkerRequest[] = [];

    constructor() {
      if (instances.length === options.failAt) {
        throw new Error('Module workers unavailable');
      }
      instances.push(this);
      if (options.ready !== false) {
        queueMicrotask(() => this.emit({ type: 'ready' }));
      }
    }

    postMessage(request: ClimateWorkerRequest, transfer?: Transferable[]) {
      assert.equal(transfer, undefined, 'shared preparation must not be transferred');
      this.requests.push(structuredClone(request));
    }

    emit(message: ClimateWorkerResponse) {
      this.onmessage?.({ data: structuredClone(message) } as MessageEvent<ClimateWorkerResponse>);
    }

    terminate() {
      this.terminated = true;
    }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: TestWorker });
  context.after(() => {
    if (previous) {
      Object.defineProperty(globalThis, 'Worker', previous);
    } else {
      Reflect.deleteProperty(globalThis, 'Worker');
    }
  });
  return instances;
}

function preparation(): PreparedClimate {
  return { height: new Float32Array([10, 20]) } as PreparedClimate;
}

function season(seasonIndex: number): ClimateSeason {
  return {
    seasonIndex,
    temperature: new Float32Array([seasonIndex]),
    rain: new Float32Array([seasonIndex + 10]),
    pet: new Float32Array([seasonIndex + 20]),
    wind: new Float32Array([seasonIndex, 1, 2]),
    current: new Float32Array([3, 4, seasonIndex]),
    sst: new Float32Array([seasonIndex + 30]),
    moisture: new Float32Array([seasonIndex + 40]),
    evaporation: new Float32Array([seasonIndex + 50]),
    atmosphereResidual: seasonIndex * 1e-12,
    oceanDivergence: seasonIndex * 1e-8,
  };
}

test('climate pool combines out-of-order seasons and reuses a bounded set of workers', async (context) => {
  const workers = installWorkers(context);
  const pool = createClimatePool(2);
  context.after(() => pool.terminate());
  assert.equal(await pool.ready, true);
  const prepared = preparation();
  for (let pass = 0; pass < 2; pass++) {
    const result = pool.solve(prepared);
    await Promise.resolve();
    assert.equal(workers.length, 2);
    assert.deepEqual(workers[0].requests[pass].seasons, [0, 2]);
    assert.deepEqual(workers[1].requests[pass].seasons, [1, 3]);
    assert.notEqual(workers[0].requests[pass].prepared.height.buffer, prepared.height.buffer);
    for (const seasonIndex of [3, 0, 2, 1]) {
      const worker = workers[seasonIndex % 2];
      worker.emit({ type: 'season', id: worker.requests[pass].id, season: season(seasonIndex) });
    }
    const climate = await result;
    assert.deepEqual(
      climate.rain.map((field) => field[0]),
      [10, 11, 12, 13],
    );
    assert.equal(climate.atmosphereResidual, 3e-12);
    assert.equal(climate.oceanDivergence, 3 * 1e-8);
    const buffers = collectClimateBuffers(climate);
    assert.equal(buffers.length, 32);
    const received = structuredClone(climate, { transfer: buffers });
    assert.equal(received.rain[0][0], 10);
    assert.equal(climate.rain[0].byteLength, 0);
    assert.equal(prepared.height.byteLength, 8, 'sending results retains the shared preparation');
  }
  pool.terminate();
  assert.ok(workers.every((worker) => worker.terminated));
});

test('partial startup failure terminates all workers before any season starts', async (context) => {
  const failedWorkers = installWorkers(context, { failAt: 1 });
  const failed = createClimatePool(4);
  assert.equal(await failed.ready, false);
  assert.equal(failedWorkers.length, 1);
  assert.ok(failedWorkers.every((worker) => worker.terminated && worker.requests.length === 0));
  await assert.rejects(failed.solve(preparation()), /Module workers unavailable/);
});

test('startup timeout settles readiness and terminates workers without starting seasons', async (context) => {
  const stalledWorkers = installWorkers(context, { ready: false });
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const stalled = createClimatePool(2);
  context.mock.timers.tick(10000);
  assert.equal(await stalled.ready, false);
  assert.ok(stalledWorkers.every((worker) => worker.terminated && worker.requests.length === 0));
});

test('worker count stays bounded and unsupported environments permit startup fallback', async (context) => {
  const workers = installWorkers(context);
  const pool = createClimatePool(99);
  assert.equal(await pool.ready, true);
  assert.equal(pool.concurrency, 4);
  assert.equal(workers.length, 4);
  pool.terminate();
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: undefined });
  const unavailable = createClimatePool(2);
  assert.equal(await unavailable.ready, false);
  await assert.rejects(unavailable.solve(preparation()), /does not support climate workers/);
});

test('cancel terminates every active worker and rejects the outstanding climate job', async (context) => {
  const workers = installWorkers(context);
  const pool = createClimatePool(3);
  assert.equal(await pool.ready, true);
  const result = pool.solve(preparation());
  const rejected = assert.rejects(result, { name: 'AbortError' });
  await Promise.resolve();
  assert.ok(workers.every((worker) => worker.requests.length === 1));
  const staleHandler = workers[0].onmessage!;
  pool.terminate();
  await rejected;
  assert.ok(workers.every((worker) => worker.terminated));
  staleHandler({
    data: { type: 'season', id: 1, season: season(0) },
  } as MessageEvent<ClimateWorkerResponse>);
  await assert.rejects(pool.solve(preparation()), { name: 'AbortError' });
  pool.terminate();
});

test('cancel during worker startup resolves readiness without leaving workers alive', async (context) => {
  const workers = installWorkers(context, { ready: false });
  const pool = createClimatePool(4);
  pool.terminate();
  assert.equal(await pool.ready, false);
  assert.ok(workers.every((worker) => worker.terminated));
});

test('a season failure stops the complete pool and never retries completed work', async (context) => {
  const workers = installWorkers(context);
  const pool = createClimatePool(2);
  assert.equal(await pool.ready, true);
  const result = pool.solve(preparation());
  const rejected = assert.rejects(result, /solver failed/);
  await Promise.resolve();
  workers[0].emit({ type: 'season', id: 1, season: season(0) });
  workers[1].emit({ type: 'error', id: 1, message: 'solver failed' });
  await rejected;
  assert.ok(workers.every((worker) => worker.terminated && worker.requests.length === 1));
});

test('old job replies are ignored while duplicate current seasons reject the pool', async (context) => {
  const workers = installWorkers(context);
  const pool = createClimatePool(2);
  assert.equal(await pool.ready, true);
  const result = pool.solve(preparation());
  const rejected = assert.rejects(result, /duplicate season/);
  await Promise.resolve();
  workers[0].emit({ type: 'season', id: 0, season: season(0) });
  assert.ok(workers.every((worker) => !worker.terminated));
  workers[0].emit({ type: 'season', id: 1, season: season(0) });
  workers[0].emit({ type: 'season', id: 1, season: season(0) });
  await rejected;
  assert.ok(workers.every((worker) => worker.terminated));
});
