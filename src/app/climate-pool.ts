import {
  combineClimateSeasons,
  type ClimateSeason,
  type PreparedClimate,
} from '../core/generation/climate';
import type { Climate } from '../core/model';

export interface ClimateWorkerRequest {
  id: number;
  prepared: PreparedClimate;
  seasons: number[];
}

export type ClimateWorkerResponse =
  | { type: 'ready' }
  | { type: 'season'; id: number; season: ClimateSeason }
  | { type: 'error'; id: number; message: string };

export interface ClimatePool {
  readonly concurrency: number;
  /** False permits a serial fallback before any seasonal work has started. */
  readonly ready: Promise<boolean>;
  solve(prepared: PreparedClimate): Promise<Climate>;
  /** Immediately stop every worker and reject any outstanding solve. */
  terminate(): void;
}

/** Only fresh climate outputs may be transferred back to the generation worker.
 * Prepared geometry remains owned by its caller and is always structured-cloned.
 */
export function collectClimateBuffers(climate: Climate): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const value of Object.values(climate)) {
    if (Array.isArray(value)) {
      for (const field of value) {
        if (field.buffer instanceof ArrayBuffer) {
          buffers.add(field.buffer);
        }
      }
    }
  }
  return [...buffers];
}

interface PendingClimate {
  id: number;
  seasons: ClimateSeason[];
  received: Uint8Array;
  resolve: (climate: Climate) => void;
  reject: (error: Error) => void;
}

/** A main-thread-owned pool: cancellation never leaves nested workers running.
 * At most four copies of read-only preparation and four seasonal workspaces are
 * live. Each worker receives its preparation once per climate pass and transfers
 * completed fields out immediately. The preparation itself contains no functions,
 * SharedArrayBuffers, or cross-origin isolation requirements.
 *
 * Readiness is established for the complete pool before jobs can be submitted.
 * Startup failure returns ready=false; a failure after startup rejects the job
 * and stops the pool, never silently running the same seasons a second time.
 */
export function createClimatePool(requestedConcurrency?: number): ClimatePool {
  const hardware = typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency || 2;
  const requested = requestedConcurrency ?? hardware;
  const concurrency = Math.max(
    1,
    Math.min(4, Math.floor(Number.isFinite(requested) ? requested : 2)),
  );
  const workers: Worker[] = [];
  const initialized = new Uint8Array(concurrency);
  let resolveReady: (ready: boolean) => void = () => {};
  const ready = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });
  let started = false;
  let stopped = false;
  let failure: Error | undefined;
  let sequence = 0;
  let pending: PendingClimate | undefined;
  const startupTimer = setTimeout(() => {
    stop(new Error('Climate workers did not become ready.'));
  }, 10000);

  const stop = (error: Error) => {
    if (stopped) {
      return;
    }
    stopped = true;
    failure = error;
    clearTimeout(startupTimer);
    for (const worker of workers) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    }
    workers.length = 0;
    resolveReady(false);
    const active = pending;
    pending = undefined;
    active?.reject(error);
  };

  const onMessage = (workerIndex: number, message: ClimateWorkerResponse) => {
    if (stopped) {
      return;
    }
    if (message.type === 'ready') {
      initialized[workerIndex] = 1;
      if (!started && initialized.every((value) => value === 1)) {
        started = true;
        clearTimeout(startupTimer);
        resolveReady(true);
      }
      return;
    }
    const active = pending;
    if (!active || message.id !== active.id) {
      return;
    }
    if (message.type === 'error') {
      stop(new Error(`Climate worker failed: ${message.message}`));
      return;
    }
    const seasonIndex = message.season.seasonIndex;
    if (
      !Number.isInteger(seasonIndex) ||
      seasonIndex < 0 ||
      seasonIndex >= 4 ||
      seasonIndex % concurrency !== workerIndex ||
      active.received[seasonIndex]
    ) {
      stop(new Error('Climate worker returned an unexpected or duplicate season.'));
      return;
    }
    active.received[seasonIndex] = 1;
    active.seasons[seasonIndex] = message.season;
    if (active.received.every((value) => value === 1)) {
      try {
        const climate = combineClimateSeasons(active.seasons);
        pending = undefined;
        active.resolve(climate);
      } catch (error) {
        stop(error instanceof Error ? error : new Error(String(error)));
      }
    }
  };

  const pool: ClimatePool = {
    concurrency,
    ready,
    async solve(prepared) {
      if (!(await ready) || stopped) {
        throw failure ?? new Error('Climate workers are unavailable.');
      }
      if (pending) {
        throw new Error('A climate solve is already running in this pool.');
      }
      return new Promise<Climate>((resolve, reject) => {
        const id = ++sequence;
        pending = { id, seasons: [], received: new Uint8Array(4), resolve, reject };
        try {
          for (let workerIndex = 0; workerIndex < workers.length; workerIndex++) {
            const seasons: number[] = [];
            for (let season = workerIndex; season < 4; season += concurrency) {
              seasons.push(season);
            }
            workers[workerIndex].postMessage({
              id,
              prepared,
              seasons,
            } satisfies ClimateWorkerRequest);
          }
        } catch (error) {
          stop(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    terminate() {
      stop(new DOMException('Climate generation was cancelled.', 'AbortError'));
    },
  };

  if (typeof Worker === 'undefined') {
    stop(new Error('This environment does not support climate workers.'));
    return pool;
  }

  try {
    for (let workerIndex = 0; workerIndex < concurrency; workerIndex++) {
      const worker = new Worker(new URL('./climate.worker.ts', import.meta.url), {
        type: 'module',
      });
      workers.push(worker);
      worker.onmessage = (event: MessageEvent<ClimateWorkerResponse>) =>
        onMessage(workerIndex, event.data);
      worker.onerror = (event) => {
        event.preventDefault();
        stop(new Error(event.message || 'Climate worker stopped unexpectedly.'));
      };
      worker.onmessageerror = () =>
        stop(new Error('Climate worker returned an unreadable result.'));
    }
  } catch (error) {
    stop(error instanceof Error ? error : new Error(String(error)));
  }
  return pool;
}
