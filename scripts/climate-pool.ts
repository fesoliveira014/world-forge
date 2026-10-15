import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  combineClimateSeasons,
  prepareClimate,
  type ClimateSeason,
  type PreparedClimate,
} from '../src/core/generation/climate';
import type { Climate } from '../src/core/model';
import type { ClimateRequest } from '../src/core/pipeline';

export type ClimateWorkerRequest =
  | { type: 'prepare'; solveId: number; seasonIndex: number; prepared: PreparedClimate }
  | { type: 'season'; solveId: number; seasonIndex: number }
  | { type: 'release'; solveId: number };

export type ClimateWorkerResponse =
  | { type: 'result'; solveId: number; result: ClimateSeason }
  | { type: 'error'; solveId: number; message: string; stack?: string };

interface WorkerSlot {
  worker: Worker;
  seasonIndex: number;
}

interface ActiveSolve {
  id: number;
  results: ClimateSeason[];
  nextSeason: number;
  remaining: number;
  resolve: (climate: Climate) => void;
  reject: (error: Error) => void;
}

export interface NodeClimatePool {
  solve(request: ClimateRequest): Promise<Climate>;
  close(): Promise<void>;
}

/** A reusable, bounded pool for the four independent climate seasons.
 * Jobs serialize while seasons run concurrently. Each worker receives one cloned
 * read-only prepared context per job; only completed season buffers transfer back.
 * A worker failure closes the whole pool and rejects queued solves. Always close
 * the pool in a finally block, including after successful generation.
 */
export function createNodeClimatePool(concurrency = 4): NodeClimatePool {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw Error('Climate concurrency must be an integer from one to four.');
  }

  const slots: WorkerSlot[] = [];
  const require = createRequire(import.meta.url);
  const tsxApi = pathToFileURL(require.resolve('tsx/esm/api')).href;
  let active: ActiveSolve | undefined;
  let nextSolveId = 0;
  let closed = false;
  let failure: Error | undefined;
  let closing: Promise<void> | undefined;
  let queue: Promise<void> = Promise.resolve();

  const close = (): Promise<void> => {
    if (!closing) {
      closed = true;
      active?.reject(failure ?? Error('Climate worker pool closed during a solve.'));
      active = undefined;
      closing = Promise.allSettled(slots.map(({ worker }) => worker.terminate())).then(() => {});
    }

    return closing;
  };

  const fail = (error: unknown) => {
    if (closed) {
      return;
    }

    failure = error instanceof Error ? error : Error(String(error));
    void close();
  };

  const receive = (slot: WorkerSlot, message: ClimateWorkerResponse) => {
    if (!active || closed || message.solveId !== active.id) {
      return;
    }

    if (message.type === 'error') {
      const error = Error(`Climate worker failed: ${message.message}`);
      error.stack = message.stack ?? error.stack;
      fail(error);

      return;
    }

    const seasonIndex = message.result.seasonIndex;

    if (seasonIndex !== slot.seasonIndex || active.results[seasonIndex]) {
      fail(Error('Climate worker returned an unexpected season.'));

      return;
    }

    active.results[seasonIndex] = message.result;
    active.remaining--;

    if (active.remaining === 0) {
      const finished = active;

      try {
        const climate = combineClimateSeasons(finished.results);

        // Keep worker runtimes warm, but allow their copied meshes and prepared
        // arrays to be collected before subsequent terrain remeshing peaks.
        for (const workerSlot of slots) {
          const release: ClimateWorkerRequest = { type: 'release', solveId: finished.id };
          workerSlot.worker.postMessage(release);
        }

        active = undefined;
        finished.resolve(climate);
      } catch (error) {
        fail(error);
      }
    } else if (active.nextSeason < 4) {
      slot.seasonIndex = active.nextSeason++;
      const request: ClimateWorkerRequest = {
        type: 'season',
        solveId: active.id,
        seasonIndex: slot.seasonIndex,
      };

      try {
        slot.worker.postMessage(request);
      } catch (error) {
        fail(error);
      }
    }
  };

  const startWorkers = () => {
    while (slots.length < concurrency) {
      // Explicit tsImport also resolves extensionless TS dependencies on Node 22.
      // Inheriting --import tsx alone does not reliably install its worker hooks.
      const worker = new Worker(
        `const { workerData } = require('node:worker_threads');
         import(workerData.tsxApi).then(({ tsImport }) =>
           tsImport(workerData.entry, workerData.parentURL));`,
        {
          eval: true,
          workerData: {
            tsxApi,
            entry: new URL('./climate-thread.ts', import.meta.url).href,
            parentURL: import.meta.url,
          },
          execArgv: [],
        },
      );
      const slot = { worker, seasonIndex: -1 };
      slots.push(slot);
      worker.on('message', (message: ClimateWorkerResponse) => receive(slot, message));
      worker.on('error', fail);
      worker.on('exit', (code) => {
        if (!closed) {
          fail(Error(`Climate worker exited unexpectedly with code ${code}.`));
        }
      });
    }
  };

  const run = (request: ClimateRequest): Promise<Climate> => {
    if (closed) {
      return Promise.reject(failure ?? Error('Climate worker pool is closed.'));
    }

    return new Promise<Climate>((resolve, reject) => {
      active = {
        id: nextSolveId++,
        results: [],
        nextSeason: concurrency,
        remaining: 4,
        resolve,
        reject,
      };

      try {
        const prepared = prepareClimate(
          request.grid,
          request.height,
          request.ocean,
          request.config,
          request.referenceOcean,
          request.recycledEvapotranspiration,
        );
        startWorkers();

        for (let index = 0; index < slots.length; index++) {
          const slot = slots[index];
          slot.seasonIndex = index;
          const message: ClimateWorkerRequest = {
            type: 'prepare',
            solveId: active.id,
            seasonIndex: index,
            prepared,
          };
          slot.worker.postMessage(message);
        }
      } catch (error) {
        fail(error);
      }
    });
  };

  return {
    solve(request) {
      const pending = queue.then(() => run(request));
      queue = pending.then(
        () => {},
        () => {},
      );

      return pending;
    },
    close,
  };
}
