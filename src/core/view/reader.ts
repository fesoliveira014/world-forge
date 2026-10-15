import type { Deposit, Lake, Layer, ResourceType } from '../model';
import type { Vec3 } from '../math';
import type { SnapshotReader } from '../storage';
import { MissingSnapshotFieldError } from '../storage';
import { classifyLakeSize } from '../generation/lake-surfaces';
import { soilSalinityLimit } from '../generation/lake-state';
import { clamp } from '../math';
import { createFertilityEvaluation } from '../generation/fertility';
import { FERTILITY_FIELDS, FERTILITY_LIMITATIONS } from './prepare';
import { PagedSpatialIndex, type PageValues } from './spatial-index';
import { PagedRenderRecords, RECORD_STRIDE, unpackRecord } from './records';
import { LinearColor } from './linear-color';
import { PagedSurfaceStencils } from './surface-stencils';
import { PagedHeightSampler } from './height-sampler';
import { recordAttributes } from './material-attributes';
import { readOverlays } from './overlays';
import { PhysicalMeshReader } from './physical-mesh';
import { FixedGridReader } from './fixed-grid';
import { RiverRenderReader } from './river-render';
import type { FixedRiverRequest } from './river-render-types';
import type {
  CellInspection,
  CellSampleBatch,
  DepositInspection,
  DepositPage,
  OverlayRequest,
  WorldHandle,
  WorldSummary,
  WorldViewSource,
} from './types';

function checkSeason(season: number) {
  if (!Number.isInteger(season) || season < -1 || season > 3) {
    throw Error('Season must be annual (-1) or one of four quarters.');
  }
}

export class WorldViewReader implements WorldViewSource {
  readonly index: PagedSpatialIndex;
  private records: PagedRenderRecords;
  private stencils: PagedSurfaceStencils;
  private heightSampler: PagedHeightSampler;
  private physicalMesh: PhysicalMeshReader | null = null;
  private fixedGrid: FixedGridReader | null = null;
  private riverRenderer: RiverRenderReader | null = null;
  readonly handle: WorldHandle;
  private constructor(
    readonly pages: PageValues,
    summary: WorldSummary,
    snapshotId: string,
    private salinityFields: { soil?: boolean; river?: boolean },
  ) {
    this.handle = { snapshotId, version: summary.version, config: summary.config, summary };
    this.index = new PagedSpatialIndex(pages);
    this.records = new PagedRenderRecords(pages);
    this.stencils = new PagedSurfaceStencils(pages, summary.surfaceCells);
    this.heightSampler = new PagedHeightSampler(pages, this.index, summary.surfaceCells, {
      stencils: this.stencils,
      records: this.records,
    });
  }
  static async open(pages: SnapshotReader | (PageValues & { descriptor?: { id: string } })) {
    if ((await pages.readValue('sidecars.view.format')) !== 'atlas-view/v2') {
      throw Error('This snapshot has no compatible paged-view index.');
    }
    const summary = (await pages.readValue('sidecars.view.summary')) as WorldSummary;
    if (!summary || !Number.isSafeInteger(summary.surfaceCells) || summary.surfaceCells <= 0) {
      throw Error('Invalid world summary.');
    }
    let salinityFields: { soil?: boolean; river?: boolean } = {};
    try {
      salinityFields =
        ((await pages.readValue('sidecars.view.salinityFields')) as typeof salinityFields) ?? {};
    } catch (error) {
      if (!(error instanceof MissingSnapshotFieldError)) {
        throw error;
      }
    }
    return new WorldViewReader(pages, summary, pages.descriptor?.id ?? 'memory', salinityFields);
  }
  async diagnostics() {
    return this.handle.summary;
  }
  gridManifest() {
    this.fixedGrid ??= new FixedGridReader(this.pages, this.handle.summary);
    return this.fixedGrid.manifest();
  }
  gridBatch(batch: number) {
    this.fixedGrid ??= new FixedGridReader(this.pages, this.handle.summary);
    return this.fixedGrid.batch(batch);
  }
  physicalManifest(layer: Layer, season: number) {
    checkSeason(season);
    this.physicalMesh ??= new PhysicalMeshReader(this.pages, this.handle.summary);
    return this.physicalMesh.manifest(layer, season);
  }
  physicalBatch(layer: Layer, season: number, batch: number) {
    checkSeason(season);
    this.physicalMesh ??= new PhysicalMeshReader(this.pages, this.handle.summary);
    return this.physicalMesh.batch(layer, season, batch);
  }
  riverRender(request: FixedRiverRequest) {
    checkSeason(request.season);
    this.riverRenderer ??= new RiverRenderReader(this.pages, this.handle.summary);
    return this.riverRenderer.read(request);
  }
  async sample(directions: Float32Array, layer: Layer, season: number): Promise<CellSampleBatch> {
    checkSeason(season);
    const count = directions.length / 3;
    if (!Number.isInteger(count) || count > 20000) {
      throw Error('A sample request supports at most 20,000 unit directions.');
    }
    const locations: { cell: number; row: number }[] = [];
    // Sequential lookups share leaf pages and bound traversal promises for broad views.
    for (let i = 0; i < count; i++) {
      locations.push(
        await this.index.locate([directions[i * 3], directions[i * 3 + 1], directions[i * 3 + 2]]),
      );
    }
    const stencilRows: number[] = [];
    const stencilWeights = new Float64Array(count * 3);
    for (let cell = 0; cell < count; cell++) {
      const stencil = await this.stencils.locate(
        [directions[cell * 3], directions[cell * 3 + 1], directions[cell * 3 + 2]],
        locations[cell].row,
      );
      stencilRows.push(...stencil.rows);
      stencilWeights.set(stencil.weights, cell * 3);
    }
    // Natural materials interpolate the original vertex attributes, not their
    // nearest-site labels. Categorical diagnostic colors retain exact ownership.
    const natural = layer === 'world';
    const vertices = natural ? null : await this.records.read(stencilRows, true);
    const values = natural
      ? null
      : await this.records.read(locations.map((location) => location.row));
    const result: CellSampleBatch = {
      cellIds: Uint32Array.from(locations, (location) => location.cell),
      heights: new Float32Array(count),
      colors: new Float32Array(count * 3),
      bankLand: new Float32Array(count),
      surfaceTerrain: new Float32Array(count * 4),
      surfaceClimate: new Float32Array(count * 4),
      surfaceHabitat: new Float32Array(count * 3),
      surfaceDelta: new Float32Array(count * 4),
      surfaceWater: new Float32Array(count * 2),
      surfaceBank: new Float32Array(count * 4),
    };
    const color = new LinearColor();
    const delta = new LinearColor();
    const bank = new LinearColor();
    const attribute = new Float64Array(26);
    const blended = new Float64Array(26);
    const vertexIndices = new Uint32Array(natural ? stencilRows.length : 0);
    let vertexAttributes: Float32Array | null = null;
    if (natural) {
      // Dense texture queries often share the same physical triangle many times.
      // Derive each original Float32 vertex value once, then preserve the exact
      // three-vertex accumulation order for every query below. This table belongs
      // only to this request, so season/layer changes cannot leave stale fields.
      const uniqueRows: number[] = [];
      const rowIndex = new Map<number, number>();
      for (let vertex = 0; vertex < stencilRows.length; vertex++) {
        const row = stencilRows[vertex];
        let index = rowIndex.get(row);
        if (index === undefined) {
          index = uniqueRows.length;
          uniqueRows.push(row);
          rowIndex.set(row, index);
        }
        vertexIndices[vertex] = index;
      }
      vertexAttributes = new Float32Array(uniqueRows.length * attribute.length);
      // Spatial row order keeps adjacent chunks on adjacent saved blocks instead
      // of repeatedly evicting/reloading blocks along a broad raster scan.
      uniqueRows.sort((first, second) => first - second);
      // At the 20,000-query limit, the table is at most 60,000 * 26 floats.
      // Gather only 4,096 raw records at once, avoiding a second full-size copy.
      const chunkSize = 4096;
      for (let start = 0; start < uniqueRows.length; start += chunkSize) {
        const rows = uniqueRows.slice(start, start + chunkSize);
        const records = await this.records.read(rows);
        for (let row = 0; row < rows.length; row++) {
          const record = unpackRecord(records, row * RECORD_STRIDE, season);
          recordAttributes(record, layer, season, attribute, color, delta, bank);
          vertexAttributes.set(attribute, rowIndex.get(rows[row])! * attribute.length);
        }
      }
    }
    for (let cell = 0; cell < count; cell++) {
      if (natural) {
        blended.fill(0);
        for (let vertex = 0; vertex < 3; vertex++) {
          const offset = vertexIndices[cell * 3 + vertex] * attribute.length;
          const weight = stencilWeights[cell * 3 + vertex];
          for (let component = 0; component < blended.length; component++) {
            blended[component] += vertexAttributes![offset + component] * weight;
          }
        }
      } else {
        const record = unpackRecord(values!, cell * RECORD_STRIDE, season);
        recordAttributes(record, layer, season, blended, color, delta, bank);
        blended[0] =
          vertices![cell * 3] * stencilWeights[cell * 3] +
          vertices![cell * 3 + 1] * stencilWeights[cell * 3 + 1] +
          vertices![cell * 3 + 2] * stencilWeights[cell * 3 + 2];
      }
      result.heights[cell] = blended[0];
      result.bankLand[cell] = blended[1];
      result.colors.set(blended.subarray(2, 5), cell * 3);
      result.surfaceTerrain.set(blended.subarray(5, 9), cell * 4);
      result.surfaceClimate.set(blended.subarray(9, 13), cell * 4);
      result.surfaceHabitat.set(blended.subarray(13, 16), cell * 3);
      result.surfaceDelta.set(blended.subarray(16, 20), cell * 4);
      result.surfaceWater.set(blended.subarray(20, 22), cell * 2);
      result.surfaceBank.set(blended.subarray(22, 26), cell * 4);
    }
    return result;
  }
  private async scalar(path: string, index: number) {
    return (await this.pages.readValues(path, [index]))[0];
  }
  private async find(path: string, count: number, value: number) {
    let low = 0;
    let high = count;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if ((await this.scalar(path, mid)) < value) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low < count && (await this.scalar(path, low)) === value ? low : -1;
  }
  async inspect(direction: Vec3, season: number): Promise<CellInspection> {
    checkSeason(season);
    const { cell, row } = await this.index.locate(direction);
    const records = await this.records.read([row]);
    const record = unpackRecord(records, 0, season);
    const point = await this.pages.readRange('world.grid.positions', cell * 3, 3);
    const position = Array.from(point) as Vec3;
    const offsets = await this.pages.readValues('world.grid.offsets', [cell, cell + 1]);
    const corners = await this.pages.readRange(
      'world.grid.cellCorners',
      offsets[0],
      offsets[1] - offsets[0],
    );
    const edges = await this.pages.readRange(
      'world.grid.arcEdges',
      offsets[0],
      offsets[1] - offsets[0],
    );
    const outline = Float32Array.from(
      await this.pages.readValues(
        'world.grid.corners',
        Array.from(corners).flatMap((corner) => [corner * 3, corner * 3 + 1, corner * 3 + 2]),
      ),
    );
    const distances = await this.pages.readValues('world.grid.edgeDistance', Array.from(edges));
    const fields = [
      'terrain.bedrock',
      'water.pet',
      'water.aet',
      'ecology.riverHabitat',
      'ecology.riparian',
      'ecology.riparianFraction',
    ];
    const scalars = await Promise.all(fields.map((path) => this.scalar('world.' + path, cell)));
    const process = await this.scalar('world.transfer', cell);
    const [strongest, lakeId] = await Promise.all([
      this.scalar('sidecars.view.strongest', cell),
      this.scalar('sidecars.view.lake', cell),
    ]);
    const lake =
      lakeId < 0 ? null : ((await this.pages.readValue(`world.drainage.lakes.${lakeId}`)) as Lake);
    let river: CellInspection['river'] = null;
    let delta: CellInspection['delta'] = null;
    let seasonalFlood: number | null = null;
    if (strongest >= 0) {
      const names = [
        'discharge',
        'catchmentArea',
        'system',
        'streamOrder',
        'source',
        'regime',
        'supportFlow',
      ];
      const values = await Promise.all(
        names.map((name) =>
          this.scalar(`world.${name === 'discharge' ? 'drainage' : 'rivers'}.${name}`, strongest),
        ),
      );
      const flows = await Promise.all(
        [0, 1, 2, 3].map((s) => this.scalar(`world.rivers.seasonalDischarge.${s}`, strongest)),
      );
      const fractions = await Promise.all(
        [0, 1, 2, 3].map((s) => this.scalar(`world.rivers.sourceFractions.${s}`, strongest)),
      );
      const channel = await this.pages.readValues('world.rivers.channel', Array.from(corners));
      const catchments = await this.pages.readValues(
        'world.rivers.catchmentArea',
        Array.from(corners),
      );
      values[1] = Math.max(
        ...Array.from(catchments, (value, index) => (channel[index] ? value : 0)),
      );
      const courseCount = (await this.pages.readValue('sidecars.view.courseCount')) as number;
      const course = await this.find('world.rivers.courses.corner', courseCount, strongest);
      const reachCount = (await this.pages.readValue('sidecars.view.reachCount')) as number;
      const reach = await this.find('world.ecology.floodplains.corner', reachCount, strongest);
      if (reach >= 0) {
        const floods = await Promise.all(
          (season < 0 ? [0, 1, 2, 3] : [season]).map((s) =>
            this.pages.readValues(`world.ecology.floodplains.seasonalFlood.${s}`, [
              reach * 2,
              reach * 2 + 1,
            ]),
          ),
        );
        seasonalFlood = Math.max(...floods.flatMap((field) => Array.from(field)));
      }
      const lakeTerminal = values[2] - (this.handle.summary.surfaceCells * 2 - 4);
      let destination = 'Ocean';
      if (lakeTerminal >= 0) {
        const terminal = (await this.pages.readValue(
          `world.drainage.lakes.${lakeTerminal}`,
        )) as Lake;
        destination = `${classifyLakeSize(terminal.area)} ${lakeTerminal + 1}`;
      }
      river = {
        corner: strongest,
        discharge: values[0],
        catchmentArea: values[1],
        system: values[2],
        streamOrder: values[3],
        source: values[4],
        regime: values[5],
        supportFlow: values[6],
        salinity: this.salinityFields.river
          ? await this.scalar('world.drainage.riverSalinity', strongest)
          : null,
        seasonalDischarge: flows,
        sourceFractions: fractions,
        sinuosity: course < 0 ? null : await this.scalar('world.rivers.courses.sinuosity', course),
        destination,
      };
      const mouth = await this.find(
        'sidecars.view.deltaLookup.keys',
        this.handle.summary.deltaCount,
        strongest,
      );
      if (mouth >= 0) {
        const id = await this.scalar('sidecars.view.deltaLookup.ids', mouth);
        const value = (await this.pages.readValue(`world.rivers.deltas.${id}`)) as {
          lake: number;
          branches: { fraction: number }[];
        };
        delta = { lake: value.lake, fractions: value.branches.map((branch) => branch.fraction) };
      }
    }
    let oxbow: CellInspection['oxbow'] = null;
    const pond = await this.find(
      'sidecars.view.pondLookup.keys',
      this.handle.summary.oxbowCount,
      cell,
    );
    if (pond >= 0) {
      const id = await this.scalar('sidecars.view.pondLookup.ids', pond);
      const value = (await this.pages.readValue(`world.terrain.oxbows.${id}`)) as {
        area: number;
        width: number;
        capacity: number;
      };
      const depths = await Promise.all(
        [0, 1, 2, 3].map((s) => this.scalar(`world.water.oxbowDepth.${s}`, id)),
      );
      oxbow = {
        area: value.area,
        width: value.width,
        capacity: value.capacity,
        seasonalDepth: depths,
        depth: season < 0 ? depths.reduce((a, b) => a + b, 0) / 4 : depths[season],
      };
    }
    const fertility = createFertilityEvaluation();
    const fertilityValues = await this.pages.readRange(
      'sidecars.view.fertility',
      cell * FERTILITY_FIELDS.length,
      FERTILITY_FIELDS.length,
    );
    FERTILITY_FIELDS.forEach((key, index) => {
      fertility[key] = fertilityValues[index];
    });
    const flags = await this.scalar('sidecars.view.fertilityFlags', cell);
    fertility.limitations = FERTILITY_LIMITATIONS.filter((_, index) => flags & (1 << index));
    fertility.score = record['resources.fertility'];
    const soilSalinity = this.salinityFields.soil
      ? await this.scalar('world.drainage.soilSalinity', cell)
      : null;
    const soilSalinityFraction = this.salinityFields.soil
      ? await this.scalar('world.drainage.soilSalinityFraction', cell)
      : null;
    // Keep the original fertility row layout so cold reads of old snapshots
    // remain valid. Salt diagnostics come from bounded authoritative field reads.
    if (fertility.landFraction > 0) {
      const landFraction = 1 - clamp(record.annualCoverage);
      fertility.soilSalinity = soilSalinity ?? 0;
      fertility.salineFraction = clamp(soilSalinityFraction ?? 0, 0, landFraction);
      fertility.salinityLimit = soilSalinityLimit(
        fertility.soilSalinity,
        fertility.salineFraction,
        landFraction,
      );
      if (fertility.salinityLimit < 0.98) {
        fertility.limitations.push('Saline soil');
      }
    }
    return {
      cell,
      position,
      latitude: (Math.asin(position[1]) * 180) / Math.PI,
      longitude: (Math.atan2(position[2], position[0]) * 180) / Math.PI,
      season,
      areaM2: (await this.scalar('world.grid.areas', cell)) * this.handle.config.radius ** 2,
      nearestCenterMetres: Math.min(...distances) * this.handle.config.radius,
      outline,
      height: record['terrain.height'],
      bedrock: scalars[0],
      sediment: record['terrain.sediment'],
      ocean: !!record['terrain.ocean'],
      lakeCoverage: record.coverage,
      temperature: record.temperature,
      annualTemperature: record['water.temperature'],
      rain: record.rain,
      annualRain: record['water.rain'],
      pet: scalars[1],
      aet: scalars[2],
      biome: record['ecology.biome'],
      vegetation: record['ecology.vegetation'],
      riparian: scalars[4],
      riparianFraction: scalars[5],
      riverHabitat: scalars[3],
      floodplainFraction: record['ecology.floodplainFraction'],
      wetland: record['ecology.wetland'],
      wetlandFraction: record['ecology.wetlandFraction'],
      soilSalinity,
      soilSalinityFraction,
      seasonalFlood,
      crustAge: await this.scalar('world.geology.age', process),
      volcanic: record['geology.crust.volcanic'],
      surfaceChange: record['terrain.surfaceChange'],
      fluvialIncision: record['terrain.fluvialIncision'],
      deltaSediment: record['terrain.deltaSediment'],
      plate: record['geology.plate'],
      river,
      lake,
      delta,
      oxbow,
      fertility,
      storedCellFertility: record['resources.fertility'],
    };
  }
  async listDeposits(
    filter: ResourceType | 'all' = 'all',
    cursor = 0,
    limit = 100,
  ): Promise<DepositPage> {
    if (filter !== 'all' && !Object.hasOwn(this.handle.summary.resourceTotals, filter)) {
      throw Error('Unknown resource filter.');
    }
    if (
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200
    ) {
      throw Error('Resource pages contain 1–200 deposits.');
    }
    const totals = this.handle.summary.resourceTotals;
    const total = filter === 'all' ? this.handle.summary.depositCount : totals[filter].count;
    const amount =
      filter === 'all'
        ? Object.values(totals).reduce((sum, value) => sum + value.amount, 0)
        : totals[filter].amount;
    const count = Math.max(0, Math.min(limit, total - cursor));
    if (!count) {
      return { items: [], nextCursor: null, total, amount };
    }
    const ids = await this.pages.readRange(`sidecars.view.depositIndices.${filter}`, cursor, count);
    const items = await Promise.all(
      Array.from(
        ids,
        (id) => this.pages.readValue(`world.resources.deposits.${id}`) as Promise<Deposit>,
      ),
    );
    return { items, nextCursor: cursor + count < total ? cursor + count : null, total, amount };
  }
  async inspectDeposit(id: string): Promise<DepositInspection | null> {
    let low = 0;
    let high = this.handle.summary.depositCount;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const key = (await this.pages.readValue(`sidecars.view.depositLookup.keys.${mid}`)) as string;
      if (key < id) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    if (
      low >= this.handle.summary.depositCount ||
      (await this.pages.readValue(`sidecars.view.depositLookup.keys.${low}`)) !== id
    ) {
      return null;
    }
    const raw = await this.scalar('sidecars.view.depositLookup.ids', low);
    const deposit = (await this.pages.readValue(`world.resources.deposits.${raw}`)) as Deposit;
    const located = await this.index.locate(deposit.anchor);
    const values = await this.records.read([located.row]);
    const record = unpackRecord(values, 0, -1);
    return {
      deposit,
      cell: located.cell,
      surface: record['terrain.ocean']
        ? 'Beneath ocean'
        : record.annualCoverage >= 1 - 1e-6
          ? 'Beneath inland water'
          : 'Land',
      latitude: (Math.asin(deposit.anchor[1]) * 180) / Math.PI,
      longitude: (Math.atan2(deposit.anchor[2], deposit.anchor[0]) * 180) / Math.PI,
    };
  }
  async overlays(request: OverlayRequest) {
    checkSeason(request.season);
    const packet = await readOverlays(this.pages, this.index, this.handle.summary, request);
    if (packet.rivers.heights.length) {
      const surface = await this.heightSampler.sample(packet.rivers.positions);
      for (let point = 0; point < surface.length; point++) {
        packet.rivers.heights[point] = Math.max(packet.rivers.heights[point], surface[point]);
      }
    }
    return packet;
  }
  get cacheStats() {
    return {
      nodes: this.index.cachedNodes,
      leaves: this.index.cachedLeaves,
      renderBlocks: this.records.cachedBlocks,
      ...this.stencils.cacheStats,
    };
  }
}
