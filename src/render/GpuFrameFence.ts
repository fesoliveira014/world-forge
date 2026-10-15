/** Limit command submission to one frame without blocking the event loop or
 * reducing geometry. WebGL2 fences are polled with a zero timeout; while pending,
 * callers can process controls, worker messages and CPU-side geometry uploads. */
export class GpuFrameFence {
  private fence: WebGLSync | null = null;
  private startedAt = 0;
  private disposed = false;
  completedFrames = 0;
  frameCompleteMs = 0;

  constructor(
    private readonly gl: Pick<
      WebGL2RenderingContext,
      | 'fenceSync'
      | 'clientWaitSync'
      | 'deleteSync'
      | 'flush'
      | 'SYNC_GPU_COMMANDS_COMPLETE'
      | 'ALREADY_SIGNALED'
      | 'CONDITION_SATISFIED'
      | 'WAIT_FAILED'
    >,
  ) {}

  get pending() {
    return this.fence !== null;
  }

  /** Call after renderer.render, passing its start time to include CPU submission. */
  submit(startedAt: number) {
    if (this.disposed) {
      throw new Error('The graphics frame fence is disposed.');
    }
    if (this.fence) {
      throw new Error('A graphics frame is already in flight.');
    }
    this.fence = this.gl.fenceSync(this.gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!this.fence) {
      throw new Error('The graphics device could not track frame completion.');
    }
    this.startedAt = startedAt;
    this.gl.flush();
  }

  /** True means a new frame may be submitted; this never waits for the GPU. */
  poll(now: number) {
    if (this.disposed) {
      return false;
    }
    if (!this.fence) {
      return true;
    }
    const status = this.gl.clientWaitSync(this.fence, 0, 0);
    if (status === this.gl.WAIT_FAILED) {
      this.gl.deleteSync(this.fence);
      this.fence = null;
      throw new Error('The graphics device failed to complete the previous frame.');
    }
    if (status !== this.gl.ALREADY_SIGNALED && status !== this.gl.CONDITION_SATISFIED) {
      return false;
    }
    this.gl.deleteSync(this.fence);
    this.fence = null;
    this.completedFrames++;
    this.frameCompleteMs = Math.max(0, now - this.startedAt);
    return true;
  }

  dispose() {
    if (this.fence) {
      this.gl.deleteSync(this.fence);
    }
    this.fence = null;
    this.disposed = true;
  }
}
