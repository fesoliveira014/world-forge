import { LinearColor as Color } from './linear-color';
import type { CellRecord } from './records';
import type { Layer } from '../model';
import { clamp } from '../math';

export const RIVER_SOURCE_COLORS = [
  '#344b4b',
  '#69b5dc',
  '#d7edf0',
  '#b4a2d8',
  '#5e91d7',
  '#83b477',
  '#d9bf80',
];

export const WETLAND_COLORS = ['#344b4b', '#619d91', '#315e54', '#9ab78b', '#9a8a68'];

const wetlandColors = WETLAND_COLORS.map((color) => new Color(color));
const resourceUplandColor = new Color('#829087');

export const BIOME_COLORS = [
  '#123c52',
  '#dcebef',
  '#aab5a3',
  '#436451',
  '#588468',
  '#a0a16a',
  '#c6ae73',
  '#9eaa68',
  '#37795a',
  '#22634e',
  '#92905a',
  '#4a9790',
  '#3b9cbb',
];

export interface LayerInfo {
  id: Layer;
  name: string;
  group: string;
  description: string;
  unit: string;
  stops: string[];
  labels: string[];
}

export const LAYERS: LayerInfo[] = [
  {
    id: 'resources',
    name: 'Minerals & gemstones',
    group: 'Resources',
    description:
      'Geological deposits with finite amounts. Select a marker to inspect its resource, extent, and formation setting.',
    unit: 'Initial endowment',
    stops: ['#ee9a68', '#bed6e5', '#ec776c', '#f6d36e', '#bb9cfa'],
    labels: ['Copper', 'Tin', 'Iron', 'Gold', 'Gems'],
  },
  {
    id: 'fertility',
    name: 'Fertility',
    group: 'Resources',
    description:
      'General land potential from sediment, water, rain and volcanic ground. Inspect the local river corridor separately.',
    unit: 'Potential · 0–100',
    stops: ['#704d42', '#b39a65', '#b9ce87', '#64b28b', '#238b80'],
    labels: ['0', '25', '50', '75', '100'],
  },
  {
    id: 'world',
    name: 'Natural world',
    group: 'Overview',
    description: 'Terrain, vegetation, water, and ice in one view.',
    unit: 'Surface',
    stops: ['#0a2948', '#285a3c', '#7c8a51', '#c2b185', '#e3edf0'],
    labels: ['Ocean', 'Forest', 'Grassland', 'Desert', 'Ice'],
  },
  {
    id: 'initial',
    name: 'Initial continents',
    group: 'Geology',
    description:
      'Starting basement before plate motion. Climate and inspection describe the final world.',
    unit: 'Initial datum',
    stops: ['#123c52', '#4b8a80', '#b4b67b'],
    labels: ['Ocean floor', 'Coast', 'Continental interior'],
  },
  {
    id: 'deformation',
    name: 'Inherited deformation',
    group: 'Geology',
    description: 'Collision uplift and rift subsidence carried through geological time.',
    unit: 'm',
    stops: ['#337eaa', '#c5d3cd', '#c27755'],
    labels: ['−3,000', '0', '3,000'],
  },
  {
    id: 'volcanism',
    name: 'Volcanic construction',
    group: 'Geology',
    description:
      'Accumulated volcanic relief carried by plates: fault arcs, rifts, and seeded hotspot tracks.',
    unit: 'm above basement',
    stops: ['#253c49', '#7b5965', '#d98959', '#ffdd9a'],
    labels: ['0', '3,000', '6,000+'],
  },
  {
    id: 'weathering',
    name: 'Erosion & deposition',
    group: 'Geology',
    description:
      'Net surface change from rain, slope weathering, wind, waves, rivers, and basin infill.',
    unit: 'm',
    stops: ['#457eab', '#b0b6a7', '#bc8c58'],
    labels: ['−1,000 · Eroded', '0', '1,000 · Deposited'],
  },
  {
    id: 'elevation',
    name: 'Elevation',
    group: 'Geology',
    description: 'Surface height relative to the fixed sea-level datum.',
    unit: 'm',
    stops: ['#092539', '#207b95', '#87b9a3', '#c1b980', '#987454', '#e2e6e0'],
    labels: ['−6,000', '0', '6,000'],
  },
  {
    id: 'tectonics',
    name: 'Tectonic plates',
    group: 'Geology',
    description: 'Present crust ownership on a smooth surface, without terrain relief.',
    unit: 'Plate regions',
    stops: ['#ecaa74', '#95b6dd', '#c290be', '#82bbae'],
    labels: ['Convergent', 'Divergent', 'Transform'],
  },
  {
    id: 'crust',
    name: 'Continental crust',
    group: 'Geology',
    description: 'Continental buoyancy independent of plate ownership.',
    unit: 'Fraction',
    stops: ['#16435f', '#747486', '#d5b586'],
    labels: ['Oceanic', 'Continental'],
  },
  {
    id: 'age',
    name: 'Crust age',
    group: 'Geology',
    description: 'Initial crust age plus elapsed geology; newly opened ocean starts at zero.',
    unit: 'Myr · model age',
    stops: ['#ffe0a4', '#dd946e', '#8d6085', '#384c7d'],
    labels: ['Young', '520 Myr'],
  },
  {
    id: 'uplift',
    name: 'Tectonic relief',
    group: 'Geology',
    description: 'Classified collision, subduction, ridge, and rift contributions.',
    unit: 'm',
    stops: ['#3b7fa7', '#b8cad0', '#dda67a', '#b25750'],
    labels: ['−2,000', '0', '3,000'],
  },
  {
    id: 'wind',
    name: 'Wind',
    group: 'Climate',
    description: 'The final wind field used to transport atmospheric moisture.',
    unit: 'm/s',
    stops: ['#163d51', '#398794', '#85c9b5', '#e3dda2'],
    labels: ['Calm', '15 m/s'],
  },
  {
    id: 'currents',
    name: 'Ocean currents',
    group: 'Climate',
    description: 'Surface circulation reconstructed from coast-blocked, shared-edge fluxes.',
    unit: 'm/s',
    stops: ['#0c273d', '#23738e', '#71c7c1', '#e8d9a0'],
    labels: ['0', '0.5 m/s'],
  },
  {
    id: 'sst',
    name: 'Ocean temperature',
    group: 'Climate',
    description: 'Temperature transported by currents and relaxed toward seasonal forcing.',
    unit: '°C',
    stops: ['#506bab', '#61b8bd', '#d2dca4', '#eead6d', '#cf675b'],
    labels: ['−2°', '15°', '32°'],
  },
  {
    id: 'temperature',
    name: 'Air temperature',
    group: 'Climate',
    description: 'Seasonal air temperature with elevation and coastal moderation.',
    unit: '°C',
    stops: ['#5e6cad', '#7cbbcc', '#d5dfa2', '#e5ac70', '#cb655b'],
    labels: ['−30°', '0°', '35°'],
  },
  {
    id: 'rainfall',
    name: 'Precipitation',
    group: 'Climate',
    description: 'Water removed from transported moisture. Annual values sum all four seasons.',
    unit: 'mm',
    stops: ['#c3ad7c', '#7aaa89', '#419d9c', '#477bb2', '#8f78b2'],
    labels: ['0', '1,500', '3,000+'],
  },
  {
    id: 'moisture',
    name: 'Atmospheric moisture',
    group: 'Climate',
    description: 'Water-equivalent column remaining in the atmosphere.',
    unit: 'mm',
    stops: ['#243e5a', '#367e9e', '#7dbbad', '#dfdaa2'],
    labels: ['0', '20', '40'],
  },
  {
    id: 'aridity',
    name: 'Aridity',
    group: 'Climate',
    description:
      'Potential evapotranspiration divided by annual precipitation. Biomes also account for temperature and rainfall seasonality.',
    unit: 'PET / rain',
    stops: ['#257b80', '#91b996', '#cab685', '#c78059'],
    labels: ['0', '2 · Semi-arid', '4', '6 · Arid'],
  },
  {
    id: 'drainage',
    name: 'River basins',
    group: 'Water',
    description:
      'Catchments grouped by a shared ocean mouth or closed lake, including connections through spilling lakes.',
    unit: 'm³/s',
    stops: ['#92beb7', '#c8b68e', '#928cb4'],
    labels: ['Catchments', 'Rivers'],
  },
  {
    id: 'lakes',
    name: 'Lakes & inland seas',
    group: 'Water',
    description:
      'Standing-water footprints, including shallow flat basins. Closed waters have no outlet.',
    unit: 'Water depth · m',
    stops: ['#254451', '#3a92a8', '#91d9da'],
    labels: ['0', '100', '500+'],
  },
  {
    id: 'floodplains',
    name: 'Floodplains',
    group: 'Water',
    description:
      'Alluvial river corridors; blue shows seasonal overbank potential. Annual view shows the seasonal peak.',
    unit: 'Potential · not probability',
    stops: ['#344b4b', '#718853', '#65cee0'],
    labels: ['Upland', 'Riverbank', 'Overbank water'],
  },
  {
    id: 'biomes',
    name: 'Biomes',
    group: 'Ecology',
    description: 'Regional climate biomes with localized meadow, woodland, and wetland riverbanks.',
    unit: 'Biome',
    stops: BIOME_COLORS.slice(1, 10),
    labels: [
      'Ice',
      'Tundra',
      'Boreal',
      'Forest',
      'Grass',
      'Desert',
      'Savanna',
      'Tropical',
      'Rainforest',
    ],
  },
  {
    id: 'sources',
    name: 'River sources',
    group: 'Water',
    description:
      'Dominant water-delivery pathway. Inspect a channel for the mixture and seasonal flow pattern.',
    unit: 'Water supply',
    stops: RIVER_SOURCE_COLORS.slice(1),
    labels: ['Rain', 'Snow / ice', 'Springs', 'Lakes', 'Wetlands', 'Mixed'],
  },
  {
    id: 'landforms',
    name: 'River landforms',
    group: 'Water',
    description: 'Fluvial lowering, winding channels, cutoff pools, and deposited river mouths.',
    unit: 'Landscape',
    stops: ['#344b4b', '#7a947f', '#936f59', '#dbc080'],
    labels: ['Upland', 'Valley', 'Canyon', 'Delta deposits'],
  },
  {
    id: 'wetlands',
    name: 'Marshes & peatlands',
    group: 'Ecology',
    description:
      'Local wetland habitat from saturation, valley shape and water access. Bogs are rain-fed and relatively isolated.',
    unit: 'Habitat potential',
    stops: WETLAND_COLORS,
    labels: ['Dry land', 'Marsh', 'Swamp', 'Fen', 'Bog'],
  },
  {
    id: 'vegetation',
    name: 'Vegetation',
    group: 'Ecology',
    description: 'Continuous vegetation potential with riparian corridors.',
    unit: 'Coverage potential',
    stops: ['#b7a578', '#7f9d68', '#3f805d', '#1f614f'],
    labels: ['Sparse', 'Dense'],
  },
  {
    id: 'ice',
    name: 'Snow & ice',
    group: 'Ecology',
    description: 'Snow-water storage and cold-season ocean ice potential.',
    unit: 'Fraction',
    stops: ['#254553', '#70a6b2', '#eff7f5'],
    labels: ['0', '0.5', '1'],
  },
  {
    id: 'sediment',
    name: 'Sediment',
    group: 'Geology',
    description: 'Material deposited by rivers and long-term infill of downstream depressions.',
    unit: 'm',
    stops: ['#344b4b', '#a49a76', '#e1bd80'],
    labels: ['0', '50', '150+'],
  },
];

const palettes = new Map<Layer, Color[]>();

for (const layerInfo of LAYERS) {
  palettes.set(
    layerInfo.id,
    layerInfo.stops.map((color) => new Color(color)),
  );
}

const biomeColors = BIOME_COLORS.map((color) => new Color(color));

const plateColors = Array.from({ length: 64 }, (_, plateIndex) =>
  new Color().setHSL((plateIndex * 0.61803398875 + 0.03) % 1, 0.32, 0.55),
);

/** Plate diagnostics need only the plate ID, not a full terrain/climate record. */
export function samplePlateColor(plate: number, target: Color): Color {
  return target.copy(plateColors[plate % plateColors.length]);
}

const darkOcean = new Color('#123c52');

const landNeutral = new Color('#344b4b');

function sampleColorRamp(layer: Layer, value: number, target: Color) {
  const colors = palettes.get(layer)!;
  const palettePosition = clamp(value) * (colors.length - 1);
  const colorIndex = Math.min(colors.length - 2, Math.floor(palettePosition));

  return target.copy(colors[colorIndex]).lerp(colors[colorIndex + 1], palettePosition - colorIndex);
}

const inlandWaterColor = new Color();
const WATER_BLEND_LAYERS: Layer[] = [
  'biomes',
  'vegetation',
  'floodplains',
  'wetlands',
  'landforms',
  'lakes',
  'drainage',
  'sources',
];

export function sampleCellColor(
  record: CellRecord,
  layer: Layer,
  season: number,
  target: Color,
): Color {
  sampleGroundColor(record, layer, season, target);
  const coverage = record.coverage;
  if (record['terrain.ocean'] || coverage <= 0 || !WATER_BLEND_LAYERS.includes(layer)) {
    return target;
  }
  if (layer === 'lakes') {
    sampleColorRamp(
      layer,
      0.35 + 0.65 * clamp(record['drainage.lakeDepth'] / 500),
      inlandWaterColor,
    );
  } else {
    inlandWaterColor.copy(biomeColors[12]);
  }
  const temperature = season < 0 ? record['water.temperature'] : record.temperature;
  inlandWaterColor.lerp(biomeColors[1], clamp((-temperature - 1) / 12));
  return target.lerp(inlandWaterColor, coverage);
}

function sampleGroundColor(record: CellRecord, layer: Layer, season: number, target: Color): Color {
  const elevation = record['terrain.height'];
  const isOcean = record['terrain.ocean'];
  // Diagnostic colors must match their legend, including on delta and bank cells.
  if (layer === 'fertility') {
    if (isOcean || record.annualCoverage >= 1 - 1e-6) {
      return target.set('#193e55');
    }
    if (record['ecology.biome'] === 1) {
      return target.set('#dcebef');
    }
    return sampleColorRamp(layer, record['resources.fertility'] / 100, target);
  }
  if (layer === 'resources') {
    if (isOcean || record.annualCoverage >= 1 - 1e-6) {
      return target.set('#143146');
    }
    if (record['ecology.biome'] === 1) {
      return target.set('#a4b9bf');
    }
    return target.set('#354d47').lerp(resourceUplandColor, clamp(elevation / 6000));
  }
  const habitatLayer = ['biomes', 'vegetation', 'floodplains', 'wetlands', 'landforms'].includes(
    layer,
  );

  if (
    (habitatLayer || ['lakes', 'drainage', 'sources'].includes(layer)) &&
    record.annualCoverage >= 1 - 1e-6
  ) {
    if (layer === 'lakes') {
      sampleColorRamp(layer, 0.35 + 0.65 * clamp(record['drainage.lakeDepth'] / 500), target);
    } else {
      target.copy(biomeColors[12]);
    }

    const temperature = season < 0 ? record['water.temperature'] : record.temperature;

    return target.lerp(biomeColors[1], clamp((-temperature - 1) / 12));
  }

  if (habitatLayer && record.delta) {
    return sampleDeltaRecord(record, season, target);
  }

  if (layer === 'initial') {
    const raw = record['geology.crust.initialBase'] ?? record['terrain.height'];

    return raw < 0
      ? target.set('#123c52')
      : sampleColorRamp(layer, 0.55 + clamp(raw / 5000) * 0.45, target);
  }

  if (layer === 'deformation') {
    return sampleColorRamp(
      layer,
      ((record['geology.crust.deformation'] ?? 0) + 3000) / 6000,
      target,
    );
  }

  if (layer === 'volcanism') {
    return sampleColorRamp(layer, (record['geology.crust.volcanic'] ?? 0) / 6000, target);
  }

  if (layer === 'weathering') {
    return sampleColorRamp(layer, ((record['terrain.surfaceChange'] ?? 0) + 1000) / 2000, target);
  }

  if (layer === 'biomes') {
    return target
      .copy(biomeColors[record['ecology.biome']])
      .lerp(wetlandColors[record['ecology.wetland']], record['ecology.wetlandFraction']);
  }

  if (layer === 'tectonics') {
    return samplePlateColor(record['geology.plate'], target);
  }

  if (layer === 'crust') {
    return sampleColorRamp(layer, record['geology.continental'], target);
  }

  if (layer === 'age') {
    return sampleColorRamp(layer, record['geology.age'] / 520, target);
  }

  if (layer === 'uplift') {
    return sampleColorRamp(layer, (record['geology.uplift'] + 2000) / 5000, target);
  }

  if (layer === 'elevation') {
    return sampleColorRamp(layer, (elevation + 6000) / 12000, target);
  }

  if (layer === 'temperature') {
    return sampleColorRamp(
      layer,
      ((season < 0 ? record['water.temperature'] : record.temperature) + 30) / 65,
      target,
    );
  }

  if (layer === 'rainfall') {
    return sampleColorRamp(
      layer,
      (season < 0 ? record['water.rain'] : record.rain) / (season < 0 ? 3000 : 900),
      target,
    );
  }

  if (layer === 'moisture') {
    return sampleColorRamp(layer, record.moisture / 40, target);
  }

  if (layer === 'wind' || layer === 'currents') {
    if (layer === 'currents' && !isOcean) {
      return target.copy(landNeutral);
    }

    return sampleColorRamp(
      layer,
      layer === 'wind' ? record.windSpeed / 15 : record.currentSpeed / 0.5,
      target,
    );
  }

  if (layer === 'sst') {
    return isOcean
      ? sampleColorRamp(layer, (record.sst + 2) / 34, target)
      : target.copy(landNeutral);
  }

  if (layer === 'aridity') {
    return isOcean
      ? target.copy(darkOcean)
      : sampleColorRamp(layer, record['water.aridity'] / 6, target);
  }

  if (layer === 'vegetation') {
    return isOcean
      ? target.copy(darkOcean)
      : sampleColorRamp(layer, record['ecology.vegetation'], target);
  }

  if (layer === 'ice') {
    return sampleColorRamp(
      layer,
      Math.max(record['ecology.ice'], record['water.snow'] / 1000),
      target,
    );
  }

  if (layer === 'sediment') {
    return isOcean
      ? target.copy(darkOcean)
      : sampleColorRamp(layer, record['terrain.sediment'] / 150, target);
  }

  if (layer === 'lakes') {
    return target.copy(isOcean ? darkOcean : landNeutral);
  }

  if (layer === 'floodplains') {
    return isOcean
      ? target.copy(darkOcean)
      : sampleColorRamp(layer, Math.sqrt(record['ecology.floodplainFraction']) * 0.45, target);
  }

  if (layer === 'wetlands') {
    return isOcean
      ? target.copy(darkOcean)
      : target
          .copy(landNeutral)
          .lerp(
            wetlandColors[record['ecology.wetland']],
            record['ecology.wetland']
              ? 0.35 + 0.65 * Math.sqrt(record['ecology.wetlandFraction'])
              : 0,
          );
  }

  if (layer === 'landforms') {
    if (isOcean) {
      return target.copy(darkOcean);
    }

    if (record['terrain.deltaSediment'] > 0.5) {
      return target.set('#dbc080');
    }

    return sampleColorRamp(layer, clamp(record['terrain.fluvialIncision'] / 350) * 0.67, target);
  }

  if (layer === 'sources') {
    if (isOcean) {
      return target.copy(darkOcean);
    }

    return record.source < 0
      ? target.copy(landNeutral)
      : target.set(RIVER_SOURCE_COLORS[record.source]).multiplyScalar(0.45);
  }
  if (layer === 'drainage') {
    return isOcean
      ? target.copy(darkOcean)
      : target.copy(plateColors[record.system % 64]).multiplyScalar(0.72);
  }

  return target.copy(landNeutral);
}

export const CATEGORICAL: Layer[] = ['tectonics', 'biomes', 'drainage', 'wetlands', 'sources'];

export function sampleDeltaRecord(record: CellRecord, season: number, target: Color) {
  const temperature = record.temperature;
  const rain = season < 0 ? 1 : clamp((record.rain * 4) / Math.max(1, record['water.rain']));
  const green = record['ecology.vegetation'] * (0.65 + rain * 0.35) * clamp((temperature + 2) / 15);
  return target
    .set('#9a8863')
    .lerp(new Color('#5b8066'), green)
    .lerp(new Color('#31788b'), record.delta === 2 ? 0.48 : 0.3)
    .lerp(new Color('#dcebef'), clamp((-temperature + 1) / 12) * 0.85);
}
