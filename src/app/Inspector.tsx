import { CircleHelp, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from '@/components/ui/dialog';
import type { World } from '../core/model';
import { BIOMES } from '../core/generation/ecology';
import { classifyLakeSize, riverDestination } from '../core/generation/lake-surfaces';
import { RIVER_HABITATS } from '../core/generation/floodplains';
import { RIVER_SOURCES, RIVER_REGIMES } from '../core/generation/rivers';
import { WETLANDS } from '../core/generation/wetlands';
import { BIOME_COLORS } from '../render/palette';
import { version as appVersion } from '../../package.json';
import { downloadWorldConfig, formatNumber } from './controls';
import { FertilityDetails } from './ResourceInspector';
import { worldProject } from '../core/project';
import { lakeAtCell, lakeCoverageAt, lakeWaterDescription } from '../core/generation/lake-state';

export function CellInspector({
  world,
  cell: cellIndex,
  season,
  onClose,
}: {
  world: World;
  cell: number;
  season: number;
  onClose: () => void;
}) {
  const processCell = world.transfer[cellIndex];
  const grid = world.grid;
  const latitude = (Math.asin(grid.positions[cellIndex * 3 + 1]) * 180) / Math.PI;
  const longitude =
    (Math.atan2(grid.positions[cellIndex * 3 + 2], grid.positions[cellIndex * 3]) * 180) / Math.PI;
  const temperature =
    season < 0
      ? world.water.temperature[cellIndex]
      : world.water.seasonalTemperature[season][cellIndex];
  const rain =
    season < 0 ? world.water.rain[cellIndex] : world.water.seasonalRain[season][cellIndex];
  let discharge = 0;
  let catchment = 0;
  let riverCorner = -1;

  for (
    let neighborOffset = grid.offsets[cellIndex];
    neighborOffset < grid.offsets[cellIndex + 1];
    neighborOffset++
  ) {
    const cornerIndex = grid.cellCorners[neighborOffset];

    if (world.rivers.channel[cornerIndex]) {
      if (riverCorner < 0 || world.drainage.discharge[cornerIndex] > discharge) {
        riverCorner = cornerIndex;
      }

      discharge = Math.max(discharge, world.drainage.discharge[cornerIndex]);
      catchment = Math.max(catchment, world.rivers.catchmentArea[cornerIndex]);
    }
  }

  const reservoir = lakeAtCell(grid, world.drainage, cellIndex);
  const coverage = lakeCoverageAt(world.drainage, cellIndex, season);
  const standingWater = coverage >= 1 - 1e-6;
  const lakeSeason = season >= 0 ? reservoir?.seasonal : undefined;
  const bankReach = riverCorner < 0 ? -1 : world.ecology.floodplains.corner.indexOf(riverCorner);
  const course = riverCorner < 0 ? -1 : world.rivers.courses.corner.indexOf(riverCorner);
  const delta = world.rivers.deltas.find((delta) => delta.corner === riverCorner);
  const pond = world.terrain.oxbows.findIndex((oxbow) => oxbow.cell === cellIndex);
  const seasonalFlood =
    bankReach < 0
      ? 0
      : Math.max(
          ...world.ecology.floodplains.seasonalFlood
            .filter((_, seasonIndex) => season < 0 || season === seasonIndex)
            .flatMap((field) => [field[bankReach * 2], field[bankReach * 2 + 1]]),
        );

  return (
    <aside className="cell-inspector">
      <div className="inspector-heading">
        <span className="eyebrow">CELL {formatNumber(cellIndex)}</span>
        <button aria-label="Close cell inspector" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <h3>
        <span style={{ background: BIOME_COLORS[world.ecology.biome[cellIndex]] }} />
        {standingWater && reservoir
          ? `${classifyLakeSize(reservoir.area)} ${reservoir.id + 1}`
          : world.ecology.biome[cellIndex] === 2 &&
              Math.abs(latitude) < 45 &&
              world.terrain.height[cellIndex] > 1500
            ? 'Alpine tundra'
            : BIOMES[world.ecology.biome[cellIndex]]}
      </h3>
      <p className="coordinates">
        {Math.abs(latitude).toFixed(2)}° {latitude < 0 ? 'S' : 'N'} ·{' '}
        {Math.abs(longitude).toFixed(2)}° {longitude < 0 ? 'W' : 'E'}
      </p>
      <dl>
        {[
          ['Elevation', `${formatNumber(world.terrain.height[cellIndex])} m`],
          ['Temperature', `${temperature.toFixed(1)} °C`],
          ['Precipitation', `${formatNumber(rain)} mm${season < 0 ? '/yr' : ''}`],
          ['PET', `${formatNumber(world.water.pet[cellIndex])} mm/yr`],
          ['Actual ET', `${formatNumber(world.water.aet[cellIndex])} mm/yr`],
          ['Annual channel flow', `${formatNumber(discharge, 1)} m³/s`],
          ...(season >= 0
            ? [
                [
                  'Seasonal channel flow',
                  `${formatNumber(riverCorner < 0 ? 0 : world.rivers.seasonalDischarge[season][riverCorner], 1)} m³/s`,
                ],
              ]
            : []),
          ['Upstream catchment', `${formatNumber(catchment / 1e6)} km²`],
          ['River system', riverCorner < 0 ? '—' : String(world.rivers.system[riverCorner] + 1)],
          ['Stream order', riverCorner < 0 ? '—' : String(world.rivers.streamOrder[riverCorner])],
          ['Water supply', riverCorner < 0 ? '—' : RIVER_SOURCES[world.rivers.source[riverCorner]]],
          ['Flow pattern', riverCorner < 0 ? '—' : RIVER_REGIMES[world.rivers.regime[riverCorner]]],
          [
            'Channel sinuosity',
            course < 0
              ? '—'
              : `${formatNumber(world.rivers.courses.sinuosity[course], 2)}× straight distance`,
          ],
          [
            'Flows to',
            riverCorner < 0
              ? '—'
              : riverDestination(world.drainage, world.rivers.system[riverCorner]),
          ],
          [
            'Vegetation potential',
            `${formatNumber(world.ecology.vegetation[cellIndex] * 100, 1)}%`,
          ],
          [
            'River corridor coverage',
            `${formatNumber(world.ecology.riparianFraction[cellIndex] * 100, 1)}% of cell`,
          ],
          ['Local river habitat', RIVER_HABITATS[world.ecology.riverHabitat[cellIndex]]],
          [
            'Bank vegetation potential',
            `${formatNumber(world.ecology.riparian[cellIndex] * 100, 1)}%`,
          ],
          [
            'Flood-accessible land',
            `${formatNumber(world.ecology.floodplainFraction[cellIndex] * 100, 1)}% of cell`,
          ],
          ['Wetland habitat', WETLANDS[world.ecology.wetland[cellIndex]]],
          [
            'Wetland coverage',
            `${formatNumber(world.ecology.wetlandFraction[cellIndex] * 100, 1)}% of cell`,
          ],
          [
            'Overbank potential',
            bankReach < 0
              ? '—'
              : seasonalFlood > 0.6
                ? 'High'
                : seasonalFlood > 0.15
                  ? 'Moderate'
                  : 'Low',
          ],
          ['Crust age', `${formatNumber(world.geology.age[processCell])} Ma`],
          [
            'Volcanic construction',
            `${formatNumber(world.geology.crust?.volcanic[processCell] ?? 0)} m`,
          ],
          ['Erosion / deposition', `${formatNumber(world.terrain.surfaceChange[cellIndex])} m`],
          [
            'River incision',
            `${formatNumber(world.terrain.fluvialIncision[cellIndex])} m · cell average`,
          ],
          ['Mouth sediment', `${formatNumber(world.terrain.deltaSediment[cellIndex], 1)} m`],
          ['Plate', String(world.geology.plate[processCell] + 1)],
          [
            'Cell area',
            `${formatNumber((grid.areas[cellIndex] * world.config.radius ** 2) / 1e6)} km²`,
          ],
        ].map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {riverCorner >= 0 && (
        <details className="lake-summary">
          <summary>Water sources &amp; seasonal flow</summary>
          <dl>
            {[
              'Rainfall runoff',
              'Rapid snow / ice melt',
              'Slow soil-water release',
              'Lake release',
            ].map((label, sourceIndex) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  {formatNumber(world.rivers.sourceFractions[sourceIndex][riverCorner] * 100, 1)}%
                </dd>
              </div>
            ))}
            {['March', 'June', 'September', 'December'].map((label, seasonIndex) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  {formatNumber(world.rivers.seasonalDischarge[seasonIndex][riverCorner], 1)} m³/s
                </dd>
              </div>
            ))}
          </dl>
          <p>
            Slow soil drainage represents spring-supported flow. Four seasonal averages indicate
            persistence; they cannot resolve individual dry days.
          </p>
        </details>
      )}
      {delta && (
        <div className="lake-summary">
          <span className="eyebrow">{delta.lake < 0 ? 'Coastal delta' : 'Lake delta'}</span>
          <p>Seasonal wetland and shallow-water colors mark the mouth cells.</p>
          <p>
            {delta.branches
              .map(
                (branch) =>
                  `${formatNumber(branch.fraction * 100)}% · ${formatNumber(discharge * branch.fraction, 1)} m³/s`,
              )
              .join(' / ')}
          </p>
        </div>
      )}
      {pond >= 0 && (
        <div className="lake-summary">
          <span className="eyebrow">Cutoff channel / oxbow</span>
          <p>
            {formatNumber(world.terrain.oxbows[pond].area / 1e6, 2)} km² ·{' '}
            {formatNumber(
              season < 0
                ? world.water.oxbowDepth.reduce(
                    (sum, seasonStorage) => sum + seasonStorage[pond],
                    0,
                  ) / 4
                : world.water.oxbowDepth[season][pond],
              2,
            )}{' '}
            m water depth
          </p>
          <p>
            Rain and snowmelt fill the abandoned channel. It becomes a dry scar when its store
            empties.
          </p>
        </div>
      )}
      {reservoir && (
        <div className="lake-summary">
          <span className="eyebrow">
            {standingWater ? '' : 'BASIN OF '}
            {classifyLakeSize(reservoir.area).toUpperCase()} {reservoir.id + 1}
          </span>
          <p>
            {reservoir.kind === 'closed'
              ? 'Closed · no surface outlet'
              : 'Spilling · connected downstream'}
            <br />
            {lakeWaterDescription(reservoir)}
            <br />
            Cell water coverage {formatNumber(coverage * 100, 1)}%
            <br />
            {season < 0 ? 'Mean area' : 'Season-end area'}{' '}
            {formatNumber((lakeSeason?.area[season] ?? reservoir.area) / 1e6)} km²
            <br />
            {season < 0 ? 'High water' : 'Season-end level'}{' '}
            {formatNumber(lakeSeason?.level[season] ?? reservoir.level, 1)} m<br />
            {reservoir.storage / Math.max(1, reservoir.area) < 0.01
              ? 'Water depth is below mesh resolution'
              : `Stored ${formatNumber((lakeSeason?.storage[season] ?? reservoir.storage) / 1e9, 3)} km³`}
            <br />
            Inflow {formatNumber(lakeSeason?.inflow[season] ?? reservoir.inflow, 1)} m³/s
            <br />
            Outflow {formatNumber(lakeSeason?.outflow[season] ?? reservoir.outflow, 1)} m³/s
          </p>
        </div>
      )}
      <FertilityDetails world={world} cell={cellIndex} />
    </aside>
  );
}

export function HelpDialog({ world }: { world: World | null }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button className="help-button" aria-label="About this generator">
          <CircleHelp size={18} />
        </button>
      </DialogTrigger>
      <DialogContent className="help-dialog">
        <DialogHeader>
          <DialogTitle>Explore how a world fits together</DialogTitle>
          <DialogDescription>
            Switch layers to follow the relationships between geology, climate, water, and ecology.
          </DialogDescription>
        </DialogHeader>
        <p>
          Drag the globe to orbit. Scroll or use the zoom controls to move closer. Click any cell
          for its physical fields. World settings take effect when you generate; display controls
          update immediately.
        </p>
        <p>
          Four seasons drive climate. River widths show annual discharge; seasonal views animate
          wet-season flow and mute frozen or low-flow channels. Melt-season Arctic rivers remain
          visible. Surface detail and simulation detail are separate, keeping plate definitions and
          circulation centers stable when you refine the terrain.
        </p>
        <p>
          Rivers start where enough upstream land supplies soil drainage, overflow, or reservoir
          release, then follow drainage downhill to the sea or a lake. Headwater controls set their
          abundance. Riverbank vegetation uses this imported water even in a desert. Meadows,
          woodlands, and wetlands fade into the surrounding biome with distance from the river;
          these corridors remain visible when river lines are hidden. The cell inspector shows the
          regional biome, local bank habitat, and each river&apos;s destination.
        </p>
        <p>
          Large rivers in gentle valleys support broad alluvial habitat that persists between
          floods. Floodplain extent adjusts this corridor; deposited sediment and valley shape
          affect its reach. Seasonal overbank water uses routed runoff, reservoir buffering,
          floodplain residence, and bank slope. Annual view shows the seasonal peak. This is habitat
          and flood-access potential, not a flood probability or daily hydraulic forecast. It does
          not add atmospheric rainfall or model soil nutrients, irrigation, or groundwater flow.
        </p>
        <p>
          Standing water has an explicit shoreline even where a very flat basin has no resolvable
          depth. As an atlas naming convention, waters of at least 10,000 km² are Great lakes and
          those of at least 100,000 km² are Inland seas. These names do not imply salt water. This
          generator routes large channels to standing water or the ocean; channel losses from
          infiltration and evaporation are not currently simulated.
        </p>
        <p>
          River evolution duration applies a recent fluvial landscape pass after geological
          weathering. Rivers lower valleys and transport the removed sediment toward floodplains and
          receiving waters. The final climate and drainage are rebuilt from that terrain. This
          duration is a modeled interval, not a birth date for each river. Canyon detail is limited
          by the surface grid.
        </p>
        <p>
          Riverbank mobility allows bends and geometric cutoffs on broad, gentle plains. Cutoff
          ponds have a seasonal rain, melt, storage, evaporation and overflow budget. Dry remnants
          remain as scars. Deposited mouths form deltas, shown as neighboring green-blue or
          brown-blue cells that respond to seasons. The channel delivers its flow to the receiving
          water. This does not model tides or migrating delta lobes.
        </p>
        <p>
          River sources shows the dominant delivery pathway; inspect a river to see its mixture.
          Snowmelt includes retained snow, while slow soil drainage is a proxy for groundwater and
          springs. Moving glaciers and deep aquifers are not simulated. Marshes, swamps, fens and
          rain-fed bogs describe local habitat potential; peat chemistry and centuries of organic
          accumulation are not modeled.
        </p>
        <p>
          The river-basin layer groups catchments by their shared outlet, including connections
          through spilling lakes. Separate coastal mouths can form independent systems. Stream order
          increases when equal-order tributaries merge, helping distinguish small branches from
          established trunks. Inland basin floors sit above sea level, below their surrounding rim.
        </p>
        <p>
          Geological duration evolves crust before climate and rivers are generated. Compare Initial
          continents with the final world, or inspect Inherited deformation and Volcanic
          construction. Faults build volcanic arcs and rifts; seeded hotspots leave tracks as plates
          move. Plate paths are prescribed; this is not a mantle or plate-force simulation. The
          separate drift preview is display only. Lake storage is an annual equilibrium estimate.
        </p>
        <p>
          Rain, slope weathering, wind, and waves reshape terrain over the selected geological
          duration. Erosion &amp; deposition shows the resulting surface change. Sediment fills
          downstream depressions before lakes and rivers are recalculated. Lower Lake persistence
          allows more infill; deeper or sediment-poor basins can still remain lakes. Landscape aging
          uses the provisional climate, rather than simulating every past climate.
        </p>
        <p>
          Switch between Globe and Flat map above the layer title. The equirectangular map is
          north-up: drag to pan, scroll or pinch to zoom, and Reset view to fit the whole world.
          Click to inspect the same cells in either layout. Polar regions appear enlarged on the
          flat map; use the globe when comparing shapes. Coastlines adds present-day ocean
          boundaries over any layer, independently of plate borders and rivers. Terrain exaggeration
          and the plate drift preview are available on the globe.
        </p>
        <p>
          Save a project to download its seed, version, and settings. Load it to regenerate with
          this version of the code. Older projects receive defaults for the new controls when
          loaded. Everything is generated in your browser.
        </p>
        <p>
          Minerals &amp; gemstones shows a finite initial endowment. Select a resource and a deposit
          to see its amount, extent, and geological setting. Fertility is annual general land
          potential; inspect a cell to compare its average with the local river corridor.
        </p>
        {world && (
          <details className="diagnostics">
            <summary>Generation diagnostics</summary>
            <p>
              Application {appVersion} · Generator {world.version}
            </p>
            <dl>
              {world.timings.map((stage) => (
                <div key={stage.name}>
                  <dt>{stage.name}</dt>
                  <dd>{stage.ms.toFixed(1)} ms</dd>
                </div>
              ))}
            </dl>
            <p>
              Atmospheric water residual: {world.climate.atmosphereResidual.toExponential(2)}{' '}
              relative
              <br />
              Ocean flux divergence: {world.climate.oceanDivergence.toExponential(2)} m²/s
              <br />
              Ocean river inflow: {formatNumber(world.drainage.oceanDischarge)} m³/s
              <br />
              Lake net water exchange: {formatNumber(world.drainage.lakeExchange)} m³/s
              <br />
              Sediment leaving modeled terrain: {(world.sedimentExport / 1e9).toFixed(3)} km³
              <br />
              Cutoff remnants: {formatNumber(world.terrain.oxbows.length)} · Deltas:{' '}
              {formatNumber(world.rivers.deltas.length)}
              <br />
              Deposits: {formatNumber(world.resources.deposits.length)} · Fertility buffer:{' '}
              {(world.resources.fertility.byteLength / 1048576).toFixed(2)} MiB
              <br />
              Typed buffers: {(world.bytes / 1048576).toFixed(1)} MiB, excluding object and GPU
              memory
            </p>
            <button
              className="quiet-button"
              onClick={() =>
                downloadWorldConfig(
                  {
                    ...worldProject(world),
                    timings: world.timings,
                    bytes: world.bytes,
                    depositCount: world.resources.deposits.length,
                    fertilityBytes: world.resources.fertility.byteLength,
                    atmosphereRelativeResidual: world.climate.atmosphereResidual,
                    oceanFluxDivergence: world.climate.oceanDivergence,
                    lakes: world.drainage.lakes,
                    sedimentExportM3: world.sedimentExport,
                  },
                  'atlas-diagnostics.json',
                )
              }
            >
              Download diagnostics
            </button>
          </details>
        )}
      </DialogContent>
    </Dialog>
  );
}
