import * as THREE from 'three';
import type { PhysicalMeshPacket } from '../core/view/physical-mesh-types';
import type { FixedRiverBatch } from '../core/view/river-render-types';
import { buildZoomRiverConstraints } from '../core/view/zoom-river-constraints';
import type { FixedSurface, FixedSurfaceAppearance } from './FixedSurface';
import { selectZoomFaces, type ZoomFaceCandidate } from './ZoomSelection';
import { buildZoomSurface, enableZoomSurfaceMaterial, type ZoomSurfacePatch } from './ZoomSurface';

/** One bounded display working set. The world source and simulation never enter
 * this controller. A finished patch replaces its predecessor only at zero morph. */
export class ZoomDetail {
  private active: ZoomSurfacePatch | null = null;
  private pending: ZoomSurfacePatch | null | undefined;
  private job: Generator<unknown, ZoomFaceCandidate[] | ZoomSurfacePatch | null> | null = null;
  private jobKind: 'selecting' | 'building' = 'selecting';
  private previous: readonly ZoomFaceCandidate[] = [];
  private constraints: Awaited<ReturnType<typeof buildZoomRiverConstraints>> | null = null;
  private waiting = false;
  private readonly abort = new AbortController();
  private disposed = false;
  private failed = false;
  private cameraKey = '';
  private lastMovement = -Infinity;
  private lastStarted = -Infinity;
  private dirty = true;
  private phase: 'ready' | 'out' | 'in' = 'ready';
  private phaseStart = 0;
  private startBlend = 0;
  private blend = 0;
  private revision = 0;
  private lastBuildMs = 0;
  private workMs = 0;
  constructor(
    private readonly parent: THREE.Group,
    private readonly surfaces: readonly FixedSurface[],
    private readonly packets: readonly PhysicalMeshPacket[],
    private readonly rivers: readonly FixedRiverBatch[],
    private readonly radius: number,
    private readonly appearance: FixedSurfaceAppearance,
    private readonly material: THREE.ShaderMaterial,
    private readonly canvas: HTMLCanvasElement,
  ) {
    enableZoomSurfaceMaterial(material, appearance.projection === 'map');
    delete this.canvas.dataset.zoomDetailError;
    this.diagnostics('selecting');
  }
  private beginBuild(candidates: ZoomFaceCandidate[]) {
    if (this.disposed || this.failed) {
      return;
    }
    this.job = buildZoomSurface(
      candidates,
      this.surfaces,
      this.packets,
      this.radius,
      this.appearance,
      this.material,
      this.constraints!,
    );
    this.jobKind = 'building';
  }
  private selected(candidates: ZoomFaceCandidate[]) {
    const identity = (list: readonly ZoomFaceCandidate[]) =>
      list
        .map((c) => `${c.batch}:${c.face}:${c.segments}`)
        .sort()
        .join(',');
    if (identity(candidates) === identity(this.previous)) {
      return;
    }
    if (!candidates.length) {
      this.pending = null;
      return;
    }
    if (this.constraints) {
      this.beginBuild(candidates);
    } else {
      this.waiting = true;
      void buildZoomRiverConstraints(this.rivers, this.radius, { signal: this.abort.signal })
        .then((constraints) => {
          if (!this.disposed && !this.failed) {
            this.constraints = constraints;
            this.waiting = false;
            this.beginBuild(candidates);
          }
        })
        .catch((error) => {
          if (!this.disposed && !this.failed) {
            this.fail(error);
          }
        });
    }
  }
  private fail(error: unknown) {
    this.failed = true;
    this.abort.abort();
    this.waiting = false;
    this.job?.return(null);
    this.job = null;
    this.pending?.dispose();
    this.pending = undefined;
    this.active?.dispose();
    this.active = null;
    this.constraints = null;
    this.previous = [];
    this.blend = 0;
    this.phase = 'ready';
    this.material.uniforms.zoomBlend.value = 0;
    this.canvas.dataset.zoomDetailError = error instanceof Error ? error.message : String(error);
    this.diagnostics('error');
  }
  private diagnostics(state: string) {
    const data = this.canvas.dataset;
    data.zoomDetailState = state;
    data.zoomDetailVertices = String(this.active?.vertices ?? 0);
    data.zoomDetailTriangles = String(this.active?.triangles ?? 0);
    data.zoomDetailFaces = String(this.active?.selections.length ?? 0);
    data.zoomDetailBytes = String(this.bytes);
    data.zoomDetailRiverConstraintBytes = String(this.constraints?.bytes ?? 0);
    data.zoomDetailRevision = String(this.revision);
    data.zoomDetailBuildMs = this.lastBuildMs.toFixed(2);
    data.zoomDetailBlend = this.blend.toFixed(3);
  }
  get bytes() {
    return (
      (this.active?.bytes ?? 0) +
      (this.active?.maskBytes ?? 0) +
      (this.pending?.bytes ?? 0) +
      (this.constraints?.bytes ?? 0)
    );
  }
  get vertices() {
    return this.active?.vertices ?? 0;
  }
  get triangleDelta() {
    return (this.active?.triangles ?? 0) - (this.active?.selections.length ?? 0);
  }
  /** Bounds every active/pending morph, including a replacement prepared while
   * its predecessor still covers the base faces. */
  get maximumDisplacement() {
    return Math.max(this.active?.maximumDisplacement ?? 0, this.pending?.maximumDisplacement ?? 0);
  }
  applyBaseVisibility(isVisible: (surface: FixedSurface) => boolean) {
    this.active?.applyBaseVisibility(isVisible);
  }
  /** Returns whether another rendered frame is needed. Work is cooperatively
   * sliced to 3 ms; the old complete surface stays visible throughout preparation. */
  tick(camera: THREE.Camera, width: number, height: number, time: number) {
    if (this.disposed || this.failed) {
      return false;
    }
    let changed = false;
    try {
      const key = [
        ...camera.matrixWorld.elements,
        ...camera.projectionMatrix.elements,
        width,
        height,
      ]
        .map((value) => value.toPrecision(7))
        .join(',');
      if (key !== this.cameraKey) {
        this.cameraKey = key;
        this.lastMovement = time;
        this.dirty = true;
      }
      // A short quiet interval catches settled controls; the maximum delay also
      // prepares new terrain during a long continuous pan or rotation.
      if (
        this.dirty &&
        !this.job &&
        !this.waiting &&
        this.pending === undefined &&
        this.phase === 'ready' &&
        (time - this.lastMovement >= 90 || time - this.lastStarted >= 400)
      ) {
        this.job = selectZoomFaces(
          this.surfaces,
          this.packets,
          camera,
          width,
          height,
          this.previous,
        );
        this.jobKind = 'selecting';
        this.dirty = false;
        this.lastStarted = time;
        this.workMs = 0;
      }
      const started = performance.now();
      while (this.job && performance.now() - started < 3) {
        const result = this.job.next();
        if (result.done) {
          this.job = null;
          if (this.jobKind === 'selecting') {
            this.selected(result.value as ZoomFaceCandidate[]);
          } else {
            this.pending = result.value as ZoomSurfacePatch | null;
            this.lastBuildMs = this.workMs + performance.now() - started;
          }
        }
      }
      this.workMs += performance.now() - started;
      if (this.pending !== undefined && this.phase !== 'out') {
        if (this.active) {
          this.phase = 'out';
          this.phaseStart = time;
          this.startBlend = this.blend;
        } else {
          this.swap(time);
          changed = true;
        }
      }
      if (this.phase === 'out') {
        this.blend = Math.max(0, this.startBlend * (1 - (time - this.phaseStart) / 180));
        changed = true;
        if (this.blend === 0) {
          this.swap(time);
        }
      } else if (this.phase === 'in') {
        this.blend = Math.min(1, (time - this.phaseStart) / 240);
        changed = true;
        if (this.blend === 1) {
          this.phase = 'ready';
        }
      }
      this.material.uniforms.zoomBlend.value = this.blend;
      this.diagnostics(
        this.phase !== 'ready'
          ? 'transitioning'
          : this.waiting
            ? 'preparing'
            : this.job
              ? this.jobKind
              : this.dirty
                ? 'selecting'
                : 'ready',
      );
    } catch (error) {
      this.fail(error);
      changed = true;
    }
    return changed;
  }
  private swap(time: number) {
    this.active?.dispose();
    this.active = this.pending ?? null;
    this.pending = undefined;
    this.previous = this.active?.selections ?? [];
    this.active?.install(this.parent);
    this.blend = 0;
    this.phaseStart = time;
    this.phase = this.active ? 'in' : 'ready';
    this.revision++;
    if (!this.active) {
      this.constraints = null;
    }
  }
  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.abort.abort();
    this.waiting = false;
    this.job?.return(null);
    this.job = null;
    this.pending?.dispose();
    this.pending = undefined;
    this.active?.dispose();
    this.active = null;
    this.constraints = null;
    this.blend = 0;
    this.material.uniforms.zoomBlend.value = 0;
    this.diagnostics('off');
  }
}
