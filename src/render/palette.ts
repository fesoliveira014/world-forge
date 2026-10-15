import { Color } from 'three';
import type { Layer, World } from '../core/model';
import { clamp } from '../core/math';
import { getDeltaCells, sampleDeltaColor, isLakeCell } from './SurfaceHabitats';
import { lakeCoverageAt } from '../core/generation/lake-state';

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

const darkOcean = new Color('#123c52');

const landNeutral = new Color('#344b4b');

function sampleColorRamp(layer: Layer, value: number, target: Color) {
  const colors = palettes.get(layer)!;
  const palettePosition = clamp(value) * (colors.length - 1);
  const colorIndex = Math.min(colors.length - 2, Math.floor(palettePosition));

  return target.copy(colors[colorIndex]).lerp(colors[colorIndex + 1], palettePosition - colorIndex);
}

function sampleSeasonalField(
  fields: Float32Array[],
  cellIndex: number,
  season: number,
  average = true,
) {
  return season < 0
    ? fields.reduce((totalValue, seasonField) => totalValue + seasonField[cellIndex], 0) /
        (average ? 4 : 1)
    : fields[season][cellIndex];
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
  world: World,
  cellIndex: number,
  layer: Layer,
  season: number,
  target: Color,
): Color {
  sampleGroundColor(world, cellIndex, layer, season, target);
  const coverage = lakeCoverageAt(world.drainage, cellIndex, season);
  if (world.terrain.ocean[cellIndex] || coverage <= 0 || !WATER_BLEND_LAYERS.includes(layer)) {
    return target;
  }
  if (layer === 'lakes') {
    sampleColorRamp(
      layer,
      0.35 + 0.65 * clamp(world.drainage.lakeDepth[cellIndex] / 500),
      inlandWaterColor,
    );
  } else {
    inlandWaterColor.copy(biomeColors[12]);
  }
  const temperature =
    season < 0
      ? world.water.temperature[cellIndex]
      : world.water.seasonalTemperature[season][cellIndex];
  inlandWaterColor.lerp(biomeColors[1], clamp((-temperature - 1) / 12));
  return target.lerp(inlandWaterColor, coverage);
}

function sampleGroundColor(
  world: World,
  cellIndex: number,
  layer: Layer,
  season: number,
  target: Color,
): Color {
  const processCell = world.transfer[cellIndex];
  const elevation = world.terrain.height[cellIndex];
  const isOcean = world.terrain.ocean[cellIndex];
  const climate = world.climate;
  const landWater = world.water;
  const ecology = world.ecology;
  // Diagnostic colors must match their legend, including on delta and bank cells.
  if (layer === 'fertility') {
    if (isOcean || isLakeCell(world, cellIndex)) {
      return target.set('#193e55');
    }
    if (ecology.biome[cellIndex] === 1) {
      return target.set('#dcebef');
    }
    return sampleColorRamp(layer, world.resources.fertility[cellIndex] / 100, target);
  }
  if (layer === 'resources') {
    if (isOcean || isLakeCell(world, cellIndex)) {
      return target.set('#143146');
    }
    if (ecology.biome[cellIndex] === 1) {
      return target.set('#a4b9bf');
    }
    return target.set('#354d47').lerp(resourceUplandColor, clamp(elevation / 6000));
  }
  const habitatLayer = ['biomes', 'vegetation', 'floodplains', 'wetlands', 'landforms'].includes(
    layer,
  );

  if (
    (habitatLayer || ['lakes', 'drainage', 'sources'].includes(layer)) &&
    isLakeCell(world, cellIndex)
  ) {
    if (layer === 'lakes') {
      sampleColorRamp(
        layer,
        0.35 + 0.65 * clamp(world.drainage.lakeDepth[cellIndex] / 500),
        target,
      );
    } else {
      target.copy(biomeColors[12]);
    }

    const temperature =
      season < 0
        ? landWater.temperature[cellIndex]
        : landWater.seasonalTemperature[season][cellIndex];

    return target.lerp(biomeColors[1], clamp((-temperature - 1) / 12));
  }

  if (habitatLayer && getDeltaCells(world)[cellIndex]) {
    return sampleDeltaColor(world, cellIndex, season, target);
  }

  if (layer === 'initial') {
    const raw = world.geology.crust?.initialBase[processCell] ?? world.terrain.height[cellIndex];

    return raw < 0
      ? target.set('#123c52')
      : sampleColorRamp(layer, 0.55 + clamp(raw / 5000) * 0.45, target);
  }

  if (layer === 'deformation') {
    return sampleColorRamp(
      layer,
      ((world.geology.crust?.deformation[processCell] ?? 0) + 3000) / 6000,
      target,
    );
  }

  if (layer === 'volcanism') {
    return sampleColorRamp(layer, (world.geology.crust?.volcanic[processCell] ?? 0) / 6000, target);
  }

  if (layer === 'weathering') {
    return sampleColorRamp(
      layer,
      ((world.terrain.surfaceChange?.[cellIndex] ?? 0) + 1000) / 2000,
      target,
    );
  }

  if (layer === 'biomes') {
    return target
      .copy(biomeColors[ecology.biome[cellIndex]])
      .lerp(wetlandColors[ecology.wetland[cellIndex]], ecology.wetlandFraction[cellIndex]);
  }

  if (layer === 'tectonics') {
    return target.copy(plateColors[world.geology.plate[processCell] % 64]);
  }

  if (layer === 'crust') {
    return sampleColorRamp(layer, world.geology.continental[processCell], target);
  }

  if (layer === 'age') {
    return sampleColorRamp(layer, world.geology.age[processCell] / 520, target);
  }

  if (layer === 'uplift') {
    return sampleColorRamp(layer, (world.geology.uplift[processCell] + 2000) / 5000, target);
  }

  if (layer === 'elevation') {
    return sampleColorRamp(layer, (elevation + 6000) / 12000, target);
  }

  if (layer === 'temperature') {
    return sampleColorRamp(
      layer,
      ((season < 0
        ? landWater.temperature[cellIndex]
        : landWater.seasonalTemperature[season][cellIndex]) +
        30) /
        65,
      target,
    );
  }

  if (layer === 'rainfall') {
    return sampleColorRamp(
      layer,
      (season < 0 ? landWater.rain[cellIndex] : landWater.seasonalRain[season][cellIndex]) /
        (season < 0 ? 3000 : 900),
      target,
    );
  }

  if (layer === 'moisture') {
    return sampleColorRamp(
      layer,
      sampleSeasonalField(climate.moisture, processCell, season) / 40,
      target,
    );
  }

  if (layer === 'wind' || layer === 'currents') {
    if (layer === 'currents' && !isOcean) {
      return target.copy(landNeutral);
    }

    const vectorFields = layer === 'wind' ? climate.wind : climate.current;
    let speed = 0;

    for (let seasonIndex = 0; seasonIndex < 4; seasonIndex++) {
      if (season < 0 || seasonIndex === season) {
        speed += Math.hypot(
          vectorFields[seasonIndex][processCell * 3],
          vectorFields[seasonIndex][processCell * 3 + 1],
          vectorFields[seasonIndex][processCell * 3 + 2],
        );
      }
    }

    return sampleColorRamp(
      layer,
      speed / (season < 0 ? 4 : 1) / (layer === 'wind' ? 15 : 0.5),
      target,
    );
  }

  if (layer === 'sst') {
    return isOcean
      ? sampleColorRamp(
          layer,
          (sampleSeasonalField(climate.sst, processCell, season) + 2) / 34,
          target,
        )
      : target.copy(landNeutral);
  }

  if (layer === 'aridity') {
    return isOcean
      ? target.copy(darkOcean)
      : sampleColorRamp(layer, landWater.aridity[cellIndex] / 6, target);
  }

  if (layer === 'vegetation') {
    return isOcean
      ? target.copy(darkOcean)
      : sampleColorRamp(layer, ecology.vegetation[cellIndex], target);
  }

  if (layer === 'ice') {
    return sampleColorRamp(
      layer,
      Math.max(ecology.ice[cellIndex], landWater.snow[cellIndex] / 1000),
      target,
    );
  }

  if (layer === 'sediment') {
    return isOcean
      ? target.copy(darkOcean)
      : sampleColorRamp(layer, world.terrain.sediment[cellIndex] / 150, target);
  }

  if (layer === 'lakes') {
    return target.copy(isOcean ? darkOcean : landNeutral);
  }

  if (layer === 'floodplains') {
    return isOcean
      ? target.copy(darkOcean)
      : sampleColorRamp(layer, Math.sqrt(ecology.floodplainFraction[cellIndex]) * 0.45, target);
  }

  if (layer === 'wetlands') {
    return isOcean
      ? target.copy(darkOcean)
      : target
          .copy(landNeutral)
          .lerp(
            wetlandColors[ecology.wetland[cellIndex]],
            ecology.wetland[cellIndex]
              ? 0.35 + 0.65 * Math.sqrt(ecology.wetlandFraction[cellIndex])
              : 0,
          );
  }

  if (layer === 'landforms') {
    if (isOcean) {
      return target.copy(darkOcean);
    }

    if (world.terrain.deltaSediment[cellIndex] > 0.5) {
      return target.set('#dbc080');
    }

    return sampleColorRamp(
      layer,
      clamp(world.terrain.fluvialIncision[cellIndex] / 350) * 0.67,
      target,
    );
  }

  if (layer === 'sources') {
    if (isOcean) {
      return target.copy(darkOcean);
    }

    let corner = -1;

    for (
      let neighborOffset = world.grid.offsets[cellIndex];
      neighborOffset < world.grid.offsets[cellIndex + 1];
      neighborOffset++
    ) {
      const cornerIndex = world.grid.cellCorners[neighborOffset];

      if (
        world.rivers.channel[cornerIndex] &&
        (corner < 0 || world.drainage.discharge[cornerIndex] > world.drainage.discharge[corner])
      ) {
        corner = cornerIndex;
      }
    }

    return corner < 0
      ? target.copy(landNeutral)
      : target.set(RIVER_SOURCE_COLORS[world.rivers.source[corner]]).multiplyScalar(0.45);
  }

  if (layer === 'drainage') {
    if (isOcean) {
      return target.copy(darkOcean);
    }

    const grid = world.grid;
    let corner = grid.cellCorners[grid.offsets[cellIndex]];

    for (
      let neighborOffset = grid.offsets[cellIndex] + 1;
      neighborOffset < grid.offsets[cellIndex + 1];
      neighborOffset++
    ) {
      if (
        world.drainage.discharge[grid.cellCorners[neighborOffset]] >
        world.drainage.discharge[corner]
      ) {
        corner = grid.cellCorners[neighborOffset];
      }
    }

    const riverSystem = world.rivers.system[corner];

    return target.copy(plateColors[riverSystem % 64]).multiplyScalar(0.72);
  }

  return target.copy(landNeutral);
}

export const CATEGORICAL: Layer[] = ['tectonics', 'biomes', 'drainage', 'wetlands', 'sources'];
