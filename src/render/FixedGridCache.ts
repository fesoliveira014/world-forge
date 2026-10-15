import type { FixedGridManifest, FixedGridPacket } from '../core/view/fixed-grid-types';
import type { WorldViewSource } from '../core/view/types';

export interface GridDisplayStatus {
  state: 'off' | 'loading' | 'ready' | 'error';
  loadedBatches: number;
  totalBatches: number;
  error?: string;
}

/** One source-owned set of compact physical edges. Scene/projection changes only
 * rebuild GPU geometry; camera movement never enters this loading lifecycle. */
export class FixedGridCache {
  manifest: FixedGridManifest | null = null;
  readonly packets: FixedGridPacket[] = [];
  requests = 0;
  done = false;
  error = '';
  released = false;
  private enabled = false;
  private loading = false;
  private disposed = false;

  constructor(
    readonly source: WorldViewSource,
    readonly snapshotId: string,
  ) {}

  get bytes() {
    return this.packets.reduce((sum, packet) => sum + packet.bytes, 0);
  }

  setEnabled(enabled: boolean) {
    if (this.disposed) {
      return;
    }
    const retry = enabled && !this.enabled;
    this.enabled = enabled;
    if (retry) {
      this.error = '';
    }
    if (this.done) {
      this.releaseReader();
    } else if (enabled && !this.loading && !this.error) {
      this.loading = true;
      void this.load();
    }
  }

  private releaseReader() {
    if (!this.released) {
      this.released = this.source.releaseGridRender?.() ?? false;
    }
  }

  private async load() {
    try {
      if (!this.manifest) {
        this.requests++;
        const manifest = await this.source.gridManifest();
        if (this.disposed) {
          return;
        }
        this.manifest = manifest;
      }
      while (this.enabled && this.packets.length < this.manifest.batches) {
        this.requests++;
        const packet = await this.source.gridBatch(this.packets.length);
        if (this.disposed) {
          return;
        }
        this.packets.push(packet);
        // Bound queued work to one packet and let input pause between batches.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (this.disposed) {
          return;
        }
      }
      this.done = this.packets.length === this.manifest.batches;
      if (this.done) {
        this.releaseReader();
      }
    } catch (error) {
      if (!this.disposed) {
        this.error = error instanceof Error ? error.message : String(error);
        // A crashed worker lane cannot accept the user's later retry. Keep the
        // completed packets, but make that retry start a fresh grid-only lane.
        this.source.cancelGridRender?.();
      }
    } finally {
      this.loading = false;
    }
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.enabled = false;
    this.source.cancelGridRender?.();
    this.packets.length = 0;
    this.manifest = null;
  }
}
