import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Dices,
  Globe2,
  Layers3,
  Map as MapIcon,
  Minus,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings2,
  Sparkles,
  Wind,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Progress } from '@/components/ui/progress';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import WorldView from '../render/WorldView';
import type { Projection } from '../render/projection';
import { MAP_STYLES, type MapStyle } from '../render/MapStyle';
import { DEFAULT_CONFIG, type Layer } from '../core/model';
import { SETTING_GROUPS, type NumericSetting } from '../core/config';
import { worldProject, readWorldProject } from '../core/project';
import { RESOURCE_PRESETS, resourcePreset } from '../core/resource-presets';
import { DepositInspector, ResourceControls } from './ResourceInspector';
import type { ResourceFilter } from '../render/ResourceMarkers';
import { LAYERS } from '../render/palette';
import { CellInspector, HelpDialog } from './Inspector';
import {
  cellCount,
  Choice,
  downloadWorldConfig,
  formatNumber,
  Range,
  Toggle,
  ToolButton,
} from './controls';
import { useWorldGeneration } from './useWorldGeneration';

export default function WorldStudio() {
  const [config, setConfig] = useState({ ...DEFAULT_CONFIG });
  const [layer, setLayer] = useState<Layer>('world');
  const [mapStyle, setMapStyle] = useState<MapStyle>('natural');
  const [season, setSeason] = useState(-1);
  const { world, busy, error, setError, progress, generate, cancel } = useWorldGeneration();
  const [gridLines, setGridLines] = useState(false);
  const [projection, setProjection] = useState<Projection>('globe');
  const [coastlines, setCoastlines] = useState(false);
  const [boundaries, setBoundaries] = useState(false);
  const [rivers, setRivers] = useState(true);
  const [vectors, setVectors] = useState(true);
  const [rotation, setRotation] = useState(false);
  const [animated, setAnimated] = useState(true);
  const [particleCount, setParticleCount] = useState(1200);
  const [flowSpeed, setFlowSpeed] = useState(1);
  const [relief, setRelief] = useState(26);
  const [riverThreshold, setRiverThreshold] = useState(20);
  const [riverWidth, setRiverWidth] = useState(1);
  const [drift, setDrift] = useState(0);
  const [selectedCell, setSelectedCell] = useState<number | null>(null);
  const [resourceFilter, setResourceFilter] = useState<ResourceFilter>('all');
  const [selectedDeposit, setSelectedDeposit] = useState<string | null>(null);
  const [projectNotice, setProjectNotice] = useState('');
  const [layersOpen, setLayersOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [command, setCommand] = useState<{ kind: 'in' | 'out' | 'reset'; id: number }>({
    kind: 'reset',
    id: 0,
  });
  const importInput = useRef<HTMLInputElement>(null);
  const activeLayer = LAYERS.find((layerInfo) => layerInfo.id === layer)!;
  const activeStyle = MAP_STYLES.find((style) => style.id === mapStyle)!;
  const legendStops =
    layer === 'world' && activeStyle.stops ? activeStyle.stops : activeLayer.stops;
  const hasPendingChanges = !!world && JSON.stringify(world.config) !== JSON.stringify(config);

  useEffect(() => {
    setSelectedCell(null);
    setSelectedDeposit(null);
  }, [world]);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setAnimated(false);
    }
  }, []);
  const worldStatistics = useMemo(() => {
    if (!world) {
      return null;
    }

    let oceanArea = 0;
    let landArea = 0;
    let areaWeightedRain = 0;
    let maximumElevation = 0;

    for (let cellIndex = 0; cellIndex < world.grid.count; cellIndex++) {
      const area = world.grid.areas[cellIndex];

      if (world.terrain.ocean[cellIndex]) {
        oceanArea += area;
      } else {
        landArea += area;
        areaWeightedRain += area * world.water.rain[cellIndex];
      }

      maximumElevation = Math.max(maximumElevation, world.terrain.height[cellIndex]);
    }

    return {
      ocean: oceanArea / (4 * Math.PI),
      rain: areaWeightedRain / Math.max(1e-9, landArea),
      highest: maximumElevation,
      lakes: world.drainage.lakes.filter((lake) => lake.area > 0).length,
    };
  }, [world]);

  function updateNumericSetting(key: NumericSetting, value: number) {
    setConfig((previousConfig) => ({
      ...previousConfig,
      [key]: value,
      ...(key === 'surfaceLevel'
        ? { processLevel: Math.min(value, previousConfig.processLevel) }
        : {}),
    }));
  }

  function chooseLayer(next: Layer) {
    setLayer(next);
    setDrift(0);
    setLayersOpen(false);
    if (next !== 'resources') {
      setSelectedDeposit(null);
    }
  }

  function selectDeposit(id: string | null) {
    setSelectedDeposit(id);
    if (id) {
      setSelectedCell(null);
      if (window.matchMedia('(max-width: 1250px)').matches) {
        setSettingsOpen(true);
      }
    }
  }

  function sendViewCommand(kind: 'in' | 'out' | 'reset') {
    setCommand((previousCommand) => ({ kind, id: previousCommand.id + 1 }));
  }

  function generateConfiguredWorld() {
    generate(config);
    setSettingsOpen(false);
  }

  async function importWorldConfig(file: File) {
    try {
      const { config: next, resourceRecipeChanged } = readWorldProject(
        JSON.parse(await file.text()),
      );
      setProjectNotice(
        resourceRecipeChanged
          ? 'Mineral rules have changed. This project is being regenerated with the current resource rules.'
          : '',
      );
      setConfig(next);
      generate(next);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Could not read this project.');
    }
  }

  const layerPanel = (
    <>
      <div className="panel-heading">
        <Layers3 size={16} />
        <h2>Layers</h2>
        <span>{LAYERS.length}</span>
      </div>
      <div className="map-style-field">
        <Choice
          label="Map style"
          value={layer === 'world' ? mapStyle : 'data-layer'}
          items={[
            ...(layer === 'world' ? [] : [['data-layer', 'Data layer']]),
            ...MAP_STYLES.map((style) => [style.id, style.name]),
          ]}
          onChange={(value) => {
            if (value === 'data-layer') {
              return;
            }
            setMapStyle(value as MapStyle);
            chooseLayer('world');
          }}
        />
      </div>
      <nav className="layer-list" aria-label="Planet layers">
        {['Overview', 'Geology', 'Climate', 'Water', 'Ecology', 'Resources'].map((group) => (
          <section key={group}>
            <h3>{group}</h3>
            {LAYERS.filter((layerInfo) => layerInfo.group === group).map((layerInfo) => (
              <button
                key={layerInfo.id}
                className={`layer-button ${layer === layerInfo.id ? 'is-active' : ''}`}
                aria-pressed={layer === layerInfo.id}
                onClick={() => chooseLayer(layerInfo.id)}
              >
                <span
                  className="layer-swatch"
                  style={{ background: layerInfo.stops[Math.floor(layerInfo.stops.length / 2)] }}
                />
                <span>{layerInfo.name}</span>
                {['wind', 'currents'].includes(layerInfo.id) && <Wind size={13} />}
              </button>
            ))}
          </section>
        ))}
      </nav>
    </>
  );
  const parameters = (
    <>
      {projectNotice && (
        <p className="project-notice" role="status">
          {projectNotice}
        </p>
      )}
      {world && layer === 'resources' && (
        <ResourceControls
          world={world}
          filter={resourceFilter}
          selected={selectedDeposit}
          onFilter={(filter) => {
            setResourceFilter(filter);
            setSelectedDeposit(null);
          }}
          onSelect={selectDeposit}
        />
      )}
      {world && selectedDeposit ? (
        <DepositInspector
          world={world}
          id={selectedDeposit}
          onClose={() => setSelectedDeposit(null)}
        />
      ) : world && selectedCell !== null ? (
        <CellInspector
          world={world}
          cell={selectedCell}
          season={season}
          onClose={() => setSelectedCell(null)}
        />
      ) : (
        <section className="world-profile">
          <div className="panel-heading">
            <Globe2 size={16} />
            <h2>World profile</h2>
          </div>
          {worldStatistics && world ? (
            <>
              <div className="profile-seed">{world.config.seed}</div>
              <div className="summary-grid">
                {[
                  ['Ocean cover', `${formatNumber(worldStatistics.ocean * 100)}%`],
                  ['Land rainfall', `${formatNumber(worldStatistics.rain)} mm/yr`],
                  ['Highest peak', `${formatNumber(worldStatistics.highest)} m`],
                  ['Reservoirs', formatNumber(worldStatistics.lakes)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
              <p className="panel-note">Click a cell to inspect its climate, terrain and water.</p>
            </>
          ) : (
            <p className="panel-note">Your world profile will appear here.</p>
          )}
        </section>
      )}
      <section className="parameters">
        <div className="panel-heading">
          <Settings2 size={16} />
          <h2>World parameters</h2>
          {hasPendingChanges && <span className="pending">Pending</span>}
        </div>
        <p className="panel-note">Apply changes with Generate world.</p>
        {SETTING_GROUPS.map((group, index) => (
          <details className="parameter-group" key={group.name} open={index === 0}>
            <summary>{group.name}</summary>
            <div>
              {group.settings.map((setting) => (
                <Range
                  key={setting.key}
                  label={setting.label}
                  value={config[setting.key]}
                  min={setting.min}
                  max={
                    setting.key === 'processLevel'
                      ? Math.min(setting.max, config.surfaceLevel)
                      : setting.max
                  }
                  step={setting.step}
                  onChange={(value) => updateNumericSetting(setting.key, value)}
                  description={setting.description}
                  display={
                    setting.key === 'radius'
                      ? `${formatNumber(config.radius / 1000)} km`
                      : setting.key === 'processLevel'
                        ? `${formatNumber(cellCount(config.processLevel))} cells`
                        : `${formatNumber(config[setting.key], 3)}${setting.unit ? ` ${setting.unit}` : ''}`
                  }
                />
              ))}
            </div>
          </details>
        ))}
        <Button
          variant="ghost"
          className="restore-defaults"
          onClick={() => setConfig({ ...DEFAULT_CONFIG, seed: config.seed })}
        >
          <RotateCcw size={14} />
          Restore defaults
        </Button>
      </section>
      <details className="parameter-group display-settings">
        <summary>Display settings</summary>
        <div>
          {(projection === 'globe' || (layer === 'world' && mapStyle === 'relief')) && (
            <Range
              label="Terrain exaggeration"
              value={relief}
              min={0}
              max={60}
              step={1}
              display={`${relief}×`}
              onChange={setRelief}
            />
          )}
          <Range
            label="River visibility"
            value={riverThreshold}
            min={1}
            max={300}
            step={1}
            display={`≥ ${riverThreshold} m³/s`}
            onChange={setRiverThreshold}
            description="Show smaller established tributaries. Headwater settings control which channels form; bank vegetation is independent of this filter."
          />
          <Range
            label="River strip width"
            value={riverWidth}
            min={0.5}
            max={2.5}
            step={0.1}
            display={`${riverWidth.toFixed(1)}×`}
            onChange={setRiverWidth}
            description="Display thickness without changing the river's course."
          />
          <Range
            label="Flow particles"
            value={particleCount}
            min={300}
            max={2400}
            step={100}
            display={formatNumber(particleCount)}
            onChange={setParticleCount}
          />
          <Range
            label="Animation speed"
            value={flowSpeed}
            min={0.25}
            max={3}
            step={0.25}
            display={`${flowSpeed}×`}
            onChange={setFlowSpeed}
          />
        </div>
      </details>
    </>
  );

  return (
    <TooltipProvider delayDuration={250}>
      <main className="world-forge">
        <header className="app-header">
          <div className="brand-lockup">
            <div className="brand-mark">
              <Globe2 size={27} />
            </div>
            <div>
              <div className="brand-line">
                <h1>World Forge</h1>
                <span>ATLAS</span>
              </div>
              <p>A world, from the ground up</p>
            </div>
          </div>
          <div className="generation-controls">
            <label className="seed-control">
              <span>Master seed</span>
              <div>
                <input
                  aria-label="Master seed"
                  value={config.seed}
                  maxLength={100}
                  spellCheck={false}
                  onChange={(event) =>
                    setConfig((previousConfig) => ({ ...previousConfig, seed: event.target.value }))
                  }
                />
                <ToolButton
                  label="Choose a random seed"
                  onClick={() =>
                    setConfig((previousConfig) => ({
                      ...previousConfig,
                      seed: `AETHER-${Math.floor(Math.random() * 100000)}`,
                    }))
                  }
                >
                  <Dices size={17} />
                </ToolButton>
              </div>
            </label>
            <Choice
              label="Surface resolution"
              value={String(config.surfaceLevel)}
              onChange={(value) => updateNumericSetting('surfaceLevel', +value)}
              items={[3, 4, 5, 6, 7, 8, 9].map((resolutionLevel) => [
                String(resolutionLevel),
                `${formatNumber(cellCount(resolutionLevel))} cells`,
              ])}
            />
            <Choice
              label="Season"
              value={String(season)}
              onChange={(value) => setSeason(+value)}
              items={[
                ['-1', 'Annual mean'],
                ['0', 'March equinox'],
                ['1', 'June solstice'],
                ['2', 'September equinox'],
                ['3', 'December solstice'],
              ]}
            />
            <Button
              className="generate-button"
              disabled={busy || !config.seed.trim()}
              onClick={generateConfiguredWorld}
            >
              {busy ? <RefreshCw size={16} className="spin" /> : <Sparkles size={16} />}
              {busy ? 'Generating' : 'Generate world'}
            </Button>
          </div>
          <div className="project-actions">
            <ToolButton label="Load project" onClick={() => importInput.current?.click()}>
              <ArrowUpFromLine size={17} />
            </ToolButton>
            <ToolButton
              label="Save project"
              disabled={!world}
              onClick={() =>
                world &&
                downloadWorldConfig(
                  worldProject(world),
                  `${world.config.seed.replace(/[^a-z0-9_-]/gi, '_')}.json`,
                )
              }
            >
              <ArrowDownToLine size={17} />
            </ToolButton>
            <HelpDialog world={world} />
          </div>
          <input
            ref={importInput}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(event) => {
              if (event.target.files?.[0]) {
                void importWorldConfig(event.target.files[0]);
              }

              event.target.value = '';
            }}
          />
        </header>
        <div className="mobile-panels">
          <Sheet open={layersOpen} onOpenChange={setLayersOpen}>
            <SheetTrigger asChild>
              <Button variant="outline">
                <Layers3 size={15} />
                Layers
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="panel-sheet">
              <SheetHeader>
                <SheetTitle>Explore layers</SheetTitle>
              </SheetHeader>
              {layerPanel}
            </SheetContent>
          </Sheet>
          <span>{activeLayer.name}</span>
          <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
            <SheetTrigger asChild>
              <Button variant="outline">
                <Settings2 size={15} />
                Parameters{hasPendingChanges && ' •'}
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="panel-sheet">
              <SheetHeader>
                <SheetTitle>World settings</SheetTitle>
              </SheetHeader>
              {parameters}
              <Button className="generate-button" onClick={generateConfiguredWorld} disabled={busy}>
                Generate world
              </Button>
            </SheetContent>
          </Sheet>
        </div>
        <div className="workspace-grid">
          <aside className="layer-panel">{layerPanel}</aside>
          <section className="viewport-panel" aria-labelledby="active-layer-title">
            <WorldView
              mapStyle={mapStyle}
              projection={projection}
              coastlines={coastlines}
              world={world}
              layer={layer}
              season={season}
              gridLines={gridLines}
              boundaries={boundaries}
              rivers={rivers}
              vectors={vectors}
              rotation={rotation}
              animated={animated}
              particleCount={particleCount}
              flowSpeed={flowSpeed}
              riverWidth={riverWidth}
              relief={relief}
              riverThreshold={riverThreshold}
              drift={drift}
              selected={selectedCell}
              onSelect={setSelectedCell}
              resourceFilter={resourceFilter}
              selectedDeposit={selectedDeposit}
              onSelectDeposit={selectDeposit}
              command={command}
            />
            <div className="projection-switch" role="group" aria-label="World layout">
              {(['globe', 'map'] as const).map((mode) => (
                <Button
                  key={mode}
                  variant="ghost"
                  size="sm"
                  aria-pressed={projection === mode}
                  onClick={() => {
                    setProjection(mode);
                    setDrift(0);
                  }}
                  title={
                    mode === 'map'
                      ? 'Equirectangular map: north up, east right. Polar areas are stretched.'
                      : 'Explore the planet in 3D'
                  }
                >
                  {mode === 'globe' ? <Globe2 size={15} /> : <MapIcon size={15} />}
                  {mode === 'globe' ? 'Globe' : 'Flat map'}
                </Button>
              ))}
            </div>
            <div className="layer-readout">
              <span className="eyebrow">Active field · {activeLayer.group}</span>
              <h2 id="active-layer-title">
                {layer === 'world' && mapStyle !== 'natural' ? activeStyle.name : activeLayer.name}
              </h2>
              <p>{layer === 'world' ? activeStyle.description : activeLayer.description}</p>
            </div>
            <div className="viewport-toolbar">
              {projection === 'globe' && (
                <ToolButton
                  label={rotation ? 'Pause planet rotation' : 'Rotate planet'}
                  onClick={() => setRotation(!rotation)}
                  active={rotation}
                >
                  {rotation ? <Pause size={17} /> : <Play size={17} />}
                </ToolButton>
              )}
              <ToolButton label="Zoom in" onClick={() => sendViewCommand('in')}>
                <Plus size={17} />
              </ToolButton>
              <ToolButton label="Zoom out" onClick={() => sendViewCommand('out')}>
                <Minus size={17} />
              </ToolButton>
              <ToolButton
                label="Reset view"
                onClick={() => {
                  sendViewCommand('reset');
                  setDrift(0);
                }}
              >
                <RotateCcw size={17} />
              </ToolButton>
            </div>
            {layer === 'tectonics' && projection === 'globe' && (
              <div className="drift-control">
                <Range
                  label="Plate drift preview"
                  value={drift}
                  min={-20}
                  max={20}
                  step={1}
                  display={`${drift}°`}
                  onChange={setDrift}
                />
                <p>Rotates plates; no historical reconstruction.</p>
              </div>
            )}
            <div className="viewport-hint">
              Drag to {projection === 'map' ? 'pan' : 'orbit'} · Scroll to zoom · Click to inspect
            </div>
            <div className="legend-card">
              <div>
                <strong>{layer === 'world' ? activeStyle.name : activeLayer.name}</strong>
                <span>{activeLayer.unit}</span>
              </div>
              {layer === 'resources' ? (
                <div className="resource-legend">
                  {RESOURCE_PRESETS.filter(
                    (preset) => resourceFilter === 'all' || resourceFilter === preset.type,
                  ).map((preset) => (
                    <span key={preset.type}>
                      <i style={{ background: preset.color }} />
                      {preset.name}
                    </span>
                  ))}
                  {resourceFilter === 'all' ? (
                    <p>Marker size shows amount within each resource.</p>
                  ) : (
                    <p>
                      Small → large: ≤{formatNumber(resourcePreset(resourceFilter).amountRange[0])}{' '}
                      → ≥{formatNumber(resourcePreset(resourceFilter).amountRange[1])} units
                    </p>
                  )}
                </div>
              ) : (
                <>
                  <div
                    className="legend-ramp"
                    style={{ background: `linear-gradient(90deg, ${legendStops.join(',')})` }}
                  />
                  <div className="legend-labels">
                    {activeLayer.labels.map((label) => (
                      <span key={label}>{label}</span>
                    ))}
                  </div>
                </>
              )}
              {layer === 'fertility' && (
                <p>Annual cell mean · blue: water · pale: ice. Inspect local corridor potential.</p>
              )}
              {projection === 'map' && (
                <p>
                  {layer === 'world' && mapStyle === 'relief'
                    ? 'Oblique relief · '
                    : 'Equirectangular · '}
                  polar areas are stretched
                </p>
              )}
              {layer === 'world' && mapStyle === 'illustrated' && (
                <p>Ink symbols show mountain and forest locations · seasonal wash</p>
              )}
              {coastlines && <p>Gold outlines · present-day coastlines</p>}
              {['world', 'vegetation', 'biomes'].includes(layer) && (
                <p>Blended riverbanks · meadow, woodland &amp; wetland habitats</p>
              )}
              {layer === 'floodplains' && (
                <p>
                  {season < 0 ? 'Peak across four seasons' : 'Selected season'} · potential, not
                  flood probability
                </p>
              )}
              {['wind', 'currents', 'sst'].includes(layer) && (
                <p>Trails move with the field · brighter head leads</p>
              )}
              {rivers && (
                <p>
                  {season < 0
                    ? 'Annual drainage · stronger flow, wider channel'
                    : 'Muted channels are frozen or low-flow · pulses follow seasonal runoff'}
                </p>
              )}
            </div>
            {busy && (
              <div className="generation-overlay">
                <div className="generation-card" role="status" aria-live="polite">
                  <Globe2 size={30} className="spin-slow" />
                  <h3>{progress.stage}</h3>
                  <Progress value={(progress.completed / progress.total) * 100} />
                  <div>
                    <span>
                      {progress.completed} / {progress.total} stages
                    </span>
                    <Button variant="ghost" size="sm" onClick={cancel}>
                      Cancel
                    </Button>
                  </div>
                </div>
              </div>
            )}
            {error && (
              <div className="error-banner" role="alert">
                <span>{error}</span>
                <button aria-label="Dismiss error" onClick={() => setError('')}>
                  <X size={16} />
                </button>
              </div>
            )}
          </section>
          <aside className="inspector-panel">{parameters}</aside>
        </div>
        <footer className="app-footer">
          <div className="display-toggles">
            <Toggle label="Cell grid" checked={gridLines} onChange={setGridLines} />
            <Toggle label="Coastlines" checked={coastlines} onChange={setCoastlines} />
            <Toggle label="Plate borders" checked={boundaries} onChange={setBoundaries} />
            <Toggle label="Rivers" checked={rivers} onChange={setRivers} />
            <Toggle label="Flow trails" checked={vectors} onChange={setVectors} />
            <Toggle label="Animate flows" checked={animated} onChange={setAnimated} />
          </div>
          <div className="runtime-stats">
            <span className={`status-dot ${busy ? 'working' : ''}`} />
            {busy
              ? 'Generating world'
              : world
                ? `${formatNumber(world.grid.count)} cells · ${(world.elapsed / 1000).toFixed(1)}s · ${(world.bytes / 1048576).toFixed(1)} MiB buffers`
                : 'Ready to generate'}
          </div>
        </footer>
      </main>
    </TooltipProvider>
  );
}
