import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_TILE_REQUESTS, TileRequestQueue } from '../src/render/TileLod';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('appearance revisions share four active requests and retain only four queued requests', async () => {
  const queue = new TileRequestQueue();
  const started: number[] = [];
  const finishes = new Map<number, () => void>();
  let active = 0;
  let peak = 0;
  const requests = Array.from({ length: 24 }, (_, index) =>
    queue
      .run(
        () => {
          active++;
          peak = Math.max(peak, active);
          started.push(index);
          return new Promise<number>((resolve) =>
            finishes.set(index, () => {
              active--;
              resolve(index);
            }),
          );
        },
        () => true,
      )
      .then(
        (value) => ({ value }),
        (error: Error) => ({ error }),
      ),
  );
  await flush();
  assert.deepEqual(started, [0, 1, 2, 3]);
  for (const index of started) {
    finishes.get(index)!();
  }
  await flush();
  assert.deepEqual(started, [0, 1, 2, 3, 20, 21, 22, 23]);
  for (const index of started.slice(4)) {
    finishes.get(index)!();
  }
  const outcomes = await Promise.all(requests);
  assert.equal(outcomes.filter((outcome) => 'error' in outcome).length, 16);
  assert.equal(peak, MAX_TILE_REQUESTS);
  assert.equal(active, 0);
});

test('queued packets from an obsolete appearance never call the sampling source', async () => {
  const queue = new TileRequestQueue();
  const finish: (() => void)[] = [];
  const running = Array.from({ length: MAX_TILE_REQUESTS }, () =>
    queue.run(
      () => new Promise<void>((resolve) => finish.push(resolve)),
      () => true,
    ),
  );
  let current = true;
  let staleCalls = 0;
  const stale = Array.from({ length: MAX_TILE_REQUESTS }, () =>
    queue
      .run(
        async () => {
          staleCalls++;
        },
        () => current,
      )
      .catch((error: Error) => error),
  );
  await flush();
  current = false;
  let freshCalls = 0;
  const fresh = queue.run(
    async () => {
      freshCalls++;
    },
    () => true,
  );
  for (const resolve of finish) {
    resolve();
  }
  await Promise.all([...running, ...stale, fresh]);
  assert.equal(staleCalls, 0);
  assert.equal(freshCalls, 1);
});

test('synchronous source failures release shared queue slots for later requests', async () => {
  const queue = new TileRequestQueue();
  await Promise.all(
    Array.from({ length: MAX_TILE_REQUESTS }, () =>
      assert.rejects(
        queue.run(
          () => {
            throw Error('closed source');
          },
          () => true,
        ),
        /closed source/,
      ),
    ),
  );
  let completed = false;
  const next = queue.run(
    async () => {
      completed = true;
    },
    () => true,
  );
  await flush();
  assert.equal(completed, true);
  await next;
});
