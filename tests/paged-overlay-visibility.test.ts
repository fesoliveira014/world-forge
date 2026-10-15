import assert from 'node:assert/strict';
import test from 'node:test';
import { Color, Mesh, PerspectiveCamera, ShaderMaterial } from 'three';
import type { OverlayLines, OverlayPacket, WorldHandle } from '../src/core/view/types';
import {
  disposeRenderObject,
  PagedOverlays,
  type OverlayLayerVisibility,
} from '../src/render/PagedOverlays';
import { FANTASY_PALETTES } from '../src/render/FantasyStyle';

const line: OverlayLines = {
  positions: new Float32Array([1, 0, 0, Math.cos(0.1), 0, Math.sin(0.1)]),
  heights: new Float32Array([0, 0]),
  widths: new Float32Array([100]),
  discharge: new Float32Array([100]),
};
const empty: OverlayLines = {
  positions: new Float32Array(),
  heights: new Float32Array(),
  widths: new Float32Array(),
  discharge: new Float32Array(),
};
const packet: OverlayPacket = {
  rivers: line,
  coasts: line,
  boundaries: line,
  grid: line,
  flow: line,
  drift: empty,
  deposits: [],
  truncated: false,
};
const all: OverlayLayerVisibility = {
  rivers: true,
  coastlines: true,
  gridLines: true,
  boundaries: true,
  vectors: true,
};
const none: OverlayLayerVisibility = {
  rivers: false,
  coastlines: false,
  gridLines: false,
  boundaries: false,
  vectors: false,
};
const make = (data = packet) =>
  new PagedOverlays(
    data,
    { config: { radius: 6371000 } } as WorldHandle,
    {
      projection: 'globe',
      relief: 1,
      mapStyle: 'natural',
      riverWidth: 1,
      particleCount: 10,
      vectors: true,
    },
    null,
  );

test('fantasy coast and river overlays use the selected ink palette', () => {
  for (const mapStyle of ['parchment', 'engraved', 'painted'] as const) {
    const overlays = new PagedOverlays(
      packet,
      { config: { radius: 6371000 } } as WorldHandle,
      { projection: 'map', relief: 0, mapStyle, riverWidth: 1, particleCount: 10, vectors: false },
      null,
    );
    const coast = overlays.getObjectByName('overlay-coastlines') as Mesh;
    const river = overlays.getObjectByName('overlay-rivers') as Mesh;
    assert.ok(
      (coast.material as ShaderMaterial).uniforms.ink.value.equals(
        new Color(FANTASY_PALETTES[mapStyle].ink),
      ),
    );
    assert.ok(
      (river.material as ShaderMaterial).uniforms.ink.value.equals(
        new Color(FANTASY_PALETTES[mapStyle].river),
      ),
    );
    disposeRenderObject(overlays);
  }
});

test('overlay toggles change existing group visibility immediately without rebuilding geometry', () => {
  const overlays = make();
  assert.equal(new PerspectiveCamera().layers.test(overlays.layers), true);
  const groups = Object.keys(all).map((layer) => overlays.getObjectByName(`overlay-${layer}`)!);
  assert.ok(groups.every(Boolean));
  const geometry = groups.map((object) => (object as Mesh).geometry);
  assert.equal(overlays.setVisibleLayers(all), false);
  assert.equal(overlays.setVisibleLayers(none), true);
  assert.ok(groups.every((object) => !object.visible));
  assert.equal(overlays.setVisibleLayers(none), false, 'idle flags do not request extra renders');
  overlays.animate(1, true, 1, new PerspectiveCamera(), 1000, 700);
  assert.ok(
    groups.every((object) => !object.visible),
    'animation cannot resurrect disabled lines',
  );
  assert.deepEqual(
    groups.map((object) => (object as Mesh).geometry),
    geometry,
  );
  assert.equal(overlays.setVisibleLayers({ ...none, gridLines: true }), true);
  assert.equal(overlays.getObjectByName('overlay-gridLines')!.visible, true);
  assert.equal(overlays.getObjectByName('overlay-coastlines')!.visible, false);
  disposeRenderObject(overlays);
});

test('a delayed packet uses current checkbox flags rather than resurrecting its requested layers', async () => {
  let complete!: (value: OverlayPacket) => void;
  let current = all;
  const pending = new Promise<OverlayPacket>((resolve) => {
    complete = resolve;
  }).then((data) => {
    const next = make(data);
    next.setVisibleLayers(current);
    return next;
  });
  current = { ...none, rivers: true };
  complete(packet);
  const overlays = await pending;
  assert.equal(overlays.getObjectByName('overlay-rivers')!.visible, true);
  for (const layer of ['coastlines', 'gridLines', 'boundaries', 'vectors']) {
    assert.equal(overlays.getObjectByName(`overlay-${layer}`)!.visible, false);
  }
  assert.equal(overlays.setVisibleLayers(current), false);
  disposeRenderObject(overlays);
});

test('flow trails pause in place and their complete draw obeys visibility and density controls', () => {
  const overlays = make();
  const flow = overlays.getObjectByName('overlay-vectors') as Mesh;
  const material = flow.material as ShaderMaterial;
  const clock = () => material.uniforms.time.value as number;
  const camera = new PerspectiveCamera();
  assert.ok(overlays.hasParticles);
  overlays.animate(0, true, 1, camera, 1000, 700);
  overlays.animate(0.05, true, 1, camera, 1000, 700);
  const advanced = clock();
  assert.ok(advanced > 0);
  overlays.animate(5, false, 1, camera, 1000, 700);
  assert.equal(clock(), advanced);
  assert.equal(flow.visible, true, 'pausing preserves the visible trails');
  overlays.animate(6, true, 0, camera, 1000, 700);
  assert.equal(clock(), advanced, 'zero speed does not reset the phase');
  overlays.setVisibleLayers({ ...all, vectors: false });
  overlays.animate(7, true, 1, camera, 1000, 700);
  assert.equal(flow.visible, false);
  assert.equal(overlays.hasParticles, false);
  assert.equal(clock(), advanced, 'hidden flow does not keep the render loop active');
  overlays.setVisibleLayers(all);
  overlays.setParticleCount(0);
  assert.equal(overlays.hasParticles, false);
  overlays.setParticleCount(1200);
  assert.ok(overlays.hasParticles);
  assert.equal(overlays.getObjectByName('overlay-vectors'), flow, 'density reuses the draw object');
  disposeRenderObject(overlays);
});

test('replacement overlay packets inherit the paused flow phase', () => {
  const previous = make();
  const camera = new PerspectiveCamera();
  previous.animate(0, true, 1, camera, 1000, 700);
  previous.animate(0.05, true, 1, camera, 1000, 700);
  const phase = ((previous.getObjectByName('overlay-vectors') as Mesh).material as ShaderMaterial)
    .uniforms.time.value;
  const hidden = make({ ...packet, flow: empty });
  hidden.preserveFlowPhase(previous);
  const replacement = make();
  replacement.preserveFlowPhase(hidden);
  replacement.animate(100, false, 1, camera, 1000, 700);
  assert.equal(
    ((replacement.getObjectByName('overlay-vectors') as Mesh).material as ShaderMaterial).uniforms
      .time.value,
    phase,
  );
  disposeRenderObject(previous);
  disposeRenderObject(hidden);
  disposeRenderObject(replacement);
});
