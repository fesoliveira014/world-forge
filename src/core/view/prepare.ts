import type { World, ResourceType } from '../model';
import { gridSpacing } from '../grid/spacing';
import { evaluateFertilityCell, createFertilityEvaluation } from '../generation/fertility';
import { lakeAtCell, lakeCoverageAt } from '../generation/lake-state';
import { packRenderRecords } from './records';
import { packSurfaceStencils } from './surface-stencils';
import { buildSpatialIndex } from './spatial-index';
import type { WorldSummary } from './types';

export const FERTILITY_FIELDS = [
  'landFraction',
  'regionalScore',
  'corridorScore',
  'meanCorridorScore',
  'corridorFraction',
  'sediment',
  'corridorSediment',
  'freshwater',
  'rain',
  'volcanic',
  'growingSeason',
  'slopeLimit',
  'wetnessLimit',
  'freshCoverLimit',
] as const;
export const FERTILITY_LIMITATIONS = [
  'Standing water',
  'Permanent ice',
  'Limited lake freshwater',
  'Limited rainfall',
  'Cold growing season',
  'Steep surrounding terrain',
  'Persistent saturation',
  'Fresh volcanic cover',
];
export const VIEW_COLUMNS = 32;
export const VIEW_ROWS = 16;

/** Saved display index and derived scalar diagnostics. Authoritative physical fields
 * stay in the world archive; no render meshes or complete world copies are made. */
export function prepareWorldView(world: World) {
  const { grid } = world;
  const index = buildSpatialIndex(grid.positions);
  const strongest = new Int32Array(grid.count).fill(-1);
  const basin = new Uint32Array(grid.count);
  const lake = new Int32Array(grid.count).fill(-1);
  const delta = new Uint8Array(grid.count);
  const fertility = new Float32Array(grid.count * FERTILITY_FIELDS.length);
  const fertilityFlags = new Uint8Array(grid.count);
  const evaluation = createFertilityEvaluation();
  let landArea = 0;
  let oceanArea = 0;
  let landRain = 0;
  let minimumHeight = Infinity;
  let maximumHeight = -Infinity;
  for (let cell = 0; cell < grid.count; cell++) {
    let best = grid.cellCorners[grid.offsets[cell]];
    for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
      const corner = grid.cellCorners[offset];
      if (world.drainage.discharge[corner] > world.drainage.discharge[best]) {
        best = corner;
      }
      if (
        world.rivers.channel[corner] &&
        (strongest[cell] < 0 ||
          world.drainage.discharge[corner] > world.drainage.discharge[strongest[cell]])
      ) {
        strongest[cell] = corner;
      }
    }
    basin[cell] = best;
    lake[cell] = lakeAtCell(grid, world.drainage, cell)?.id ?? -1;
    if (lake[cell] < 0) {
      // A dry salt bed has no wet shoreline share, but its basin remains useful
      // to inspect. Keep this fallback out of the physical shoreline helpers.
      let salt = 0;
      for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
        const candidate = world.drainage.lakes[world.drainage.lakeId[grid.cellCorners[offset]]];
        if (candidate && candidate.area <= 0 && (candidate.salinity?.bedSalt ?? 0) > salt) {
          salt = candidate.salinity!.bedSalt;
          lake[cell] = candidate.id;
        }
      }
    }
    evaluateFertilityCell(world, cell, evaluation);
    for (let field = 0; field < FERTILITY_FIELDS.length; field++) {
      fertility[cell * FERTILITY_FIELDS.length + field] = evaluation[FERTILITY_FIELDS[field]];
    }
    for (const limitation of evaluation.limitations) {
      const flag = FERTILITY_LIMITATIONS.indexOf(limitation);
      if (flag >= 0) {
        fertilityFlags[cell] |= 1 << flag;
      }
    }
    const area = grid.areas[cell];
    if (world.terrain.ocean[cell]) {
      oceanArea += area;
    } else {
      landArea += area;
      landRain += area * world.water.rain[cell];
    }
    minimumHeight = Math.min(minimumHeight, world.terrain.height[cell]);
    maximumHeight = Math.max(maximumHeight, world.terrain.height[cell]);
  }
  for (const mouth of world.rivers.deltas) {
    const receiver = world.drainage.receiver[mouth.corner];
    if (receiver < 0) {
      continue;
    }
    const candidates = new Set<number>();
    for (const corner of [mouth.corner, receiver]) {
      for (let slot = 0; slot < 3; slot++) {
        candidates.add(grid.triangles[corner * 3 + slot]);
      }
    }
    const land = [...candidates]
      .filter(
        (cell) => !world.terrain.ocean[cell] && lakeCoverageAt(world.drainage, cell) < 1 - 1e-6,
      )
      .sort((a, b) => world.terrain.deltaSediment[b] - world.terrain.deltaSediment[a] || a - b);
    if (!land.length) {
      continue;
    }
    delta[land[0]] = 1;
    const second = land
      .slice(1)
      .find((cell) =>
        grid.neighbors.subarray(grid.offsets[land[0]], grid.offsets[land[0] + 1]).includes(cell),
      );
    if (second !== undefined) {
      delta[second] = 2;
    }
  }
  const resourceTypes: ResourceType[] = ['copper', 'tin', 'iron', 'gold', 'corundum'];
  const resourceTotals = Object.fromEntries(
    resourceTypes.map((type) => [type, { count: 0, amount: 0 }]),
  ) as WorldSummary['resourceTotals'];
  const depositIndices = Object.fromEntries(
    ['all', ...resourceTypes].map((type) => [type, [] as number[]]),
  ) as Record<ResourceType | 'all', number[]>;
  world.resources.deposits.forEach((deposit, id) => {
    resourceTotals[deposit.resourceType].count++;
    resourceTotals[deposit.resourceType].amount += deposit.amount;
    depositIndices.all.push(id);
    depositIndices[deposit.resourceType].push(id);
  });
  const summary: WorldSummary = {
    version: world.version,
    config: world.config,
    surfaceCells: grid.count,
    processCells: world.process.count,
    bytes: world.bytes,
    elapsed: world.elapsed,
    oceanFraction: oceanArea / (landArea + oceanArea),
    landAreaKm2: (landArea * world.config.radius ** 2) / 1e6,
    landRainMm: landRain / Math.max(1e-20, landArea),
    minimumHeight,
    maximumHeight,
    lakeCount: world.drainage.lakes.filter((lake) => lake.area > 0).length,
    riverCount: world.rivers.courses.corner.length,
    deltaCount: world.rivers.deltas.length,
    oxbowCount: world.terrain.oxbows.length,
    depositCount: world.resources.deposits.length,
    resourceTotals,
    timings: world.timings,
    evolution: world.evolution,
    refinementWork: world.refinementWork,
    featureRefinementStats: world.featureRefinementStats,
    featureCoarseningStats: world.featureCoarseningStats,
    refinement: grid.refinement && {
      baseCount: grid.refinement.baseCount,
      insertedCount: grid.refinement.insertedCount,
      passes: grid.refinement.passes,
    },
    execution: world.execution,
    atmosphereRelativeResidual: world.climate.atmosphereResidual,
    oceanFluxDivergence: world.climate.oceanDivergence,
    oceanDischarge: world.drainage.oceanDischarge,
    lakeExchange: world.drainage.lakeExchange,
    sedimentExport: world.sedimentExport,
    nearestCenterSpacingM: gridSpacing(grid, world.config.radius),
  };
  const bins: number[][] = Array.from({ length: VIEW_COLUMNS * VIEW_ROWS }, () => []);
  const addFeature = (
    kind: number,
    id: number,
    points: ArrayLike<number>,
    start = 0,
    end = points.length,
  ) => {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let i = start; i < end; i += 3) {
      x += points[i];
      y += points[i + 1];
      z += points[i + 2];
    }
    const norm = Math.hypot(x, y, z);
    if (norm === 0) {
      return;
    }
    x /= norm;
    y /= norm;
    z /= norm;
    let radius = 0;
    for (let i = start; i < end; i += 3) {
      radius = Math.max(
        radius,
        Math.acos(Math.max(-1, Math.min(1, x * points[i] + y * points[i + 1] + z * points[i + 2]))),
      );
    }
    radius += 1e-6;
    const lat = Math.asin(y);
    const lon = Math.atan2(z, x);
    const span =
      Math.abs(lat) + radius >= Math.PI / 2
        ? Math.PI
        : Math.asin(Math.min(1, Math.sin(radius) / Math.cos(lat)));
    const firstY = Math.max(0, Math.floor(((lat - radius + Math.PI / 2) / Math.PI) * VIEW_ROWS));
    const lastY = Math.min(
      VIEW_ROWS - 1,
      Math.floor(((lat + radius + Math.PI / 2) / Math.PI) * VIEW_ROWS),
    );
    const firstX = Math.floor(((lon - span + Math.PI) / (2 * Math.PI)) * VIEW_COLUMNS);
    const lastX = Math.floor(((lon + span + Math.PI) / (2 * Math.PI)) * VIEW_COLUMNS);
    for (let row = firstY; row <= lastY; row++) {
      for (let col = firstX; col <= Math.min(lastX, firstX + VIEW_COLUMNS - 1); col++) {
        bins[row * VIEW_COLUMNS + (((col % VIEW_COLUMNS) + VIEW_COLUMNS) % VIEW_COLUMNS)].push(
          kind,
          id,
        );
      }
    }
  };
  for (let course = 0; course < world.rivers.courses.corner.length; course++) {
    addFeature(
      0,
      course,
      world.rivers.courses.points,
      world.rivers.courses.offsets[course] * 3,
      world.rivers.courses.offsets[course + 1] * 3,
    );
  }
  const edgePoints = new Float64Array(6);
  for (let edge = 0; edge < grid.edgeLength.length; edge++) {
    const a = grid.edgeCells[edge * 2];
    const b = grid.edgeCells[edge * 2 + 1];
    const coast = world.terrain.ocean[a] !== world.terrain.ocean[b];
    const boundary =
      world.geology.plate[world.transfer[a]] !== world.geology.plate[world.transfer[b]];
    if (!coast && !boundary) {
      continue;
    }
    for (let endpoint = 0; endpoint < 2; endpoint++) {
      for (let axis = 0; axis < 3; axis++) {
        edgePoints[endpoint * 3 + axis] =
          grid.corners[grid.edgeCorners[edge * 2 + endpoint] * 3 + axis];
      }
    }
    if (coast) {
      addFeature(1, edge, edgePoints);
    }
    if (boundary) {
      addFeature(2, edge, edgePoints);
    }
  }
  world.rivers.deltas.forEach((mouth, id) =>
    mouth.branches.forEach((branch) => addFeature(3, id, branch.points)),
  );
  world.terrain.oxbows.forEach((pond, id) => addFeature(4, id, pond.points));
  world.resources.deposits.forEach((deposit, id) => addFeature(5, id, deposit.anchor));
  const offsets = new Uint32Array(bins.length + 1);
  for (let bin = 0; bin < bins.length; bin++) {
    offsets[bin + 1] = offsets[bin] + bins[bin].length;
  }
  const refs = new Uint32Array(offsets[bins.length]);
  bins.forEach((bin, id) => refs.set(bin, offsets[id]));
  // Optional acceleration for newer snapshots. The original mixed index remains
  // present so saved v2 worlds without this ranking use the reader's scan fallback.
  const peakFlow = (corner: number) => {
    let score = world.drainage.discharge[corner];
    score = Math.max(score, world.drainage.seasonalPeak?.[corner] ?? 0);
    for (const flows of world.rivers.seasonalDischarge) {
      score = Math.max(score, flows[corner]);
    }
    return Number.isFinite(score) ? Math.max(0, score) : 0;
  };
  const rankedBins = bins.map((bin) => {
    const seen = new Set<string>();
    const ranks: { kind: number; id: number; score: number }[] = [];
    for (let entry = 0; entry < bin.length; entry += 2) {
      const kind = bin[entry];
      const id = bin[entry + 1];
      if (kind !== 0 && kind !== 3 && kind !== 4) {
        continue;
      }
      const key = `${kind}:${id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      let score: number;
      if (kind === 0) {
        score = peakFlow(world.rivers.courses.corner[id]);
      } else if (kind === 3) {
        score = peakFlow(world.rivers.deltas[id].corner);
      } else {
        const pond = world.terrain.oxbows[id];
        const corner = strongest[pond.cell];
        // A disconnected pond has no routed discharge. Its channel-width proxy
        // supplies display priority only; it changes no physical water fields.
        score = corner >= 0 ? peakFlow(corner) : (pond.width / 8) ** 2;
      }
      ranks.push({ kind, id, score });
    }
    return ranks.sort((a, b) => b.score - a.score || a.kind - b.kind || a.id - b.id);
  });
  const rankOffsets = new Uint32Array(bins.length + 1);
  rankedBins.forEach((bin, id) => {
    rankOffsets[id + 1] = rankOffsets[id] + bin.length;
  });
  const rankRefs = new Uint32Array(rankOffsets[bins.length] * 2);
  const rankScores = new Float32Array(rankOffsets[bins.length]);
  rankedBins.forEach((bin, id) =>
    bin.forEach((entry, offset) => {
      const row = rankOffsets[id] + offset;
      rankRefs[row * 2] = entry.kind;
      rankRefs[row * 2 + 1] = entry.id;
      rankScores[row] = entry.score;
    }),
  );
  const riverRank = { offsets: rankOffsets, refs: rankRefs, scores: rankScores };
  const sortedLookup = (values: number[]) => {
    const ids = Uint32Array.from({ length: values.length }, (_, id) => id);
    ids.sort((a, b) => values[a] - values[b] || a - b);
    return { keys: Uint32Array.from(ids, (id) => values[id]), ids };
  };
  return {
    summary,
    sidecars: {
      view: {
        format: 'atlas-view/v2',
        stencils: packSurfaceStencils(grid, index.cells),
        summary,
        index,
        strongest,
        basin,
        lake,
        delta,
        fertility,
        fertilityFlags,
        depositIndices,
        deltaLookup: sortedLookup(world.rivers.deltas.map((item) => item.corner)),
        pondLookup: sortedLookup(world.terrain.oxbows.map((item) => item.cell)),
        overlay: { offsets, refs, riverRank },
        depositLookup: (() => {
          const ids = Uint32Array.from({ length: world.resources.deposits.length }, (_, id) => id);
          ids.sort((a, b) =>
            world.resources.deposits[a].id < world.resources.deposits[b].id
              ? -1
              : world.resources.deposits[a].id > world.resources.deposits[b].id
                ? 1
                : 0,
          );
          return { keys: Array.from(ids, (id) => world.resources.deposits[id].id), ids };
        })(),
        records: packRenderRecords(world, index.cells, strongest, basin, delta),
        hasCrust: !!world.geology.crust,
        seasonalLakeCoverage: !!world.drainage.seasonalLakeCoverage,
        salinityFields: {
          soil: !!world.drainage.soilSalinity && !!world.drainage.soilSalinityFraction,
          river: !!world.drainage.riverSalinity,
        },
        courseCount: world.rivers.courses.corner.length,
        reachCount: world.ecology.floodplains.corner.length,
      },
    },
  };
}
