/** Storage is deliberately independent of generator versions and renderer caches. */
export const SNAPSHOT_SCHEMA_VERSION = 1;
export const SNAPSHOT_PAGE_BYTES = 4 * 1024 * 1024;
const ARRAY_BLOCK_LENGTH = 256;
const PAGED_NUMBER_LENGTH = 1024;

export class MissingSnapshotFieldError extends Error {
  constructor(readonly field: string) {
    super(`Snapshot field does not exist: ${field}.`);
    this.name = 'MissingSnapshotFieldError';
  }
}

export type GraphValue = string | number | boolean | null | undefined | { ref: number };
export type NumericArray =
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;

export const ARRAY_TYPES = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
};

export type ArrayType = keyof typeof ARRAY_TYPES;
export type GraphNode =
  | { kind: 'object'; entries: [string, GraphValue][]; nullPrototype: boolean }
  | { kind: 'array'; values: GraphValue[] }
  | { kind: 'list'; length: number; blocks: number[] }
  | { kind: 'numbers'; length: number; buffer: number }
  | { kind: 'buffer'; buffer: number }
  | {
      kind: 'view';
      type: ArrayType | 'DataView';
      buffer: GraphValue;
      offset: number;
      length: number;
    };

export interface BufferDescriptor {
  byteLength: number;
  pages: number;
}

export interface GraphManifest {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  littleEndian: boolean;
  pageBytes: number;
  root: GraphValue;
  nodes: number;
  buffers: BufferDescriptor[];
}

export interface EncodedGraph {
  manifest: GraphManifest;
  nodes: GraphNode[];
  page(buffer: number, page: number): ArrayBuffer;
}

export function isReference(value: GraphValue): value is { ref: number } {
  return typeof value === 'object' && value !== null;
}

function isLittleEndian(): boolean {
  return new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
}

/** Numeric source arrays are converted one page at a time, never duplicated in full. */
export function encodeGraph(value: unknown, pageBytes = SNAPSHOT_PAGE_BYTES): EncodedGraph {
  if (!Number.isSafeInteger(pageBytes) || pageBytes < 8 || pageBytes % 8 !== 0) {
    throw new Error('Snapshot pages must contain a whole number of eight-byte values.');
  }

  const nodes: GraphNode[] = [];
  const references = new Map<object, number>();
  const sources: (ArrayBuffer | number[])[] = [];
  const buffers: BufferDescriptor[] = [];
  const addBuffer = (source: ArrayBuffer | number[]) => {
    const byteLength = source instanceof ArrayBuffer ? source.byteLength : source.length * 8;
    const id = sources.length;
    sources.push(source);
    buffers.push({ byteLength, pages: Math.ceil(byteLength / pageBytes) });
    return id;
  };

  function encode(item: unknown): GraphValue {
    if (
      item === null ||
      item === undefined ||
      ['string', 'number', 'boolean'].includes(typeof item)
    ) {
      return item as GraphValue;
    }
    if (typeof item !== 'object') {
      throw new Error(`Snapshots cannot contain ${typeof item} values.`);
    }
    const previous = references.get(item);
    if (previous !== undefined) {
      return { ref: previous };
    }
    const id = nodes.length;
    references.set(item, id);
    // Reserve before descending, so shared objects and cycles keep their identity.
    nodes.push({ kind: 'array', values: [] });
    let node: GraphNode;
    if (item instanceof ArrayBuffer) {
      node = { kind: 'buffer', buffer: addBuffer(item) };
    } else if (ArrayBuffer.isView(item)) {
      if (!(item.buffer instanceof ArrayBuffer)) {
        throw new Error('Shared memory cannot be stored in a world snapshot.');
      }
      const type = item instanceof DataView ? 'DataView' : item.constructor.name;
      if (type !== 'DataView' && !Object.hasOwn(ARRAY_TYPES, type)) {
        throw new Error(`Unsupported snapshot array type: ${type}.`);
      }
      node = {
        kind: 'view',
        type: type as ArrayType | 'DataView',
        buffer: encode(item.buffer),
        offset: item.byteOffset,
        length: item instanceof DataView ? item.byteLength : (item as NumericArray).length,
      };
    } else if (Array.isArray(item)) {
      let numeric = item.length >= PAGED_NUMBER_LENGTH;
      for (let index = 0; numeric && index < item.length; index++) {
        numeric = typeof item[index] === 'number';
      }
      if (numeric) {
        node = { kind: 'numbers', length: item.length, buffer: addBuffer(item as number[]) };
      } else if (item.length > ARRAY_BLOCK_LENGTH) {
        const blocks: number[] = [];
        for (let start = 0; start < item.length; start += ARRAY_BLOCK_LENGTH) {
          const block = encode(item.slice(start, start + ARRAY_BLOCK_LENGTH));
          blocks.push((block as { ref: number }).ref);
        }
        node = { kind: 'list', length: item.length, blocks };
      } else {
        node = { kind: 'array', values: item.map(encode) };
      }
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('Snapshots support only plain objects and numeric arrays.');
      }
      node = {
        kind: 'object',
        nullPrototype: prototype === null,
        entries: Object.entries(item).map(([key, child]) => [key, encode(child)]),
      };
    }
    nodes[id] = node;
    return { ref: id };
  }

  const root = encode(value);
  return {
    manifest: {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      littleEndian: isLittleEndian(),
      pageBytes,
      root,
      nodes: nodes.length,
      buffers,
    },
    nodes,
    page(buffer, page) {
      const source = sources[buffer];
      const descriptor = buffers[buffer];
      if (!source || !Number.isSafeInteger(page) || page < 0 || page >= descriptor.pages) {
        throw new Error('Invalid snapshot page.');
      }
      const start = page * pageBytes;
      const end = Math.min(descriptor.byteLength, start + pageBytes);
      if (source instanceof ArrayBuffer) {
        return source.slice(start, end);
      }
      const data = new Float64Array((end - start) / 8);
      for (let index = 0; index < data.length; index++) {
        data[index] = source[start / 8 + index];
      }
      return data.buffer;
    },
  };
}

export function validateManifest(manifest: GraphManifest): void {
  if (manifest.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error('This snapshot uses an unsupported storage format.');
  }
  if (manifest.littleEndian !== isLittleEndian()) {
    throw new Error('This snapshot uses an incompatible numeric byte order.');
  }
  if (
    !Number.isSafeInteger(manifest.pageBytes) ||
    manifest.pageBytes < 8 ||
    manifest.pageBytes % 8
  ) {
    throw new Error('Invalid snapshot page size.');
  }
  if (!Number.isSafeInteger(manifest.nodes) || manifest.nodes < 0) {
    throw new Error('Invalid snapshot graph.');
  }
  for (const buffer of manifest.buffers) {
    if (
      !Number.isSafeInteger(buffer.byteLength) ||
      buffer.byteLength < 0 ||
      buffer.pages !== Math.ceil(buffer.byteLength / manifest.pageBytes)
    ) {
      throw new Error('Invalid snapshot buffer size.');
    }
  }
}

export interface GraphSource {
  manifest: GraphManifest;
  node(id: number): Promise<GraphNode>;
  page(buffer: number, page: number): Promise<ArrayBuffer>;
}

/** Used only for compute restore or a deliberately small requested metadata subtree. */
export async function restoreGraph(
  source: GraphSource,
  root = source.manifest.root,
): Promise<unknown> {
  validateManifest(source.manifest);
  const restored = new Map<number, unknown>();
  const restoredBuffers = new Map<number, ArrayBuffer>();

  async function restoreBuffer(id: number): Promise<ArrayBuffer> {
    const previous = restoredBuffers.get(id);
    if (previous) {
      return previous;
    }
    const descriptor = source.manifest.buffers[id];
    if (!descriptor) {
      throw new Error('Missing snapshot buffer descriptor.');
    }
    const buffer = new ArrayBuffer(descriptor.byteLength);
    const bytes = new Uint8Array(buffer);
    for (let page = 0; page < descriptor.pages; page++) {
      const data = await source.page(id, page);
      const expected = Math.min(
        source.manifest.pageBytes,
        bytes.length - page * source.manifest.pageBytes,
      );
      if (data.byteLength !== expected) {
        throw new Error('Snapshot page length does not match its descriptor.');
      }
      bytes.set(new Uint8Array(data), page * source.manifest.pageBytes);
    }
    restoredBuffers.set(id, buffer);
    return buffer;
  }

  async function restore(value: GraphValue): Promise<unknown> {
    if (!isReference(value)) {
      return value;
    }
    if (restored.has(value.ref)) {
      return restored.get(value.ref);
    }
    const node = await source.node(value.ref);
    if (node.kind === 'buffer') {
      const result = await restoreBuffer(node.buffer);
      restored.set(value.ref, result);
      return result;
    }
    if (node.kind === 'view') {
      const buffer = (await restore(node.buffer)) as ArrayBuffer;
      const result =
        node.type === 'DataView'
          ? new DataView(buffer, node.offset, node.length)
          : new ARRAY_TYPES[node.type](buffer, node.offset, node.length);
      restored.set(value.ref, result);
      return result;
    }
    if (node.kind === 'numbers') {
      const result: number[] = new Array(node.length);
      restored.set(value.ref, result);
      const descriptor = source.manifest.buffers[node.buffer];
      for (let page = 0; page < descriptor.pages; page++) {
        const values = new Float64Array(await source.page(node.buffer, page));
        const start = (page * source.manifest.pageBytes) / 8;
        for (let index = 0; index < values.length; index++) {
          result[start + index] = values[index];
        }
      }
      return result;
    }
    if (node.kind === 'object') {
      const result = node.nullPrototype ? Object.create(null) : {};
      restored.set(value.ref, result);
      for (const [key, child] of node.entries) {
        Object.defineProperty(result, key, {
          value: await restore(child),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return result;
    }
    const result: unknown[] = new Array(node.kind === 'list' ? node.length : node.values.length);
    restored.set(value.ref, result);
    if (node.kind === 'list') {
      for (let block = 0; block < node.blocks.length; block++) {
        const values = (await restore({ ref: node.blocks[block] })) as unknown[];
        for (let index = 0; index < values.length; index++) {
          if (index in values) {
            result[block * ARRAY_BLOCK_LENGTH + index] = values[index];
          }
        }
      }
    } else {
      for (let index = 0; index < node.values.length; index++) {
        if (index in node.values) {
          result[index] = await restore(node.values[index]);
        }
      }
    }
    return result;
  }
  return restore(root);
}

export async function childValue(
  source: GraphSource,
  value: GraphValue,
  key: string,
): Promise<GraphValue> {
  if (!isReference(value)) {
    throw new Error(`Snapshot path is not an object at ${key}.`);
  }
  const node = await source.node(value.ref);
  if (node.kind === 'object') {
    const entry = node.entries.find(([name]) => name === key);
    if (!entry) {
      throw new MissingSnapshotFieldError(key);
    }
    return entry[1];
  }
  const index = Number(key);
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error(`Invalid snapshot array index: ${key}.`);
  }
  if (node.kind === 'array' && index < node.values.length) {
    return node.values[index];
  }
  if (node.kind === 'list' && index < node.length) {
    const block = await source.node(node.blocks[Math.floor(index / ARRAY_BLOCK_LENGTH)]);
    if (block.kind === 'array') {
      return block.values[index % ARRAY_BLOCK_LENGTH];
    }
  }
  if (node.kind === 'array' || node.kind === 'list') {
    throw new MissingSnapshotFieldError(key);
  }
  throw new Error(`Snapshot field is not an object array: ${key}.`);
}
