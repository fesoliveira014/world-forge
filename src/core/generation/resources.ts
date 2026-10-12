import type { Deposit, FormationCause, Geology, Grid } from '../model';
import {
  clamp,
  createNoise,
  createSeededRandom,
  cross,
  normalizeVector,
  readVector,
} from '../math';
import { nearestCell } from '../grid/build';
import { referencePoint } from './crust-evolution';
import { RESOURCE_PRESETS, type ResourcePreset } from '../resource-presets';

/** Primary placement deliberately cannot inspect fine terrain, climate, or display cells. */
export interface DepositEnvironment {
  process: Grid;
  geology: Geology;
  referenceOceanMask: Uint8Array;
  seed: string;
  radius: number;
}

interface ResourceSettings {
  depositFrequency: number;
  depositAmount: number;
}

function causeSuitability(
  cause: FormationCause,
  continental: number,
  retained: boolean,
  magmatic: number,
  compression: number,
  fracture: number,
): number {
  switch (cause) {
    case 'inherited-sedimentary':
      return retained ? continental : 0;
    case 'selected-intrusive':
      return continental * magmatic * (0.6 + 0.4 * compression);
    case 'deformation-associated':
      return continental * compression * (0.55 + 0.45 * fracture);
    case 'selected-volcanic':
      return magmatic * (0.3 + 0.7 * continental);
    case 'magmatic-hydrothermal':
      return magmatic * (0.45 + 0.55 * fracture);
  }
}

/** Reuse caller-owned cause weights when scanning a resource's process cells. */
function evaluateSuitability(
  environment: DepositEnvironment,
  processCell: number,
  preset: ResourcePreset,
  noise: ReturnType<typeof createNoise>,
  causeWeights: Float64Array,
): number {
  causeWeights.fill(0);
  if (environment.referenceOceanMask[processCell]) {
    return 0;
  }

  const { process, geology, radius } = environment;
  const crust = geology.crust;
  const retained = !crust || crust.material[processCell] === 1;
  const direction = readVector(process.positions, processCell);
  const materialDirection =
    crust && retained
      ? referencePoint(crust.inverse, geology.plate[processCell], ...direction)
      : direction;
  const scale = radius / (preset.maskScaleKm * 1000);
  const maskSample =
    0.5 +
    0.5 *
      noise(
        materialDirection[0] * scale,
        materialDirection[1] * scale,
        materialDirection[2] * scale,
      );
  const maskRamp = clamp((maskSample - preset.maskThreshold) / 0.3);
  const eligibility = maskRamp * maskRamp * (3 - 2 * maskRamp);
  const continental = clamp((geology.continental[processCell] - 0.35) / 0.5);
  const magmatic = Math.max(
    clamp(geology.volcanism[processCell] / 1500),
    clamp((crust?.volcanic[processCell] ?? 0) / 4000),
  );
  const compression = clamp(
    Math.max(0, geology.uplift[processCell], crust?.deformation[processCell] ?? 0) / 2600,
  );
  let fracture = 0;

  // Boundary IDs are per process edge. They are never indexed by a cell ID.
  for (
    let offset = process.offsets[processCell];
    offset < process.offsets[processCell + 1];
    offset++
  ) {
    if (geology.boundary[process.arcEdges[offset]] > 0) {
      fracture = 1;
      break;
    }
  }

  let total = 0;
  for (let causeIndex = 0; causeIndex < preset.causes.length; causeIndex++) {
    const rule = preset.causes[causeIndex];
    const weight =
      eligibility *
      rule.weight *
      causeSuitability(rule.cause, continental, retained, magmatic, compression, fracture);
    causeWeights[causeIndex] = weight;
    total += weight;
  }
  return total;
}

function selectWeightedIndex(cumulative: Float64Array, value: number): number {
  let lower = 0;
  let upper = cumulative.length - 1;
  while (lower < upper) {
    const middle = (lower + upper) >>> 1;
    if (cumulative[middle] <= value) {
      lower = middle + 1;
    } else {
      upper = middle;
    }
  }
  return lower;
}

/** A spherical offset in a physical disk; display mesh subdivision is irrelevant. */
function nearbyAnchor(
  center: [number, number, number],
  angularRadius: number,
  random: () => number,
): [number, number, number] {
  const east = normalizeVector(cross(Math.abs(center[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], center));
  const north = cross(center, east);
  const distance = angularRadius * Math.sqrt(random());
  const bearing = random() * 2 * Math.PI;
  return normalizeVector(
    center.map(
      (component, axis) =>
        component * Math.cos(distance) +
        Math.sin(distance) * (east[axis] * Math.cos(bearing) + north[axis] * Math.sin(bearing)),
    ),
  );
}

/** Retrospective initial endowment. Rendering and history never call this routine. */
export function generateDeposits(
  environment: DepositEnvironment,
  settings: ResourceSettings,
  presets: readonly ResourcePreset[] = RESOURCE_PRESETS,
): Deposit[] {
  const deposits: Deposit[] = [];
  if (settings.depositFrequency === 0) {
    return deposits;
  }
  const cumulativeArea = new Float64Array(environment.process.count);
  const radiusKmSquared = (environment.radius / 1000) ** 2;

  for (const preset of presets) {
    const familySeed = `${environment.seed}/resources/${preset.type}`;
    const placementRandom = createSeededRandom(`${familySeed}/placement-${preset.revision}`);
    const eligibilityNoise = createNoise(`${familySeed}/eligibility-${preset.revision}`);
    const causeWeights = new Float64Array(preset.causes.length);
    let eligibleAreaKm2 = 0;

    for (let processCell = 0; processCell < environment.process.count; processCell++) {
      const suitability = evaluateSuitability(
        environment,
        processCell,
        preset,
        eligibilityNoise,
        causeWeights,
      );
      eligibleAreaKm2 += suitability * environment.process.areas[processCell] * radiusKmSquared;
      cumulativeArea[processCell] = eligibleAreaKm2;
    }

    const expectedClusters =
      (eligibleAreaKm2 / 1e6) * preset.clustersPerMillionKm2 * settings.depositFrequency;
    const clusterCount = Math.floor(expectedClusters) + +(placementRandom() < expectedClusters % 1);

    for (let clusterIndex = 0; clusterIndex < clusterCount; clusterIndex++) {
      const anchorCell = selectWeightedIndex(cumulativeArea, placementRandom() * eligibleAreaKm2);
      const center = readVector(environment.process.positions, anchorCell);
      const memberCount = 1 + Math.floor(placementRandom() * 4);

      for (let memberIndex = 0; memberIndex < memberCount; memberIndex++) {
        for (let attempt = 0; attempt < 6; attempt++) {
          const anchor = nearbyAnchor(
            center,
            (preset.clusterRadiusKm * 1000) / environment.radius,
            placementRandom,
          );
          const processCell = nearestCell(environment.process, ...anchor, anchorCell);
          const suitability = evaluateSuitability(
            environment,
            processCell,
            preset,
            eligibilityNoise,
            causeWeights,
          );
          if (suitability <= 0) {
            continue;
          }

          let causeIndex = 0;
          let choice = placementRandom() * suitability;
          while (causeIndex < causeWeights.length - 1 && choice >= causeWeights[causeIndex]) {
            choice -= causeWeights[causeIndex++];
          }

          const id = `${preset.type}:${clusterIndex}:${memberIndex}`;
          const amountRandom = createSeededRandom(`${familySeed}/${id}/amount-${preset.revision}`);
          const extentRandom = createSeededRandom(`${familySeed}/${id}/extent-${preset.revision}`);
          const [minimumAmount, maximumAmount] = preset.amountRange;
          const [minimumExtent, maximumExtent] = preset.extentRangeKm;
          deposits.push({
            id,
            resourceType: preset.type,
            anchor,
            extentKm: minimumExtent + (maximumExtent - minimumExtent) * extentRandom(),
            amount: Math.round(
              (minimumAmount + (maximumAmount - minimumAmount) * amountRandom() ** 2) *
                settings.depositAmount,
            ),
            formationCause: preset.causes[causeIndex].cause,
          });
          break;
        }
      }
    }
  }
  return deposits;
}
