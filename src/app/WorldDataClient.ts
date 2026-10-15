import type { Layer, ResourceType } from '../core/model';
import type { Vec3 } from '../core/math';
import type { PhysicalMeshManifest, PhysicalMeshPacket } from '../core/view/physical-mesh-types';
import type { FixedGridManifest, FixedGridPacket } from '../core/view/fixed-grid-types';
import type { FixedRiverBatch, FixedRiverRequest } from '../core/view/river-render-types';
import type {
  CellInspection,
  CellSampleBatch,
  DepositInspection,
  DepositPage,
  OverlayPacket,
  OverlayRequest,
  WorldSummary,
  WorldViewSource,
} from '../core/view/types';

export interface ReaderResponse {
  id: number;
  snapshotId: string;
  value?: unknown;
  error?: string;
}

interface InspectionTask {
  key: string;
  direction: Vec3;
  season: number;
  promise: Promise<CellInspection>;
  resolve(value: CellInspection): void;
  reject(error: Error): void;
}

interface PagingStats {
  cachedPageBytes: number;
  cachedMetadataBytes: number;
  cachedPages: number;
  pageReads: number;
  activePageReads: number;
}

/** Requests in one lane execute in order inside its own bounded page reader. */
class ReaderLane {
  private readonly worker: Worker;
  private failure: Error | null = null;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(
    readonly snapshotId: string,
    onFailure?: (error: Error) => void,
  ) {
    this.worker = new Worker(new URL('./reader.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<ReaderResponse>) => {
      const message = event.data;
      if (this.failure || message.snapshotId !== this.snapshotId) {
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        pending.reject(new Error(message.error));
      } else {
        pending.resolve(message.value);
      }
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || 'The world reader stopped unexpectedly.');
      this.dispose(error);
      onFailure?.(error);
    };
    this.worker.onmessageerror = () => {
      const error = new Error('A world response could not be decoded.');
      this.dispose(error);
      onFailure?.(error);
    };
  }

  dispose(error = new Error('This world view is closed.')) {
    if (this.failure) {
      return;
    }
    this.failure = error;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.onmessageerror = null;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    this.worker.terminate();
  }

  get idle() {
    return this.pending.size === 0;
  }

  call<T>(id: number, method: string, args: unknown[]): Promise<T> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      try {
        this.worker.postMessage({ id, snapshotId: this.snapshotId, method, args });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
}

/** A revision-scoped asynchronous view which never owns simulation arrays.
 * Terrain and inspection share the primary reader. Overlays, complete rivers
 * and the persistent grid lazily get independent workers, so they cannot hold up
 * terrain or each other. Each lane has a 32 MiB page and 4 MiB metadata cache.
 */
export class WorldDataClient implements WorldViewSource {
  private readonly primary: ReaderLane;
  private overlay: ReaderLane | null = null;
  private river: ReaderLane | null = null;
  private grid: ReaderLane | null = null;
  private riverVariant: string | null = null;
  private nextId = 0;
  private disposed = false;
  private activeInspection: InspectionTask | null = null;
  private queuedInspection: InspectionTask | null = null;

  constructor(readonly snapshotId: string) {
    this.primary = new ReaderLane(snapshotId, (error) => this.close(error));
  }

  private call<T>(
    method: string,
    args: unknown[] = [],
    laneName: 'primary' | 'overlay' | 'river' | 'grid' = 'primary',
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error('This world view is closed.'));
    }
    try {
      const lane =
        laneName === 'primary'
          ? this.primary
          : (this[laneName] ??= new ReaderLane(this.snapshotId));
      return lane.call<T>(++this.nextId, method, args);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  sample(directions: Float32Array, layer: Layer, season: number) {
    return this.call<CellSampleBatch>('sample', [directions, layer, season]);
  }
  gridManifest() {
    return this.call<FixedGridManifest>('gridManifest', [], 'grid');
  }
  gridBatch(batch: number) {
    return this.call<FixedGridPacket>('gridBatch', [batch], 'grid');
  }
  releaseGridRender() {
    if (this.disposed || !this.grid?.idle) {
      return false;
    }
    this.grid.dispose();
    this.grid = null;
    return true;
  }
  cancelGridRender() {
    this.grid?.dispose(new DOMException('This grid view was discarded.', 'AbortError'));
    this.grid = null;
  }
  physicalManifest(layer: Layer, season: number) {
    return this.call<PhysicalMeshManifest>('physicalManifest', [layer, season]);
  }
  physicalBatch(layer: Layer, season: number, batch: number) {
    return this.call<PhysicalMeshPacket>('physicalBatch', [layer, season, batch]);
  }
  riverRender(request: FixedRiverRequest) {
    const variant = `${request.season}:${request.threshold}`;
    if (!this.disposed && variant !== this.riverVariant) {
      // A complete network can take substantial time to prepare. Terminating
      // only this lane prevents rapid season/threshold changes from queuing
      // obsolete whole-network builds ahead of the latest requested view.
      this.river?.dispose(
        new DOMException('A newer river appearance replaced this request.', 'AbortError'),
      );
      this.river = null;
      this.riverVariant = variant;
    }
    return this.call<FixedRiverBatch>('riverRender', [request], 'river');
  }
  releaseRiverRender(request: Pick<FixedRiverRequest, 'season' | 'threshold'>) {
    const variant = `${request.season}:${request.threshold}`;
    if (this.disposed || variant !== this.riverVariant || !this.river?.idle) {
      return false;
    }
    // The complete compact asset now owns everything needed for drawing and
    // projection changes. Its preparation worker still retains original bank
    // payloads, draping lookup arrays and page caches; none are needed anymore.
    // The variant/idle guards prevent a stale completion from cancelling a new
    // appearance or an outstanding reader query.
    this.river.dispose();
    this.river = null;
    this.riverVariant = null;
    return true;
  }
  inspect(direction: Vec3, season: number) {
    if (this.disposed) {
      return Promise.reject(new Error('This saved-world view is closed.'));
    }
    const key = JSON.stringify([direction, season]);
    if (this.activeInspection?.key === key) {
      this.replaceQueuedInspection(null);
      return this.activeInspection.promise;
    }
    if (this.queuedInspection?.key === key) {
      return this.queuedInspection.promise;
    }
    let resolve!: (value: CellInspection) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<CellInspection>((resolveTask, rejectTask) => {
      resolve = resolveTask;
      reject = rejectTask;
    });
    const task: InspectionTask = {
      key,
      direction: [...direction],
      season,
      promise,
      resolve,
      reject,
    };
    if (this.activeInspection) {
      this.replaceQueuedInspection(task);
    } else {
      this.startInspection(task);
    }
    return promise;
  }
  private replaceQueuedInspection(task: InspectionTask | null) {
    this.queuedInspection?.reject(
      new DOMException('A newer cell inspection replaced this request.', 'AbortError'),
    );
    this.queuedInspection = task;
  }
  private startInspection(task: InspectionTask) {
    this.activeInspection = task;
    void this.call<CellInspection>('inspect', [task.direction, task.season])
      .then(task.resolve, task.reject)
      .finally(() => {
        if (this.activeInspection !== task) {
          return;
        }
        this.activeInspection = null;
        const next = this.queuedInspection;
        this.queuedInspection = null;
        if (!next) {
          return;
        }
        if (this.disposed) {
          next.reject(new Error('This saved-world view is closed.'));
        } else {
          this.startInspection(next);
        }
      });
  }
  overlays(request: OverlayRequest) {
    return this.call<OverlayPacket>('overlays', [request], 'overlay');
  }
  inspectDeposit(id: string) {
    return this.call<DepositInspection | null>('inspectDeposit', [id]);
  }
  listDeposits(filter: ResourceType | 'all' = 'all', cursor = 0, limit = 50) {
    return this.call<DepositPage>('listDeposits', [filter, cursor, limit]);
  }
  diagnostics() {
    return this.call<WorldSummary>('diagnostics');
  }
  async pagingStats() {
    const lanes = [this.call<PagingStats>('pagingStats')];
    // Diagnostics alone must not allocate otherwise unused reader workers.
    if (this.overlay) {
      lanes.push(this.call<PagingStats>('pagingStats', [], 'overlay'));
    }
    if (this.river) {
      lanes.push(this.call<PagingStats>('pagingStats', [], 'river'));
    }
    if (this.grid) {
      lanes.push(this.call<PagingStats>('pagingStats', [], 'grid'));
    }
    const results = await Promise.all(lanes);
    return results.reduce<PagingStats & { readerCount: number }>(
      (total, lane) => ({
        readerCount: total.readerCount + 1,
        cachedPageBytes: total.cachedPageBytes + lane.cachedPageBytes,
        cachedMetadataBytes: total.cachedMetadataBytes + lane.cachedMetadataBytes,
        cachedPages: total.cachedPages + lane.cachedPages,
        pageReads: total.pageReads + lane.pageReads,
        activePageReads: total.activePageReads + lane.activePageReads,
      }),
      {
        readerCount: 0,
        cachedPageBytes: 0,
        cachedMetadataBytes: 0,
        cachedPages: 0,
        pageReads: 0,
        activePageReads: 0,
      },
    );
  }
  exportRecipe() {
    return this.call<Blob>('exportRecipe');
  }
  private close(error: Error) {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.primary.dispose(error);
    this.overlay?.dispose(error);
    this.river?.dispose(error);
    this.grid?.dispose(error);
    this.queuedInspection?.reject(error);
    this.queuedInspection = null;
  }
  dispose() {
    this.close(new Error('This world view is closed.'));
  }
}
