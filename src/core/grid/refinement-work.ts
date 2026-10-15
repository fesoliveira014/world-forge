import type { Grid, ResolvedRegionalRefinement } from '../model';
import { nearestCell } from './build';
import { createGradedSpacingField } from './graded-spacing';
import { validateResolvedRefinementPlan, type ResolvedRefinementPlan } from './refinement-plan';
import type { SpacingField } from './refine';

export interface RefinementWorkEstimate {
  /** Rounded requested work plus retained existing sites; not a cell budget. */
  estimatedCells: number;
  estimatedAddedCells: number;
  /** Approximate full snapshot storage at 1 KiB per surface site. */
  estimatedRetainedMiB: number;
  /** Approximate working peak at 3 KiB per site, including the retained snapshot. */
  estimatedPeakMiB: number;
  sampledDirections: number;
  method: 'physical-spacing-quadrature';
  uncertainty: 'order-of-magnitude';
  sampledCaps: number;
  totalCaps: number;
}

interface IntegrationCap {
  x: number;
  y: number;
  z: number;
  radius: number;
  target: number;
  influenceRadius: number;
}

/** Count overlapping spherical disks with bounding-box whole-node shortcuts. */
function createCoverageCounter(caps: IntegrationCap[], radius: number) {
  interface Node {
    minimum: number[];
    maximum: number[];
    minimumRadius: number;
    maximumRadius: number;
    start: number;
    end: number;
    left?: Node;
    right?: Node;
  }
  const indices = Uint32Array.from({ length: caps.length }, (_, index) => index);
  const coordinate = (cap: IntegrationCap, axis: number) =>
    axis === 0 ? cap.x : axis === 1 ? cap.y : cap.z;
  const build = (start: number, end: number): Node => {
    const node: Node = {
      minimum: [Infinity, Infinity, Infinity],
      maximum: [-Infinity, -Infinity, -Infinity],
      minimumRadius: Infinity,
      maximumRadius: 0,
      start,
      end,
    };
    for (let index = start; index < end; index++) {
      const cap = caps[indices[index]];
      node.minimumRadius = Math.min(node.minimumRadius, cap.influenceRadius / radius);
      node.maximumRadius = Math.max(node.maximumRadius, cap.influenceRadius / radius);
      for (let axis = 0; axis < 3; axis++) {
        node.minimum[axis] = Math.min(node.minimum[axis], coordinate(cap, axis));
        node.maximum[axis] = Math.max(node.maximum[axis], coordinate(cap, axis));
      }
    }
    if (end - start > 16) {
      let axis = 0;
      for (let candidate = 1; candidate < 3; candidate++) {
        if (
          node.maximum[candidate] - node.minimum[candidate] >
          node.maximum[axis] - node.minimum[axis]
        ) {
          axis = candidate;
        }
      }
      indices
        .subarray(start, end)
        .sort(
          (first, second) =>
            coordinate(caps[first], axis) - coordinate(caps[second], axis) || first - second,
        );
      const middle = (start + end) >>> 1;
      node.left = build(start, middle);
      node.right = build(middle, end);
    }
    return node;
  };
  const root = caps.length ? build(0, caps.length) : undefined;
  return (x: number, y: number, z: number): number => {
    const visit = (node: Node): number => {
      let nearestSquared = 0;
      let farthestSquared = 0;
      for (let axis = 0; axis < 3; axis++) {
        const value = axis === 0 ? x : axis === 1 ? y : z;
        nearestSquared += Math.max(0, node.minimum[axis] - value, value - node.maximum[axis]) ** 2;
        farthestSquared +=
          Math.max(Math.abs(node.minimum[axis] - value), Math.abs(node.maximum[axis] - value)) ** 2;
      }
      if (nearestSquared > (2 * Math.sin(node.maximumRadius / 2)) ** 2 * (1 + 1e-12)) {
        return 0;
      }
      if (
        node.minimumRadius >= Math.PI ||
        farthestSquared < (2 * Math.sin(node.minimumRadius / 2)) ** 2
      ) {
        return node.end - node.start;
      }
      if (node.left && node.right) {
        return visit(node.left) + visit(node.right);
      }
      let count = 0;
      for (let index = node.start; index < node.end; index++) {
        const cap = caps[indices[index]];
        if (x * cap.x + y * cap.y + z * cap.z >= Math.cos(cap.influenceRadius / radius) - 1e-14) {
          count++;
        }
      }
      return count;
    };
    return root ? visit(root) : 0;
  };
}

const roundEstimate = (value: number) => {
  if (value === 0) {
    return 0;
  }
  const scale = 10 ** (Math.floor(Math.log10(value)) - 1);
  return Math.round(value / scale) * scale;
};

/** Estimate work without inserting sites or reducing the requested quality.
 *
 * Integrate physical area / target², with the hexagonal site-density factor and
 * a 30% allowance for irregular circumcenter insertion. Pilot sites and corners
 * supply area-weighted quadrature. Sparse caps additionally use logarithmic radial
 * bands so a narrow vent between pilot samples is not missed. Their incremental
 * density is divided by overlapping cap coverage, rather than adding footprints.
 * At most 32 cap quadratures are selected by requested-work importance. Spatial
 * trees evaluate the complete cap field and coverage without a quadratic scan.
 *
 * These rounded values are order-of-magnitude planning estimates, not upper
 * bounds or allocation guarantees. Geometry, fields, browser overhead, transfer
 * sparsity, and remeshing affect actual storage. The 1/3 KiB retained/peak model
 * is calibrated to current world buffers and excludes renderer/GPU allocations.
 */
export function estimateRefinementWork(
  pilot: Grid,
  value: ResolvedRefinementPlan,
): RefinementWorkEstimate {
  const plan = validateResolvedRefinementPlan(value);
  if (pilot.count !== plan.cellCount) {
    throw Error('Refinement work estimation requires the plan’s pilot mesh.');
  }

  const samplePilot = createGradedSpacingField(
    pilot,
    Float64Array.from(plan.targetSpacingMetres),
    plan.radiusMetres,
    plan.baseSpacingMetres,
    plan.gradation,
    Float64Array.from(plan.sourceRadiiMetres),
  );
  return estimatePreparedRefinementWork(pilot, plan, samplePilot);
}

/** Sparse geographic actions need no pair of full per-cell background arrays. */
export function estimateRegionalRefinementWork(
  pilot: Grid,
  plan: ResolvedRegionalRefinement,
): RefinementWorkEstimate {
  let previous = 0;
  const existingSpacing: SpacingField = (x, y, z) => {
    previous = nearestCell(pilot, x, y, z, previous);
    // The retained mesh already pays for this local density. Subtract it from
    // each cap's requested work, rather than comparing with a coarse global
    // background that can hide additions to an already dense adaptive globe.
    return Math.sqrt(pilot.areas[previous] * IRREGULAR_DENSITY) * plan.planetRadiusMetres;
  };
  return estimatePreparedRefinementWork(
    pilot,
    {
      radiusMetres: plan.planetRadiusMetres,
      baseSpacingMetres: plan.baseSpacingMetres,
      gradation: plan.gradation,
      volcanicCaps: plan.caps.map((cap) => ({
        position: cap.center,
        radiusMetres: cap.radiusMetres,
        targetSpacingMetres: Math.min(plan.request.targetSpacingMetres, plan.baseSpacingMetres),
      })),
    },
    existingSpacing,
    true,
  );
}

const IRREGULAR_DENSITY = (2 / Math.sqrt(3)) * 1.3;

function estimatePreparedRefinementWork(
  pilot: Grid,
  plan: Pick<
    ResolvedRefinementPlan,
    'radiusMetres' | 'baseSpacingMetres' | 'gradation' | 'volcanicCaps'
  >,
  samplePilot: SpacingField,
  retainExisting = false,
): RefinementWorkEstimate {
  const radius = plan.radiusMetres;
  const radiusSquared = radius * radius;
  let integral = 0;
  let sampledDirections = 0;

  // Half of each cell's support is sampled at its center, and half is shared
  // across its polygon corners. All weights sum to the physical sphere area.
  for (let cell = 0; !retainExisting && cell < pilot.count; cell++) {
    const spacing = samplePilot(
      pilot.positions[cell * 3],
      pilot.positions[cell * 3 + 1],
      pilot.positions[cell * 3 + 2],
    );
    integral += (0.5 * pilot.areas[cell] * radiusSquared) / spacing ** 2;
    sampledDirections++;
  }

  for (let corner = 0; !retainExisting && corner < pilot.corners.length / 3; corner++) {
    let weight = 0;
    for (let incident = 0; incident < 3; incident++) {
      const cell = pilot.triangles[corner * 3 + incident];
      weight += pilot.areas[cell] / (pilot.offsets[cell + 1] - pilot.offsets[cell]);
    }
    const spacing = samplePilot(
      pilot.corners[corner * 3],
      pilot.corners[corner * 3 + 1],
      pilot.corners[corner * 3 + 2],
    );
    integral += (0.5 * weight * radiusSquared) / spacing ** 2;
    sampledDirections++;
  }

  const caps: IntegrationCap[] = [];
  const seen = new Set<string>();
  for (const cap of plan.volcanicCaps) {
    const identity = JSON.stringify([cap.position, cap.radiusMetres, cap.targetSpacingMetres]);
    if (cap.targetSpacingMetres === plan.baseSpacingMetres || seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    caps.push({
      x: cap.position[0],
      y: cap.position[1],
      z: cap.position[2],
      radius: cap.radiusMetres,
      target: cap.targetSpacingMetres,
      influenceRadius: Math.min(
        Math.PI * radius,
        cap.radiusMetres + (plan.baseSpacingMetres - cap.targetSpacingMetres) / plan.gradation,
      ),
    });
  }

  const capPositions = new Float64Array(caps.length * 3);
  const capTargets = new Float64Array(caps.length);
  const capRadii = new Float64Array(caps.length);
  const weights = new Float64Array(caps.length);
  let totalWeight = 0;
  for (let index = 0; index < caps.length; index++) {
    const cap = caps[index];
    capPositions.set([cap.x, cap.y, cap.z], index * 3);
    capTargets[index] = cap.target;
    capRadii[index] = cap.radius;
    // A cheap isolated-cap mass proxy gives tiny, very fine sources a chance
    // proportional to their requested work, rather than their angular size.
    const plateau = 4 * Math.PI * radiusSquared * Math.sin(cap.radius / (2 * radius)) ** 2;
    weights[index] =
      plateau * (1 / cap.target ** 2 - 1 / plan.baseSpacingMetres ** 2) +
      ((2 * Math.PI) / plan.gradation ** 2) * Math.log(plan.baseSpacingMetres / cap.target) +
      ((2 * Math.PI * cap.radius) / plan.gradation) * (1 / cap.target - 1 / plan.baseSpacingMetres);
    totalWeight += weights[index];
  }
  const sampleVolcanic = createGradedSpacingField(
    { count: caps.length, positions: capPositions },
    capTargets,
    radius,
    plan.baseSpacingMetres,
    plan.gradation,
    capRadii,
  );
  const coverageAt = createCoverageCounter(caps, radius);
  const selectedCaps = new Map<number, number>();
  if (caps.length <= 32) {
    for (let index = 0; index < caps.length; index++) {
      selectedCaps.set(index, 1);
    }
  } else {
    let index = 0;
    let cumulative = weights[0];
    for (let sample = 0; sample < 32; sample++) {
      const target = ((sample + 0.5) * totalWeight) / 32;
      while (index + 1 < caps.length && cumulative < target) {
        cumulative += weights[++index];
      }
      selectedCaps.set(index, (selectedCaps.get(index) ?? 0) + totalWeight / (32 * weights[index]));
    }
  }
  const radialFractions = [0.5 - Math.sqrt(1 / 12), 0.5 + Math.sqrt(1 / 12)];
  const azimuthSamples = 16;
  for (const [capIndex, samplingWeight] of selectedCaps) {
    const cap = caps[capIndex];
    // A stable tangent basis covers seam-crossing and polar caps identically.
    const horizontal = Math.hypot(cap.x, cap.z);
    const tangentX = horizontal > 1e-12 ? -cap.z / horizontal : 1;
    const tangentY = 0;
    const tangentZ = horizontal > 1e-12 ? cap.x / horizontal : 0;
    const otherX = cap.y * tangentZ - cap.z * tangentY;
    const otherY = cap.z * tangentX - cap.x * tangentZ;
    const otherZ = cap.x * tangentY - cap.y * tangentX;
    const boundaries = [0];
    if (cap.radius > 0) {
      boundaries.push(cap.radius);
    }
    let spacing = cap.target;
    while (boundaries[boundaries.length - 1] < cap.influenceRadius) {
      spacing = Math.min(plan.baseSpacingMetres, spacing * 2);
      boundaries.push(
        Math.min(cap.influenceRadius, cap.radius + (spacing - cap.target) / plan.gradation),
      );
    }

    for (let band = 1; band < boundaries.length; band++) {
      const inner = boundaries[band - 1] / radius;
      const outer = boundaries[band] / radius;
      const innerHalfSineSquared = Math.sin(inner / 2) ** 2;
      const halfSineSquaredSpan = Math.sin(outer / 2) ** 2 - innerHalfSineSquared;
      const bandArea =
        4 * Math.PI * radiusSquared * Math.sin((inner + outer) / 2) * Math.sin((outer - inner) / 2);
      const sampleArea = bandArea / (radialFractions.length * azimuthSamples);

      for (const fraction of radialFractions) {
        const angle =
          2 *
          Math.asin(Math.sqrt(Math.min(1, innerHalfSineSquared + fraction * halfSineSquaredSpan)));
        const radial = Math.cos(angle);
        const tangent = Math.sin(angle);
        for (let azimuth = 0; azimuth < azimuthSamples; azimuth++) {
          const rotation = (2 * Math.PI * (azimuth + 0.5)) / azimuthSamples;
          const firstWeight = tangent * Math.cos(rotation);
          const secondWeight = tangent * Math.sin(rotation);
          const x = cap.x * radial + tangentX * firstWeight + otherX * secondWeight;
          const y = cap.y * radial + tangentY * firstWeight + otherY * secondWeight;
          const z = cap.z * radial + tangentZ * firstWeight + otherZ * secondWeight;
          const coverage = coverageAt(x, y, z);
          const volcanicSpacing = sampleVolcanic(x, y, z);
          const pilotSpacing = samplePilot(x, y, z);
          // Dividing by union coverage forms a partition of unity across cap
          // quadratures, including coincident and differently sized footprints.
          integral +=
            (samplingWeight *
              sampleArea *
              Math.max(0, 1 / volcanicSpacing ** 2 - 1 / pilotSpacing ** 2)) /
            Math.max(1, coverage);
          sampledDirections++;
        }
      }
    }
  }

  const estimatedCells = retainExisting
    ? pilot.count + roundEstimate(integral * IRREGULAR_DENSITY)
    : Math.max(pilot.count, roundEstimate(integral * IRREGULAR_DENSITY));
  return {
    estimatedCells,
    estimatedAddedCells: estimatedCells - pilot.count,
    estimatedRetainedMiB: roundEstimate(estimatedCells / 1024),
    estimatedPeakMiB: roundEstimate((estimatedCells * 3) / 1024),
    sampledDirections,
    method: 'physical-spacing-quadrature',
    uncertainty: 'order-of-magnitude',
    sampledCaps: selectedCaps.size,
    totalCaps: caps.length,
  };
}
