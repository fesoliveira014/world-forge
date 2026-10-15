import type { World } from '../model';
import { ByteCache } from './cache';
import {
  ARRAY_TYPES,
  MissingSnapshotFieldError,
  childValue,
  isReference,
  restoreGraph,
  validateManifest,
  type GraphManifest,
  type GraphNode,
  type GraphSource,
  type GraphValue,
} from './codec';
import {
  readSnapshotNode,
  readSnapshotPage,
  readSnapshotRecord,
  type SnapshotDescriptor,
} from './database';

export interface SnapshotReaderOptions {
  cacheBytes?: number;
  metadataCacheBytes?: number;
}

export class SnapshotReader {
  readonly descriptor: SnapshotDescriptor;
  readonly manifest: GraphManifest;
  private readonly pages: ByteCache<ArrayBuffer>;
  private readonly nodes: ByteCache<GraphNode>;
  private readonly pendingPages = new Map<string, Promise<ArrayBuffer>>();
  private readonly pendingNodes = new Map<number, Promise<GraphNode>>();
  private readonly readQueue: (() => void)[] = [];
  private activeReads = 0;
  private closed = false;
  private pageReads = 0;
  private readonly source: GraphSource;

  private constructor(
    descriptor: SnapshotDescriptor,
    manifest: GraphManifest,
    options: SnapshotReaderOptions,
  ) {
    validateManifest(manifest);
    this.descriptor = descriptor;
    this.manifest = manifest;
    this.pages = new ByteCache(options.cacheBytes ?? 32 * 1024 * 1024);
    this.nodes = new ByteCache(options.metadataCacheBytes ?? 4 * 1024 * 1024);
    this.source = {
      manifest,
      node: (id) => this.loadNode(id),
      page: (buffer, page) => this.loadPage(buffer, page),
    };
  }

  static async open(id: string, options: SnapshotReaderOptions = {}): Promise<SnapshotReader> {
    const record = await readSnapshotRecord(id);
    return new SnapshotReader(record.descriptor, record.manifest, options);
  }

  get stats() {
    return {
      cachedPageBytes: this.pages.bytes,
      cachedMetadataBytes: this.nodes.bytes,
      cachedPages: this.pages.size,
      pageReads: this.pageReads,
      activePageReads: this.activeReads,
    };
  }

  close(): void {
    this.closed = true;
    this.pages.clear();
    this.nodes.clear();
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new DOMException('The saved world reader was closed.', 'AbortError');
    }
  }

  private async loadNode(id: number): Promise<GraphNode> {
    this.ensureOpen();
    if (!Number.isSafeInteger(id) || id < 0 || id >= this.manifest.nodes) {
      throw new Error('Invalid snapshot graph reference.');
    }
    const cached = this.nodes.get(String(id));
    if (cached) {
      return cached;
    }
    let pending = this.pendingNodes.get(id);
    if (!pending) {
      pending = readSnapshotNode(this.descriptor.id, id)
        .then((node) => {
          this.ensureOpen();
          this.nodes.set(String(id), node, JSON.stringify(node).length * 2 + 128);
          return node;
        })
        .finally(() => this.pendingNodes.delete(id));
      this.pendingNodes.set(id, pending);
    }
    return pending;
  }

  private async readPageWithLimit(buffer: number, page: number): Promise<ArrayBuffer> {
    if (this.activeReads >= 2) {
      await new Promise<void>((resolve) => this.readQueue.push(resolve));
    } else {
      this.activeReads++;
    }
    try {
      this.ensureOpen();
      this.pageReads++;
      const result = await readSnapshotPage(this.descriptor.id, buffer, page);
      this.ensureOpen();
      const descriptor = this.manifest.buffers[buffer];
      const expected = Math.min(
        this.manifest.pageBytes,
        descriptor.byteLength - page * this.manifest.pageBytes,
      );
      if (!(result instanceof ArrayBuffer) || result.byteLength !== expected) {
        throw new Error('The saved world contains a damaged data page.');
      }
      return result;
    } finally {
      const next = this.readQueue.shift();
      if (next) {
        // Transfer the active slot directly; new callers cannot overtake the queue.
        next();
      } else {
        this.activeReads--;
      }
    }
  }

  private async loadPage(buffer: number, page: number): Promise<ArrayBuffer> {
    this.ensureOpen();
    const descriptor = this.manifest.buffers[buffer];
    if (!descriptor || !Number.isSafeInteger(page) || page < 0 || page >= descriptor.pages) {
      throw new Error('Invalid snapshot page reference.');
    }
    const key = `${buffer}:${page}`;
    const cached = this.pages.get(key);
    if (cached) {
      return cached;
    }
    let pending = this.pendingPages.get(key);
    if (!pending) {
      pending = this.readPageWithLimit(buffer, page)
        .then((data) => {
          this.ensureOpen();
          this.pages.set(key, data, data.byteLength);
          return data;
        })
        .finally(() => this.pendingPages.delete(key));
      this.pendingPages.set(key, pending);
    }
    return pending;
  }

  private async resolve(path: string): Promise<GraphValue> {
    this.ensureOpen();
    let value = this.manifest.root;
    if (path !== '') {
      for (const part of path.split('.')) {
        value = await childValue(this.source, value, part);
      }
    }
    return value;
  }

  /** Restore only the requested subtree. Renderers should request metadata, never `world`. */
  async readValue<T = unknown>(path: string): Promise<T> {
    const value = await this.resolve(path);
    return (await restoreGraph(this.source, value)) as T;
  }

  async readOptionalValue<T = unknown>(path: string): Promise<T | undefined> {
    try {
      return await this.readValue<T>(path);
    } catch (error) {
      if (error instanceof MissingSnapshotFieldError) {
        return undefined;
      }
      throw error;
    }
  }

  async describe(path: string): Promise<{ kind: string; length?: number; type?: string }> {
    const value = await this.resolve(path);
    if (!isReference(value)) {
      return { kind: typeof value };
    }
    const node = await this.loadNode(value.ref);
    if (node.kind === 'view') {
      return { kind: node.kind, length: node.length, type: node.type };
    }
    if (node.kind === 'array') {
      return { kind: node.kind, length: node.values.length };
    }
    if (node.kind === 'numbers' || node.kind === 'list') {
      return { kind: node.kind, length: node.length };
    }
    return { kind: node.kind };
  }

  /** Outputs own their buffers and can safely be transferred out of a reader worker. */
  async readValues(path: string, indices: ArrayLike<number>): Promise<Float64Array> {
    return this.gather(path, indices.length, (index) => indices[index]);
  }

  async readRange(path: string, start: number, count: number): Promise<Float64Array> {
    if (!Number.isSafeInteger(start) || start < 0) {
      throw new RangeError('Invalid snapshot range start.');
    }
    return this.gather(path, count, (index) => start + index);
  }

  private async gather(
    path: string,
    count: number,
    indexAt: (index: number) => number,
  ): Promise<Float64Array> {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError('Invalid snapshot value count.');
    }
    const value = await this.resolve(path);
    if (!isReference(value)) {
      throw new Error('The requested snapshot field is not a numeric array.');
    }
    const node = await this.loadNode(value.ref);
    if (!['view', 'numbers', 'array', 'list'].includes(node.kind)) {
      throw new Error('The requested snapshot field is not a numeric array.');
    }
    const length = node.kind === 'array' ? node.values.length : 'length' in node ? node.length : 0;
    for (let output = 0; output < count; output++) {
      const index = indexAt(output);
      if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
        throw new RangeError('Snapshot value index is outside the stored field.');
      }
    }
    const result = new Float64Array(count);
    if (node.kind === 'array' || node.kind === 'list') {
      for (let output = 0; output < count; output++) {
        const entry = await childValue(this.source, value, String(indexAt(output)));
        if (typeof entry !== 'number') {
          throw new Error('The requested snapshot field contains nonnumeric entries.');
        }
        result[output] = entry;
      }
      return result;
    }
    if (node.kind !== 'view' && node.kind !== 'numbers') {
      throw new Error('The requested snapshot field is not a numeric array.');
    }
    if (node.kind === 'view' && node.type === 'DataView') {
      throw new Error('DataView fields require an explicit numeric interpretation.');
    }
    const type =
      node.kind === 'numbers' ? Float64Array : ARRAY_TYPES[node.type as keyof typeof ARRAY_TYPES];
    const offset = node.kind === 'view' ? node.offset : 0;
    const elementBytes = type.BYTES_PER_ELEMENT;
    let buffer: number;
    if (node.kind === 'numbers') {
      buffer = node.buffer;
    } else {
      if (!isReference(node.buffer)) {
        throw new Error('Invalid typed array buffer reference.');
      }
      const bufferNode = await this.loadNode(node.buffer.ref);
      if (bufferNode.kind !== 'buffer') {
        throw new Error('Invalid typed array buffer node.');
      }
      buffer = bufferNode.buffer;
    }
    const pages = new Map<number, number[]>();
    for (let output = 0; output < count; output++) {
      const page = Math.floor((offset + indexAt(output) * elementBytes) / this.manifest.pageBytes);
      const outputs = pages.get(page);
      if (outputs) {
        outputs.push(output);
      } else {
        pages.set(page, [output]);
      }
    }
    // Read one page at a time for each request; simultaneous packet requests share at most two reads.
    for (const [page, outputs] of pages) {
      const data = await this.loadPage(buffer, page);
      const values = new type(data, 0, Math.floor(data.byteLength / elementBytes));
      for (const output of outputs) {
        const byte = offset + indexAt(output) * elementBytes - page * this.manifest.pageBytes;
        result[output] = values[byte / elementBytes];
      }
    }
    return result;
  }
}

/** Allocate each final buffer once; raw restore pages are not retained in a second cache. */
export async function restoreWorldSnapshot(id: string): Promise<World> {
  const reader = await SnapshotReader.open(id, { cacheBytes: 0 });
  try {
    return await reader.readValue<World>('world');
  } finally {
    reader.close();
  }
}
