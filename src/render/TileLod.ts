import {
  ROOT_TILES,
  tileChildren,
  tileKey,
  tileAdjacentLeaves,
  tileParent,
  type RenderTile,
} from './TileGeometry';

export const MAX_ACTIVE_TILES = 64;
export const MAX_RESIDENT_TILES = 128;
// Dense material maps restore screen-scale coast and habitat detail. The old
// 32 MiB limit only budgeted sparse geometry attributes, not those material maps.
export const MAX_TILE_BYTES = 192 * 1024 * 1024;
export const MAX_TILE_REQUESTS = 4;
export interface TileResource {
  bytes: number;
  readonly transitioning?: boolean;
  dispose(): void;
}

/** Fixed-size residency; stale responses are destroyed before they reach the scene. */
export class TileStore<T extends TileResource> {
  private entries = new Map<string, { resource: T; touched: number }>();
  private pending = new Set<string>();
  private failures = new Map<string, number>();
  private clock = 0;
  private alive = true;
  private protected = new Set<string>();
  bytes = 0;
  constructor(
    private readonly load: (tile: RenderTile) => Promise<T>,
    private readonly changed: () => void,
    readonly maxEntries = MAX_RESIDENT_TILES,
    readonly maxBytes = MAX_TILE_BYTES,
    private readonly onError?: (error: unknown) => void,
  ) {}
  get size() {
    return this.entries.size;
  }
  get loading() {
    return this.pending.size;
  }
  get(tile: RenderTile): T | undefined {
    const entry = this.entries.get(tileKey(tile));
    if (entry) {
      entry.touched = ++this.clock;
    }
    return entry?.resource;
  }
  protect(tiles: RenderTile[]) {
    this.protected.clear();
    for (let tile of tiles) {
      while (tile.z >= 1) {
        this.protected.add(tileKey(tile));
        tile = tileParent(tile);
      }
    }
    for (const tile of ROOT_TILES) {
      this.protected.add(tileKey(tile));
    }
  }
  request(tile: RenderTile): boolean {
    const key = tileKey(tile);
    if (
      !this.alive ||
      (this.failures.get(key) ?? 0) >= 2 ||
      this.entries.has(key) ||
      this.pending.has(key) ||
      this.pending.size >= MAX_TILE_REQUESTS
    ) {
      return false;
    }
    this.pending.add(key);
    void this.load(tile)
      .then((resource) => {
        if (!this.alive) {
          resource.dispose();
          return;
        }
        while (
          this.entries.size >= this.maxEntries ||
          this.bytes + resource.bytes > this.maxBytes
        ) {
          let victim = '';
          let oldest = Infinity;
          for (const [candidate, entry] of this.entries) {
            if (!this.protected.has(candidate) && entry.touched < oldest) {
              victim = candidate;
              oldest = entry.touched;
            }
          }
          if (!victim) {
            resource.dispose();
            return;
          }
          const entry = this.entries.get(victim)!;
          entry.resource.dispose();
          this.bytes -= entry.resource.bytes;
          this.entries.delete(victim);
        }
        this.failures.delete(key);
        this.entries.set(key, { resource, touched: ++this.clock });
        this.bytes += resource.bytes;
      })
      .catch((error: unknown) => {
        if (!this.alive) {
          return;
        }
        this.failures.set(key, (this.failures.get(key) ?? 0) + 1);
        while (this.failures.size > this.maxEntries) {
          this.failures.delete(this.failures.keys().next().value!);
        }
        this.onError?.(error);
      })
      .finally(() => {
        this.pending.delete(key);
        if (this.alive) {
          this.changed();
        }
      });
    return true;
  }
  dispose() {
    this.alive = false;
    for (const entry of this.entries.values()) {
      entry.resource.dispose();
    }
    this.entries.clear();
    this.failures.clear();
    this.bytes = 0;
  }
}

const previousCuts = new WeakMap<object, RenderTile[]>();

/** Parents remain until all children are ready. Every split preserves 2:1 neighbor balance.
 * The selected tree only grows during a call: at most (maxLeaves - 4) / 3 successful
 * splits. A split/coarsen repair loop can oscillate at the budget boundary.
 */
export function selectTiles<T extends TileResource>(
  store: TileStore<T>,
  score: (tile: RenderTile) => number,
  maxLeaves = MAX_ACTIVE_TILES,
  maximumLevel = 18,
  options: { allowVisibleCoarsening?: boolean } = {},
): RenderTile[] {
  const leaves = new Map<string, RenderTile>();
  const previous = previousCuts.get(store);
  if (
    previous &&
    previous.length >= ROOT_TILES.length &&
    previous.every((tile) => store.get(tile))
  ) {
    for (const tile of previous) {
      leaves.set(tileKey(tile), tile);
    }
  } else {
    for (const root of ROOT_TILES) {
      if (store.get(root)) {
        leaves.set(tileKey(root), root);
      } else {
        store.request(root);
      }
    }
  }
  // Preserve visible coverage through rotations and pans. Only an explicit zoom-out
  // permits visible coarsening, with a wide gap between split and merge thresholds.
  // Merge before splitting, never as a budget repair after a split (which oscillates).
  let merged = true;
  while (merged) {
    merged = false;
    const parents = new Map<string, RenderTile>();
    for (const tile of leaves.values()) {
      if (tile.z > 1) {
        const parent = tileParent(tile);
        parents.set(tileKey(parent), parent);
      }
    }
    for (const parent of [...parents.values()].sort((a, b) => b.z - a.z)) {
      const children = tileChildren(parent);
      if (!children.every((child) => leaves.has(tileKey(child)))) {
        continue;
      }
      const offscreen = children.every((child) => score(child) === 0);
      if (!offscreen && !(options.allowVisibleCoarsening && score(parent) < 0.65)) {
        continue;
      }
      if (tileAdjacentLeaves(parent, leaves).some((neighbor) => neighbor.z > parent.z + 1)) {
        continue;
      }
      if (!store.get(parent)) {
        store.request(parent);
        continue;
      }
      for (const child of children) {
        leaves.delete(tileKey(child));
      }
      leaves.set(tileKey(parent), parent);
      merged = true;
    }
  }
  const requests = new Map<string, { tile: RenderTile; priority: number }>();
  // Do not subdivide a partial root cover. Its missing neighbors have no usable fallback yet.
  if (leaves.size >= ROOT_TILES.length) {
    const blocked = new Set<string>();
    const splitBalanced = (tile: RenderTile, priority: number): boolean => {
      const key = tileKey(tile);
      if (blocked.has(key)) {
        return false;
      }
      // A child samples its displayed parent's material during its transition.
      // Finish that blend before beginning a further level, rather than retaining
      // a nested chain of ancestor texture samplers.
      if (store.get(tile)?.transitioning) {
        blocked.add(key);
        return false;
      }
      const coarser = tileAdjacentLeaves(tile, leaves).filter(
        (neighbor): neighbor is RenderTile => !!neighbor && neighbor.z < tile.z,
      );
      if (coarser.length) {
        // First create room for this split in the neighboring hierarchy. Each recursive
        // dependency is strictly coarser, so this walk is bounded by maximumLevel.
        for (const neighbor of coarser) {
          if (splitBalanced(neighbor, priority)) {
            return true;
          }
        }
        blocked.add(key);
        return false;
      }
      const children = tileChildren(tile);
      if (children.every((child) => store.get(child))) {
        leaves.delete(tileKey(tile));
        for (const child of children) {
          leaves.set(tileKey(child), child);
        }
        return true;
      }
      for (const child of children) {
        if (!store.get(child)) {
          const key = tileKey(child);
          const previous = requests.get(key);
          if (!previous || previous.priority < priority) {
            requests.set(key, { tile: child, priority });
          }
        }
      }
      blocked.add(key);
      return false;
    };
    while (leaves.size + 3 <= maxLeaves) {
      blocked.clear();
      const candidates = [...leaves.values()]
        .filter((tile) => tile.z < maximumLevel && score(tile) > 1.15)
        .sort((a, b) => score(b) - score(a));
      let split = false;
      for (const tile of candidates) {
        if (splitBalanced(tile, score(tile))) {
          split = true;
          break;
        }
      }
      if (!split) {
        break;
      }
    }
  }
  const result = [...leaves.values()];
  previousCuts.set(store, result);
  store.protect(result);
  for (const request of [...requests.values()].sort((a, b) => b.priority - a.priority)) {
    store.request(request.tile);
  }
  return result;
}

/** Shares the in-flight limit across appearance revisions; obsolete queued work never samples. */
export class TileRequestQueue {
  private active = 0;
  private queue: {
    run(): Promise<unknown>;
    valid(): boolean;
    resolve(value: unknown): void;
    reject(reason: Error): void;
  }[] = [];
  run<T>(task: () => Promise<T>, valid: () => boolean): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ run: task, valid, resolve: (value) => resolve(value as T), reject });
      this.pump();
    });
  }
  private pump() {
    this.queue = this.queue.filter((task) => {
      if (task.valid()) {
        return true;
      }
      task.reject(new Error('Obsolete tile request'));
      return false;
    });
    while (this.queue.length > MAX_TILE_REQUESTS) {
      this.queue.shift()!.reject(new Error('Superseded tile request'));
    }
    while (this.active < MAX_TILE_REQUESTS && this.queue.length) {
      const task = this.queue.shift()!;
      this.active++;
      void Promise.resolve()
        .then(task.run)
        .then(task.resolve, task.reject)
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }
}
