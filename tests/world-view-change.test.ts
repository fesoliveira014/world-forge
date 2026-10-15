import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorldViewProps } from '../src/render/PagedWorldView';
import { worldViewDisplayChanged } from '../src/render/WorldViewChange';

function fixture(): WorldViewProps {
  return {
    handle: null,
    source: null,
    mapStyle: 'natural',
    projection: 'globe',
    coastlines: false,
    layer: 'world',
    season: -1,
    gridLines: true,
    boundaries: false,
    animated: false,
    particleCount: 1200,
    flowSpeed: 1,
    riverWidth: 1,
    rivers: true,
    vectors: true,
    rotation: false,
    relief: 26,
    riverThreshold: 20,
    drift: 0,
    selectedAnchor: [1, 0, 0],
    onSelectAnchor() {},
    resourceFilter: 'all',
    selectedDeposit: null,
    onSelectDeposit() {},
    command: { kind: 'reset', id: 0 },
    regionPreview: { center: [1, 0, 0], radiusMetres: 250000 },
  };
}

test('status rerenders and callback changes do not masquerade as camera or display changes', () => {
  const before = fixture();
  const after = fixture();
  after.onGridStatusChange = () => {};
  after.onCoastStatusChange = () => {};
  assert.notEqual(before, after);
  assert.notEqual(before.selectedAnchor, after.selectedAnchor);
  assert.notEqual(before.regionPreview, after.regionPreview);
  assert.notEqual(before.onSelectAnchor, after.onSelectAnchor);
  assert.equal(worldViewDisplayChanged(before, after), false);
  assert.equal(worldViewDisplayChanged(before, { ...after, zoomDetail: true }), false);
  assert.equal(
    worldViewDisplayChanged(
      { ...before, regionPreview: null },
      { ...after, regionPreview: undefined },
    ),
    false,
  );
});

test('display controls, source replacement and camera commands still request an immediate frame', () => {
  const before = fixture();
  const changes: Partial<WorldViewProps>[] = [
    { handle: {} as WorldViewProps['handle'] },
    { source: {} as WorldViewProps['source'] },
    { mapStyle: 'relief' },
    { projection: 'map' },
    { coastlines: true },
    { layer: 'biomes' },
    { season: 0 },
    { gridLines: false },
    { boundaries: true },
    { animated: true },
    { particleCount: 2400 },
    { flowSpeed: 2 },
    { riverWidth: 1.5 },
    { rivers: false },
    { vectors: false },
    { rotation: true },
    { relief: 40 },
    { riverThreshold: 30 },
    { drift: 1 },
    { resourceFilter: 'iron' },
    { selectedDeposit: 'deposit-1' },
    { zoomDetail: false },
    { command: { kind: 'reset', id: 1 } },
    { command: { kind: 'in', id: 0 } },
  ];
  for (const change of changes) {
    assert.equal(
      worldViewDisplayChanged(before, { ...before, ...change }),
      true,
      JSON.stringify(change),
    );
  }
});

test('selection and region changes compare geographic values rather than object identity', () => {
  const before = fixture();
  for (const change of [
    { selectedAnchor: null },
    { selectedAnchor: [0, 1, 0] },
    { regionPreview: null },
    { regionPreview: { center: [1, 0, 0], radiusMetres: 300000 } },
    { regionPreview: { center: [0, 1, 0], radiusMetres: 250000 } },
  ] satisfies Partial<WorldViewProps>[]) {
    assert.equal(worldViewDisplayChanged(before, { ...before, ...change }), true);
  }
});
