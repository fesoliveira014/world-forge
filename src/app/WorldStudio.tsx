'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
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
import type { GridDisplayStatus } from '../render/FixedGridCache';
import type { Projection } from '../render/projection';
import { MAP_STYLES, type MapStyle } from '../render/MapStyle';
import { isFantasyMapStyle } from '../render/FantasyStyle';
import { NEW_WORLD_CONFIG, type Layer, type WorldConfig } from '../core/model';
import { SETTING_GROUPS, type NumericSetting, type Setting } from '../core/config';
import { RESOURCE_PRESETS, resourcePreset } from '../core/resource-presets';
import {
  applyQualityPreset,
  matchingQualityPreset,
  QUALITY_PRESETS,
} from '../core/quality-presets';
import { DepositInspector, ResourceControls } from './ResourceInspector';
import type { ResourceFilter } from '../render/ResourceMarkers';
import { LAYERS } from '../render/palette';
import { CellInspector, HelpDialog } from './Inspector';
import { cellCount, Choice, formatNumber, Range, Toggle, ToolButton } from './controls';
import { useWorldGeneration } from './useWorldGeneration';
import type { Vec3 } from '../core/math';
import type { CellInspection, OverlayPacket } from '../core/view/types';
import { WorldLibrary } from './WorldLibrary';
import { SaveWorldDialog } from './SaveWorldDialog';
import { RegionControls } from './RegionControls';
import { regionSettingsError, type RegionSettings } from './region-settings';

function settingDisplay(setting: Setting, config: WorldConfig): string {
  const value = config[setting.key];

  if (
    [
      'radius',
      'refinementMinSpacing',
      'featureRefinementSpacing',
      'featureDistrictRadius',
      'featureCoarseningSpacing',
    ].includes(setting.key)
  ) {
    return `${formatNumber(value / 1000, 1)} km`;
  }

  if (setting.key === 'refinementStrength') {
    return value === 0 ? 'Off' : `${formatNumber(value * 100)}%`;
  }

  if (setting.key === 'evolutionRefinements' || setting.key === 'featureRefinementPasses') {
    return value === 0 ? 'Off' : `${formatNumber(value)} ${value === 1 ? 'pass' : 'passes'}`;
  }

  if (setting.key === 'landscapeBatches') {
    return `${formatNumber(value)} ${value === 1 ? 'step' : 'steps'}`;
  }

  if (setting.key === 'processLevel') {
    return `${formatNumber(cellCount(value))} cells`;
  }

  return `${formatNumber(value, 3)}${setting.unit ? ` ${setting.unit}` : ''}`;
}

function getReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
function subscribeReducedMotion(callback: () => void) {
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  media.addEventListener('change', callback);
  return () => media.removeEventListener('change', callback);
}

export default function WorldStudio() {
  const [config, setConfig] = useState({ ...NEW_WORLD_CONFIG });
  const [layer, setLayer] = useState<Layer>('world');
  const [mapStyle, setMapStyle] = useState<MapStyle>('natural');
  const [season, setSeason] = useState(-1);
  const {
    handle: world,
    initialConfig,
    source,
    libraryRevision,
    saving,
    busy,
    error,
    setError,
    progress,
    generate,
    importRecipe,
    refine,
    cancel,
    open,
    close,
    save,
    cancelSave,
  } = useWorldGeneration();
  const [zoomDetail, setZoomDetail] = useState(true);
  const [gridLines, setGridLines] = useState(false);
  const [gridStatus, setGridStatus] = useState<GridDisplayStatus>({
    state: 'off',
    loadedBatches: 0,
    totalBatches: 0,
  });
  const [projection, setProjection] = useState<Projection>('globe');
  const [coastlines, setCoastlines] = useState(false);
  const [coastStatus, setCoastStatus] = useState<OverlayPacket['coastStatus']>();
  const [boundaries, setBoundaries] = useState(false);
  const [rivers, setRivers] = useState(true);
  const [vectors, setVectors] = useState(true);
  const [rotation, setRotation] = useState(false);
  const [animated, setAnimated] = useState<boolean | null>(null);
  const [particleCount, setParticleCount] = useState(1200);
  const [flowSpeed, setFlowSpeed] = useState(1);
  const [relief, setRelief] = useState(26);
  const [riverThreshold, setRiverThreshold] = useState(20);
  const [riverWidth, setRiverWidth] = useState(1);
  const [drift, setDrift] = useState(0);
  const [selectedAnchor, setSelectedAnchor] = useState<Vec3 | null>(null);
  const [inspectionResult, setInspectionResult] = useState<{
    snapshotId: string;
    anchor: Vec3;
    season: number;
    inspection: CellInspection;
  } | null>(null);
  const [inspectionFailure, setInspectionFailure] = useState<{
    source: typeof source;
    anchor: Vec3;
    season: number;
    message: string;
  } | null>(null);
  const inspectionError =
    inspectionFailure?.source === source &&
    inspectionFailure?.anchor === selectedAnchor &&
    inspectionFailure?.season === season
      ? inspectionFailure.message
      : '';
  const [regionSettings, setRegionSettings] = useState<RegionSettings>({
    radiusMetres: 250000,
    targetSpacingMetres: 10000,
    footprint: 'region',
  });
  const [exporting, setExporting] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const reducedMotion = useSyncExternalStore(subscribeReducedMotion, getReducedMotion, () => false);
  const animationsEnabled = animated ?? !reducedMotion;
  const inspection =
    world &&
    inspectionResult?.snapshotId === world.snapshotId &&
    inspectionResult.anchor === selectedAnchor &&
    inspectionResult.season === season
      ? inspectionResult.inspection
      : null;
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
  const heightmapView = layer === 'world' && mapStyle === 'heightmap';
  const legendStops =
    layer === 'world' && activeStyle.stops ? activeStyle.stops : activeLayer.stops;
  const legendLabels = heightmapView
    ? world
      ? [
          `${formatNumber(world.summary.minimumHeight)} m`,
          `${formatNumber(world.summary.maximumHeight)} m`,
        ]
      : ['Lowest', 'Highest']
    : activeLayer.labels;
  const hasPendingChanges = !!world && JSON.stringify(world.config) !== JSON.stringify(config);
  const qualityPreset = matchingQualityPreset(config);

  if (initialConfig && !initialized) {
    setConfig({ ...NEW_WORLD_CONFIG, ...initialConfig });
    setInitialized(true);
  }

  useEffect(() => {
    if (!world || !source || !selectedAnchor) {
      return;
    }
    let active = true;
    void source
      .inspect(selectedAnchor, season)
      .then((next) => {
        if (active) {
          setInspectionFailure(null);
          setInspectionResult({
            snapshotId: world.snapshotId,
            anchor: selectedAnchor,
            season,
            inspection: next,
          });
        }
      })
      .catch((caughtError) => {
        if (active) {
          setInspectionFailure({
            source,
            anchor: selectedAnchor,
            season,
            message:
              caughtError instanceof Error
                ? caughtError.message
                : 'Could not inspect this location.',
          });
        }
      });
    return () => {
      active = false;
    };
  }, [world, source, selectedAnchor, season]);

  const worldStatistics = world?.summary;

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
      setSelectedAnchor(null);
      if (window.matchMedia('(max-width: 1250px)').matches) {
        setSettingsOpen(true);
      }
    }
  }

  function sendViewCommand(kind: 'in' | 'out' | 'reset') {
    setCommand((previousCommand) => ({ kind, id: previousCommand.id + 1 }));
  }

  function generateConfiguredWorld() {
    void generate(config);
    setSelectedAnchor(null);
    setSelectedDeposit(null);
    setSettingsOpen(false);
  }

  function importWorldConfig(file: File) {
    void importRecipe(file, ({ config: next, resourceRecipeChanged }) => {
      setProjectNotice(
        resourceRecipeChanged
          ? 'Mineral rules have changed. This recipe is being regenerated with the current resource rules.'
          : '',
      );
      setConfig(next);
      setSelectedAnchor(null);
      setSelectedDeposit(null);
    });
  }

  async function exportRecipe() {
    if (!source || !world) {
      return;
    }
    setExporting(true);
    try {
      const recipe = await source.exportRecipe();
      const url = URL.createObjectURL(recipe);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${world.config.seed.replace(/[^a-z0-9_-]/gi, '_')}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : 'Could not export this recipe.',
      );
    } finally {
      setExporting(false);
    }
  }

  function refineSelectedRegion() {
    if (!world || !selectedAnchor || regionSettingsError(regionSettings, world.config.radius)) {
      return;
    }
    if (regionSettings.footprint === 'watershed') {
      if (!inspection?.river) {
        return;
      }
      void refine({
        kind: 'watershed',
        corner: inspection.river.corner,
        targetSpacingMetres: regionSettings.targetSpacingMetres,
      });
    } else {
      void refine({
        kind: 'region',
        center: selectedAnchor,
        radiusMetres: regionSettings.radiusMetres,
        targetSpacingMetres: regionSettings.targetSpacingMetres,
      });
    }
    setSettingsOpen(false);
  }

  async function openSavedWorld(id: string) {
    const next = await open(id);
    if (next) {
      setConfig({ ...next.config });
      setSelectedAnchor(null);
      setSelectedDeposit(null);
      setProjectNotice('');
    }
    return next;
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
      {world && source && layer === 'resources' && (
        <ResourceControls
          key={`${world.snapshotId}:${resourceFilter}`}
          source={source}
          summary={world.summary}
          filter={resourceFilter}
          selected={selectedDeposit}
          onFilter={(filter) => {
            setResourceFilter(filter);
            setSelectedDeposit(null);
          }}
          onSelect={selectDeposit}
        />
      )}
      {world && source && selectedDeposit ? (
        <DepositInspector
          source={source}
          id={selectedDeposit}
          onClose={() => setSelectedDeposit(null)}
        />
      ) : world && selectedAnchor ? (
        <>
          {inspection ? (
            <CellInspector inspection={inspection} onClose={() => setSelectedAnchor(null)} />
          ) : (
            <p className="panel-note" role="status">
              {inspectionError || 'Loading cell…'}{' '}
              <button onClick={() => setSelectedAnchor(null)}>Close</button>
            </p>
          )}
          <RegionControls
            settings={regionSettings}
            planetRadius={world.config.radius}
            busy={busy || saving}
            watershedAvailable={!!inspection?.river}
            onChange={setRegionSettings}
            onRefine={refineSelectedRegion}
          />
        </>
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
                  ['Ocean cover', `${formatNumber(worldStatistics.oceanFraction * 100)}%`],
                  ['Land rainfall', `${formatNumber(worldStatistics.landRainMm)} mm/yr`],
                  ['Highest peak', `${formatNumber(worldStatistics.maximumHeight)} m`],
                  ['Reservoirs', formatNumber(worldStatistics.lakeCount)],
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
        <div className="quality-preset">
          <Choice
            label="Quality preset"
            value={qualityPreset?.id ?? 'custom'}
            items={[
              ...(qualityPreset ? [] : [['custom', 'Custom'] as [string, string]]),
              ...QUALITY_PRESETS.map((preset): [string, string] => [preset.id, preset.label]),
            ]}
            onChange={(id) => {
              const preset = QUALITY_PRESETS.find((candidate) => candidate.id === id);

              if (preset) {
                setConfig((previous) => applyQualityPreset(previous, preset));
              }
            }}
          />
        </div>
        <p className="panel-note">Applies detail settings; choose Generate world to run.</p>
        {qualityPreset && (
          <p className="panel-note">
            {qualityPreset.referenceCost} Costs vary with seed, settings and hardware.
          </p>
        )}
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
                  display={settingDisplay(setting, config)}
                />
              ))}
            </div>
          </details>
        ))}
        <Button
          variant="ghost"
          className="restore-defaults"
          onClick={() => setConfig({ ...NEW_WORLD_CONFIG, seed: config.seed })}
        >
          <RotateCcw size={14} />
          Restore defaults
        </Button>
      </section>
      {!heightmapView && (
        <details className="parameter-group display-settings">
          <summary>Display settings</summary>
          <div>
            {!(layer === 'world' && isFantasyMapStyle(mapStyle)) &&
              (projection === 'globe' || (layer === 'world' && mapStyle === 'relief')) && (
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
              description="Display thickness without changing the course. Tight bends limit widening to keep the channel from overlapping itself."
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
      )}
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
              label="Base surface resolution"
              value={String(config.surfaceLevel)}
              onChange={(value) => updateNumericSetting('surfaceLevel', +value)}
              items={[3, 4, 5, 6, 7, 8, 9].map((resolutionLevel) => [
                String(resolutionLevel),
                `${formatNumber(cellCount(resolutionLevel))} base cells`,
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
              disabled={busy || saving || !config.seed.trim()}
              onClick={generateConfiguredWorld}
            >
              {busy ? <RefreshCw size={16} className="spin" /> : <Sparkles size={16} />}
              {busy ? 'Working' : 'Generate world'}
            </Button>
          </div>
          <div className="project-actions">
            <SaveWorldDialog
              key={world?.snapshotId ?? 'empty'}
              handle={world}
              busy={busy}
              saving={saving}
              onSave={save}
              onCancel={cancelSave}
            />
            <ToolButton
              label="Import recipe"
              disabled={saving}
              onClick={() => importInput.current?.click()}
            >
              <ArrowUpFromLine size={17} />
            </ToolButton>
            <ToolButton
              label="Export recipe"
              disabled={!world || !source || exporting}
              onClick={() => void exportRecipe()}
            >
              <ArrowDownToLine size={17} />
            </ToolButton>
            <WorldLibrary
              handle={world}
              busy={busy || saving}
              revision={libraryRevision}
              onOpen={openSavedWorld}
              onClose={close}
            />
            <HelpDialog handle={world} />
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
              <Button
                className="generate-button"
                onClick={generateConfiguredWorld}
                disabled={busy || saving}
              >
                Generate world
              </Button>
            </SheetContent>
          </Sheet>
        </div>
        <div className="workspace-grid">
          <aside className="layer-panel">{layerPanel}</aside>
          <section
            className={`viewport-panel${layer === 'world' && isFantasyMapStyle(mapStyle) ? ' fantasy-map' : ''}${heightmapView ? ' heightmap-view' : ''}`}
            aria-labelledby="active-layer-title"
          >
            {world && (
              <WorldView
                zoomDetail={zoomDetail}
                mapStyle={mapStyle}
                projection={projection}
                coastlines={coastlines}
                handle={world}
                source={source}
                layer={layer}
                season={season}
                gridLines={gridLines}
                onGridStatusChange={setGridStatus}
                onCoastStatusChange={setCoastStatus}
                boundaries={boundaries}
                rivers={rivers}
                vectors={vectors}
                rotation={rotation}
                animated={animationsEnabled}
                particleCount={particleCount}
                flowSpeed={flowSpeed}
                riverWidth={riverWidth}
                relief={relief}
                riverThreshold={riverThreshold}
                drift={drift}
                selectedAnchor={selectedAnchor}
                onSelectAnchor={(anchor: Vec3 | null) => {
                  setSelectedAnchor(anchor);
                  setSelectedDeposit(null);
                  if (anchor && window.matchMedia('(max-width: 1250px)').matches) {
                    setSettingsOpen(true);
                  }
                }}
                regionPreview={
                  selectedAnchor &&
                  regionSettings.footprint === 'region' &&
                  !regionSettingsError(regionSettings, world.config.radius)
                    ? { center: selectedAnchor, radiusMetres: regionSettings.radiusMetres }
                    : null
                }
                resourceFilter={resourceFilter}
                selectedDeposit={selectedDeposit}
                onSelectDeposit={selectDeposit}
                command={command}
              />
            )}
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
                  label="Plate motion preview"
                  value={drift}
                  min={-20}
                  max={20}
                  step={1}
                  display={`${drift}°`}
                  onChange={setDrift}
                />
                <p>Arrows show geodesic plate motion; no historical reconstruction.</p>
              </div>
            )}
            <div className="viewport-hint">
              {!heightmapView &&
                gridLines &&
                (gridStatus.state === 'loading' || gridStatus.state === 'error') && (
                  <span
                    className="grid-zoom-cue"
                    role={gridStatus.state === 'error' ? 'alert' : 'status'}
                  >
                    {gridStatus.state === 'error'
                      ? `Cell grid: ${gridStatus.error ?? 'Unable to load'}. Turn it off and on to retry.`
                      : gridStatus.totalBatches
                        ? `Loading cell grid · ${Math.round((gridStatus.loadedBatches / gridStatus.totalBatches) * 100)}%`
                        : 'Preparing cell grid…'}
                  </span>
                )}
              {coastlines && layer !== 'world' && coastStatus === 'zoom-in' && (
                <span className="grid-zoom-cue" role="status">
                  Coastlines: zoom in to show complete outlines.
                </span>
              )}
              <span>
                Drag to {projection === 'map' ? 'pan' : 'orbit'} · Scroll to zoom · Click to inspect
              </span>
            </div>
            <div className="legend-card">
              <div>
                <strong>{layer === 'world' ? activeStyle.name : activeLayer.name}</strong>
                <span>{heightmapView ? 'Elevation' : activeLayer.unit}</span>
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
                    {legendLabels.map((label, index) => (
                      <span key={index}>{label}</span>
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
              {layer === 'world' && isFantasyMapStyle(mapStyle) && (
                <p>Drawn mountain ranges and woodland · flat cartography · seasonal colors</p>
              )}
              {heightmapView && <p>Lowest → highest · unshaded terrain elevation</p>}
              {!heightmapView && coastlines && (
                <p>
                  {layer === 'world' && isFantasyMapStyle(mapStyle)
                    ? 'Inked shores'
                    : 'Gold outlines'}
                  {' · '}present-day coastlines
                </p>
              )}
              {!heightmapView && ['world', 'vegetation', 'biomes'].includes(layer) && (
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
              {!heightmapView && rivers && (
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
                      {progress.completed} / {progress.total}
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
            {heightmapView ? (
              <span>Heightmap · elevation only</span>
            ) : (
              <>
                <Toggle
                  label="Zoom detail"
                  checked={zoomDetail}
                  onChange={setZoomDetail}
                  description="Adds local terrain shape detail as you zoom in Natural globe and Shaded relief views. The simulation and physical cell grid stay unchanged."
                />
                <Toggle label="Cell grid" checked={gridLines} onChange={setGridLines} />
                <Toggle label="Coastlines" checked={coastlines} onChange={setCoastlines} />
                <Toggle label="Plate borders" checked={boundaries} onChange={setBoundaries} />
                <Toggle label="Rivers" checked={rivers} onChange={setRivers} />
                <Toggle label="Flow trails" checked={vectors} onChange={setVectors} />
                <Toggle label="Animate flows" checked={animationsEnabled} onChange={setAnimated} />
              </>
            )}
          </div>
          <div className="runtime-stats">
            {world && (
              <span
                className={`world-save-status ${world.saved === false ? 'unsaved' : ''}`}
                role="status"
                title={
                  world.saved === false ? 'Choose Save world to keep this terrain.' : world.name
                }
              >
                {world.saved === false ? 'Unsaved world' : 'Saved world'}
              </span>
            )}
            <span className={`status-dot ${busy ? 'working' : ''}`} />
            {busy
              ? progress.stage
              : world
                ? `${formatNumber(world.summary.surfaceCells)} cells · ${(world.summary.elapsed / 1000).toFixed(1)}s · ${(world.summary.bytes / 1048576).toFixed(1)} MiB buffers`
                : 'Ready to generate'}
          </div>
        </footer>
      </main>
    </TooltipProvider>
  );
}
