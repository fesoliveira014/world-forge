import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_CONFIG,
  NEW_WORLD_CONFIG,
  type WorldConfig,
  type RegionalRefinementRequest,
  type ResolvedRegionalRefinement,
} from '../core/model';
import type {
  GenerationInput,
  GenerationRequest,
  RefinementRequest,
  RecipeImportRequest,
  GenerationResponse,
} from './generation-messages';
import type { ResolvedRefinementPlan } from '../core/grid/refinement-plan';
import type { ResolvedFeatureRefinementPlan } from '../core/grid/feature-refinement';
import type { ResolvedFeatureCoarseningPlan } from '../core/grid/feature-coarsening';
import { collectClimateBuffers, createClimatePool, type ClimatePool } from './climate-pool';

import {
  createSnapshotDraftSession,
  discardWorldDraft,
  listSnapshots,
  openSnapshot,
  promoteSnapshot,
  type SnapshotDescriptor,
} from '../core/storage';
import type { WorldHandle, WorldSummary } from '../core/view/types';
import { WorldDataClient } from './WorldDataClient';

export function snapshotHandle(snapshot: SnapshotDescriptor): WorldHandle {
  const summary = snapshot.summary as WorldSummary | undefined;
  if (
    !summary?.config ||
    summary.surfaceCells !== snapshot.surfaceCells ||
    !summary.nearestCenterSpacingM
  ) {
    throw new Error(
      'This saved world has no compatible display index. Import its recipe to regenerate it.',
    );
  }
  // Saved worlds predate newer controls. Preserve legacy generation behavior
  // while giving both startup and Library opens a complete configuration.
  const config = { ...DEFAULT_CONFIG, ...summary.config };
  return {
    snapshotId: snapshot.id,
    saved: snapshot.saved !== false,
    name: snapshot.name,
    version: snapshot.worldVersion,
    config,
    summary: { ...summary, config },
  };
}

type RecipeLoaded = Extract<GenerationResponse, { type: 'recipe-loaded' }>;
type DraftSession = Awaited<ReturnType<typeof createSnapshotDraftSession>>;
type WorkerOwnedFields = 'id' | 'climateConcurrency' | 'outputSnapshotId' | 'draftOwnerId';

export function useWorldGeneration() {
  const [handle, setHandle] = useState<WorldHandle | null>(null);
  const [initialConfig, setInitialConfig] = useState<WorldConfig | null>(null);
  const [source, setSource] = useState<WorldDataClient | null>(null);
  const currentHandle = useRef<WorldHandle | null>(null);
  const reader = useRef<WorldDataClient | null>(null);
  const draftSession = useRef<Promise<DraftSession> | null>(null);
  const pendingDraft = useRef<{ id: string; ownerId: string } | null>(null);
  const activeSave = useRef<AbortController | null>(null);
  const [saving, setSaving] = useState(false);
  const [libraryRevision, setLibraryRevision] = useState(0);
  const ensureDraftSession = useCallback(() => {
    if (!draftSession.current) {
      const opening = createSnapshotDraftSession();
      draftSession.current = opening;
      void opening.catch(() => {
        if (draftSession.current === opening) {
          draftSession.current = null;
        }
      });
    }
    return draftSession.current;
  }, []);
  const discardDraft = useCallback((previous: WorldHandle | null) => {
    if (previous?.saved !== false || !draftSession.current) {
      return;
    }
    // Cleanup atomically skips any draft concurrently promoted by Save world.
    void draftSession.current
      .then((session) => discardWorldDraft(previous.snapshotId, session.id))
      .catch(() => {}); // A later session cleanup retries abandoned temporary pages.
  }, []);
  const installHandle = useCallback(
    (next: WorldHandle | null) => {
      const nextSource = next ? new WorldDataClient(next.snapshotId) : null;
      const previous = currentHandle.current;
      reader.current?.dispose();
      reader.current = nextSource;
      currentHandle.current = next;
      setSource(nextSource);
      setHandle(next);
      if (previous?.snapshotId !== next?.snapshotId) {
        discardDraft(previous);
      }
    },
    [discardDraft],
  );
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState({ stage: 'Preparing world', completed: 0, total: 13 });
  const activeWorker = useRef<Worker | null>(null);
  const activeClimatePool = useRef<ClimatePool | null>(null);
  const jobSequence = useRef(0);
  const stopActiveWorkers = useCallback(() => {
    const worker = activeWorker.current;
    activeWorker.current = null;

    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    }

    const pool = activeClimatePool.current;
    activeClimatePool.current = null;
    pool?.terminate();
    const abandoned = pendingDraft.current;
    pendingDraft.current = null;
    if (abandoned) {
      void discardWorldDraft(abandoned.id, abandoned.ownerId).catch(() => {});
    }
  }, []);
  const cancelSave = useCallback(() => activeSave.current?.abort(), []);
  const invalidateOperation = useCallback(() => {
    jobSequence.current++;
    stopActiveWorkers();
  }, [stopActiveWorkers]);
  const cancel = useCallback(() => {
    invalidateOperation();
    setBusy(false);
  }, [invalidateOperation]);
  const run = useCallback(
    async (
      request:
        | Omit<GenerationRequest, WorkerOwnedFields>
        | Omit<RefinementRequest, WorkerOwnedFields>
        | Omit<RecipeImportRequest, WorkerOwnedFields>,
      onRecipeLoaded?: (recipe: RecipeLoaded) => void,
    ) => {
      const jobId = ++jobSequence.current;
      cancelSave();
      stopActiveWorkers();
      setBusy(true);
      setError('');
      setProgress({
        stage:
          request.type === 'refine'
            ? 'Opening terrain for refinement'
            : request.type === 'import'
              ? 'Reading recipe'
              : 'Building spherical grids',
        completed: 0,
        total: 13,
      });

      try {
        const session = await ensureDraftSession();
        if (jobId !== jobSequence.current) {
          return;
        }
        const outputSnapshotId = crypto.randomUUID();
        pendingDraft.current = { id: outputSnapshotId, ownerId: session.id };
        let climateConcurrency = 1;
        const availableWorkers = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2));

        if (
          (request.type === 'import' ||
            (request.type === 'generate' && request.config.processLevel >= 5)) &&
          availableWorkers > 1
        ) {
          const pool = createClimatePool(availableWorkers);
          activeClimatePool.current = pool;
          const ready = await pool.ready;

          if (jobId !== jobSequence.current) {
            return;
          }

          if (ready && pool.concurrency > 1) {
            climateConcurrency = pool.concurrency;
          } else {
            pool.terminate();
            activeClimatePool.current = null;
          }
        }

        const generationWorker = new Worker(new URL('./generator.worker.ts', import.meta.url), {
          type: 'module',
        });
        activeWorker.current = generationWorker;
        generationWorker.onmessage = async (event: MessageEvent<GenerationResponse>) => {
          const message = event.data;

          if (message.id !== jobSequence.current) {
            return;
          }

          if (message.type === 'recipe-loaded') {
            onRecipeLoaded?.(message);
          } else if (message.type === 'progress') {
            setProgress(message);
          } else if (message.type === 'climate-request') {
            try {
              const pool = activeClimatePool.current;

              if (!pool) {
                throw new Error('Climate workers are unavailable. Generate again to retry.');
              }

              const climate = await pool.solve(message.prepared);

              if (jobId !== jobSequence.current || activeWorker.current !== generationWorker) {
                return;
              }

              generationWorker.postMessage(
                {
                  type: 'climate-result',
                  id: jobId,
                  requestId: message.requestId,
                  climate,
                } satisfies GenerationInput,
                collectClimateBuffers(climate),
              );
            } catch (caughtError) {
              if (jobId !== jobSequence.current || activeWorker.current !== generationWorker) {
                return;
              }

              generationWorker.postMessage({
                type: 'climate-error',
                id: jobId,
                requestId: message.requestId,
                message: caughtError instanceof Error ? caughtError.message : String(caughtError),
              } satisfies GenerationInput);
            }
          } else {
            try {
              if (message.type === 'complete') {
                installHandle(message.handle);
                pendingDraft.current = null;
              } else {
                setError(message.message);
              }
            } catch (caughtError) {
              setError(
                caughtError instanceof Error
                  ? caughtError.message
                  : 'The generated world could not be displayed. Generate again to retry.',
              );
            } finally {
              setBusy(false);
              stopActiveWorkers();
            }
          }
        };
        generationWorker.onerror = () => {
          if (jobId !== jobSequence.current) {
            return;
          }

          setError('Generation stopped unexpectedly. Try a lower surface detail.');
          setBusy(false);
          stopActiveWorkers();
        };
        generationWorker.onmessageerror = () => {
          if (jobId !== jobSequence.current) {
            return;
          }
          setError('The worker response could not be read. Your previous world is intact.');
          setBusy(false);
          stopActiveWorkers();
        };
        generationWorker.postMessage({
          ...request,
          id: jobId,
          outputSnapshotId,
          draftOwnerId: session.id,
          ...(request.type !== 'refine' ? { climateConcurrency } : {}),
        } as GenerationInput);
      } catch (caughtError) {
        if (jobId !== jobSequence.current) {
          return;
        }

        stopActiveWorkers();
        setError(
          caughtError instanceof Error ? caughtError.message : 'Could not start generation.',
        );
        setBusy(false);
      }
    },
    [cancelSave, ensureDraftSession, installHandle, stopActiveWorkers],
  );

  const save = useCallback(async (name: string) => {
    const current = currentHandle.current;
    if (!current || current.saved !== false || activeSave.current) {
      return false;
    }
    const controller = new AbortController();
    activeSave.current = controller;
    setSaving(true);
    try {
      const saved = await promoteSnapshot(current.snapshotId, name, { signal: controller.signal });
      // A committed save remains valid even if another view has since opened.
      if (currentHandle.current?.snapshotId === current.snapshotId) {
        const next = { ...currentHandle.current, saved: true, name: saved.name };
        currentHandle.current = next;
        setHandle(next);
      }
      setLibraryRevision((revision) => revision + 1);
      return true;
    } catch (caughtError) {
      if (caughtError instanceof DOMException && caughtError.name === 'AbortError') {
        return false;
      }
      throw caughtError;
    } finally {
      if (activeSave.current === controller) {
        activeSave.current = null;
        setSaving(false);
      }
    }
  }, []);

  const generate = useCallback(
    (
      config: WorldConfig,
      refinementPlans?: ResolvedRefinementPlan[],
      regionalRefinements?: ResolvedRegionalRefinement[],
      featureRefinementPlans?: ResolvedFeatureRefinementPlan[],
      featureCoarseningPlans?: ResolvedFeatureCoarseningPlan[],
    ) =>
      run({
        type: 'generate',
        config,
        refinementPlans,
        regionalRefinements,
        featureRefinementPlans,
        featureCoarseningPlans,
      }),
    [run],
  );
  const importRecipe = useCallback(
    (file: Blob, onParsed?: (recipe: RecipeLoaded) => void) =>
      run({ type: 'import', file }, onParsed),
    [run],
  );
  const refine = useCallback(
    (request: RegionalRefinementRequest) => {
      if (handle) {
        return run({ type: 'refine', snapshotId: handle.snapshotId, request });
      }
    },
    [handle, run],
  );
  const open = useCallback(
    async (id: string) => {
      cancelSave();
      cancel();
      const jobId = jobSequence.current;
      setBusy(true);
      setError('');
      setProgress({ stage: 'Opening saved world', completed: 0, total: 1 });
      try {
        const next = snapshotHandle(await openSnapshot(id));
        if (jobId !== jobSequence.current) {
          return null;
        }
        installHandle(next);
        return next;
      } catch (caughtError) {
        if (jobId === jobSequence.current) {
          setError(
            caughtError instanceof Error ? caughtError.message : 'Could not open this world.',
          );
        }
        return null;
      } finally {
        if (jobId === jobSequence.current) {
          setBusy(false);
        }
      }
    },
    [cancel, cancelSave, installHandle],
  );
  const close = useCallback(() => {
    cancelSave();
    cancel();
    const closedAt = jobSequence.current;
    const previous = handle;
    installHandle(null);
    // A failed deletion may restore this view only before the next user operation.
    return async () => {
      if (previous && jobSequence.current === closedAt) {
        return open(previous.snapshotId);
      }
      return null;
    };
  }, [cancel, cancelSave, handle, installHandle, open]);

  useEffect(() => {
    let active = true;
    const startupId = jobSequence.current;
    void ensureDraftSession()
      .then(() => listSnapshots())
      .then((snapshots) => {
        if (!active || jobSequence.current !== startupId) {
          return;
        }
        if (snapshots.length) {
          setInitialConfig(snapshotHandle(snapshots[0]).config);
          void open(snapshots[0].id);
        } else {
          void generate(NEW_WORLD_CONFIG);
        }
      })
      .catch((caughtError) => {
        if (!active || jobSequence.current !== startupId) {
          return;
        }
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : 'Local saved-world storage is unavailable.',
        );
        setBusy(false);
      });
    return () => {
      active = false;
      cancelSave();
      invalidateOperation();
      reader.current?.dispose();
      const closing = draftSession.current;
      draftSession.current = null;
      void closing?.then((session) => session.close()).catch(() => {});
    };
  }, [generate, open, invalidateOperation, ensureDraftSession, cancelSave]);

  return {
    handle,
    initialConfig,
    source,
    libraryRevision,
    saving,
    busy,
    error,
    setError,
    progress,
    generate,
    importRecipe,
    refine,
    cancel,
    open,
    close,
    save,
    cancelSave,
  };
}
