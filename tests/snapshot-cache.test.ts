import assert from 'node:assert/strict';
import test from 'node:test';
import { ByteCache } from '../src/core/storage/cache';

test('cache refreshes recency and evicts enough bytes for differently sized entries', () => {
  const cache = new ByteCache<string>(10);
  cache.set('one', 'first', 4);
  cache.set('two', 'second', 4);
  assert.equal(cache.get('one'), 'first');
  cache.set('three', 'third', 6);
  assert.equal(cache.get('two'), undefined);
  assert.equal(cache.get('one'), 'first');
  assert.equal(cache.bytes, 10);
  cache.set('oversized', 'uncached', 11);
  assert.equal(cache.bytes, 10);
  assert.equal(cache.get('oversized'), undefined);
  cache.set('one', 'replacement', 8);
  assert.equal(cache.get('three'), undefined);
  assert.equal(cache.bytes, 8);
  cache.clear();
  assert.equal(cache.bytes, 0);
  assert.equal(cache.size, 0);
});
