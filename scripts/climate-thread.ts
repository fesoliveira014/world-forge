import { parentPort } from 'node:worker_threads';
import { solveClimateSeason, type PreparedClimate } from '../src/core/generation/climate';
import type { ClimateWorkerRequest, ClimateWorkerResponse } from './climate-pool';

if (!parentPort) {
  throw Error('The climate thread must run inside a worker.');
}

const port = parentPort;
let context: PreparedClimate | undefined;
let solveId = -1;

port.on('message', (message: ClimateWorkerRequest) => {
  try {
    if (message.type === 'release') {
      if (message.solveId === solveId) {
        context = undefined;
      }

      return;
    }

    if (message.type === 'prepare') {
      context = message.prepared;
      solveId = message.solveId;
    }

    if (!context || message.solveId !== solveId) {
      throw Error('Climate season received without its prepared solve context.');
    }

    const result = solveClimateSeason(context, message.seasonIndex);
    const response: ClimateWorkerResponse = { type: 'result', solveId, result };
    const transfer = new Set<ArrayBuffer>();

    for (const value of Object.values(result)) {
      if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) {
        transfer.add(value.buffer);
      }
    }

    // Prepared inputs remain owned by this worker for its later seasons.
    port.postMessage(response, [...transfer]);
  } catch (error) {
    const failure = error instanceof Error ? error : Error(String(error));
    const response: ClimateWorkerResponse = {
      type: 'error',
      solveId: message.solveId,
      message: failure.message,
      stack: failure.stack,
    };
    port.postMessage(response);
  }
});
