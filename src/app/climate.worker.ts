/// <reference lib="webworker" />
import { solveClimateSeason } from '../core/generation/climate';
import type { ClimateWorkerRequest, ClimateWorkerResponse } from './climate-pool';

/** One cloned preparation per worker, reused for its assigned seasons. The main
 * thread owns this worker so cancelling the generating job terminates it directly.
 */
self.onmessage = (event: MessageEvent<ClimateWorkerRequest>) => {
  const { id, prepared, seasons } = event.data;
  try {
    for (const seasonIndex of seasons) {
      const season = solveClimateSeason(prepared, seasonIndex);
      const buffers = Object.values(season)
        .filter((value): value is Float32Array => value instanceof Float32Array)
        .map((value) => value.buffer as ArrayBuffer);
      self.postMessage({ type: 'season', id, season } satisfies ClimateWorkerResponse, buffers);
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      message: error instanceof Error ? error.message : String(error),
    } satisfies ClimateWorkerResponse);
    self.close();
  }
};

self.postMessage({ type: 'ready' } satisfies ClimateWorkerResponse);
