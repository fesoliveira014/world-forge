import assert from 'node:assert/strict';
import test from 'node:test';
import { Material, Object3D, type RenderItem } from 'three';
import { terrainOpaqueSort } from '../src/render/terrainOpaqueSort';

function item(material: Material, z: number, fields: Partial<RenderItem> = {}): RenderItem {
  const object = new Object3D();
  return {
    id: object.id,
    object,
    geometry: null,
    material,
    materialVariant: 0,
    groupOrder: 0,
    renderOrder: 0,
    z,
    group: null,
    ...fields,
  };
}

test('ordinary opaque objects retain Three depth ordering and creation-order ties', () => {
  const material = new Material();
  const far = item(material, 10);
  const firstNear = item(material, 1);
  const secondNear = item(material, 1);
  assert.deepEqual([secondNear, far, firstNear].sort(terrainOpaqueSort), [
    firstNear,
    secondNear,
    far,
  ]);
  material.dispose();
});

test('shared terrain preserves packet creation order regardless of depth and object class', () => {
  const material = new Material();
  material.userData.fixedSurfacePacketOrder = true;
  const first = item(material, 100);
  const second = item(material, -100);
  const third = item(material, 0);
  // Generic objects deliberately share the tagged material, guarding against a
  // pairwise FixedSurface-only comparator that breaks transitivity.
  assert.deepEqual([third, second, first].sort(terrainOpaqueSort), [first, second, third]);
  for (const a of [first, second, third]) {
    for (const b of [first, second, third]) {
      for (const c of [first, second, third]) {
        if (terrainOpaqueSort(a, b) <= 0 && terrainOpaqueSort(b, c) <= 0) {
          assert.ok(terrainOpaqueSort(a, c) <= 0);
        }
      }
    }
  }
  material.dispose();
});

test('group, render, material, and material-variant priority still precede terrain packet order', () => {
  const earlyMaterial = new Material();
  const laterMaterial = new Material();
  earlyMaterial.userData.fixedSurfacePacketOrder = true;
  laterMaterial.userData.fixedSurfacePacketOrder = true;
  const lowPriority = item(laterMaterial, -100, { groupOrder: 1 });
  const renderLast = item(laterMaterial, -100, { renderOrder: 1 });
  const materialLast = item(laterMaterial, -100);
  const variantLast = item(earlyMaterial, -100, { materialVariant: 1 });
  const first = item(earlyMaterial, 100);
  const expected = [first, variantLast, materialLast, renderLast, lowPriority];
  const input = [...expected].reverse();
  assert.deepEqual(input.sort(terrainOpaqueSort), expected);
  earlyMaterial.dispose();
  laterMaterial.dispose();
});
