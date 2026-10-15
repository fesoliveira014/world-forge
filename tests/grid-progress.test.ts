import assert from 'node:assert/strict';
import test from 'node:test';
import { gridProgressDrawDue } from '../src/render/GridProgress';

test('a large grid draws at most eight progress milestones plus initial and final frames', () => {
  let drawn = 0;
  const frames: number[] = [];
  for (let installed = 1; installed <= 960; installed++) {
    if (gridProgressDrawDue(installed, 960, drawn, 300)) {
      drawn = installed;
      frames.push(installed);
    }
  }
  assert.equal(frames[0], 1);
  assert.equal(frames.at(-1), 960);
  assert.ok(frames.length <= 10);
  assert.equal(gridProgressDrawDue(960, 960, drawn, 1000), false);
});

test('rapid progress waits but completion and user input remain immediate', () => {
  assert.equal(gridProgressDrawDue(120, 960, 0, 249), false);
  assert.equal(gridProgressDrawDue(120, 960, 0, 250), true);
  assert.equal(gridProgressDrawDue(960, 960, 900, 1), true);
  assert.equal(gridProgressDrawDue(8, 960, 7, 1, true), true);
  assert.equal(gridProgressDrawDue(7, 960, 7, 1, true), true);
  assert.equal(gridProgressDrawDue(0, 0, 0, 1000), false);
});

test('a camera or toggle frame advances the progress watermark instead of adding a redundant preview', () => {
  const installedAtInput = 237;
  assert.equal(gridProgressDrawDue(installedAtInput, 960, 121, 10, true), true);
  const drawn = installedAtInput;
  assert.equal(gridProgressDrawDue(241, 960, drawn, 300), false);
  assert.equal(gridProgressDrawDue(357, 960, drawn, 300), true);
  assert.equal(gridProgressDrawDue(960, 960, 960, 1000), false);
});
