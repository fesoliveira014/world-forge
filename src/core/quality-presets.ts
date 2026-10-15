import type { WorldConfig } from './model';

const QUALITY_SETTINGS = [
  'surfaceLevel',
  'processLevel',
  'refinementMinSpacing',
  'refinementStrength',
  'evolutionRefinements',
  'featureRefinementPasses',
  'featureRefinementSpacing',
  'featureRefinementBudget',
  'featureDistrictStrength',
  'featureDistrictRadius',
  'featureDistrictThreshold',
  'featureCoarseningBudget',
  'featureCoarseningSpacing',
  'featureCoarseningTolerance',
  'landscapeBatches',
] as const;

export interface QualityPreset {
  id: string;
  label: string;
  settings: Pick<WorldConfig, (typeof QUALITY_SETTINGS)[number]>;
  referenceCost: string;
}

export const QUALITY_PRESETS: readonly QualityPreset[] = [
  {
    id: 'quick',
    label: 'Quick preview',
    settings: {
      surfaceLevel: 4,
      processLevel: 3,
      refinementMinSpacing: 100000,
      refinementStrength: 0.6,
      evolutionRefinements: 1,
      featureRefinementPasses: 0,
      featureRefinementSpacing: 10000,
      featureRefinementBudget: 20,
      featureDistrictStrength: 0,
      featureDistrictRadius: 300000,
      featureDistrictThreshold: 5,
      featureCoarseningBudget: 0,
      featureCoarseningSpacing: 250000,
      featureCoarseningTolerance: 25,
      landscapeBatches: 4,
    },
    referenceCost: 'A smaller world for faster previews and regional experiments.',
  },
  {
    id: 'balanced',
    label: 'Balanced cloud',
    settings: {
      surfaceLevel: 6,
      processLevel: 6,
      refinementMinSpacing: 50000,
      refinementStrength: 0.8,
      evolutionRefinements: 2,
      featureRefinementPasses: 1,
      featureRefinementSpacing: 10000,
      featureRefinementBudget: 20,
      featureDistrictStrength: 60,
      featureDistrictRadius: 300000,
      featureDistrictThreshold: 5,
      featureCoarseningBudget: 10,
      featureCoarseningSpacing: 250000,
      featureCoarseningTolerance: 25,
      landscapeBatches: 12,
    },
    referenceCost:
      '40,962 base terrain and weather cells, with adaptive detail around features and lake districts. Final passes can insert up to 20% of the pre-pass count and remove up to 10% from quiet land, adding generation work.',
  },
];

export function matchingQualityPreset(config: WorldConfig): QualityPreset | undefined {
  return QUALITY_PRESETS.find((preset) =>
    QUALITY_SETTINGS.every((key) => config[key] === preset.settings[key]),
  );
}

/** Quality changes must preserve the seed, physical world settings and material controls. */
export function applyQualityPreset(config: WorldConfig, preset: QualityPreset): WorldConfig {
  return { ...config, ...preset.settings };
}
