import type { RenderItem } from 'three';

/** Keep Three r185's opaque ordering, with creation order inside a fixed-terrain
 * material. Separate terrain materials previously imposed this same packet order;
 * depth sorting a shared material can change which equal-depth edge wins. */
export function terrainOpaqueSort(a: RenderItem, b: RenderItem): number {
  if (a.groupOrder !== b.groupOrder) {
    return a.groupOrder - b.groupOrder;
  }
  if (a.renderOrder !== b.renderOrder) {
    return a.renderOrder - b.renderOrder;
  }
  // r185's sorter uses this internal runtime ID, omitted from Material's public type.
  const aMaterialId = (a.material as typeof a.material & { id: number }).id;
  const bMaterialId = (b.material as typeof b.material & { id: number }).id;
  if (aMaterialId !== bMaterialId) {
    return aMaterialId - bMaterialId;
  }
  if (a.materialVariant !== b.materialVariant) {
    return a.materialVariant - b.materialVariant;
  }
  // Tag the whole material cohort, not a pair of object classes: otherwise a
  // third object sharing the material could make the comparison non-transitive.
  if (a.material.userData.fixedSurfacePacketOrder === true && a.id !== b.id) {
    return a.id - b.id;
  }
  if (a.z !== b.z) {
    return a.z - b.z;
  }
  return a.id - b.id;
}
