import type { Layer } from '../model';
import { LinearColor } from './linear-color';
import { DualFieldCache } from './dual-field-cache';
import { samplePlateColor } from './colors';
import { simplifyTectonicPacket } from './tectonic-simplification';
import { simplifyCategoricalPacket } from './categorical-simplification';
import { recordAttributes, packPhysicalMaterialAttributes } from './material-attributes';
import { PagedRenderRecords, RECORD_STRIDE, unpackRecord, type CellRecord } from './records';
import type { PageValues } from './spatial-index';
import { STENCIL_CELLS_PER_BLOCK, STENCIL_FACES_PER_BLOCK } from './surface-stencils';
import type { WorldSummary } from './types';
import {
  PHYSICAL_FACES_PER_BATCH,
  PHYSICAL_MATERIAL_FIELD_COUNT,
  physicalMeshMode,
  type PhysicalMeshManifest,
  type PhysicalMeshPacket,
} from './physical-mesh-types';

function checkSeason(season: number) {
  if (!Number.isInteger(season) || season < -1 || season > 3) {
    throw Error('Season must be annual (-1) or one of four quarters.');
  }
}

/** Signed normalized octahedral encoding; the renderer recovers physical slope
 * from the radial/tangent components before applying its relief multiplier. */
function octNormal(x: number, y: number, z: number, result: Int16Array, offset: number) {
  const length = Math.abs(x) + Math.abs(y) + Math.abs(z);
  x /= length;
  y /= length;
  z /= length;
  if (z < 0) {
    const previousX = x;
    x = (1 - Math.abs(y)) * (x < 0 ? -1 : 1);
    y = (1 - Math.abs(previousX)) * (y < 0 ? -1 : 1);
  }
  result[offset] = Math.round(x * 32767);
  result[offset + 1] = Math.round(y * 32767);
}

/** Fixed, camera-independent batches of the saved physical mesh. Only bounded
 * topology/record blocks are cached; no World is restored and no nearest-point
 * lookup or display-grid resampling occurs. */
export class PhysicalMeshReader {
  private readonly records: PagedRenderRecords;
  private readonly dualFields: DualFieldCache;
  private readonly faces = new Map<number, Uint32Array>();
  private readonly positions = new Map<number, Float64Array>();
  private inverseRows: Uint32Array | null = null;
  constructor(
    private readonly pages: PageValues,
    private readonly summary: WorldSummary,
  ) {
    this.records = new PagedRenderRecords(pages);
    this.dualFields = new DualFieldCache(pages);
  }

  async manifest(layer: Layer, season: number): Promise<PhysicalMeshManifest> {
    checkSeason(season);
    const count = this.summary.surfaceCells;
    const faces = count * 2 - 4;
    const mode = physicalMeshMode(layer);
    return {
      format: 'atlas-physical-mesh/v1',
      layer,
      season,
      mode,
      batches: Math.ceil(faces / PHYSICAL_FACES_PER_BATCH),
      triangles: faces * (mode === 'dual' ? 3 : 1),
      ...(mode === 'dual' ? { simplified: true } : {}),
      physicalVertices: count,
      elevationRange: [
        Math.min(-12000, this.summary.minimumHeight),
        Math.max(9000, this.summary.maximumHeight),
      ],
      // Flat provoking-vertex colors let adjacent cells share dual corners.
      // Local batch borders add duplicates in either mode.
      estimatedBytes:
        mode === 'dual'
          ? (count * 3 - 4) * 20 + (count * 18 - 36) * 2
          : count * (20 + (layer === 'world' ? PHYSICAL_MATERIAL_FIELD_COUNT * 4 : 4)) + faces * 6,
    };
  }

  async batch(layer: Layer, season: number, batch: number): Promise<PhysicalMeshPacket> {
    const manifest = await this.manifest(layer, season);
    if (!Number.isSafeInteger(batch) || batch < 0 || batch >= manifest.batches) {
      throw Error('Physical mesh batch is outside the saved surface.');
    }
    const first = batch * PHYSICAL_FACES_PER_BATCH;
    const count = Math.min(PHYSICAL_FACES_PER_BATCH, this.summary.surfaceCells * 2 - 4 - first);
    return manifest.mode === 'dual'
      ? this.dualBatch(layer, season, batch, first, count)
      : this.primalBatch(layer, season, batch, first, count, manifest.elevationRange);
  }

  private async face(id: number): Promise<Uint32Array> {
    const block = Math.floor(id / STENCIL_FACES_PER_BLOCK);
    let values = this.faces.get(block);
    if (!values) {
      const loaded = await this.pages.readValue(`sidecars.view.stencils.faces.${block}`);
      if (!(loaded instanceof Uint32Array)) {
        throw Error('Invalid physical face block.');
      }
      values = loaded;
    } else {
      this.faces.delete(block);
    }
    this.faces.set(block, values);
    if (this.faces.size > 16) {
      this.faces.delete(this.faces.keys().next().value!);
    }
    const offset = (id % STENCIL_FACES_PER_BLOCK) * 6;
    return values.subarray(offset, offset + 6);
  }

  private async vertexPositions(rows: number[]): Promise<Float64Array> {
    const result = new Float64Array(rows.length * 3);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const block = Math.floor(row / STENCIL_CELLS_PER_BLOCK);
      let values = this.positions.get(block);
      if (!values) {
        const start = block * STENCIL_CELLS_PER_BLOCK;
        values = await this.pages.readRange(
          'sidecars.view.index.positions',
          start * 3,
          Math.min(STENCIL_CELLS_PER_BLOCK, this.summary.surfaceCells - start) * 3,
        );
      } else {
        this.positions.delete(block);
      }
      this.positions.set(block, values);
      if (this.positions.size > 32) {
        this.positions.delete(this.positions.keys().next().value!);
      }
      const offset = (row % STENCIL_CELLS_PER_BLOCK) * 3;
      result.set(values.subarray(offset, offset + 3), i * 3);
    }
    return result;
  }

  private async primalBatch(
    layer: Layer,
    season: number,
    batch: number,
    first: number,
    count: number,
    elevationRange: [number, number],
  ): Promise<PhysicalMeshPacket> {
    const topology = new Map<number, Uint32Array>();
    const wanted = new Set<number>();
    for (let face = first; face < first + count; face++) {
      const vertices = await this.face(face);
      topology.set(face, vertices);
      for (let slot = 0; slot < 3; slot++) {
        wanted.add(vertices[slot]);
      }
    }
    // Complete every output vertex's incident ring. A face on the other side of
    // a batch border contributes the same normal as it does in its own batch.
    const pending = [...topology.keys()];
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const face = topology.get(pending[cursor])!;
      for (let slot = 0; slot < 3; slot++) {
        if (!wanted.has(face[slot]) && !wanted.has(face[(slot + 1) % 3])) {
          continue;
        }
        const neighbor = face[slot + 3];
        if (!topology.has(neighbor)) {
          topology.set(neighbor, await this.face(neighbor));
          pending.push(neighbor);
        }
      }
    }
    const all = new Set<number>();
    for (const face of topology.values()) {
      for (let slot = 0; slot < 3; slot++) {
        all.add(face[slot]);
      }
    }
    const rows = [...all].sort((a, b) => a - b);
    const rowIndices = new Map(rows.map((row, i) => [row, i]));
    const points = await this.vertexPositions(rows);
    const heights = await this.records.read(rows, true);
    const targets = [...wanted].sort((a, b) => a - b);
    const local = new Map(targets.map((row, i) => [row, i]));
    const directions = new Float32Array(targets.length * 3);
    const vertexHeights = new Float32Array(targets.length);
    const normalSums = new Float64Array(targets.length * 3);
    const baseNormalSums = new Float64Array(targets.length * 3);
    const normals = new Int16Array(targets.length * 2);
    const indices = new Uint16Array(count * 3);
    for (let i = 0; i < targets.length; i++) {
      const row = rowIndices.get(targets[i])!;
      directions.set(points.subarray(row * 3, row * 3 + 3), i * 3);
      vertexHeights[i] = heights[row];
    }
    const radius = this.summary.config.radius;
    // Canonical order makes duplicated vertices' sums byte-identical between batches.
    for (const faceId of [...topology.keys()].sort((a, b) => a - b)) {
      const face = topology.get(faceId)!;
      const a = rowIndices.get(face[0])!;
      const b = rowIndices.get(face[1])!;
      const c = rowIndices.get(face[2])!;
      const ar = 1 + Math.max(0, heights[a]) / radius;
      const br = 1 + Math.max(0, heights[b]) / radius;
      const cr = 1 + Math.max(0, heights[c]) / radius;
      const ax = points[a * 3] * ar;
      const ay = points[a * 3 + 1] * ar;
      const az = points[a * 3 + 2] * ar;
      const bx = points[b * 3] * br - ax;
      const by = points[b * 3 + 1] * br - ay;
      const bz = points[b * 3 + 2] * br - az;
      const cx = points[c * 3] * cr - ax;
      const cy = points[c * 3 + 1] * cr - ay;
      const cz = points[c * 3 + 2] * cr - az;
      let nx = by * cz - bz * cy;
      let ny = bz * cx - bx * cz;
      let nz = bx * cy - by * cx;
      if (nx * ax + ny * ay + nz * az < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      const ubx = points[b * 3] - points[a * 3];
      const uby = points[b * 3 + 1] - points[a * 3 + 1];
      const ubz = points[b * 3 + 2] - points[a * 3 + 2];
      const ucx = points[c * 3] - points[a * 3];
      const ucy = points[c * 3 + 1] - points[a * 3 + 1];
      const ucz = points[c * 3 + 2] - points[a * 3 + 2];
      let unx = uby * ucz - ubz * ucy;
      let uny = ubz * ucx - ubx * ucz;
      let unz = ubx * ucy - uby * ucx;
      if (unx * ax + uny * ay + unz * az < 0) {
        unx = -unx;
        uny = -uny;
        unz = -unz;
      }
      for (let slot = 0; slot < 3; slot++) {
        const vertex = local.get(face[slot]);
        if (vertex !== undefined) {
          normalSums[vertex * 3] += nx;
          normalSums[vertex * 3 + 1] += ny;
          normalSums[vertex * 3 + 2] += nz;
          baseNormalSums[vertex * 3] += unx;
          baseNormalSums[vertex * 3 + 1] += uny;
          baseNormalSums[vertex * 3 + 2] += unz;
        }
        if (faceId >= first && faceId < first + count) {
          indices[(faceId - first) * 3 + slot] = vertex!;
        }
      }
    }
    for (let i = 0; i < targets.length; i++) {
      const offset = i * 3;
      const row = rowIndices.get(targets[i])! * 3;
      const dx = points[row];
      const dy = points[row + 1];
      const dz = points[row + 2];
      const raisedDot =
        dx * normalSums[offset] + dy * normalSums[offset + 1] + dz * normalSums[offset + 2];
      const baseDot =
        dx * baseNormalSums[offset] +
        dy * baseNormalSums[offset + 1] +
        dz * baseNormalSums[offset + 2];
      // Remove the triangulated sphere's tangent-normal bias. Otherwise the
      // renderer's relief multiplier exaggerates mesh irregularity as terrain,
      // even when every physical height is identical.
      if (raisedDot > 0 && baseDot > 0) {
        octNormal(
          dx + normalSums[offset] / raisedDot - baseNormalSums[offset] / baseDot,
          dy + normalSums[offset + 1] / raisedDot - baseNormalSums[offset + 1] / baseDot,
          dz + normalSums[offset + 2] / raisedDot - baseNormalSums[offset + 2] / baseDot,
          normals,
          i * 2,
        );
      } else {
        octNormal(dx, dy, dz, normals, i * 2);
      }
    }
    const colors = new Uint8Array(layer === 'world' ? 0 : targets.length * 4);
    const materials =
      layer === 'world'
        ? Array.from(
            { length: PHYSICAL_MATERIAL_FIELD_COUNT },
            () => new Uint8Array(targets.length * 4),
          )
        : [];
    await this.attributes(targets, layer, season, colors, materials, elevationRange);
    return this.packet(
      batch,
      'primal',
      directions,
      vertexHeights,
      normals,
      colors,
      materials,
      indices,
    );
  }

  private async attributes(
    rows: number[],
    layer: Layer,
    season: number,
    colors: Uint8Array,
    materials: Uint8Array[],
    range: [number, number],
    vertexHeights?: Float32Array,
    visitRecord?: (vertex: number, record: CellRecord) => void,
  ) {
    const attribute = new Float64Array(26);
    const color = new LinearColor();
    const delta = new LinearColor();
    const bank = new LinearColor();
    for (let start = 0; start < rows.length; start += 4096) {
      const subset = rows.slice(start, start + 4096);
      const records = await this.records.read(subset);
      for (let i = 0; i < subset.length; i++) {
        if (vertexHeights) {
          // Both source fields are Float32 and are packed without conversion.
          // Their final Float32 sum matches the original raw dual-cell gather.
          vertexHeights[start + i] = records[i * RECORD_STRIDE] + records[i * RECORD_STRIDE + 6];
        }
        const record = unpackRecord(records, i * RECORD_STRIDE, season);
        visitRecord?.(start + i, record);
        recordAttributes(record, layer, season, attribute, color, delta, bank);
        if (materials.length) {
          packPhysicalMaterialAttributes(attribute, materials, start + i, range);
        } else {
          for (let axis = 0; axis < 3; axis++) {
            colors[(start + i) * 4 + axis] = Math.round(
              Math.max(0, Math.min(1, attribute[axis + 2])) * 255,
            );
          }
          colors[(start + i) * 4 + 3] = 255;
        }
      }
    }
  }

  private packet(
    batch: number,
    mode: 'primal' | 'dual',
    directions: Float32Array,
    heights: Float32Array,
    normals: Int16Array,
    colors: Uint8Array,
    materials: Uint8Array[],
    indices: Uint16Array,
  ): PhysicalMeshPacket {
    return {
      batch,
      mode,
      directions,
      heights,
      normals,
      colors,
      materials,
      indices,
      bytes: [directions, heights, normals, colors, ...materials, indices].reduce(
        (sum, data) => sum + data.byteLength,
        0,
      ),
    };
  }

  private async dualBatch(
    layer: Layer,
    season: number,
    batch: number,
    first: number,
    count: number,
  ): Promise<PhysicalMeshPacket> {
    const faceCount = this.summary.surfaceCells * 2 - 4;
    const faces = Array.from({ length: count }, (_, index) => first + index);
    const triangles = await this.dualFields.read('world.grid.triangles', faces, faceCount, 3);
    const neighbors = await this.dualFields.read('world.grid.cornerNeighbors', faces, faceCount, 3);
    const cells = [...new Set(triangles)].sort((a, b) => a - b);
    const corners = [
      ...new Set([...Array.from({ length: count }, (_, i) => first + i), ...neighbors]),
    ].sort((a, b) => a - b);
    const cellIndex = new Map(cells.map((cell, i) => [cell, i]));
    const cornerIndex = new Map(corners.map((corner, i) => [corner, cells.length + i]));
    if (layer === 'tectonics') {
      // Plate regions have no elevation or seasonal appearance. Avoid decoding
      // terrain, climate, lake and spatial-record fields for this diagnostic.
      const cellPositions = await this.dualFields.read(
        'world.grid.positions',
        cells,
        this.summary.surfaceCells,
        3,
      );
      const cornerPositions = await this.dualFields.read(
        'world.grid.corners',
        corners,
        faceCount,
        3,
      );
      const processCells = await this.dualFields.read(
        'world.transfer',
        cells,
        this.summary.surfaceCells,
      );
      const plates = await this.dualFields.read(
        'world.geology.plate',
        Array.from(processCells),
        this.summary.processCells,
      );
      const vertices = cells.length + corners.length;
      if (vertices > 65535) {
        throw Error('Physical category batch exceeds Uint16 vertex capacity.');
      }
      const directions = new Float32Array(vertices * 3);
      directions.set(cellPositions);
      directions.set(cornerPositions, cells.length * 3);
      const colors = new Uint8Array(vertices * 4);
      const color = new LinearColor();
      for (let cell = 0; cell < cells.length; cell++) {
        samplePlateColor(plates[cell], color);
        colors.set(
          [color.r, color.g, color.b]
            .map((value) => Math.round(Math.fround(value) * 255))
            .concat(255),
          cell * 4,
        );
      }
      const indices = dualIndices(
        first,
        count,
        triangles,
        neighbors,
        cellIndex,
        cornerIndex,
        directions,
      );
      const triangleRegions = Uint32Array.from(
        { length: indices.length / 3 },
        (_, triangle) => plates[indices[triangle * 3 + 2]],
      );
      return simplifyTectonicPacket(
        this.packet(
          batch,
          'dual',
          directions,
          new Float32Array(vertices),
          new Int16Array(0),
          colors,
          [],
          indices,
        ),
        { triangleRegions },
      );
    }
    if (!this.inverseRows) {
      const inverse = new Uint32Array(this.summary.surfaceCells);
      for (let start = 0; start < inverse.length; start += 32768) {
        const ids = await this.pages.readRange(
          'sidecars.view.index.cells',
          start,
          Math.min(32768, inverse.length - start),
        );
        ids.forEach((cell, offset) => {
          inverse[cell] = start + offset;
        });
      }
      this.inverseRows = inverse;
    }
    const cellRows = cells.map((cell) => this.inverseRows![cell]);
    const cellPositions = await this.vertexPositions(cellRows);
    const cornerPositions = await this.dualFields.read('world.grid.corners', corners, faceCount, 3);
    const cornerHeights = await this.dualFields.read('world.drainage.height', corners, faceCount);
    const lakeIds = await this.dualFields.read('world.drainage.lakeId', corners, faceCount);
    const fractions = await this.dualFields.read('world.drainage.lakeFraction', corners, faceCount);
    const levels = new Map<number, number>();
    for (let i = 0; i < corners.length; i++) {
      const lake = lakeIds[i];
      if (lake >= 0 && fractions[i] > 0) {
        if (!levels.has(lake)) {
          levels.set(
            lake,
            Number(await this.pages.readValue(`world.drainage.lakes.${lake}.level`)),
          );
        }
        cornerHeights[i] = Math.max(cornerHeights[i], levels.get(lake)!);
      }
    }
    const vertices = cells.length + corners.length;
    if (vertices > 65535) {
      throw Error('Physical category batch exceeds Uint16 vertex capacity.');
    }
    const directions = new Float32Array(vertices * 3);
    directions.set(cellPositions);
    directions.set(cornerPositions, cells.length * 3);
    const heights = new Float32Array(vertices);
    heights.set(cornerHeights, cells.length);
    // Shared corners require flat category colors. Every fan's final/provoking
    // vertex is its owning cell center; corners never interpolate neighboring classes.
    const colors = new Uint8Array(vertices * 4);
    const semantic = new Int32Array(cells.length);
    const water = new Uint8Array(cells.length);
    const protectedVertices = new Uint8Array(vertices);
    const lakeCells: number[] = [];
    const basinCells: number[] = [];
    await this.attributes(cellRows, layer, season, colors, [], [0, 1], heights, (cell, record) => {
      const annual = record.annualCoverage;
      const seasonal = record.coverage;
      const partial = (annual > 0 && annual < 1 - 1e-6) || (seasonal > 0 && seasonal < 1 - 1e-6);
      water[cell] = record['terrain.ocean']
        ? 1
        : partial
          ? 3
          : Math.max(annual, seasonal) > 0
            ? 2
            : 0;
      // Preserve the complete original fan around blended shore and delta cells.
      protectedVertices[cell] = Number(partial || record.delta > 0);
      if (water[cell] >= 2) {
        lakeCells.push(cell);
      } else if (water[cell] === 0) {
        if (layer === 'drainage') {
          basinCells.push(cell);
        } else {
          semantic[cell] =
            layer === 'sources'
              ? record.source
              : layer === 'biomes'
                ? record['ecology.biome'] * 16 + record['ecology.wetland']
                : record['ecology.wetland'];
        }
      }
    });
    if (basinCells.length) {
      // Packed colors store system %64. Preserve full basin identity even where
      // adjacent basins happen to reuse the same visible palette entry.
      const basin = await this.dualFields.read(
        'sidecars.view.basin',
        basinCells.map((cell) => cells[cell]),
        this.summary.surfaceCells,
      );
      const systems = await this.dualFields.read(
        'world.rivers.system',
        Array.from(basin),
        faceCount,
      );
      for (let i = 0; i < basinCells.length; i++) {
        semantic[basinCells[i]] = systems[i];
      }
    }
    if (lakeCells.length) {
      const lakes = await this.dualFields.read(
        'sidecars.view.lake',
        lakeCells.map((cell) => cells[cell]),
        this.summary.surfaceCells,
      );
      for (let i = 0; i < lakeCells.length; i++) {
        semantic[lakeCells[i]] = lakes[i];
      }
    }
    for (let corner = 0; corner < corners.length; corner++) {
      if (fractions[corner] > 0 && fractions[corner] < 1 - 1e-6) {
        protectedVertices[cells.length + corner] = 1;
      }
    }
    const indices = dualIndices(
      first,
      count,
      triangles,
      neighbors,
      cellIndex,
      cornerIndex,
      directions,
    );
    const groups = new Map<string, number>();
    const cellGroups = new Uint32Array(cells.length);
    for (let cell = 0; cell < cells.length; cell++) {
      const key = `${water[cell]}:${semantic[cell]}`;
      if (!groups.has(key)) {
        groups.set(key, groups.size);
      }
      cellGroups[cell] = groups.get(key)!;
    }
    const triangleRegions = new Uint32Array(indices.length / 3);
    for (let face = 0; face < triangleRegions.length; face++) {
      const owner = indices[face * 3 + 2];
      triangleRegions[face] = cellGroups[owner];
      if (protectedVertices[owner]) {
        protectedVertices[indices[face * 3]] = 1;
        protectedVertices[indices[face * 3 + 1]] = 1;
      }
    }
    return simplifyCategoricalPacket(
      this.packet(batch, 'dual', directions, heights, new Int16Array(0), colors, [], indices),
      { triangleRegions, protectedVertices },
    );
  }
}

function dualIndices(
  first: number,
  count: number,
  triangles: ArrayLike<number>,
  neighbors: ArrayLike<number>,
  cellIndex: Map<number, number>,
  cornerIndex: Map<number, number>,
  directions: Float32Array,
) {
  const indices = new Uint16Array(count * 9);
  for (let face = 0; face < count; face++) {
    const a = cornerIndex.get(first + face)!;
    for (let slot = 0; slot < 3; slot++) {
      const b = cornerIndex.get(neighbors[face * 3 + slot])!;
      const center = cellIndex.get(triangles[face * 3 + slot])!;
      // Keep consistent outward winding without changing the provoking center.
      const ax = directions[a * 3];
      const ay = directions[a * 3 + 1];
      const az = directions[a * 3 + 2];
      const bx = directions[b * 3];
      const by = directions[b * 3 + 1];
      const bz = directions[b * 3 + 2];
      const cx = directions[center * 3];
      const cy = directions[center * 3 + 1];
      const cz = directions[center * 3 + 2];
      const positive =
        (ay * bz - az * by) * cx + (az * bx - ax * bz) * cy + (ax * by - ay * bx) * cz >= 0;
      indices.set([positive ? a : b, positive ? b : a, center], (face * 3 + slot) * 3);
    }
  }
  return indices;
}
