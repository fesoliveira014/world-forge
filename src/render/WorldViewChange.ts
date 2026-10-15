import type { Vec3 } from '../core/math';
import type { WorldViewProps } from './PagedWorldView';

const DISPLAY_FIELDS = [
  'handle',
  'source',
  'mapStyle',
  'projection',
  'coastlines',
  'layer',
  'season',
  'gridLines',
  'boundaries',
  'animated',
  'particleCount',
  'flowSpeed',
  'riverWidth',
  'rivers',
  'vectors',
  'rotation',
  'relief',
  'riverThreshold',
  'drift',
  'resourceFilter',
  'selectedDeposit',
] as const satisfies readonly (keyof WorldViewProps)[];

function samePoint(a: Vec3 | null | undefined, b: Vec3 | null | undefined) {
  return a === b || (!a && !b) || (!!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);
}

/** Loading/status callbacks can rerender the parent without changing anything
 * on the canvas. Keep immediate rendering for actual display inputs only. */
export function worldViewDisplayChanged(previous: WorldViewProps, next: WorldViewProps) {
  if (previous === next) {
    return false;
  }
  if (DISPLAY_FIELDS.some((field) => previous[field] !== next[field])) {
    return true;
  }
  if ((previous.zoomDetail !== false) !== (next.zoomDetail !== false)) {
    return true;
  }
  if (!samePoint(previous.selectedAnchor, next.selectedAnchor)) {
    return true;
  }
  if (!samePoint(previous.regionPreview?.center, next.regionPreview?.center)) {
    return true;
  }
  if (previous.regionPreview?.radiusMetres !== next.regionPreview?.radiusMetres) {
    return true;
  }
  return previous.command.id !== next.command.id || previous.command.kind !== next.command.kind;
}
