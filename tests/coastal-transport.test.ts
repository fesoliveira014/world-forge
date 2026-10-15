import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGrid, nearestCell } from '../src/core/grid/build';
import { createRegionSpacing, refineGrid } from '../src/core/grid/refine';
import { transportCoastalSediment } from '../src/core/generation/coastal-transport';
import { DEFAULT_CONFIG, type Climate, type Grid, type Terrain } from '../src/core/model';

const config = { ...DEFAULT_CONFIG, radius: 1000, erosion: 1, waveErosion: 1 };
const base = buildGrid(2, 'coastal-transport', 0.65);
function fixture(grid: Grid) {
  const terrain: Terrain = {
    bedrock: new Float32Array(grid.count),
    sediment: new Float32Array(grid.count),
    height: new Float32Array(grid.count),
    ocean: new Uint8Array(grid.count),
    surfaceChange: new Float32Array(grid.count),
    coastDistance: new Float32Array(grid.count),
    seaThreshold: 0,
    fluvialIncision: new Float32Array(grid.count),
    deltaSediment: new Float32Array(grid.count),
    oxbows: [],
  };
  const wind = new Float32Array(grid.count * 3);
  for (let cell = 0; cell < grid.count; cell++) {
    const x = grid.positions[3 * cell];
    const y = grid.positions[3 * cell + 1];
    const z = grid.positions[3 * cell + 2];
    terrain.bedrock[cell] = y < 0 ? -10 : 10;
    terrain.ocean[cell] = y < 0 ? 1 : 0;
    terrain.sediment[cell] = x > 0.9 && Math.abs(y) < 0.25 ? 2 : 0;
    terrain.height[cell] = terrain.bedrock[cell] + terrain.sediment[cell];
    wind[3 * cell] = -10 * z;
    wind[3 * cell + 2] = 10 * x;
  }
  return {
    terrain,
    climate: { wind: [wind], current: [] } as unknown as Climate,
    transfer: Uint32Array.from({ length: grid.count }, (_, cell) => cell),
  };
}

test('littoral drift moves sediment along ocean shores and conserves unequal-area volume', () => {
  const grid = refineGrid(
    base,
    config.radius,
    'coastal-transport',
    createRegionSpacing(500, config.radius, [
      { center: [1, 0, 0], radiusMetres: 200, targetSpacingMetres: 60 },
    ]),
  );
  const { terrain, climate, transfer } = fixture(grid);
  const initial = terrain.sediment.slice();
  const rock = terrain.bedrock.slice();
  const result = transportCoastalSediment(grid, grid, transfer, terrain, climate, config, 0.012);
  assert.ok(result.movedVolume > 0);
  assert.ok(result.steps > 1, 'small adaptive coastal cells set a stable timestep');
  assert.ok(Math.abs(result.residual) / result.initialVolume < 1e-7);
  assert.deepEqual(terrain.bedrock, rock);
  assert.ok(terrain.sediment.every((depth) => Number.isFinite(depth) && depth >= 0));
  let positive = 0;
  let negative = 0;
  for (let cell = 0; cell < grid.count; cell++) {
    const change = (terrain.sediment[cell] - initial[cell]) * grid.areas[cell];
    const z = grid.positions[cell * 3 + 2];
    if (z > 0) {
      positive += change;
    } else {
      negative += change;
    }
    if (Math.abs(grid.positions[cell * 3 + 1]) > 0.6) {
      assert.equal(terrain.sediment[cell], initial[cell]);
    }
  }
  assert.ok(positive > 0 && negative < 0, 'eastward flow moves the sediment patch eastward');
});

test('disabled, calm, bare, inland and zero-duration coasts remain unchanged', () => {
  for (const condition of ['disabled', 'erosion', 'calm', 'bare', 'inland', 'zero']) {
    const { terrain, climate, transfer } = fixture(base);
    if (condition === 'calm') {
      climate.wind[0].fill(0);
    }
    if (condition === 'bare') {
      terrain.sediment.fill(0);
    }
    if (condition === 'inland') {
      terrain.ocean.fill(0);
    }
    const before = terrain.sediment.slice();
    const result = transportCoastalSediment(
      base,
      base,
      transfer,
      terrain,
      climate,
      {
        ...config,
        waveErosion: condition === 'disabled' ? 0 : 1,
        erosion: condition === 'erosion' ? 0 : 1,
      },
      condition === 'zero' ? 0 : 0.01,
    );
    assert.deepEqual(terrain.sediment, before, condition);
    assert.equal(result.movedVolume, 0, condition);
  }
});

test('ocean shoreline transport is stable across time subdivisions and process search hints', () => {
  const run = (parts: number, wrongHints = false) => {
    const { terrain, climate, transfer } = fixture(base);
    if (wrongHints) {
      transfer.fill(nearestCell(base, -1, 0, 0));
    }
    for (let i = 0; i < parts; i++) {
      transportCoastalSediment(base, base, transfer, terrain, climate, config, 0.0004 / parts);
    }
    return terrain.sediment;
  };
  const once = run(1);
  const twice = run(2);
  const four = run(4);
  const hinted = run(1, true);
  let coarseError = 0;
  let fineError = 0;
  for (let cell = 0; cell < base.count; cell++) {
    coarseError += Math.abs(once[cell] - twice[cell]);
    fineError += Math.abs(twice[cell] - four[cell]);
    assert.ok(Math.abs(once[cell] - hinted[cell]) < 1e-6);
  }
  assert.ok(fineError < coarseError * 0.7, 'explicit transport converges as the timestep shrinks');
});

test('invalid coastal duration or physical forcing fails before mutation', () => {
  const { terrain, climate, transfer } = fixture(base);
  for (const duration of [-1, Infinity, NaN]) {
    assert.throws(() =>
      transportCoastalSediment(base, base, transfer, terrain, climate, config, duration),
    );
  }
  assert.throws(() =>
    transportCoastalSediment(base, base, transfer, terrain, climate, { ...config, radius: 0 }, 1),
  );
});
