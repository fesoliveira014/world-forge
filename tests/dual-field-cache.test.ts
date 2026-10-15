import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DualFieldCache,
  DUAL_FIELD_BLOCK_ROWS,
  DUAL_FIELD_CACHE_BYTES,
} from '../src/core/view/dual-field-cache';
import type { PageValues } from '../src/core/view/spatial-index';

test('decoded fields retain Float64 precision, output order, duplicates and short final blocks', async () => {
  const rows = DUAL_FIELD_BLOCK_ROWS + 3;
  const source = Float64Array.from(
    { length: rows * 3 },
    (_, index) => Math.sin(index) * 0.000000000123 + index / 7,
  );
  const ranges: number[][] = [];
  const pages: PageValues = {
    async readRange(_path, first, count) {
      ranges.push([first, count]);
      return source.slice(first, first + count);
    },
    async readValues() {
      throw Error('no scalar gathers');
    },
    async readValue() {
      throw Error('no full-field restoration');
    },
  };
  const cache = new DualFieldCache(pages);
  const wanted = [rows - 1, 17, rows - 1, DUAL_FIELD_BLOCK_ROWS - 1];
  const expected = Float64Array.from(
    wanted.flatMap((row) => Array.from(source.subarray(row * 3, row * 3 + 3))),
  );
  const first = await cache.read('positions', wanted, rows, 3);
  assert.deepEqual(first, expected);
  assert.deepEqual(ranges, [
    [DUAL_FIELD_BLOCK_ROWS * 3, 9],
    [0, DUAL_FIELD_BLOCK_ROWS * 3],
  ]);
  first.fill(0);
  assert.deepEqual(
    await cache.read('positions', wanted, rows, 3),
    expected,
    'returned buffers never alias cached values',
  );
  assert.equal(ranges.length, 2);
  await assert.rejects(cache.read('positions', [rows], rows, 3), /outside/);
});

test('neighboring dual packets reuse decoded fields after the small raw-page cache evicts them', async () => {
  const pageBytes = 4 * 1024 * 1024;
  const rawCapacity = 32 * 1024 * 1024;
  const raw = new Map<string, number>();
  let rawBytes = 0;
  let pageReads = 0;
  const fields = [
    'triangles',
    'cornerNeighbors',
    'positions',
    'corners',
    'height',
    'lakeDepth',
    'cornerHeight',
    'lakeId',
    'lakeFraction',
  ];
  const pages: PageValues = {
    async readRange(path, first, count) {
      if (!raw.has(path)) {
        pageReads++;
        while (rawBytes + pageBytes > rawCapacity) {
          const oldest = raw.keys().next().value!;
          rawBytes -= raw.get(oldest)!;
          raw.delete(oldest);
        }
        rawBytes += pageBytes;
      } else {
        raw.delete(path);
      }
      raw.set(path, pageBytes);
      return Float64Array.from({ length: count }, (_, offset) => first + offset);
    },
    async readValues() {
      throw Error('no scalar gathers');
    },
    async readValue() {
      throw Error('no full-field restoration');
    },
  };
  const cache = new DualFieldCache(pages);
  for (let packet = 0; packet < 10; packet++) {
    for (const field of fields) {
      const wanted = [packet * 12, packet * 12 + 7];
      assert.deepEqual(await cache.read(field, wanted, 1_000_000), Float64Array.from(wanted));
    }
  }
  assert.equal(
    pageReads,
    fields.length,
    'nine alternating raw pages load once, not once per packet',
  );
  assert.ok(rawBytes <= rawCapacity);
  assert.equal(cache.retainedBytes, fields.length * DUAL_FIELD_BLOCK_ROWS * 8);
});

test('decoded field ownership stays bounded as spatial regions change', async () => {
  let reads = 0;
  const pages: PageValues = {
    async readRange(_path, start, count) {
      reads++;
      assert.ok(count <= DUAL_FIELD_BLOCK_ROWS * 3);
      return Float64Array.from({ length: count }, (_, offset) => start + offset);
    },
    async readValues() {
      throw Error('no scalar gathers');
    },
    async readValue() {
      throw Error('no full-field restoration');
    },
  };
  const cache = new DualFieldCache(pages);
  const blockCount = Math.ceil(DUAL_FIELD_CACHE_BYTES / (DUAL_FIELD_BLOCK_ROWS * 3 * 8)) + 5;
  for (let block = 0; block < blockCount; block++) {
    await cache.read(
      'corners',
      [block * DUAL_FIELD_BLOCK_ROWS],
      blockCount * DUAL_FIELD_BLOCK_ROWS,
      3,
    );
    assert.ok(cache.retainedBytes <= DUAL_FIELD_CACHE_BYTES);
  }
  assert.equal(reads, blockCount);
  assert.deepEqual(
    await cache.read('corners', [0], blockCount * DUAL_FIELD_BLOCK_ROWS, 3),
    Float64Array.of(0, 1, 2),
  );
  assert.equal(reads, blockCount + 1, 'evicted blocks reload rather than retain the whole field');
});
