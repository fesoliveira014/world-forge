import type { World, WorldConfig } from '../core/model';

/** Shared worker protocol. Keep these field names stable across sender and receiver. */
export interface GenerationRequest {
  id: number;
  config: WorldConfig;
}

export type GenerationResponse =
  | { type: 'progress'; id: number; stage: string; completed: number; total: number }
  | { type: 'complete'; id: number; world: World }
  | { type: 'error'; id: number; message: string };
