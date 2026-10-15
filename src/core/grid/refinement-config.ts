import { DEFAULT_CONFIG, type WorldConfig } from '../model';

const OPTIONAL_DEFAULTS = [
  ['featureRefinementPasses', DEFAULT_CONFIG.featureRefinementPasses],
  ['featureRefinementSpacing', DEFAULT_CONFIG.featureRefinementSpacing],
  ['featureRefinementBudget', DEFAULT_CONFIG.featureRefinementBudget],
  ['featureDistrictStrength', DEFAULT_CONFIG.featureDistrictStrength],
  ['featureDistrictRadius', DEFAULT_CONFIG.featureDistrictRadius],
  ['featureDistrictThreshold', DEFAULT_CONFIG.featureDistrictThreshold],
  ['featureCoarseningBudget', DEFAULT_CONFIG.featureCoarseningBudget],
  ['featureCoarseningSpacing', DEFAULT_CONFIG.featureCoarseningSpacing],
  ['featureCoarseningTolerance', DEFAULT_CONFIG.featureCoarseningTolerance],
  ['salinityYears', DEFAULT_CONFIG.salinityYears],
  ['weatheringSalinity', DEFAULT_CONFIG.weatheringSalinity],
  ['inheritedMarineSalinity', DEFAULT_CONFIG.inheritedMarineSalinity],
] as const;

function serialize(entries: Iterable<readonly [string, string | number]>): string {
  const fields = new Map(entries);
  for (const [key, value] of OPTIONAL_DEFAULTS) {
    if (!fields.has(key)) {
      fields.set(key, value);
    }
  }
  return JSON.stringify(
    [...fields].sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0)),
  );
}

/** Stable physical recipe identity, defaulting absent controls from older recipes. */
export function refinementConfigSignature(config: WorldConfig): string {
  return serialize(Object.entries(config));
}

/** Old plans predate final-feature and salinity settings. Preserve all other fields and reject
 * malformed signatures; this does not relax mesh or physical-recipe matching.
 */
export function normalizedRefinementConfigSignature(signature: string): string | null {
  let entries: unknown;
  try {
    entries = JSON.parse(signature);
  } catch {
    return null;
  }
  if (!Array.isArray(entries)) {
    return null;
  }
  const keys = new Set<string>();
  for (const entry of entries) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string' ||
      keys.has(entry[0]) ||
      !(typeof entry[1] === 'string' || (typeof entry[1] === 'number' && Number.isFinite(entry[1])))
    ) {
      return null;
    }
    keys.add(entry[0]);
  }
  return serialize(entries as [string, string | number][]);
}
