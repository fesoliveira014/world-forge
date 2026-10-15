import assert from 'node:assert/strict';
import test from 'node:test';
import { GpuFrameFence } from '../src/render/GpuFrameFence';

function fixture() {
  const calls: unknown[][] = [];
  let status = 0x911b; // TIMEOUT_EXPIRED
  const sync = {} as WebGLSync;
  const gl = {
    SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
    ALREADY_SIGNALED: 0x911a,
    CONDITION_SATISFIED: 0x911c,
    WAIT_FAILED: 0x911d,
    fenceSync(condition: number, flags: number) {
      calls.push(['fence', condition, flags]);
      return sync;
    },
    clientWaitSync(fence: WebGLSync, flags: number, timeout: number) {
      calls.push(['poll', fence, flags, timeout]);
      return status;
    },
    deleteSync(fence: WebGLSync | null) {
      calls.push(['delete', fence]);
    },
    flush() {
      calls.push(['flush']);
    },
  } as const;
  return {
    gate: new GpuFrameFence(gl),
    calls,
    gl,
    status: (value: number) => {
      status = value;
    },
  };
}

test('GPU frame fence permits only one frame and polls without a blocking timeout', () => {
  const { gate, calls, gl, status } = fixture();
  assert.equal(gate.poll(0), true);
  gate.submit(10);
  assert.equal(gate.pending, true);
  assert.throws(() => gate.submit(12), /already in flight/);
  for (const time of [20, 100, 1000]) {
    assert.equal(gate.poll(time), false);
  }
  assert.equal(gate.completedFrames, 0);
  assert.equal(calls.filter((call) => call[0] === 'fence').length, 1);
  for (const call of calls.filter((call) => call[0] === 'poll')) {
    assert.deepEqual(call.slice(2), [0, 0]);
  }
  status(gl.CONDITION_SATISFIED);
  assert.equal(gate.poll(1010), true);
  assert.equal(gate.pending, false);
  assert.equal(gate.completedFrames, 1);
  assert.equal(gate.frameCompleteMs, 1000);
  gate.submit(1020);
  status(gl.ALREADY_SIGNALED);
  assert.equal(gate.poll(1030), true);
  assert.equal(gate.completedFrames, 2);
  assert.equal(calls.filter((call) => call[0] === 'flush').length, 2);
});

test('GPU frame fence releases pending sync on failure and idempotent teardown', () => {
  const { gate, calls, gl, status } = fixture();
  gate.submit(0);
  status(gl.WAIT_FAILED);
  assert.throws(() => gate.poll(10), /failed to complete/);
  assert.equal(gate.pending, false);
  assert.equal(gate.completedFrames, 0);
  gate.submit(20);
  gate.dispose();
  gate.dispose();
  assert.equal(calls.filter((call) => call[0] === 'delete').length, 2);
  assert.equal(gate.poll(30), false);
  assert.throws(() => gate.submit(40), /disposed/);
});
