import { CircleHelp, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from '@/components/ui/dialog';
import type { CellInspection, WorldHandle } from '../core/view/types';
import { BIOMES } from '../core/generation/ecology';
import { classifyLakeSize } from '../core/generation/lake-surfaces';
import { RIVER_HABITATS } from '../core/generation/floodplains';
import { RIVER_SOURCES, RIVER_REGIMES } from '../core/generation/rivers';
import { WETLANDS } from '../core/generation/wetlands';
import { BIOME_COLORS } from '../render/palette';
import { version as appVersion } from '../../package.json';
import { downloadWorldConfig, formatNumber } from './controls';
import { FertilityDetails } from './ResourceInspector';
import { lakeWaterDescription } from '../core/generation/lake-state';
import { salinityClass } from '../core/generation/salinity';

export function CellInspector({
  inspection,
  onClose,
}: {
  inspection: CellInspection;
  onClose: () => void;
}) {
  const {
    cell: cellIndex,
    latitude,
    longitude,
    temperature,
    rain,
    season,
    river,
    delta,
    oxbow,
    seasonalFlood,
  } = inspection;
  const discharge = river?.discharge ?? 0;
  const catchment = river?.catchmentArea ?? 0;
  const riverCorner = river?.corner ?? -1;
  const reservoir = inspection.lake;
  const coverage = inspection.lakeCoverage;
  const standingWater = coverage >= 1 - 1e-6;
  const lakeSeason = season >= 0 ? reservoir?.seasonal : undefined;

  return (
    <aside className="cell-inspector">
      <div className="inspector-heading">
        <span className="eyebrow">CELL {formatNumber(cellIndex)}</span>
        <button aria-label="Close cell inspector" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <h3>
        <span style={{ background: BIOME_COLORS[inspection.biome] }} />
        {standingWater && reservoir
          ? `${classifyLakeSize(reservoir.area)} ${reservoir.id + 1}`
          : inspection.biome === 2 && Math.abs(latitude) < 45 && inspection.height > 1500
            ? 'Alpine tundra'
            : BIOMES[inspection.biome]}
      </h3>
      <p className="coordinates">
        {Math.abs(latitude).toFixed(2)}° {latitude < 0 ? 'S' : 'N'} ·{' '}
        {Math.abs(longitude).toFixed(2)}° {longitude < 0 ? 'W' : 'E'}
      </p>
      <dl>
        {[
          ['Elevation', `${formatNumber(inspection.height)} m`],
          ['Bedrock elevation', `${formatNumber(inspection.bedrock)} m`],
          ['Sediment thickness', `${formatNumber(inspection.sediment, 2)} m`],
          ['Temperature', `${temperature.toFixed(1)} °C`],
          ['Precipitation', `${formatNumber(rain)} mm${season < 0 ? '/yr' : ''}`],
          ['PET', `${formatNumber(inspection.pet)} mm/yr`],
          ['Actual ET', `${formatNumber(inspection.aet)} mm/yr`],
          ['Annual channel flow', `${formatNumber(discharge, 1)} m³/s`],
          ...(season >= 0
            ? [
                [
                  'Seasonal channel flow',
                  `${formatNumber(riverCorner < 0 ? 0 : river!.seasonalDischarge[season], 1)} m³/s`,
                ],
              ]
            : []),
          ['Upstream catchment', `${formatNumber(catchment / 1e6)} km²`],
          ['River system', riverCorner < 0 ? '—' : String(river!.system + 1)],
          ['Stream order', riverCorner < 0 ? '—' : String(river!.streamOrder)],
          ['Water supply', riverCorner < 0 ? '—' : RIVER_SOURCES[river!.source]],
          ['Flow pattern', riverCorner < 0 ? '—' : RIVER_REGIMES[river!.regime]],
          [
            'Channel sinuosity',
            river?.sinuosity == null
              ? '—'
              : `${formatNumber(river!.sinuosity!, 2)}× straight distance`,
          ],
          ['Flows to', riverCorner < 0 ? '—' : river!.destination],
          ...(river?.salinity != null
            ? [
                [
                  'River salinity',
                  `${formatNumber(river.salinity, 2)} g/L · ${salinityClass(river.salinity)}`,
                ],
              ]
            : []),
          ['Vegetation potential', `${formatNumber(inspection.vegetation * 100, 1)}%`],
          [
            'River corridor coverage',
            `${formatNumber(inspection.riparianFraction * 100, 1)}% of cell`,
          ],
          ['Local river habitat', RIVER_HABITATS[inspection.riverHabitat]],
          ['Bank vegetation potential', `${formatNumber(inspection.riparian * 100, 1)}%`],
          [
            'Flood-accessible land',
            `${formatNumber(inspection.floodplainFraction * 100, 1)}% of cell`,
          ],
          ['Wetland habitat', WETLANDS[inspection.wetland]],
          ['Wetland coverage', `${formatNumber(inspection.wetlandFraction * 100, 1)}% of cell`],
          ...(inspection.soilSalinity != null &&
          inspection.soilSalinity > 2 &&
          (inspection.soilSalinityFraction ?? 0) > 0
            ? [
                ['Affected-soil salinity', `${formatNumber(inspection.soilSalinity, 2)} g/L`],
                [
                  'Salt-affected soil',
                  `${formatNumber((inspection.soilSalinityFraction ?? 0) * 100, 1)}% of cell`,
                ],
              ]
            : []),
          [
            'Overbank potential',
            seasonalFlood === null
              ? '—'
              : seasonalFlood > 0.6
                ? 'High'
                : seasonalFlood > 0.15
                  ? 'Moderate'
                  : 'Low',
          ],
          ['Crust age', `${formatNumber(inspection.crustAge)} Ma`],
          ['Volcanic construction', `${formatNumber(inspection.volcanic)} m`],
          ['Erosion / deposition', `${formatNumber(inspection.surfaceChange)} m`],
          ['River incision', `${formatNumber(inspection.fluvialIncision)} m · cell average`],
          ['Mouth sediment', `${formatNumber(inspection.deltaSediment, 1)} m`],
          ['Plate', String(inspection.plate + 1)],
          ['Cell area', `${formatNumber(inspection.areaM2 / 1e6)} km²`],
          ['Nearest cell center', `${formatNumber(inspection.nearestCenterMetres / 1000, 2)} km`],
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
                <dd>{formatNumber(river!.sourceFractions[sourceIndex] * 100, 1)}%</dd>
              </div>
            ))}
            {['March', 'June', 'September', 'December'].map((label, seasonIndex) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{formatNumber(river!.seasonalDischarge[seasonIndex], 1)} m³/s</dd>
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
            {delta.fractions
              .map(
                (fraction) =>
                  `${formatNumber(fraction * 100)}% · ${formatNumber(discharge * fraction, 1)} m³/s`,
              )
              .join(' / ')}
          </p>
        </div>
      )}
      {oxbow && (
        <div className="lake-summary">
          <span className="eyebrow">Cutoff channel / oxbow</span>
          <p>
            {formatNumber(oxbow.area / 1e6, 2)} km² · {formatNumber(oxbow.depth, 2)} m water depth
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
          {reservoir.salinity && (
            <>
              <dl>
                {reservoir.storage > 0 && (
                  <div>
                    <dt>Lake salinity</dt>
                    <dd>{formatNumber(reservoir.salinity.concentration, 2)} g/L</dd>
                  </div>
                )}
                <div>
                  <dt>Dissolved salt</dt>
                  <dd>{formatNumber(reservoir.salinity.dissolvedSalt / 1000)} tonnes</dd>
                </div>
                <div>
                  <dt>Lakebed salt</dt>
                  <dd>{formatNumber(reservoir.salinity.bedSalt / 1000)} tonnes</dd>
                </div>
                <div>
                  <dt>Salt accumulation interval</dt>
                  <dd>{formatNumber(reservoir.salinity.elapsedYears)} years</dd>
                </div>
              </dl>
              <p>Salt values use the representative annual water balance.</p>
            </>
          )}
        </div>
      )}
      <FertilityDetails
        fertility={inspection.fertility}
        storedScore={inspection.storedCellFertility}
        salinityModeled={inspection.soilSalinity != null}
      />
    </aside>
  );
}

export function HelpDialog({ handle }: { handle: WorldHandle | null }) {
  const world = handle?.summary;
  const spacing = world?.nearestCenterSpacingM;

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
          update immediately. Your current world stays visible while you work. Cancel leaves it
          intact.
        </p>
        <p>
          Four seasons drive climate. River widths show annual discharge; seasonal views animate
          wet-season flow and mute frozen or low-flow channels. Melt-season Arctic rivers remain
          visible. Surface detail and simulation detail are separate, keeping plate definitions and
          circulation centers stable when you refine the terrain.
        </p>
        <p>
          Base surface resolution sets the initial cell count. Adaptive refinement adds smaller
          cells near coasts and terrain changes before the final world is generated. Minimum target
          spacing controls the requested local detail; diagnostics report the actual count and
          center distances. Smaller spacing can increase generation time and memory substantially.
          Refinement is off by default. Refine evolving terrain can revisit the growing river
          network and changing relief during landscape evolution. New cells inherit the eroded
          bedrock and deposited sediment; they do not restart the terrain.
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
          Landscape evolution duration sets the recent interval after geological weathering.
          Landscape time steps divide that interval and rebuild drainage as rivers lower valleys and
          sediment moves downstream. Hillslope transport moves material downslope, while wind
          redistributes exposed sediment. More steps increase generation time without increasing the
          modeled duration. Final climate and water are rebuilt from the evolved terrain. This
          interval is not a birth date for each river; canyon detail remains limited by cell
          spacing.
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
          separate plate motion arrow preview is display only. Lake storage is an annual equilibrium
          estimate.
        </p>
        <p>
          Lake salts come from dissolved catchment minerals and the selected inherited lake
          salinity. Evaporation removes water while leaving salt behind; outlets carry dissolved
          salt downstream. Drying leaves lakebed salt that can dissolve again when water returns.
          The salt accumulation interval is separate from geological age, and refinement does not
          advance it. Oceanic crust alone does not establish a marine history or make a lake saline.
        </p>
        <p>
          Inspect a lake or river for its dissolved salt concentration in g/L. Freshwater is below
          0.5 g/L, brackish water is below 5 g/L, saline water is below 50 g/L, and hypersaline
          water is 50 g/L or more. Local salt exposure reduces soil fertility and vegetation; the
          climate biome and climatic aridity remain separate. Old saved worlds have no modeled salt
          state.
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
          and plate motion arrows are available on the globe.
        </p>
        <p>
          Automatic feature detail checks the finished terrain for unresolved lake shores, river
          junctions and outlets, coastlines and sharp relief. Lake district detail also covers broad
          lake-rich regions and the land between small lakes. Quiet-land controls allow uniform
          grassland and forest interiors to lose cells, subject to height and spacing limits;
          waterways, wetlands and terrain features stay protected. The insertion and removal budgets
          are separate limits shared across final passes. Water and habitats are recalculated
          without advancing landscape time. These passes only run during generation.
        </p>
        <p>
          Zoom detail adds temporary terrain subdivisions near the view centre in Natural globe and
          Shaded relief views. It uses the existing heights and slopes, preserving original cell
          edges, shores, lake surfaces and river corridors. Zooming out releases the extra detail.
          The physical cell grid, simulation and saved world stay unchanged.
        </p>
        <p>
          Generated and refined worlds start unsaved. Choose Save world to name and keep the exact
          terrain in this browser. Saved worlds opens it without regeneration; clearing browser
          storage removes saved worlds. Unsaved terrain is discarded when replaced or closed. Export
          recipe downloads settings and resolved refinement history for regeneration. Import recipe
          replays that history with this version of the generator. Select a cell to refine a local
          region or its whole river-system watershed without advancing landscape time.
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
              <br />
              Climate solve: {world.execution.climateWorkers}{' '}
              {world.execution.climateWorkers === 1 ? 'worker' : 'workers'} per seasonal stage
            </p>
            {spacing && (
              <p>
                Surface cells: {formatNumber(world.surfaceCells)} · Simulation cells:{' '}
                {formatNumber(world.processCells)}
                {world.refinement && (
                  <>
                    <br />
                    Base cells: {formatNumber(world.refinement.baseCount)} · Added:{' '}
                    {formatNumber(world.refinement.insertedCount)} · Refinement passes:{' '}
                    {world.refinement.passes}
                  </>
                )}
                <br />
                Nearest-center spacing: {formatNumber(spacing.min / 1000, 2)}–
                {formatNumber(spacing.max / 1000, 2)} km
                <br />
                10th / median / 90th percentile: {formatNumber(spacing.p10 / 1000, 2)} /{' '}
                {formatNumber(spacing.median / 1000, 2)} / {formatNumber(spacing.p90 / 1000, 2)} km
              </p>
            )}
            {!!world.featureRefinementStats?.length && (
              <dl>
                {world.featureRefinementStats.map((pass, index) => (
                  <div key={index}>
                    <dt>Final feature pass {index + 1}</dt>
                    <dd>
                      +{formatNumber(pass.afterCells - pass.beforeCells)} cells
                      {' · '}
                      {formatNumber(pass.selectedCells)} feature cells selected
                      {pass.budgetExhausted ? ' · limited by budget' : ''}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {!!world.featureCoarseningStats?.length && (
              <dl>
                {world.featureCoarseningStats.map((pass) => (
                  <div key={pass.pass}>
                    <dt>Quiet-land pass {pass.pass + 1}</dt>
                    <dd>
                      −{formatNumber(pass.removedCells)} cells
                      {' · '}
                      {formatNumber(pass.candidateCells)} candidates
                      {' · '}
                      {formatNumber(pass.budgetCells)} cell limit
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {world.evolution && (
              <>
                <p>
                  Recent landscape interval: {formatNumber(world.evolution.durationMyr, 3)} Myr
                  <br />
                  Completed time steps: {world.evolution.batches} · Drainage refreshes:{' '}
                  {world.evolution.drainageRefreshes}
                  <br />
                  Hillslope material moved: {formatNumber(
                    world.evolution.hillslopeMoved / 1e9,
                    3,
                  )}{' '}
                  km³
                  <br />
                  Wind material moved: {formatNumber(world.evolution.windMoved / 1e9, 3)} km³
                </p>
                {world.evolution.remeshes.length > 0 && (
                  <dl>
                    {world.evolution.remeshes.map((remesh, index) => (
                      <div key={index}>
                        <dt>Refinement at {formatNumber(remesh.elapsedMyr, 3)} Myr</dt>
                        <dd>
                          {formatNumber(remesh.beforeCells)} → {formatNumber(remesh.afterCells)}
                          {' cells · sediment change '}
                          {((remesh.sedimentAfter - remesh.sedimentBefore) / 1e9).toExponential(2)}
                          {' km³'}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </>
            )}
            <dl>
              {world.timings.map((stage) => (
                <div key={stage.name}>
                  <dt>{stage.name}</dt>
                  <dd>{stage.ms.toFixed(1)} ms</dd>
                </div>
              ))}
            </dl>
            <p>
              Atmospheric water residual: {world.atmosphereRelativeResidual.toExponential(2)}{' '}
              relative
              <br />
              Ocean flux divergence: {world.oceanFluxDivergence.toExponential(2)} m²/s
              <br />
              Ocean river inflow: {formatNumber(world.oceanDischarge)} m³/s
              <br />
              Lake net water exchange: {formatNumber(world.lakeExchange)} m³/s
              <br />
              Sediment leaving modeled terrain: {(world.sedimentExport / 1e9).toFixed(3)} km³
              <br />
              Cutoff remnants: {formatNumber(world.oxbowCount)} · Deltas:{' '}
              {formatNumber(world.deltaCount)}
              <br />
              Deposits: {formatNumber(world.depositCount)} · Fertility buffer:{' '}
              {((world.surfaceCells * 4) / 1048576).toFixed(2)} MiB
              <br />
              Typed buffers: {(world.bytes / 1048576).toFixed(1)} MiB, excluding object and GPU
              memory
            </p>
            <button
              className="quiet-button"
              onClick={() =>
                downloadWorldConfig(
                  { snapshotId: handle?.snapshotId, ...world },
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
