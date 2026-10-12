import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_CONFIG, type World, type WorldConfig } from '../core/model';
import type { GenerationRequest, GenerationResponse } from './generation-messages';

export function useWorldGeneration() {
  const [world, setWorld] = useState<World | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState({ stage: 'Preparing world', completed: 0, total: 13 });
  const activeWorker = useRef<Worker | null>(null);
  const jobSequence = useRef(0);
  const cancel = useCallback(() => {
    activeWorker.current?.terminate();
    activeWorker.current = null;
    jobSequence.current++;
    setBusy(false);
  }, []);
  const generate = useCallback((config: WorldConfig) => {
    activeWorker.current?.terminate();
    setBusy(true);
    setError('');
    setProgress({ stage: 'Building spherical grids', completed: 0, total: 13 });
    const jobId = ++jobSequence.current;

    try {
      const generationWorker = new Worker(new URL('./generator.worker.ts', import.meta.url), {
        type: 'module',
      });
      activeWorker.current = generationWorker;
      generationWorker.onmessage = (event: MessageEvent<GenerationResponse>) => {
        const message = event.data;

        if (message.id !== jobSequence.current) {
          return;
        }

        if (message.type === 'progress') {
          setProgress(message);
        } else {
          if (message.type === 'complete') {
            setWorld(message.world);
          } else {
            setError(message.message);
          }

          setBusy(false);
          generationWorker.terminate();
          activeWorker.current = null;
        }
      };
      generationWorker.onerror = () => {
        setError('Generation stopped unexpectedly. Try a lower surface detail.');
        setBusy(false);
        generationWorker.terminate();
        activeWorker.current = null;
      };
      generationWorker.postMessage({ id: jobId, config } satisfies GenerationRequest);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Could not start generation.');
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    generate(DEFAULT_CONFIG);

    return () => activeWorker.current?.terminate();
  }, [generate]);

  return { world, busy, error, setError, progress, generate, cancel };
}
