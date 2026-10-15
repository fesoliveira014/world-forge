import type { Layer } from '../model';
import { clamp } from '../math';
import type { CellRecord } from './records';
import { LinearColor } from './linear-color';
import { sampleCellColor, sampleDeltaRecord } from './colors';

/** The previous primal mesh uploaded these attributes as Float32 vertex values.
 * Blend those values on the same physical triangles before resampling a tile. */
export function recordAttributes(
  r: CellRecord,
  layer: Layer,
  season: number,
  target: Float64Array,
  color: LinearColor,
  delta: LinearColor,
  bank: LinearColor,
) {
  const biome = r['ecology.biome'];
  const ocean = r['terrain.ocean'];
  const wet = clamp(r.coverage);
  const land = ocean ? 0 : 1 - wet;
  target.fill(0);
  target[0] = r['terrain.height'] + r['drainage.lakeDepth'];
  target[1] = ocean ? 0 : 1 - clamp(r.annualCoverage);
  sampleCellColor(r, layer, season, color);
  target.set([color.r, color.g, color.b], 2);
  target.set(
    [r['terrain.height'], land, r['ecology.vegetation'], [3, 4, 8, 9].includes(biome) ? 1 : 0],
    5,
  );
  target.set(
    [
      r.temperature,
      r['water.aridity'],
      biome === 1 ? 1 : ocean || wet > 0 ? clamp((-r.temperature - 1) / 12) : 0,
      land < 1e-6 ? 0 : clamp(r['water.snow'] / 160) * clamp((3 - r.temperature) / 9),
    ],
    9,
  );
  target.set(
    [r['ecology.wetland'], r['ecology.wetlandFraction'], r['terrain.fluvialIncision']],
    13,
  );
  if (r.delta) {
    sampleDeltaRecord(r, season, delta);
    target.set([delta.r * 0.85, delta.g * 0.85, delta.b * 0.85, 0.85], 16);
  }
  target.set([ocean, wet], 20);
  const alpha = land * clamp(r['ecology.riparianFraction']) * 0.85;
  bank.set('#718853').lerp(new LinearColor('#285a3c'), clamp(r['ecology.riparian']));
  target.set([bank.r * alpha, bank.g * alpha, bank.b * alpha, alpha], 22);
  for (let component = 0; component < target.length; component++) {
    target[component] = Math.fround(target[component]);
  }
}

/** Compact display encoding shared by the fixed physical mesh's vertex fields.
 * This does not quantize the saved simulation or physical vertex heights. */
export function packPhysicalMaterialAttributes(
  values: ArrayLike<number>,
  maps: Uint8Array[],
  vertex: number,
  elevationRange: readonly [number, number],
) {
  const offset = vertex * 4;
  const byte = (value: number) => Math.round(clamp(value) * 255);
  const pair = (map: number, channel: number, value: number, low: number, high: number) => {
    const integer = Math.round(clamp((value - low) / (high - low)) * 65535);
    maps[map][offset + channel] = integer >> 8;
    maps[map][offset + channel + 1] = integer & 255;
  };
  pair(0, 0, values[5], ...elevationRange);
  maps[0][offset + 2] = byte(values[6]);
  maps[0][offset + 3] = byte(values[7]);
  maps[1][offset] = byte(values[8]);
  pair(1, 1, values[9], -128, 128);
  maps[1][offset + 3] = byte(values[10]);
  maps[2][offset] = byte(values[11]);
  maps[2][offset + 1] = byte(values[12]);
  maps[2][offset + 2] = byte(values[13] / 4);
  maps[2][offset + 3] = byte(values[14]);
  pair(3, 0, values[15], 0, 65535);
  maps[3][offset + 2] = byte(values[16]);
  maps[3][offset + 3] = byte(values[17]);
  maps[4][offset] = byte(values[18]);
  maps[4][offset + 1] = byte(values[19]);
  maps[4][offset + 2] = byte(values[20]);
  maps[4][offset + 3] = byte(values[21]);
}

/** Legacy dense sampling also carries an approximate bank tint. Fixed terrain
 * obtains its banks from the shared atlas and only needs the first five fields. */
export function packMaterialAttributes(
  values: ArrayLike<number>,
  maps: Uint8Array[],
  vertex: number,
  elevationRange: readonly [number, number],
) {
  packPhysicalMaterialAttributes(values, maps, vertex, elevationRange);
  const offset = vertex * 4;
  for (let component = 0; component < 4; component++) {
    maps[5][offset + component] = Math.round(clamp(values[22 + component]) * 255);
  }
}
