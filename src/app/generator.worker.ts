/// <reference lib="webworker" />
import { generateWorld, collectWorldBuffers } from '../core/pipeline';
import type { GenerationRequest, GenerationResponse } from './generation-messages';

self.onmessage = (event: MessageEvent<GenerationRequest>) => {
  const { config, id: jobId } = event.data;

  try {
    const world = generateWorld(config, (stage, completed, total) =>
      self.postMessage({
        type: 'progress',
        id: jobId,
        stage,
        completed,
        total,
      } satisfies GenerationResponse),
    );
    self.postMessage(
      { type: 'complete', id: jobId, world } satisfies GenerationResponse,
      collectWorldBuffers(world),
    );
  } catch (error) {
    self.postMessage({
      type: 'error',
      id: jobId,
      message: error instanceof Error ? error.message : String(error),
    } satisfies GenerationResponse);
  }
};
