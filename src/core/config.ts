import type { WorldConfig } from './model';

export type NumericSetting = Exclude<keyof WorldConfig, 'seed'>;

export interface Setting {
  key: NumericSetting;
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  description: string;
}

/** Shared by project-file validation and the UI. Every control changes a generation stage. */
export const SETTING_GROUPS: { name: string; settings: Setting[] }[] = [
  {
    name: 'Minerals & fertility',
    settings: [
      {
        key: 'depositFrequency',
        label: 'Deposit frequency',
        min: 0,
        max: 4,
        step: 0.1,
        unit: '×',
        description:
          'Regional mineral occurrence frequency. Zero omits deposits; fertility is still calculated.',
      },
      {
        key: 'depositAmount',
        label: 'Deposit amount',
        min: 0.1,
        max: 4,
        step: 0.1,
        unit: '×',
        description:
          'Abstract quantity per deposit. Changes amounts without changing deposit locations.',
      },
    ],
  },
  {
    name: 'Geometry & continents',
    settings: [
      {
        key: 'processLevel',
        label: 'Simulation detail',
        min: 3,
        max: 7,
        step: 1,
        description:
          'Climate and plate grid subdivision. The highest level is much slower; surface detail can increase independently.',
      },
      {
        key: 'irregularity',
        label: 'Cell irregularity',
        min: 0,
        max: 1,
        step: 0.05,
        description: 'Jitter of spherical cells.',
      },
      {
        key: 'oceanFraction',
        label: 'Ocean coverage',
        min: 0.2,
        max: 0.85,
        step: 0.01,
        description: 'Target fraction beneath the sea-level datum.',
      },
      {
        key: 'continentScale',
        label: 'Continent size',
        min: 0.5,
        max: 1.7,
        step: 0.05,
        unit: '×',
        description: 'Larger values create broader continental masses.',
      },
      {
        key: 'reliefScale',
        label: 'Terrain height',
        min: 0.4,
        max: 1.8,
        step: 0.05,
        unit: '×',
        description: 'Vertical scale of plains and concentrated mountain relief.',
      },
      {
        key: 'radius',
        label: 'Planet radius',
        min: 3000000,
        max: 12000000,
        step: 100000,
        unit: 'km',
        description: 'Sets physical cell areas and transport distances.',
      },
    ],
  },
  {
    name: 'Lithosphere',
    settings: [
      {
        key: 'tectonicDuration',
        label: 'Geological duration',
        min: 0,
        max: 300,
        step: 10,
        unit: 'Myr',
        description:
          'Move crust and accumulate deformation before climate. Zero keeps the initial geography.',
      },
      {
        key: 'plateSpeed',
        label: 'Plate motion',
        min: 0,
        max: 8,
        step: 0.5,
        unit: 'cm/yr',
        description:
          'Scale of prescribed plate velocities. Individual plates have different axes and speeds.',
      },
      {
        key: 'plates',
        label: 'Tectonic plates',
        min: 6,
        max: 32,
        step: 1,
        description: 'Initial connected major, minor and microplate regions whose crust is moved.',
      },
      {
        key: 'exposure',
        label: 'Tectonic activity',
        min: 0,
        max: 2,
        step: 0.05,
        unit: '×',
        description: 'Strength of collision, subduction, rifts and ridges.',
      },
      {
        key: 'tectonicWidth',
        label: 'Mountain belt width',
        min: 0.4,
        max: 1.8,
        step: 0.05,
        unit: '×',
        description: 'Physical width of tectonic features.',
      },
      {
        key: 'volcanicActivity',
        label: 'Volcanic construction',
        min: 0,
        max: 2,
        step: 0.1,
        unit: '×',
        description:
          'Rock built at subduction arcs, spreading faults, and hotspots over geological time.',
      },
      {
        key: 'hotspotCount',
        label: 'Intraplate hotspots',
        min: 0,
        max: 24,
        step: 1,
        description:
          'Seeded volcanic sources with finite lifetimes. Moving plates carry their island and plateau tracks.',
      },
      {
        key: 'erosion',
        label: 'Erosion',
        min: 0,
        max: 1,
        step: 0.05,
        description:
          'Rain, slope weathering, river incision, and sediment delivery. Geological duration sets landscape aging.',
      },
      {
        key: 'waveErosion',
        label: 'Coastal erosion',
        min: 0,
        max: 2,
        step: 0.1,
        unit: '×',
        description:
          'Wave attack on exposed coasts, with variable rock resistance and wind exposure.',
      },
      {
        key: 'windErosion',
        label: 'Wind erosion',
        min: 0,
        max: 2,
        step: 0.1,
        unit: '×',
        description:
          'Deflation of dry weathered ground. Weaker where moisture protects the surface.',
      },
    ],
  },
  {
    name: 'Atmosphere & ocean',
    settings: [
      {
        key: 'temperature',
        label: 'Climate warmth',
        min: -5,
        max: 30,
        step: 1,
        unit: '°C',
        description: 'Global thermal baseline before latitude and elevation.',
      },
      {
        key: 'obliquity',
        label: 'Axial tilt',
        min: 0,
        max: 40,
        step: 1,
        unit: '°',
        description: 'Strength of seasonal heating and circulation migration.',
      },
      {
        key: 'windStrength',
        label: 'Wind strength',
        min: 0.5,
        max: 3,
        step: 0.1,
        unit: '×',
        description: 'Actual moisture advection speed.',
      },
      {
        key: 'circulationScale',
        label: 'Wind whorl size',
        min: 0.6,
        max: 1.5,
        step: 0.05,
        unit: '×',
        description: 'Angular reach of regional atmospheric circulation.',
      },
      {
        key: 'currentStrength',
        label: 'Ocean currents',
        min: 0,
        max: 3,
        step: 0.1,
        unit: '×',
        description: 'Ocean heat transport through coast-blocked gyres.',
      },
      {
        key: 'evaporationScale',
        label: 'Ocean evaporation',
        min: 0.5,
        max: 2,
        step: 0.05,
        unit: '×',
        description: 'Moisture supply from sea temperature, wind and humidity.',
      },
      {
        key: 'moistureLifetime',
        label: 'Moisture residence',
        min: 6,
        max: 30,
        step: 1,
        unit: 'days',
        description: 'Longer residence allows moisture to travel farther inland.',
      },
      {
        key: 'moistureMixing',
        label: 'Atmospheric mixing',
        min: 0,
        max: 1600000,
        step: 100000,
        unit: 'm²/s',
        description: 'Conservative eddy diffusion in physical units, independent of cell size.',
      },
      {
        key: 'orographicStrength',
        label: 'Mountain rainout',
        min: 0,
        max: 2,
        step: 0.1,
        unit: '×',
        description: 'Rainfall caused by wind rising over mountains.',
      },
    ],
  },
  {
    name: 'Land & water',
    settings: [
      {
        key: 'lakePersistence',
        label: 'Lake persistence',
        min: 0,
        max: 1,
        step: 0.05,
        description:
          'Higher values preserve depressions during geological sediment infill. Lower values let more old basins become plains.',
      },
      {
        key: 'recycling',
        label: 'Moisture recycling',
        min: 0,
        max: 1,
        step: 0.05,
        description:
          'Fraction of available land evapotranspiration returned in the final climate pass.',
      },
      {
        key: 'soilCapacity',
        label: 'Soil water storage',
        min: 20,
        max: 300,
        step: 10,
        unit: 'mm',
        description: 'Soil bucket capacity before overflow becomes runoff.',
      },
      {
        key: 'infiltration',
        label: 'Soil infiltration',
        min: 0.5,
        max: 1,
        step: 0.025,
        description: 'Fraction entering soil; the remainder feeds storm runoff and tributaries.',
      },
      {
        key: 'floodplainExtent',
        label: 'Floodplain extent',
        min: 0.5,
        max: 2,
        step: 0.1,
        unit: '×',
        description:
          'Width of fertile river corridors and seasonal floodplains. Large rivers in gentle valleys expand most; high banks still limit access.',
      },
      {
        key: 'fluvialDuration',
        label: 'River evolution duration',
        min: 0,
        max: 5,
        step: 0.25,
        unit: 'Myr',
        description:
          'Recent landscape time for river incision and migration. Uses the generated climate; this is not the age of every river. Requires erosion above zero.',
      },
      {
        key: 'bankMobility',
        label: 'Riverbank mobility',
        min: 0,
        max: 2,
        step: 0.1,
        unit: '×',
        description:
          'Lateral migration and cutoff bends on gentle alluvial plains. Steep or confined channels remain narrow.',
      },
      {
        key: 'riverSourceArea',
        label: 'Headwater catchment',
        min: 1000,
        max: 30000,
        step: 1000,
        unit: 'km²',
        description:
          'Minimum upstream land area for a river to start. Larger values create fewer tributaries.',
      },
      {
        key: 'riverSourceFlow',
        label: 'Headwater water supply',
        min: 0.1,
        max: 20,
        step: 0.1,
        unit: 'm³/s',
        description:
          'Minimum soil drainage, overflow, or reservoir release at a source. Storm runoff alone cannot start a river.',
      },
    ],
  },
];

export function validateConfig(config: WorldConfig) {
  if (typeof config.seed !== 'string' || !config.seed.trim() || config.seed.length > 100) {
    throw Error('Enter a seed of 1–100 characters.');
  }

  const settings = SETTING_GROUPS.flatMap((group) => group.settings);
  settings.push({
    key: 'surfaceLevel',
    label: 'Surface detail',
    min: 3,
    max: 9,
    step: 1,
    description: '',
  });

  for (const setting of settings) {
    const value = config[setting.key];

    if (
      !Number.isFinite(value) ||
      value < setting.min ||
      value > setting.max ||
      (['plates', 'hotspotCount', 'surfaceLevel', 'processLevel'].includes(setting.key) &&
        !Number.isInteger(value))
    ) {
      throw Error(`${setting.label} is outside the supported range.`);
    }
  }

  if (config.processLevel > config.surfaceLevel) {
    throw Error('Simulation detail cannot exceed surface detail.');
  }
}
