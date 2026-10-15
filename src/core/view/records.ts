import type { World } from '../model';
import type { PageValues } from './spatial-index';

export type CellRecord = Record<string, number>;
export const RECORD_FIELDS = [
  'terrain.height',
  'terrain.ocean',
  'terrain.sediment',
  'terrain.surfaceChange',
  'terrain.fluvialIncision',
  'terrain.deltaSediment',
  'drainage.lakeDepth',
  'ecology.biome',
  'ecology.vegetation',
  'ecology.wetland',
  'ecology.wetlandFraction',
  'ecology.floodplainFraction',
  'ecology.ice',
  'ecology.riparian',
  'ecology.riparianFraction',
  'geology.plate',
  'geology.continental',
  'geology.age',
  'geology.uplift',
  'geology.crust.initialBase',
  'geology.crust.deformation',
  'geology.crust.volcanic',
  'resources.fertility',
  'water.rain',
  'water.temperature',
  'water.snow',
  'water.aridity',
  'annualCoverage',
  'delta',
  'source',
  'system',
  ...Array.from({ length: 4 }, (_, season) =>
    ['temperature', 'rain', 'coverage', 'moisture', 'sst', 'windSpeed', 'currentSpeed'].map(
      (name) => `${name}.${season}`,
    ),
  ).flat(),
] as const;
export const RECORD_STRIDE = RECORD_FIELDS.length;
export const RECORDS_PER_BLOCK = 2048;
export interface PackedRenderRecords {
  stride: number;
  rowsPerBlock: number;
  blocks: Float32Array[];
}

/** Spatial blocks each have their own buffer, so cold-view I/O reads about 0.5 MiB
 * rather than every raw physical field's multi-megabyte storage page. */
export function packRenderRecords(
  world: World,
  cells: Uint32Array,
  strongest: Int32Array,
  basin: Uint32Array,
  delta: Uint8Array,
): PackedRenderRecords {
  const blocks: Float32Array[] = [];
  const getField = (path: string): ArrayLike<number> | undefined => {
    let value: unknown = world;
    for (const key of path.split('.')) {
      value = (value as Record<string, unknown> | undefined)?.[key];
    }
    return value as ArrayLike<number> | undefined;
  };
  const columns = RECORD_FIELDS.slice(0, 27).map(getField);
  const seasonal = Array.from({ length: 4 }, (_, season) => {
    const wind = Float32Array.from({ length: world.process.count }, (_, cell) =>
      Math.hypot(...world.climate.wind[season].subarray(cell * 3, cell * 3 + 3)),
    );
    const current = Float32Array.from({ length: world.process.count }, (_, cell) =>
      Math.hypot(...world.climate.current[season].subarray(cell * 3, cell * 3 + 3)),
    );
    return [
      world.water.seasonalTemperature[season],
      world.water.seasonalRain[season],
      world.drainage.seasonalLakeCoverage?.[season] ?? world.drainage.lakeCoverage,
      world.climate.moisture[season],
      world.climate.sst[season],
      wind,
      current,
    ];
  });
  for (let start = 0; start < cells.length; start += RECORDS_PER_BLOCK) {
    const end = Math.min(cells.length, start + RECORDS_PER_BLOCK);
    const block = new Float32Array((end - start) * RECORD_STRIDE);
    for (let row = start; row < end; row++) {
      const cell = cells[row];
      const process = world.transfer[cell];
      const offset = (row - start) * RECORD_STRIDE;
      for (let field = 0; field < columns.length; field++) {
        block[offset + field] =
          columns[field]?.[field >= 15 && field <= 21 ? process : cell] ??
          (field === 19 ? world.terrain.height[cell] : 0);
      }
      block[offset + 27] = world.drainage.lakeCoverage[cell];
      block[offset + 28] = delta[cell];
      block[offset + 29] = strongest[cell] < 0 ? -1 : world.rivers.source[strongest[cell]];
      block[offset + 30] = world.rivers.system[basin[cell]] % 64;
      for (let season = 0; season < 4; season++) {
        for (let field = 0; field < 7; field++) {
          block[offset + 31 + season * 7 + field] =
            seasonal[season][field][field < 3 ? cell : process];
        }
      }
    }
    blocks.push(block);
  }
  return { stride: RECORD_STRIDE, rowsPerBlock: RECORDS_PER_BLOCK, blocks };
}
export function unpackRecord(values: Float32Array, offset: number, season: number): CellRecord {
  const record: CellRecord = {};
  for (let field = 0; field < 31; field++) {
    record[RECORD_FIELDS[field]] = values[offset + field];
  }
  for (let field = 0; field < 7; field++) {
    const name = [
      'temperature',
      'rain',
      'coverage',
      'moisture',
      'sst',
      'windSpeed',
      'currentSpeed',
    ][field];
    record[name] =
      season >= 0
        ? values[offset + 31 + season * 7 + field]
        : field === 0
          ? record['water.temperature']
          : field === 1
            ? record['water.rain']
            : field === 2
              ? record.annualCoverage
              : (values[offset + 31 + field] +
                  values[offset + 38 + field] +
                  values[offset + 45 + field] +
                  values[offset + 52 + field]) /
                4;
  }
  return record;
}
export class PagedRenderRecords {
  private cache = new Map<number, Promise<Float32Array>>();
  constructor(private pages: PageValues) {}
  async read(rows: readonly number[], heightOnly = false): Promise<Float32Array> {
    const result = new Float32Array(rows.length * (heightOnly ? 1 : RECORD_STRIDE));
    const groups = new Map<number, number[]>();
    rows.forEach((row, index) => {
      const block = Math.floor(row / RECORDS_PER_BLOCK);
      const group = groups.get(block) ?? [];
      group.push(index);
      groups.set(block, group);
    });
    // Sequential blocks bound temporary ownership even for a full-globe overview.
    for (const [block, indices] of groups) {
      let pending = this.cache.get(block);
      if (!pending) {
        pending = this.pages.readValue(`sidecars.view.records.blocks.${block}`).then((value) => {
          if (!(value instanceof Float32Array)) {
            throw Error('Invalid render record block.');
          }
          return value;
        });
        this.cache.set(block, pending);
      } else {
        this.cache.delete(block);
        this.cache.set(block, pending);
      }
      if (this.cache.size > 16) {
        this.cache.delete(this.cache.keys().next().value!);
      }
      const values = await pending;
      for (const index of indices) {
        const offset = (rows[index] % RECORDS_PER_BLOCK) * RECORD_STRIDE;
        if (heightOnly) {
          result[index] = values[offset] + values[offset + 6];
        } else {
          result.set(values.subarray(offset, offset + RECORD_STRIDE), index * RECORD_STRIDE);
        }
      }
    }
    return result;
  }
  get cachedBlocks() {
    return this.cache.size;
  }
}
