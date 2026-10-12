import type { FormationCause, ResourceType } from './model';

export const RESOURCE_RECIPE = 'resources-1';

export interface ResourcePreset {
  type: ResourceType;
  name: string;
  color: string;
  revision: string;
  maskScaleKm: number;
  maskThreshold: number;
  clustersPerMillionKm2: number;
  clusterRadiusKm: number;
  amountRange: readonly [number, number];
  extentRangeKm: readonly [number, number];
  causes: readonly { cause: FormationCause; weight: number }[];
}

/** Worldbuilding presets. The environment supplies context, not mineral chemistry.
 * Amount ranges are abstract and comparable only within a resource family.
 */
export const RESOURCE_PRESETS: readonly ResourcePreset[] = [
  {
    type: 'copper',
    name: 'Copper',
    color: '#ee9a68',
    revision: 'v1',
    maskScaleKm: 650,
    maskThreshold: 0.3,
    clustersPerMillionKm2: 1.8,
    clusterRadiusKm: 160,
    amountRange: [2000, 40000],
    extentRangeKm: [3, 18],
    causes: [{ cause: 'magmatic-hydrothermal', weight: 1 }],
  },
  {
    type: 'tin',
    name: 'Tin',
    color: '#bed6e5',
    revision: 'v1',
    maskScaleKm: 450,
    maskThreshold: 0.53,
    clustersPerMillionKm2: 1.4,
    clusterRadiusKm: 100,
    amountRange: [300, 6000],
    extentRangeKm: [2, 10],
    causes: [{ cause: 'selected-intrusive', weight: 1 }],
  },
  {
    type: 'iron',
    name: 'Iron',
    color: '#ec776c',
    revision: 'v1',
    maskScaleKm: 850,
    maskThreshold: 0.35,
    clustersPerMillionKm2: 0.9,
    clusterRadiusKm: 220,
    amountRange: [8000, 80000],
    extentRangeKm: [5, 30],
    causes: [{ cause: 'inherited-sedimentary', weight: 1 }],
  },
  {
    type: 'gold',
    name: 'Gold',
    color: '#f6d36e',
    revision: 'v1',
    maskScaleKm: 550,
    maskThreshold: 0.43,
    clustersPerMillionKm2: 0.9,
    clusterRadiusKm: 130,
    amountRange: [100, 3000],
    extentRangeKm: [2, 12],
    causes: [
      { cause: 'magmatic-hydrothermal', weight: 0.55 },
      { cause: 'deformation-associated', weight: 0.45 },
    ],
  },
  {
    type: 'corundum',
    name: 'Ruby / sapphire',
    color: '#bb9cfa',
    revision: 'v1',
    maskScaleKm: 420,
    maskThreshold: 0.53,
    clustersPerMillionKm2: 0.9,
    clusterRadiusKm: 90,
    amountRange: [30, 1500],
    extentRangeKm: [1, 8],
    causes: [
      { cause: 'deformation-associated', weight: 0.65 },
      { cause: 'selected-volcanic', weight: 0.35 },
    ],
  },
];

export const FORMATION_NAMES: Record<FormationCause, string> = {
  'magmatic-hydrothermal': 'Magmatic / hydrothermal setting',
  'selected-intrusive': 'Selected intrusive setting',
  'deformation-associated': 'Deformation-associated setting',
  'inherited-sedimentary': 'Inherited sedimentary mineralization',
  'selected-volcanic': 'Selected volcanic gemstone setting',
};

/** Artistic response scales, not measured soil constants or crop requirements. */
export const FERTILITY_PRESET = {
  baselineGround: 0.35,
  sedimentWeight: 0.4,
  volcanicWeight: 0.25,
  sedimentScaleMetres: 12,
  adequateRainPetRatio: 0.9,
  volcanicScaleMetres: 1500,
  volcanicMaturationMyr: 2,
  freshCoverScaleMetres: 1500,
  shoreWidthMetres: 2500,
  shoreAccessHeightMetres: 4,
  slopeScale: 0.04,
  maximumWetnessPenalty: 0.3,
};

export function resourcePreset(type: ResourceType): ResourcePreset {
  return RESOURCE_PRESETS.find((preset) => preset.type === type)!;
}
