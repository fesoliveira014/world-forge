import type { PageValues } from './spatial-index';

export const DUAL_FIELD_BLOCK_ROWS = 32768;
export const DUAL_FIELD_CACHE_BYTES = 8 * 1024 * 1024;

/** Small decoded blocks keep neighboring dual packets from cycling nine large
 * raw field pages through the snapshot cache. Float64 gathers preserve every
 * source number exactly; this cache never changes saved data or packet order.
 * Owned by the serialized reader-worker queue, not shared across parallel reads. */
export class DualFieldCache {
  private readonly blocks = new Map<string, Float64Array>();
  private bytes = 0;

  constructor(private readonly pages: PageValues) {}

  get retainedBytes() {
    return this.bytes;
  }

  async read(path: string, rows: readonly number[], rowCount: number, components = 1) {
    const result = new Float64Array(rows.length * components);
    const groups = new Map<number, number[]>();
    for (let output = 0; output < rows.length; output++) {
      const row = rows[output];
      if (!Number.isSafeInteger(row) || row < 0 || row >= rowCount) {
        throw new RangeError('Dual field row is outside the saved surface.');
      }
      const block = Math.floor(row / DUAL_FIELD_BLOCK_ROWS);
      const group = groups.get(block) ?? [];
      group.push(output);
      groups.set(block, group);
    }
    // Adjacent rows usually share a raw snapshot page. Finish each block before
    // moving on, keeping scratch ownership bounded even for scattered old sites.
    for (const [block, outputs] of groups) {
      const key = `${path}:${components}:${block}`;
      let values = this.blocks.get(key);
      if (values) {
        this.blocks.delete(key);
      } else {
        const first = block * DUAL_FIELD_BLOCK_ROWS;
        values = await this.pages.readRange(
          path,
          first * components,
          Math.min(DUAL_FIELD_BLOCK_ROWS, rowCount - first) * components,
        );
        this.bytes += values.byteLength;
      }
      this.blocks.set(key, values);
      while (this.bytes > DUAL_FIELD_CACHE_BYTES) {
        const oldest = this.blocks.keys().next().value!;
        this.bytes -= this.blocks.get(oldest)!.byteLength;
        this.blocks.delete(oldest);
      }
      for (const output of outputs) {
        const offset = (rows[output] % DUAL_FIELD_BLOCK_ROWS) * components;
        for (let component = 0; component < components; component++) {
          result[output * components + component] = values[offset + component];
        }
      }
    }
    return result;
  }
}
