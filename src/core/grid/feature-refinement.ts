import type { Drainage, Grid, Rivers, Terrain, WorldConfig } from '../model';
import { clamp } from '../math';
import { calculateHeightGradient } from '../operators/spatial';
import { createGradedSpacingField } from './graded-spacing';
import { refinementGeometryHash } from './refinement-plan';
import {
  normalizedRefinementConfigSignature,
  refinementConfigSignature,
} from './refinement-config';
import type { SpacingField } from './refine';
import { analyzeLakeDistricts } from './feature-districts';

export interface FeatureRefinementContext {
  grid: Grid;
  terrain: Terrain;
  drainage: Drainage;
  rivers: Rivers;
  config: WorldConfig;
}

export interface FeatureCandidate {
  cell: number;
  score: number;
  targetSpacingMetres?: number;
  /** Continuous geographic footprint, rather than just the source cell. */
  radiusMetres?: number;
}

/** Detectors inspect physical fields only; they never alter terrain or topology. */
export interface FeatureDetector {
  id: string;
  detect(context: FeatureRefinementContext, emit: (candidate: FeatureCandidate) => void): void;
  budgetWeight?(context: FeatureRefinementContext): number;
}

export interface FeatureRefinementStats {
  candidateCells: number;
  selectedCells: number;
  estimatedAddedCells: number;
  budgetSkippedCells: number;
  coveredCells: number;
  byDetector: Record<string, { candidates: number; selected: number }>;
  stoppedByBudget: boolean;
}

export interface FeatureRefinementPassStats {
  beforeCells: number;
  afterCells: number;
  budget: number;
  selectedCells: number;
  candidateCells: number;
  budgetExhausted: boolean;
  byDetector?: FeatureRefinementStats['byDetector'];
}

export interface ResolvedFeatureRefinementPlan {
  format: 'atlas-feature-refinement/v1';
  sourceGeometryHash: string;
  configSignature: string;
  sourceCellCount: number;
  planetRadiusMetres: number;
  baseSpacingMetres: number;
  gradation: number;
  maxAddedCells: number;
  caps: {
    center: [number, number, number];
    radiusMetres: number;
    targetSpacingMetres: number;
    features: string[];
  }[];
  stats: FeatureRefinementStats;
}

export interface FeatureRefinementPlan {
  resolved: ResolvedFeatureRefinementPlan;
  spacingAt: SpacingField;
  stats: FeatureRefinementStats;
}

const emitIncidentLand = (
  context: FeatureRefinementContext,
  corner: number,
  score: number,
  emit: (candidate: FeatureCandidate) => void,
) => {
  for (let incident = 0; incident < 3; incident++) {
    const cell = context.grid.triangles[corner * 3 + incident];
    if (!context.terrain.ocean[cell]) {
      emit({ cell, score });
    }
  }
};

export const lakeShoreDetector: FeatureDetector = {
  id: 'lake-shores',
  detect(context, emit) {
    const { grid, terrain, drainage, config } = context;
    const seasons = drainage.seasonalLakeCoverage ?? [drainage.lakeCoverage];
    for (let cell = 0; cell < grid.count; cell++) {
      if (terrain.ocean[cell]) {
        continue;
      }
      let mixture = 0;
      let boundary = false;
      for (const field of seasons) {
        const wet = clamp(field[cell]);
        // Test each season separately: a lake that alternates wholly wet and dry
        // must not acquire a shoreline throughout its interior from its mean.
        mixture = Math.max(mixture, 4 * wet * (1 - wet));
        if (wet <= 1e-4) {
          continue;
        }
        for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
          const neighbor = grid.neighbors[offset];
          if (!terrain.ocean[neighbor] && field[neighbor] <= 1e-4) {
            boundary = true;
          }
        }
      }
      if (mixture > 0.01 || boundary) {
        emit({ cell, score: Math.max(0.7 + 0.3 * Math.sqrt(mixture), boundary ? 0.85 : 0) });
      }
    }
    // A tiny lake may occupy only a small fraction of a corner's support, so its
    // mixed-cell score alone can understate the unresolved physical footprint.
    const peakArea = Float64Array.from(drainage.lakes, (lake) =>
      lake.seasonal ? Math.max(...lake.seasonal.area) : lake.area,
    );
    for (let corner = 0; corner < drainage.lakeId.length; corner++) {
      const lake = drainage.lakeId[corner];
      if (lake < 0 || !(peakArea[lake] > 0) || !(drainage.lakeFraction[corner] > 0)) {
        continue;
      }
      let support = 0;
      for (let incident = 0; incident < 3; incident++) {
        support += (grid.areas[grid.triangles[corner * 3 + incident]] * config.radius ** 2) / 3;
      }
      if (peakArea[lake] < 4 * support) {
        emitIncidentLand(context, corner, 0.95, emit);
      }
    }
  },
};

export const riverFeatureDetector: FeatureDetector = {
  id: 'river-features',
  detect(context, emit) {
    const { grid, drainage, rivers } = context;
    const incoming = new Uint8Array(rivers.channel.length);
    const mainUpstream = new Int32Array(rivers.channel.length).fill(-1);
    for (let corner = 0; corner < rivers.channel.length; corner++) {
      const receiver = drainage.receiver[corner];
      if (!rivers.channel[corner] || receiver < 0) {
        continue;
      }
      incoming[receiver]++;
      const previous = mainUpstream[receiver];
      if (previous < 0 || drainage.discharge[corner] > drainage.discharge[previous]) {
        mainUpstream[receiver] = corner;
      }
    }
    for (let corner = 0; corner < rivers.channel.length; corner++) {
      if (!rivers.channel[corner]) {
        continue;
      }
      const upstream = mainUpstream[corner];
      const receiver = drainage.receiver[corner];
      let score = incoming[corner] > 1 ? 0.95 : 0.45;
      if (upstream >= 0 && receiver >= 0) {
        let dot = 0;
        let inSquared = 0;
        let outSquared = 0;
        for (let axis = 0; axis < 3; axis++) {
          const before = grid.corners[corner * 3 + axis] - grid.corners[upstream * 3 + axis];
          const after = grid.corners[receiver * 3 + axis] - grid.corners[corner * 3 + axis];
          dot += before * after;
          inSquared += before ** 2;
          outSquared += after ** 2;
        }
        const turn = 1 - dot / Math.max(1e-30, Math.sqrt(inSquared * outSquared));
        if (turn > 0.3) {
          score = Math.max(score, 0.65 + 0.25 * clamp(turn / 2));
        }
      }
      emitIncidentLand(context, corner, score, emit);
    }
    for (const lake of drainage.lakes) {
      if (lake.outlet >= 0 && lake.outflow > 0) {
        emitIncidentLand(context, lake.outlet, 1, emit);
      }
    }
  },
};

export const coastlineDetector: FeatureDetector = {
  id: 'coastline',
  detect({ grid, terrain }, emit) {
    for (let cell = 0; cell < grid.count; cell++) {
      if (terrain.ocean[cell]) {
        continue;
      }
      for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
        if (terrain.ocean[grid.neighbors[offset]]) {
          emit({ cell, score: 0.8 });
          break;
        }
      }
    }
  },
};

export const terrainReliefDetector: FeatureDetector = {
  id: 'terrain-relief',
  detect({ grid, terrain, config }, emit) {
    const gradient = calculateHeightGradient(grid, terrain.height, config.radius);
    for (let cell = 0; cell < grid.count; cell++) {
      if (terrain.ocean[cell]) {
        continue;
      }
      let error = 0;
      for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
        const neighbor = grid.neighbors[offset];
        if (terrain.ocean[neighbor]) {
          continue;
        }
        let predicted = 0;
        for (let axis = 0; axis < 3; axis++) {
          predicted +=
            gradient[cell * 3 + axis] *
            config.radius *
            (grid.positions[neighbor * 3 + axis] - grid.positions[cell * 3 + axis]);
        }
        error = Math.max(
          error,
          Math.abs(terrain.height[neighbor] - terrain.height[cell] - predicted),
        );
      }
      // A steep but consistently reconstructed slope does not request detail.
      if (error > 60) {
        emit({ cell, score: 0.5 + 0.35 * clamp((error - 60) / 500) });
      }
    }
  },
};

export const lakeDistrictDetector: FeatureDetector = {
  id: 'lake-districts',
  budgetWeight: ({ config }) => config.featureDistrictStrength / 25,
  detect(context, emit) {
    for (const candidate of analyzeLakeDistricts(context).candidates) {
      emit(candidate);
    }
  },
};

export const DEFAULT_FEATURE_DETECTORS: readonly FeatureDetector[] = [
  lakeDistrictDetector,
  lakeShoreDetector,
  riverFeatureDetector,
  coastlineDetector,
  terrainReliefDetector,
];

function cellRadii(grid: Grid, radius: number): Float64Array {
  const result = new Float64Array(grid.count);
  for (let cell = 0; cell < grid.count; cell++) {
    const x = grid.positions[cell * 3];
    const y = grid.positions[cell * 3 + 1];
    const z = grid.positions[cell * 3 + 2];
    for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
      const corner = grid.cellCorners[offset] * 3;
      const a = grid.corners[corner];
      const b = grid.corners[corner + 1];
      const c = grid.corners[corner + 2];
      const angle = Math.atan2(
        Math.hypot(y * c - z * b, z * a - x * c, x * b - y * a),
        x * a + y * b + z * c,
      );
      result[cell] = Math.max(result[cell], angle * radius);
    }
  }
  return result;
}

/** Isolated-cap incremental density, including its graded transition halo. This
 * intentionally does not discount overlapping caps. It is a planning estimate;
 * refineGrid's insertion limit, not this estimate, enforces the actual budget.
 */
function estimateCapWork(radius: number, target: number, localSpacing: number, gradient: number) {
  const plateau = Math.PI * radius ** 2 * (1 / target ** 2 - 1 / localSpacing ** 2);
  const halo =
    ((2 * Math.PI) / gradient ** 2) * Math.log(localSpacing / target) +
    ((2 * Math.PI * radius) / gradient) * (1 / target - 1 / localSpacing);
  return Math.max(1, Math.ceil((plateau + halo) * (2 / Math.sqrt(3)) * 1.5));
}

/** Reserve half of the estimated work among active feature detectors, equally
 * unless a detector supplies a weight. Each reserve uses that detector's own
 * scores, so another signal cannot monopolize it. Unused work returns to the
 * global rank; district strength controls its share without changing physics.
 */
function selectFeatureCaps(
  grid: Grid,
  radii: Float64Array,
  capRadii: Float64Array,
  targets: Float64Array,
  ranked: Uint32Array,
  detectors: readonly FeatureDetector[],
  detectorScores: readonly (Float64Array | undefined)[],
  detectorWeights: readonly number[],
  planetRadius: number,
  maxAddedCells: number,
  stats: FeatureRefinementStats,
): ResolvedFeatureRefinementPlan['caps'] {
  const covered = new Uint8Array(grid.count); // 0 available, 1 covered, 2 selected
  const caps: ResolvedFeatureRefinementPlan['caps'] = [];
  let regionQueue: Uint32Array | undefined;
  let visited: Uint32Array | undefined;
  let visit = 0;
  const select = (cell: number, ceiling: number) => {
    if (covered[cell]) {
      return;
    }
    let radius = Math.max(radii[cell], capRadii[cell]);
    const work = (candidateRadius: number) =>
      estimateCapWork(candidateRadius, targets[cell], radii[cell] * Math.sqrt(3), 0.35);
    const available = ceiling - stats.estimatedAddedCells;
    let cost = work(radius);
    if (cost > available) {
      // A district may be much larger than this pass's allowance. Fit a useful
      // continuous part of it rather than rejecting the entire broad feature.
      if (!(capRadii[cell] > radii[cell]) || work(radii[cell]) > available) {
        return;
      }
      let low = radii[cell];
      let high = radius;
      for (let iteration = 0; iteration < 32; iteration++) {
        const middle = (low + high) / 2;
        if (work(middle) <= available) {
          low = middle;
        } else {
          high = middle;
        }
      }
      radius = low;
      cost = work(radius);
    }
    const features: string[] = [];
    for (let index = 0; index < detectors.length; index++) {
      if ((detectorScores[index]?.[cell] ?? 0) > 0) {
        features.push(detectors[index].id);
      }
    }
    features.sort();
    caps.push({
      center: [
        grid.positions[cell * 3],
        grid.positions[cell * 3 + 1],
        grid.positions[cell * 3 + 2],
      ],
      radiusMetres: radius,
      targetSpacingMetres: targets[cell],
      features,
    });
    stats.estimatedAddedCells += cost;
    stats.selectedCells++;
    for (const feature of features) {
      stats.byDetector[feature].selected++;
    }
    covered[cell] = 2;
    for (let offset = grid.offsets[cell]; offset < grid.offsets[cell + 1]; offset++) {
      const neighbor = grid.neighbors[offset];
      if (covered[neighbor] !== 2) {
        covered[neighbor] = 1;
      }
    }
    if (radius > radii[cell] * (1 + 1e-9)) {
      regionQueue ??= new Uint32Array(grid.count);
      visited ??= new Uint32Array(grid.count);
      visit++;
      let read = 0;
      let write = 1;
      regionQueue[0] = cell;
      visited[cell] = visit;
      const cosine = Math.cos(Math.min(Math.PI, radius / planetRadius));
      while (read < write) {
        const current = regionQueue[read++];
        for (let offset = grid.offsets[current]; offset < grid.offsets[current + 1]; offset++) {
          const neighbor = grid.neighbors[offset];
          if (visited[neighbor] === visit) {
            continue;
          }
          visited[neighbor] = visit;
          let dot = 0;
          for (let axis = 0; axis < 3; axis++) {
            dot += grid.positions[cell * 3 + axis] * grid.positions[neighbor * 3 + axis];
          }
          if (dot < cosine) {
            continue;
          }
          regionQueue[write++] = neighbor;
          // Finer signals inside the district retain their own opportunity.
          if (covered[neighbor] !== 2 && targets[neighbor] >= targets[cell]) {
            covered[neighbor] = 1;
          }
        }
      }
    }
  };
  const activeWeight = detectorScores.reduce(
    (sum, scores, index) => sum + (scores ? detectorWeights[index] : 0),
    0,
  );
  if (activeWeight > 0) {
    for (let index = 0; index < detectors.length; index++) {
      const scores = detectorScores[index];
      if (!scores) {
        continue;
      }
      const reserve = Math.floor((maxAddedCells * 0.5 * detectorWeights[index]) / activeWeight);
      if (reserve <= 0) {
        continue;
      }
      const ownRank = new Uint32Array(stats.byDetector[detectors[index].id].candidates);
      let next = 0;
      for (const cell of ranked) {
        if (scores[cell] > 0) {
          ownRank[next++] = cell;
        }
      }
      ownRank.sort((a, b) => scores[b] - scores[a] || a - b);
      const ceiling = Math.min(maxAddedCells, stats.estimatedAddedCells + reserve);
      for (const cell of ownRank) {
        select(cell, ceiling);
      }
    }
  }
  for (const cell of ranked) {
    select(cell, maxAddedCells);
  }
  // A candidate skipped by an early reserve may subsequently be selected or
  // covered. Count the final partition once, after all opportunities are used.
  for (const cell of ranked) {
    if (covered[cell] === 1) {
      stats.coveredCells++;
    } else if (covered[cell] === 0) {
      stats.budgetSkippedCells++;
    }
  }
  stats.stoppedByBudget = stats.budgetSkippedCells > 0;
  return caps;
}

/** Merge bounded detector scores, then select deterministically without pairwise
 * cap searches. Adjacent source cells share a selected cap/transition halo. Work
 * is O(D N log N + emitted candidates) for D detectors; spacing has its own tree.
 */
export function planFeatureRefinement(
  context: FeatureRefinementContext,
  maxAddedCells: number,
  detectors: readonly FeatureDetector[] = DEFAULT_FEATURE_DETECTORS,
): FeatureRefinementPlan {
  if (!Number.isSafeInteger(maxAddedCells) || maxAddedCells < 0) {
    throw Error('Feature refinement needs a nonnegative cell budget.');
  }
  const { grid, config } = context;
  if (!(config.featureRefinementSpacing > 0) || !Number.isFinite(config.featureRefinementSpacing)) {
    throw Error('Feature refinement needs positive target spacing.');
  }
  const radii = cellRadii(grid, config.radius);
  let baseSpacing = 0;
  for (const radius of radii) {
    baseSpacing = Math.max(baseSpacing, radius * Math.sqrt(3));
  }
  baseSpacing *= 1 + 1e-9;
  // Dense numeric staging avoids millions of Map entries and per-cell Sets on
  // large surfaces. Float64 preserves the detector's exact score/target ordering.
  const scores = new Float64Array(grid.count);
  const targets = new Float64Array(grid.count);
  const capRadii = new Float64Array(grid.count);
  const stats: FeatureRefinementStats = {
    candidateCells: 0,
    selectedCells: 0,
    estimatedAddedCells: 0,
    budgetSkippedCells: 0,
    coveredCells: 0,
    byDetector: {},
    stoppedByBudget: false,
  };
  const orderedDetectors = [...detectors].sort((a, b) => a.id.localeCompare(b.id, 'en'));
  // Allocate one score field only when a detector emits a usable candidate.
  // Positive scores also encode membership; no separate bitsets or Sets remain.
  const detectorScores: (Float64Array | undefined)[] = new Array(orderedDetectors.length);
  const detectorWeights = orderedDetectors.map((detector) => {
    const weight = detector.budgetWeight?.(context) ?? 1;
    if (!Number.isFinite(weight) || weight < 0) {
      throw Error('Feature detector weights must be nonnegative.');
    }
    return weight;
  });
  for (let detectorIndex = 0; detectorIndex < orderedDetectors.length; detectorIndex++) {
    const detector = orderedDetectors[detectorIndex];
    if (!detector.id || Object.hasOwn(stats.byDetector, detector.id)) {
      throw Error('Feature detector IDs must be nonempty and unique.');
    }
    const counts = { candidates: 0, selected: 0 };
    Object.defineProperty(stats.byDetector, detector.id, {
      value: counts,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    detector.detect(context, (candidate) => {
      if (
        !Number.isSafeInteger(candidate.cell) ||
        candidate.cell < 0 ||
        candidate.cell >= grid.count ||
        !Number.isFinite(candidate.score) ||
        candidate.score <= 0 ||
        (candidate.targetSpacingMetres !== undefined &&
          (!(candidate.targetSpacingMetres > 0) ||
            !Number.isFinite(candidate.targetSpacingMetres))) ||
        (candidate.radiusMetres !== undefined &&
          (!(candidate.radiusMetres >= 0) ||
            !Number.isFinite(candidate.radiusMetres) ||
            candidate.radiusMetres > Math.PI * config.radius))
      ) {
        return;
      }
      const localSpacing = radii[candidate.cell] * Math.sqrt(3);
      const target = Math.max(
        config.featureRefinementSpacing,
        localSpacing / 2,
        candidate.targetSpacingMetres ?? 0,
      );
      if (target >= localSpacing * (1 - 1e-9)) {
        return;
      }
      const cell = candidate.cell;
      const ownScores = (detectorScores[detectorIndex] ??= new Float64Array(grid.count));
      if (ownScores[cell] === 0) {
        counts.candidates++;
      }
      ownScores[cell] = Math.max(ownScores[cell], clamp(candidate.score));
      if (scores[cell] === 0) {
        stats.candidateCells++;
      }
      scores[cell] = Math.max(scores[cell], clamp(candidate.score));
      targets[cell] = targets[cell] === 0 ? target : Math.min(targets[cell], target);
      capRadii[cell] = Math.max(capRadii[cell], candidate.radiusMetres ?? 0);
    });
  }
  const ranked = new Uint32Array(stats.candidateCells);
  let candidateIndex = 0;
  for (let cell = 0; cell < grid.count; cell++) {
    if (scores[cell] > 0) {
      ranked[candidateIndex++] = cell;
    }
  }
  ranked.sort((a, b) => scores[b] - scores[a] || a - b);
  const caps = selectFeatureCaps(
    grid,
    radii,
    capRadii,
    targets,
    ranked,
    orderedDetectors,
    detectorScores,
    detectorWeights,
    config.radius,
    maxAddedCells,
    stats,
  );
  return replayFeatureRefinement(context, {
    format: 'atlas-feature-refinement/v1',
    sourceGeometryHash: refinementGeometryHash(grid),
    configSignature: refinementConfigSignature(config),
    sourceCellCount: grid.count,
    planetRadiusMetres: config.radius,
    baseSpacingMetres: baseSpacing,
    gradation: 0.35,
    maxAddedCells,
    caps,
    stats,
  });
}

export function validateResolvedFeatureRefinementPlan(
  value: unknown,
): ResolvedFeatureRefinementPlan {
  const plan = value as ResolvedFeatureRefinementPlan | null;
  const positive = (n: unknown): n is number =>
    typeof n === 'number' && Number.isFinite(n) && n > 0;
  const count = (n: unknown): n is number =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  const stats = plan?.stats;
  if (
    !plan ||
    plan.format !== 'atlas-feature-refinement/v1' ||
    typeof plan.sourceGeometryHash !== 'string' ||
    typeof plan.configSignature !== 'string' ||
    normalizedRefinementConfigSignature(plan.configSignature) === null ||
    !count(plan.sourceCellCount) ||
    plan.sourceCellCount < 4 ||
    !positive(plan.planetRadiusMetres) ||
    !positive(plan.baseSpacingMetres) ||
    !positive(plan.gradation) ||
    plan.gradation > 0.5 ||
    !count(plan.maxAddedCells) ||
    !Array.isArray(plan.caps) ||
    !plan.caps.every(
      (cap) =>
        cap &&
        Array.isArray(cap.center) &&
        cap.center.length === 3 &&
        cap.center.every(Number.isFinite) &&
        Math.abs(Math.hypot(...cap.center) - 1) < 1e-9 &&
        typeof cap.radiusMetres === 'number' &&
        Number.isFinite(cap.radiusMetres) &&
        cap.radiusMetres >= 0 &&
        cap.radiusMetres <= Math.PI * plan.planetRadiusMetres &&
        positive(cap.targetSpacingMetres) &&
        cap.targetSpacingMetres < plan.baseSpacingMetres &&
        Array.isArray(cap.features) &&
        cap.features.length > 0 &&
        cap.features.every((id) => typeof id === 'string' && id.length > 0) &&
        new Set(cap.features).size === cap.features.length,
    ) ||
    !stats ||
    ![
      stats.candidateCells,
      stats.selectedCells,
      stats.estimatedAddedCells,
      stats.budgetSkippedCells,
      stats.coveredCells,
    ].every(count) ||
    stats.candidateCells > plan.sourceCellCount ||
    stats.selectedCells !== plan.caps.length ||
    stats.selectedCells + stats.coveredCells + stats.budgetSkippedCells !== stats.candidateCells ||
    stats.estimatedAddedCells > plan.maxAddedCells ||
    typeof stats.stoppedByBudget !== 'boolean' ||
    stats.stoppedByBudget !== stats.budgetSkippedCells > 0 ||
    !stats.byDetector ||
    typeof stats.byDetector !== 'object' ||
    Array.isArray(stats.byDetector) ||
    !Object.entries(stats.byDetector).every(
      ([id, counts]) =>
        id.length > 0 &&
        counts &&
        count(counts.candidates) &&
        count(counts.selected) &&
        counts.candidates <= stats.candidateCells &&
        counts.selected <= counts.candidates,
    ) ||
    !plan.caps.every((cap) => cap.features.every((id) => Object.hasOwn(stats.byDetector, id))) ||
    (plan.maxAddedCells === 0 && plan.caps.length > 0)
  ) {
    throw Error(
      'Saved feature refinement contains invalid geometry, selection statistics, or cell budget.',
    );
  }
  return plan;
}

export function replayFeatureRefinement(
  context: FeatureRefinementContext,
  value: ResolvedFeatureRefinementPlan,
  maxAddedCells = value.maxAddedCells,
): FeatureRefinementPlan {
  const resolved = validateResolvedFeatureRefinementPlan(value);
  if (
    resolved.sourceCellCount !== context.grid.count ||
    resolved.sourceGeometryHash !== refinementGeometryHash(context.grid) ||
    resolved.planetRadiusMetres !== context.config.radius ||
    normalizedRefinementConfigSignature(resolved.configSignature) !==
      refinementConfigSignature(context.config) ||
    resolved.maxAddedCells !== maxAddedCells
  ) {
    throw Error('Saved feature refinement does not match this world, recipe, or cell budget.');
  }
  const positions = new Float64Array(resolved.caps.length * 3);
  const targets = new Float64Array(resolved.caps.length);
  const radii = new Float64Array(resolved.caps.length);
  resolved.caps.forEach((cap, index) => {
    positions.set(cap.center, index * 3);
    targets[index] = cap.targetSpacingMetres;
    radii[index] = cap.radiusMetres;
  });
  return {
    resolved,
    stats: resolved.stats,
    spacingAt: createGradedSpacingField(
      { count: resolved.caps.length, positions },
      targets,
      resolved.planetRadiusMetres,
      resolved.baseSpacingMetres,
      resolved.gradation,
      radii,
    ),
  };
}
