'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Layer } from '../core/model';
import type { Vec3 } from '../core/math';
import type { WorldHandle, WorldViewSource, ViewBounds, OverlayPacket } from '../core/view/types';
import type { ResourceFilter } from './ResourceMarkers';
import { mapPoint, projectLines, spherePoint, type Projection } from './projection';
import { mapReliefScale, type MapStyle } from './MapStyle';
import { loadSymbolAtlas } from './CartographicSymbols';
import { FantasySymbols, type FantasySymbolPlacements } from './FantasySymbols';
import { isFantasyMapStyle } from './FantasyStyle';
import {
  FixedSurface,
  fixedSurfaceSymbols,
  createFixedSurfaceMaterial,
  setFixedSurfaceCoastlines,
  setFixedSurfaceBanks,
  worldSurfaceAppearance,
} from './FixedSurface';
import { FixedRiverAsset, FixedRivers } from './FixedRivers';
import { GpuFrameFence } from './GpuFrameFence';
import { terrainOpaqueSort } from './terrainOpaqueSort';
import { ZoomDetail } from './ZoomDetail';
import { FixedGrid } from './FixedGrid';
import { FixedGridCache, type GridDisplayStatus } from './FixedGridCache';
import { worldViewDisplayChanged } from './WorldViewChange';
import { gridProgressDrawDue } from './GridProgress';
import { TerrainVisibility } from './TerrainVisibility';
import { TerrainBatchRenderer } from './TerrainBatchRenderer';
import { geographicSurfaceAnchor } from './SurfacePicking';
import type { PhysicalMeshManifest, PhysicalMeshPacket } from '../core/view/physical-mesh-types';
import type { FixedRiverBatch } from '../core/view/river-render-types';
import {
  PagedOverlays,
  disposeRenderObject,
  regionRing,
  anchorLineMaterial,
} from './PagedOverlays';
import { globeViewBounds } from './TileGeometry';

export interface WorldViewProps {
  handle: WorldHandle | null;
  source: WorldViewSource | null;
  mapStyle: MapStyle;
  projection: Projection;
  coastlines: boolean;
  layer: Layer;
  season: number;
  gridLines: boolean;
  /** Temporary display subdivisions; never changes the saved physical mesh. */
  zoomDetail?: boolean;
  onGridStatusChange?: (status: GridDisplayStatus) => void;
  onCoastStatusChange?: (status: OverlayPacket['coastStatus']) => void;
  boundaries: boolean;
  animated: boolean;
  particleCount: number;
  flowSpeed: number;
  riverWidth: number;
  rivers: boolean;
  vectors: boolean;
  rotation: boolean;
  relief: number;
  riverThreshold: number;
  drift: number;
  selectedAnchor: Vec3 | null;
  onSelectAnchor: (anchor: Vec3 | null) => void;
  regionPreview?: { center: Vec3; radiusMetres: number } | null;
  resourceFilter: ResourceFilter;
  selectedDeposit: string | null;
  onSelectDeposit: (id: string | null) => void;
  command: { kind: 'in' | 'out' | 'reset'; id: number };
}
interface SceneView {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  controls: OrbitControls;
  command(command: WorldViewProps['command']): void;
}
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** Main-thread state is display packets only. Simulation arrays live in the data worker. */
export default function PagedWorldView(props: WorldViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  const view = useRef<SceneView | null>(null);
  const packetCache = useRef<{
    source: WorldViewSource;
    key: string;
    manifest: PhysicalMeshManifest | null;
    packets: PhysicalMeshPacket[];
    requests: number;
    done: boolean;
    error: string;
    fantasyPlacements: FantasySymbolPlacements | null;
  } | null>(null);
  const riverCache = useRef<{
    source: WorldViewSource;
    key: string;
    asset: FixedRiverAsset;
    packets: (FixedRiverBatch | null)[];
    totalBatches: number;
    requests: number;
    done: boolean;
    cancelled: boolean;
    released: boolean;
    error: string;
  } | null>(null);
  const gridCache = useRef<FixedGridCache | null>(null);
  const [loading, setLoading] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    const container = host.current!;
    const flat = props.projection === 'map';
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance',
      });
    } catch {
      queueMicrotask(() =>
        setError('WebGL is unavailable. Enable hardware acceleration to explore the world.'),
      );
      return;
    }
    // Three r185 requires WebGL2; its shared declaration still includes WebGL1.
    let gpuFrames = new GpuFrameFence(renderer.getContext() as WebGL2RenderingContext);
    let graphicsContextLost = false;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setOpaqueSort(terrainOpaqueSort);
    renderer.setClearColor('#080e15', 0);
    container.appendChild(renderer.domElement);
    Object.assign(renderer.domElement.dataset, {
      zoomDetailState: 'off',
      zoomDetailVertices: '0',
      zoomDetailTriangles: '0',
      zoomDetailFaces: '0',
      zoomDetailBytes: '0',
      zoomDetailRiverConstraintBytes: '0',
      zoomDetailRevision: '0',
      zoomDetailBuildMs: '0',
      zoomDetailBlend: '0',
    });
    renderer.domElement.setAttribute('role', 'img');
    renderer.domElement.setAttribute(
      'aria-label',
      flat
        ? 'Interactive map. Drag to pan, scroll to zoom, click to inspect.'
        : 'Interactive planet. Drag to rotate, scroll to zoom, click to inspect.',
    );
    const scene = new THREE.Scene();
    const surfaces = new THREE.Group();
    scene.add(surfaces);
    const camera = flat
      ? new THREE.OrthographicCamera(-Math.PI, Math.PI, Math.PI / 2, -Math.PI / 2, 0.00001, 100)
      : new THREE.PerspectiveCamera(38, 1, 0.00001, 100);
    if (flat) {
      camera.position.set(0, 0, 6);
    } else {
      camera.position.set(2.25, 0.85, 2.05);
    }
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.minDistance = 1.00002;
    controls.maxDistance = 5.5;
    controls.enablePan = flat;
    controls.enableRotate = !flat;
    controls.rotateSpeed = 0.5;
    controls.autoRotateSpeed = 0.35;
    if (flat) {
      controls.screenSpacePanning = true;
      controls.minZoom = 1;
      controls.maxZoom = 131072;
      controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
      controls.touches.ONE = THREE.TOUCH.PAN;
      controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
    }
    const placeholder = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 20),
      new THREE.MeshBasicMaterial({ color: '#173548' }),
    );
    placeholder.visible = !flat;
    scene.add(placeholder);
    const raycaster = new THREE.Raycaster();
    const cursor = new THREE.Vector2();
    let alive = true;
    let frame = 0;
    let lastUpdate = 0;
    let width = 1;
    let height = 1;
    let symbolAtlas: THREE.DataTexture | null = null;
    let fantasySymbols: FantasySymbols | null = null;
    let fantasySymbolsFinished = false;
    let activeSource: WorldViewSource | null = null;
    let appearanceKey = '';
    let failedAppearanceKey = '';
    let failedDraw = false;
    let activeSurfaces: FixedSurface[] = [];
    let terrainVisibility = new TerrainVisibility();
    let terrainBatches: TerrainBatchRenderer | null = null;
    let surfaceComplete = false;
    let surfaceMaterial: THREE.ShaderMaterial | null = null;
    let zoomDetail: ZoomDetail | null = null;
    let activeGrid: FixedGrid | null = null;
    let activeGridCache: FixedGridCache | null = null;
    let gridAppearanceKey = '';
    let gridCameraKey = '';
    let gridNeedsCull = false;
    let gridDisplayError = '';
    let lastGridError = '';
    let gridWasEnabled = false;
    let gridPreparing = false;
    let gridDirty = false;
    let lastDrawnGridBatches = 0;
    let lastGridDrawAt = -Infinity;
    const disposeGridGeometry = () => {
      activeGrid?.dispose();
      activeGrid = null;
      activeGridCache = null;
      gridAppearanceKey = '';
      gridCameraKey = '';
      gridNeedsCull = false;
      gridDirty = false;
      lastDrawnGridBatches = 0;
      lastGridDrawAt = -Infinity;
      Object.assign(renderer.domElement.dataset, {
        gridVisibleBatches: '0',
        gridCulledBatches: '0',
        gridDrawCalls: '0',
      });
    };
    const releaseGridCache = () => {
      disposeGridGeometry();
      gridCache.current?.dispose();
      gridCache.current = null;
      gridDisplayError = '';
    };
    let symbols: THREE.Points[] = [];
    const symbolBins = new Set<string>();
    let activeRivers: FixedRivers | null = null;
    let activeRiverKey = '';
    let addedRiverBatches = 0;
    let riverSegmentCount = 0;
    const releaseRiverCache = () => {
      activeRivers?.dispose();
      activeRivers = null;
      activeRiverKey = '';
      addedRiverBatches = 0;
      riverSegmentCount = 0;
      const previous = riverCache.current;
      riverCache.current = null;
      if (previous) {
        previous.cancelled = true;
        previous.packets.length = 0;
        previous.asset.dispose();
      }
    };
    const cancelRiverLoading = () => {
      if (riverCache.current) {
        riverCache.current.cancelled = true;
        riverCache.current.packets.length = 0;
      }
    };
    let drawnCoastlines = false;
    let needsDraw = true;
    let cameraChanged = true;
    let displayReady = false;
    let lastProgressDraw = -Infinity;
    let lastDrawnInstallation = -1;
    let renderedFrames = 0;
    let drawnProps = latest.current;
    let atlasVersion = -1;
    let overlays: PagedOverlays | null = null;
    let overlayKey = '';
    let overlayFailedKey = '';
    let overlayBytes = 0;
    let overlayPending = false;
    let overlayEpoch = 0;
    let gridStatusKey = '';
    const updateGridStatus = (status: GridDisplayStatus) => {
      renderer.domElement.dataset.gridState = status.state;
      renderer.domElement.dataset.gridError = status.error ?? '';
      const statusKey = JSON.stringify(status);
      if (statusKey === gridStatusKey) {
        return;
      }
      gridStatusKey = statusKey;
      latest.current.onGridStatusChange?.(status);
    };
    updateGridStatus({ state: 'off', loadedBatches: 0, totalBatches: 0 });
    let coastStatus: OverlayPacket['coastStatus'];
    const updateCoastStatus = (status: OverlayPacket['coastStatus']) => {
      renderer.domElement.dataset.coastStatus = status ?? '';
      if (status === coastStatus) {
        return;
      }
      coastStatus = status;
      latest.current.onCoastStatusChange?.(status);
    };
    latest.current.onCoastStatusChange?.(undefined);
    let selection: THREE.Object3D | null = null;
    let selectionKey = '';
    let selectionEpoch = 0;
    let selectionPending = false;
    let region: THREE.LineSegments | null = null;
    let regionKey = '';
    const visibleMapBounds = (): ViewBounds => {
      const mapCamera = camera as THREE.OrthographicCamera;
      return {
        west: Math.max(-Math.PI, camera.position.x + mapCamera.left / camera.zoom),
        east: Math.min(Math.PI, camera.position.x + mapCamera.right / camera.zoom),
        south: Math.max(-Math.PI / 2, camera.position.y + mapCamera.bottom / camera.zoom),
        north: Math.min(Math.PI / 2, camera.position.y + mapCamera.top / camera.zoom),
      };
    };
    const requestBounds = (): ViewBounds => {
      if (flat) {
        return visibleMapBounds();
      }
      const [lon, lat] = mapPoint(camera.position.x, camera.position.y, camera.position.z);
      return globeViewBounds(
        lon,
        lat,
        camera.position.length(),
        THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov),
        width / height,
        camera.zoom,
      );
    };
    const updatePackets = () => {
      // Normalize the display together so terrain and every overlay agree.
      // Saved heights and the user's style/relief preferences remain unchanged.
      const requested = latest.current;
      const heightmap = requested.layer === 'world' && requested.mapStyle === 'heightmap';
      const current = {
        ...requested,
        ...worldSurfaceAppearance(requested.layer, requested.mapStyle, requested.relief),
        // Keep the scalar view free of colored ink, water and selection marks.
        // These overrides leave the user's settings intact for other styles.
        ...(heightmap
          ? {
              coastlines: false,
              gridLines: false,
              boundaries: false,
              rivers: false,
              vectors: false,
              animated: false,
              zoomDetail: false,
              selectedAnchor: null,
              regionPreview: null,
            }
          : {}),
      };
      if (overlays?.setVisibleLayers(current)) {
        needsDraw = true;
      }
      overlays?.setParticleCount(current.particleCount);
      const handle = current.handle;
      const source = current.source;
      const key =
        handle && source
          ? [
              handle.snapshotId,
              current.layer,
              current.season,
              current.mapStyle,
              current.relief,
            ].join(':')
          : '';
      const sourceChanged = source !== activeSource;
      if (key !== appearanceKey || sourceChanged) {
        zoomDetail?.dispose();
        zoomDetail = null;
        if (sourceChanged) {
          activeRivers?.dispose();
          activeRivers = null;
          activeRiverKey = '';
          addedRiverBatches = 0;
          riverSegmentCount = 0;
        }
        activeSource = source;
        appearanceKey = key;
        setError('');
        failedAppearanceKey = graphicsContextLost ? key : '';
        failedDraw = graphicsContextLost;
        if (graphicsContextLost) {
          setError(
            'The graphics context is unavailable. Wait for the device to recover, then reopen the world, or reload the page.',
          );
        }
        displayReady = false;
        lastDrawnInstallation = -1;
        terrainBatches?.dispose();
        terrainBatches = null;
        for (const surface of activeSurfaces) {
          surface.dispose();
        }
        activeSurfaces = [];
        terrainVisibility = new TerrainVisibility();
        surfaceComplete = false;
        surfaceMaterial?.dispose();
        surfaceMaterial = null;
        for (const object of symbols) {
          disposeRenderObject(object);
        }
        symbols = [];
        symbolBins.clear();
        fantasySymbols?.dispose();
        fantasySymbols = null;
        fantasySymbolsFinished = false;
        needsDraw = true;
        overlayKey = '';
        overlayFailedKey = '';
        overlayEpoch++;
        selectionKey = '';
        selectionEpoch++;
        regionKey = '';
        updateCoastStatus(undefined);
        if (overlays) {
          disposeRenderObject(overlays);
          overlays = null;
          overlayBytes = 0;
        }
        if (selection) {
          disposeRenderObject(selection);
          selection = null;
        }
        if (region) {
          disposeRenderObject(region);
          region = null;
        }
        if (handle && !flat) {
          controls.minDistance =
            1 +
            (Math.max(0, handle.summary.maximumHeight) / handle.config.radius) * current.relief +
            0.00002;
          // A close inspection of the flat plate sphere may be below the relief
          // restored by the next layer. Move out before its first rendered frame.
          if (camera.position.distanceTo(controls.target) < controls.minDistance) {
            camera.position
              .sub(controls.target)
              .setLength(controls.minDistance)
              .add(controls.target);
            camera.updateMatrixWorld();
            cameraChanged = true;
          }
        }
      }
      if (
        gridCache.current &&
        (!handle ||
          gridCache.current.source !== source ||
          gridCache.current.snapshotId !== handle.snapshotId)
      ) {
        releaseGridCache();
      }
      if (key && failedAppearanceKey === key) {
        return;
      }
      if (!handle || !source) {
        packetCache.current = null;
        releaseRiverCache();
        releaseGridCache();
        updateGridStatus({ state: 'off', loadedBatches: 0, totalBatches: 0 });
        setLoading('');
        return;
      }
      if (current.gridLines && !gridCache.current) {
        gridCache.current = new FixedGridCache(source, handle.snapshotId);
      }
      if (current.gridLines && !gridWasEnabled && gridDisplayError) {
        disposeGridGeometry();
        gridDisplayError = '';
      }
      gridWasEnabled = current.gridLines;
      const physicalGrid = gridCache.current;
      physicalGrid?.setEnabled(current.gridLines && !gridDisplayError);
      if (physicalGrid) {
        const nextGridAppearance = `${current.projection}:${current.mapStyle}:${current.relief}`;
        if (activeGridCache !== physicalGrid || gridAppearanceKey !== nextGridAppearance) {
          disposeGridGeometry();
          activeGridCache = physicalGrid;
          gridAppearanceKey = nextGridAppearance;
          gridDisplayError = '';
          try {
            activeGrid = new FixedGrid(handle.config.radius, current);
            scene.add(activeGrid);
            gridNeedsCull = true;
          } catch (failure) {
            gridDisplayError = failure instanceof Error ? failure.message : String(failure);
            physicalGrid.setEnabled(false);
          }
        }
        const visible = current.gridLines && !gridDisplayError;
        if (activeGrid && activeGrid.visible !== visible) {
          activeGrid.visible = visible;
          gridNeedsCull = true;
          needsDraw = true;
        }
        if (activeGrid && current.gridLines && !gridDisplayError) {
          const started = performance.now();
          try {
            for (
              let count = 0;
              activeGrid.batches < physicalGrid.packets.length && count < 16;
              count++
            ) {
              if (count > 0 && performance.now() - started >= 3) {
                break;
              }
              activeGrid.addBatch(physicalGrid.packets[activeGrid.batches]);
              gridNeedsCull = true;
              gridDirty = true;
            }
          } catch (failure) {
            gridDisplayError = failure instanceof Error ? failure.message : String(failure);
            physicalGrid.setEnabled(false);
            activeGrid.visible = false;
            needsDraw = true;
            Object.assign(renderer.domElement.dataset, {
              gridVisibleBatches: '0',
              gridDrawCalls: '0',
            });
          }
        }
      }
      const gridError = physicalGrid?.error || gridDisplayError;
      if (gridError && gridError !== lastGridError) {
        // Flush the resident partial grid even between preview milestones.
        needsDraw = true;
      }
      lastGridError = gridError;
      const gridReady =
        !!physicalGrid?.done && activeGrid?.batches === physicalGrid.manifest?.batches;
      gridPreparing = current.gridLines && !gridError && !gridReady;
      updateGridStatus({
        state: !current.gridLines ? 'off' : gridError ? 'error' : gridReady ? 'ready' : 'loading',
        loadedBatches: activeGrid?.batches ?? 0,
        totalBatches: physicalGrid?.manifest?.batches ?? 0,
        ...(gridError ? { error: gridError } : {}),
      });
      Object.assign(renderer.domElement.dataset, {
        gridBatches: String(activeGrid?.batches ?? 0),
        gridTotalBatches: String(physicalGrid?.manifest?.batches ?? 0),
        gridRequests: String(physicalGrid?.requests ?? 0),
        gridSegments: String(activeGrid?.segments ?? 0),
        gridTotalSegments: String(physicalGrid?.manifest?.edges ?? 0),
        gridRenderSegments: String(activeGrid?.renderSegments ?? 0),
        gridSourceBytes: String(physicalGrid?.bytes ?? 0),
        gridAdditionalCpuBytes: String(activeGrid?.additionalCpuBytes ?? 0),
        gridGpuBytes: String(activeGrid?.gpuBytes ?? 0),
        gridBytes: String(
          (activeGrid?.retainedBytes ?? 0) +
            (physicalGrid?.bytes ?? 0) -
            (activeGrid?.sourceBytes ?? 0),
        ),
        gridWorkerReleased: String(physicalGrid?.released ?? false),
      });
      const dataKey = `${handle.snapshotId}:${current.layer}:${current.season}`;
      if (packetCache.current?.key !== dataKey || packetCache.current.source !== source) {
        const cache = {
          source,
          key: dataKey,
          manifest: null as PhysicalMeshManifest | null,
          packets: [] as PhysicalMeshPacket[],
          requests: 0,
          done: false,
          error: '',
          fantasyPlacements: null as FantasySymbolPlacements | null,
        };
        packetCache.current = cache;
        void (async () => {
          try {
            cache.requests++;
            cache.manifest = await source.physicalManifest(current.layer, current.season);
            for (let first = 0; first < cache.manifest.batches; first += 4) {
              if (packetCache.current !== cache) {
                return;
              }
              const count = Math.min(4, cache.manifest.batches - first);
              cache.requests += count;
              // Keep bounded work ready in the reader while WebGL uploads run.
              const packets = await Promise.all(
                Array.from({ length: count }, (_, offset) =>
                  source.physicalBatch(current.layer, current.season, first + offset),
                ),
              );
              if (packetCache.current !== cache) {
                return;
              }
              cache.packets.push(...packets);
            }
            cache.done = true;
          } catch (error) {
            cache.error = error instanceof Error ? error.message : String(error);
          }
        })();
      }
      const nextRiverKey = `${handle.snapshotId}:${current.season}:${current.riverThreshold}`;
      if (
        riverCache.current?.key !== nextRiverKey ||
        riverCache.current.source !== source ||
        riverCache.current.cancelled
      ) {
        releaseRiverCache();
        const cache = {
          source,
          key: nextRiverKey,
          asset: new FixedRiverAsset(),
          packets: [] as (FixedRiverBatch | null)[],
          totalBatches: 0,
          requests: 0,
          done: false,
          cancelled: false,
          released: false,
          error: '',
        };
        riverCache.current = cache;
        void (async () => {
          try {
            let total = 1;
            for (let batch = 0; batch < total; batch++) {
              if (riverCache.current !== cache || cache.cancelled) {
                return;
              }
              cache.requests++;
              const packet = await source.riverRender({
                season: current.season,
                threshold: current.riverThreshold,
                batch,
              });
              if (riverCache.current !== cache || cache.cancelled) {
                return;
              }
              total = Math.max(1, packet.totalBatches);
              cache.totalBatches = total;
              cache.packets.push(packet);
            }
            cache.done = true;
          } catch (error) {
            cache.error = error instanceof Error ? error.message : String(error);
          }
        })();
      }
      const riverAppearance = {
        projection: current.projection,
        relief: current.relief,
        mapStyle: current.mapStyle,
        layer: current.layer,
        riverWidth: current.riverWidth,
      };
      if (activeRiverKey !== nextRiverKey || !activeRivers) {
        zoomDetail?.dispose();
        zoomDetail = null;
        activeRivers?.dispose();
        activeRivers = new FixedRivers(handle, riverAppearance, riverCache.current.asset);
        scene.add(activeRivers);
        activeRiverKey = nextRiverKey;
        addedRiverBatches = 0;
        if (surfaceMaterial) {
          setFixedSurfaceBanks(surfaceMaterial, activeRivers.bankTexture);
        }
        needsDraw = true;
      }
      activeRivers.setAppearance(riverAppearance);
      activeRivers.visible = current.rivers;
      const riversCache = riverCache.current;
      const installStarted = performance.now();
      const cache = packetCache.current;
      if (cache.manifest) {
        if (current.layer === 'world' && isFantasyMapStyle(current.mapStyle) && !fantasySymbols) {
          fantasySymbols = new FantasySymbols(
            handle,
            { projection: current.projection, mapStyle: current.mapStyle },
            cache.fantasyPlacements,
          );
          scene.add(fantasySymbols);
        }
        surfaceMaterial ??= createFixedSurfaceMaterial(
          handle,
          cache.manifest,
          current,
          activeRivers.bankTexture,
        );
        terrainBatches ??= new TerrainBatchRenderer(renderer, surfaces);
        for (let count = 0; count < 64 && activeSurfaces.length < cache.packets.length; count++) {
          if (count > 0 && performance.now() - installStarted >= 8) {
            break;
          }
          const packet = cache.packets[activeSurfaces.length];
          const surface = new FixedSurface(
            packet,
            handle,
            cache.manifest,
            current,
            activeRivers.bankTexture,
            surfaceMaterial,
          );
          surfaces.add(surface);
          activeSurfaces.push(surface);
          terrainVisibility.register(surface, current.projection);
          terrainBatches.add(surface);
          fantasySymbols?.addPacket(packet);
          if (current.layer === 'world' && current.mapStyle === 'illustrated') {
            symbolAtlas ??= loadSymbolAtlas();
            const marks = fixedSurfaceSymbols(packet, handle, current, symbolAtlas, symbolBins);
            symbols.push(marks);
            scene.add(marks);
          }
          needsDraw = true;
        }
        if (cache.done && activeSurfaces.length === cache.manifest.batches) {
          terrainBatches.finish();
          if (fantasySymbols && !fantasySymbolsFinished) {
            fantasySymbols.finish();
            // Only a complete placement set belongs to the packet cache. It
            // survives appearance/projection changes, while the view keeps its
            // own atlas and GPU geometry. Source/snapshot/season changes replace
            // this cache, so partial or stale placements are never reused.
            cache.fantasyPlacements = fantasySymbols.placements;
            fantasySymbolsFinished = true;
            needsDraw = true;
          }
        }
      }
      // The asset consumes original bank arrays once. Projection rebuilds replay
      // only its compact water records and retain the same painted atlas.
      const riverInstallAllowed =
        performance.now() - installStarted < 8 || activeSurfaces.length === cache.manifest?.batches;
      if (riverInstallAllowed) {
        const rawIndex = riversCache.asset.receivedBatches;
        const raw = riversCache.packets[rawIndex];
        if (raw) {
          riversCache.asset.addBatch(raw, { deferBankUpload: true });
          riversCache.packets[rawIndex] = null;
        }
        const compact = riversCache.asset.packets[addedRiverBatches];
        if (compact) {
          activeRivers.addBatch(compact, { deferBankUpload: true });
          addedRiverBatches++;
          needsDraw = true;
        }
      }
      const consumedAllRivers =
        riversCache.done && riversCache.asset.receivedBatches === riversCache.totalBatches;
      if (consumedAllRivers && !riversCache.released && source.releaseRiverRender) {
        riversCache.released = source.releaseRiverRender({
          season: current.season,
          threshold: current.riverThreshold,
        });
      }
      placeholder.visible = !flat && activeSurfaces.length === 0;
      renderer.domElement.dataset.renderMode = 'fixed-physical';
      renderer.domElement.dataset.effectiveRelief = String(current.relief);
      renderer.domElement.dataset.effectiveMapStyle = current.mapStyle;
      renderer.domElement.dataset.physicalBatches = String(cache.manifest?.batches ?? 0);
      renderer.domElement.dataset.loadedPhysicalBatches = String(activeSurfaces.length);
      renderer.domElement.dataset.physicalTriangles = String(
        cache.manifest?.simplified
          ? activeSurfaces.reduce(
              (sum, _surface, index) => sum + cache.packets[index].indices.length / 3,
              0,
            )
          : (cache.manifest?.triangles ?? 0),
      );
      renderer.domElement.dataset.physicalSourceTriangles = String(cache.manifest?.triangles ?? 0);
      renderer.domElement.dataset.physicalVertices = String(cache.manifest?.physicalVertices ?? 0);
      renderer.domElement.dataset.fantasySymbolCount = String(fantasySymbols?.count ?? 0);
      renderer.domElement.dataset.fantasySymbolBytes = String(fantasySymbols?.bytes ?? 0);
      renderer.domElement.dataset.fantasyPlacementBytes = String(
        cache.fantasyPlacements?.bytes ?? 0,
      );
      renderer.domElement.dataset.fantasyPlacementReused = String(
        fantasySymbols?.reusedPlacements ?? false,
      );
      renderer.domElement.dataset.renderTriangles = String(
        activeSurfaces.reduce((sum, surface) => sum + surface.triangles, 0) +
          (zoomDetail?.triangleDelta ?? 0),
      );
      renderer.domElement.dataset.renderVertices = String(
        activeSurfaces.reduce(
          (sum, surface) => sum + surface.geometry.getAttribute('position').count,
          0,
        ) + (zoomDetail?.vertices ?? 0),
      );
      renderer.domElement.dataset.surfaceRequests = String(cache.requests);
      renderer.domElement.dataset.materialRequests = String(cache.requests);
      renderer.domElement.dataset.riverRequests = String(riversCache.requests);
      renderer.domElement.dataset.riverPaths = String(activeRivers.pathCount);
      riverSegmentCount = activeRivers.segmentCount;
      renderer.domElement.dataset.riverSegments = String(riverSegmentCount);
      renderer.domElement.dataset.riverBatches = String(addedRiverBatches);
      renderer.domElement.dataset.receivedRiverBatches = String(riversCache.asset.receivedBatches);
      renderer.domElement.dataset.riverAssetPacketBytes = String(riversCache.asset.packetBytes);
      renderer.domElement.dataset.riverSourceBytes = String(riversCache.asset.sourceBytes);
      renderer.domElement.dataset.releasedRiverBytes = String(riversCache.asset.releasedBytes);
      renderer.domElement.dataset.riverWorkerReleased = String(riversCache.released);
      renderer.domElement.dataset.riverAssetId = riversCache.asset.bankTexture.uuid;

      renderer.domElement.dataset.pendingSurfaceBatches = String(
        (cache.manifest?.batches ?? 0) - activeSurfaces.length,
      );
      if (surfaceMaterial) {
        setFixedSurfaceCoastlines(surfaceMaterial, current.coastlines);
      }
      renderer.domElement.dataset.surfaceMaterialCount = surfaceMaterial ? '1' : '0';
      if (drawnCoastlines !== current.coastlines) {
        needsDraw = true;
      }
      drawnCoastlines = current.coastlines;
      if (!current.coastlines || current.layer === 'world') {
        updateCoastStatus(undefined);
      }
      const queuedRiverBytes = riversCache.packets.reduce(
        (sum, packet) =>
          sum +
          (packet
            ? Object.values(packet).reduce<number>(
                (bytes, value) => bytes + (ArrayBuffer.isView(value) ? value.byteLength : 0),
                0,
              )
            : 0),
        0,
      );
      const symbolBytes =
        symbols.reduce(
          (sum, marks) =>
            sum +
            Object.values(marks.geometry.attributes).reduce(
              (bytes, attr) => bytes + attr.array.byteLength * 2,
              0,
            ),
          0,
        ) +
        (symbolAtlas?.image?.data?.byteLength ?? 0) * 3 +
        (fantasySymbols?.bytes ?? 0) +
        (cache.fantasyPlacements?.bytes ?? 0);
      const terrainStorage = terrainBatches?.stats;
      const surfaceBytes =
        activeSurfaces.reduce((sum, surface) => sum + surface.retainedBytes, 0) -
        (terrainStorage?.replacedGpuBytes ?? 0) +
        (terrainStorage?.gpuBytes ?? 0) +
        (terrainStorage?.cpuBytes ?? 0);
      const unloadedBytes = cache.packets
        .slice(activeSurfaces.length)
        .reduce((sum, packet) => sum + packet.bytes, 0);
      renderer.domElement.dataset.surfaceBytes = String(surfaceBytes + unloadedBytes);
      renderer.domElement.dataset.riverBytes = String(activeRivers.bytes + queuedRiverBytes);
      renderer.domElement.dataset.overlayBytes = String(overlayBytes);
      renderer.domElement.dataset.displayBytes = String(
        surfaceBytes +
          unloadedBytes +
          activeRivers.bytes +
          queuedRiverBytes +
          overlayBytes +
          symbolBytes +
          (activeGrid?.retainedBytes ?? 0) +
          (gridCache.current?.bytes ?? 0) -
          (activeGrid?.sourceBytes ?? 0) +
          (zoomDetail?.bytes ?? 0),
      );
      const ready = cache.done && activeSurfaces.length === cache.manifest?.batches;
      surfaceComplete = ready;
      renderer.domElement.dataset.surfaceReady = String(ready);
      const totalRiverBatches = riversCache.totalBatches;
      const riverReady =
        consumedAllRivers && addedRiverBatches === riversCache.asset.packets.length;
      displayReady = ready && (heightmap || riverReady);
      const canZoomDetail =
        displayReady &&
        current.zoomDetail !== false &&
        current.layer === 'world' &&
        (current.mapStyle === 'relief' || (current.mapStyle === 'natural' && !flat));
      if (!canZoomDetail && zoomDetail) {
        zoomDetail.dispose();
        zoomDetail = null;
        needsDraw = true;
      } else if (canZoomDetail && !zoomDetail && surfaceMaterial) {
        zoomDetail = new ZoomDetail(
          surfaces,
          activeSurfaces,
          cache.packets,
          riversCache.asset.packets,
          handle.config.radius,
          current,
          surfaceMaterial,
          renderer.domElement,
        );
      }
      if (!canZoomDetail) {
        renderer.domElement.dataset.zoomDetailState = 'off';
      }
      if (riverReady) {
        if (riversCache.asset.flushBanks()) {
          needsDraw = true;
        }
      }
      renderer.domElement.dataset.riverReady = String(riverReady);
      renderer.domElement.dataset.pendingRiverBatches = String(
        Math.max(0, totalRiverBatches - riversCache.asset.receivedBatches) +
          riversCache.asset.packets.length -
          addedRiverBatches,
      );
      renderer.domElement.dataset.estimatedSurfaceBytes = String(
        cache.manifest?.estimatedBytes ?? 0,
      );
      setLoading(
        !ready
          ? cache.manifest
            ? `Loading ${current.layer === 'tectonics' ? 'tectonic plates' : 'full-detail terrain'} · ${Math.round((activeSurfaces.length / Math.max(1, cache.manifest.batches)) * 100)}%`
            : current.layer === 'tectonics'
              ? 'Preparing tectonic plates…'
              : 'Preparing full-detail terrain…'
          : !heightmap && !riverReady
            ? totalRiverBatches
              ? `Loading connected rivers · ${Math.round(((riversCache.asset.receivedBatches + addedRiverBatches) / (totalRiverBatches + riversCache.asset.packets.length)) * 100)}%`
              : 'Preparing connected rivers…'
            : '',
      );
      if (cache.error || (!heightmap && riversCache.error)) {
        setError(
          `The complete ${cache.error ? 'terrain' : 'river network'} could not be loaded: ${cache.error || riversCache.error}`,
        );
        setLoading('');
      }
      const bounds = requestBounds();
      const boundsKey = Object.values(bounds)
        .map((n) => n.toFixed(8))
        .join(',');
      const nextOverlay = [
        appearanceKey,
        boundsKey,
        current.rivers,
        current.coastlines && current.layer !== 'world',
        current.boundaries,
        current.resourceFilter,
        current.selectedDeposit,
        current.riverThreshold,
        current.riverWidth,
        current.vectors,
        current.drift,
      ].join(':');
      if (
        activeSurfaces.length > 0 &&
        nextOverlay !== overlayKey &&
        nextOverlay !== overlayFailedKey &&
        !overlayPending
      ) {
        overlayPending = true;
        const epoch = ++overlayEpoch;
        const request = {
          bounds,
          layer: current.layer,
          season: current.season,
          rivers: false,
          coasts: current.coastlines && current.layer !== 'world',
          boundaries: current.boundaries,
          drift: current.drift,
          resources: current.layer === 'resources',
          resourceFilter: current.resourceFilter,
          vectors: ['wind', 'currents', 'sst'].includes(current.layer) && current.vectors,
          maxVectors: 512,
          maxSegments: 8000,
          maxResources: 256,
          riverThreshold: current.riverThreshold,
        };
        void source
          .overlays(request)
          .then((packet) => {
            if (!alive || epoch !== overlayEpoch || appearanceKey !== key) {
              return;
            }
            const next = new PagedOverlays(
              packet,
              handle,
              {
                projection: current.projection,
                mapStyle: current.layer === 'world' ? current.mapStyle : 'natural',
                relief: current.relief,
                riverWidth: current.riverWidth,
                particleCount: current.particleCount,
                vectors: current.vectors,
                flowKind: current.layer === 'wind' ? 'wind' : 'current',
              },
              current.selectedDeposit,
            );
            next.setVisibleLayers(latest.current);
            next.setParticleCount(latest.current.particleCount);
            if (overlays) {
              next.preserveFlowPhase(overlays);
              disposeRenderObject(overlays);
            }
            overlays = next;
            overlayBytes = 0;
            next.traverse((object) => {
              const geometry = (object as THREE.Mesh).geometry;
              if (geometry) {
                for (const attr of Object.values(geometry.attributes)) {
                  overlayBytes += attr.array.byteLength * 2;
                }
                if (geometry.index) {
                  overlayBytes += geometry.index.array.byteLength * 2;
                }
              }
            });
            scene.add(next);
            cameraChanged = true;
            needsDraw = true;
            overlayKey = nextOverlay;
            renderer.domElement.dataset.overlayTruncated = String(packet.truncated);
            if (latest.current.coastlines && latest.current.layer !== 'world') {
              updateCoastStatus(packet.coastStatus);
            }
            renderer.domElement.dataset.coastSegments = String(packet.coasts.positions.length / 6);
          })
          .catch((error: unknown) => {
            if (!alive || epoch !== overlayEpoch) {
              return;
            }
            overlayFailedKey = nextOverlay;
            setError(
              `Map overlays could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
            );
          })
          .finally(() => {
            overlayPending = false;
          });
      }
      const nextRegion = current.regionPreview
        ? `${appearanceKey}:${current.regionPreview.center}:${current.regionPreview.radiusMetres}`
        : '';
      if (nextRegion !== regionKey) {
        needsDraw = true;
        regionKey = nextRegion;
        if (region) {
          disposeRenderObject(region);
        }
        region = null;
        if (current.regionPreview) {
          region = regionRing(
            current.regionPreview.center,
            current.regionPreview.radiusMetres,
            handle.config.radius,
            '#ffd08a',
            flat,
          );
          if (flat) {
            projectLines(region.geometry, 0.003);
          }
          scene.add(region);
        }
      }
      const nextSelection = current.selectedAnchor
        ? `${appearanceKey}:${current.selectedAnchor}`
        : '';
      if (nextSelection !== selectionKey && !selectionPending) {
        needsDraw = true;
        selectionKey = nextSelection;
        const epoch = ++selectionEpoch;
        if (selection) {
          disposeRenderObject(selection);
        }
        selection = null;
        if (current.selectedAnchor) {
          selectionPending = true;
          void source
            .inspect(current.selectedAnchor, current.season)
            .then((cell) => {
              if (
                !alive ||
                epoch !== selectionEpoch ||
                String(latest.current.selectedAnchor) !== String(current.selectedAnchor)
              ) {
                return;
              }
              const positions = new Float32Array(cell.outline.length * 2);
              const count = cell.outline.length / 3;
              for (let i = 0; i < count; i++) {
                for (let a = 0; a < 3; a++) {
                  positions[i * 6 + a] = cell.outline[i * 3 + a];
                  positions[i * 6 + 3 + a] = cell.outline[((i + 1) % count) * 3 + a];
                }
              }
              const radius =
                1 + (Math.max(0, cell.height) / handle.config.radius) * current.relief + 0.0001;
              for (let i = 0; i < positions.length; i++) {
                positions[i] *= radius;
              }
              const geometry = new THREE.BufferGeometry();
              geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
              if (flat) {
                projectLines(
                  geometry,
                  0.00003,
                  mapReliefScale(current.layer === 'world' ? current.mapStyle : 'natural'),
                  0.0001,
                );
              }
              const line = new THREE.LineSegments(geometry, anchorLineMaterial('#ffe1a1', flat));
              line.renderOrder = 10;
              selection = line;
              scene.add(line);
              cameraChanged = true;
              needsDraw = true;
            })
            .catch(() => {})
            .finally(() => {
              selectionPending = false;
            });
        }
      }
    };
    const command = (next: WorldViewProps['command']) => {
      if (next.kind === 'reset') {
        camera.zoom = 1;
        if (flat) {
          camera.position.set(0, 0, 6);
        } else {
          camera.position.set(2.25, 0.85, 2.05);
        }
        controls.target.set(0, 0, 0);
      } else if (flat) {
        camera.zoom = clamp(camera.zoom * (next.kind === 'in' ? 1.6 : 1 / 1.6), 1, 131072);
      } else if (next.kind === 'out' && camera.zoom > 1) {
        camera.zoom = Math.max(1, camera.zoom / 1.6);
      } else if (next.kind === 'in' && camera.position.length() <= controls.minDistance * 1.03) {
        camera.zoom = Math.min(131072, camera.zoom * 1.6);
      } else {
        camera.position.setLength(
          clamp(
            1 + (camera.position.length() - 1) * (next.kind === 'in' ? 0.65 : 1.5),
            controls.minDistance,
            5.5,
          ),
        );
      }
      camera.updateProjectionMatrix();
      controls.update();
      needsDraw = true;
    };
    view.current = { renderer, camera, controls, command };
    const wheel = (event: WheelEvent) => {
      if (
        !flat &&
        ((event.deltaY < 0 && camera.position.length() <= controls.minDistance * 1.01) ||
          (event.deltaY > 0 && camera.zoom > 1))
      ) {
        camera.zoom = clamp(camera.zoom * Math.exp(-event.deltaY * 0.002), 1, 131072);
        camera.updateProjectionMatrix();
        needsDraw = true;
      }
    };
    const targetCamera = (event: Event) => {
      const target = (
        event as CustomEvent<{
          longitude: number;
          latitude: number;
          distance?: number;
          zoom?: number;
        }>
      ).detail;
      if (!target || !Number.isFinite(target.longitude) || !Number.isFinite(target.latitude)) {
        return;
      }
      const longitude = clamp(target.longitude, -Math.PI, Math.PI);
      const latitude = clamp(target.latitude, -Math.PI / 2, Math.PI / 2);
      camera.zoom = clamp(target.zoom ?? 1, 1, 131072);
      if (flat) {
        controls.target.set(longitude, latitude, 0);
        camera.position.set(longitude, latitude, 6);
      } else {
        controls.target.set(0, 0, 0);
        spherePoint(longitude, latitude, camera.position).multiplyScalar(
          clamp(target.distance ?? 2.5, controls.minDistance, 5.5),
        );
      }
      camera.updateProjectionMatrix();
      controls.update();
      needsDraw = true;
    };
    if (process.env.NODE_ENV !== 'production') {
      renderer.domElement.addEventListener('atlas-camera', targetCamera);
    }
    renderer.domElement.addEventListener('wheel', wheel, { passive: true });
    const resize = () => {
      width = Math.max(1, container.clientWidth);
      height = Math.max(1, container.clientHeight);
      renderer.setSize(width, height);
      if (camera instanceof THREE.PerspectiveCamera) {
        camera.aspect = width / height;
      } else {
        const halfHeight = Math.max(Math.PI / 2, (Math.PI * height) / width);
        camera.left = (-halfHeight * width) / height;
        camera.right = -camera.left;
        camera.top = halfHeight;
        camera.bottom = -halfHeight;
      }
      camera.updateProjectionMatrix();
      needsDraw = true;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    controls.addEventListener('change', () => {
      cameraChanged = true;
      needsDraw = true;
    });
    let down = [0, 0];
    const pointerDown = (event: PointerEvent) => {
      down = [event.clientX, event.clientY];
    };
    const pointerUp = (event: PointerEvent) => {
      if (Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 5) {
        return;
      }
      const rect = renderer.domElement.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const deposit = overlays?.pick(camera, x, y, width, height, flat);
      if (deposit) {
        latest.current.onSelectDeposit(deposit);
        return;
      }
      latest.current.onSelectDeposit(null);
      cursor.set((x / width) * 2 - 1, 1 - (y / height) * 2);
      raycaster.setFromCamera(cursor, camera);
      // Flat illustration and plate ownership inspect their geographic sphere/map.
      // Other simplified categories retain their displayed terrain intersection,
      // then recover geography without interpolating coarse sphere directions.
      const geographicView =
        latest.current.layer === 'tectonics' ||
        (latest.current.layer === 'world' &&
          (isFantasyMapStyle(latest.current.mapStyle) || latest.current.mapStyle === 'heightmap'));
      const hit = geographicView ? undefined : raycaster.intersectObjects(activeSurfaces, false)[0];
      let anchor: THREE.Vector3 | null = null;
      if (hit && packetCache.current?.manifest?.simplified) {
        anchor = geographicSurfaceAnchor(hit.point, flat ? 'map' : 'globe');
      } else if (hit?.face) {
        const mesh = hit.object as THREE.Mesh;
        const geometry = mesh.geometry;
        const positions = geometry.getAttribute('position');
        const sphere = geometry.getAttribute('spherePosition');
        const a = new THREE.Vector3().fromBufferAttribute(positions, hit.face.a);
        const b = new THREE.Vector3().fromBufferAttribute(positions, hit.face.b);
        const c = new THREE.Vector3().fromBufferAttribute(positions, hit.face.c);
        const weights = THREE.Triangle.getBarycoord(hit.point, a, b, c, new THREE.Vector3());
        if (weights) {
          anchor = new THREE.Vector3()
            .fromBufferAttribute(sphere, hit.face.a)
            .multiplyScalar(weights.x)
            .addScaledVector(new THREE.Vector3().fromBufferAttribute(sphere, hit.face.b), weights.y)
            .addScaledVector(new THREE.Vector3().fromBufferAttribute(sphere, hit.face.c), weights.z)
            .normalize();
        }
      } else if (flat) {
        const point = raycaster.ray.intersectPlane(
          new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
          new THREE.Vector3(),
        );
        if (point && Math.abs(point.x) <= Math.PI && Math.abs(point.y) <= Math.PI / 2) {
          anchor = spherePoint(point.x, point.y, new THREE.Vector3());
        }
      } else {
        anchor = raycaster.ray.intersectSphere(
          new THREE.Sphere(new THREE.Vector3(), 1),
          new THREE.Vector3(),
        );
      }
      latest.current.onSelectAnchor(anchor ? [anchor.x, anchor.y, anchor.z] : null);
    };
    const contextLost = () => {
      graphicsContextLost = true;
      gpuFrames.dispose();
      zoomDetail?.dispose();
      zoomDetail = null;
      failedDraw = true;
      failedAppearanceKey = appearanceKey;
      packetCache.current = null;
      cancelRiverLoading();
      gridCache.current?.setEnabled(false);
      setLoading('');
      setError(
        'The graphics context was lost. Reopen this world on a device with enough graphics memory for its full physical mesh.',
      );
    };
    const contextRestored = () => {
      graphicsContextLost = false;
      // The prior context invalidated every sync. Keep the visible error until
      // an explicit reopen, then track frames against the restored context.
      gpuFrames = new GpuFrameFence(renderer.getContext() as WebGL2RenderingContext);
    };
    renderer.domElement.addEventListener('webglcontextlost', contextLost);
    renderer.domElement.addEventListener('webglcontextrestored', contextRestored);
    renderer.domElement.addEventListener('pointerdown', pointerDown);
    renderer.domElement.addEventListener('pointerup', pointerUp);
    const render = (time: number) => {
      if (!alive) {
        return;
      }
      frame = requestAnimationFrame(render);
      const propsChanged = worldViewDisplayChanged(drawnProps, latest.current);
      drawnProps = latest.current;
      if (propsChanged) {
        // Explicit display controls must not wait for the next loading preview.
        cameraChanged = true;
        needsDraw = true;
      }
      controls.autoRotate = displayReady && !gridPreparing && latest.current.rotation && !flat;
      controls.update();
      if (flat) {
        const x = clamp(controls.target.x, -Math.PI, Math.PI);
        const y = clamp(controls.target.y, -Math.PI / 2, Math.PI / 2);
        if (x !== controls.target.x || y !== controls.target.y) {
          needsDraw = true;
        }
        camera.position.x += x - controls.target.x;
        camera.position.y += y - controls.target.y;
        controls.target.x = x;
        controls.target.y = y;
      }
      camera.updateMatrixWorld();
      // Received terrain should use the next frame's bounded installation slice,
      // rather than sitting idle behind the 100 ms overlay/status cadence. Large
      // categorical packets otherwise spend most of their load time queued here.
      const terrainBacklog = (packetCache.current?.packets.length ?? 0) > activeSurfaces.length;
      if (propsChanged || terrainBacklog || time - lastUpdate > 100) {
        try {
          updatePackets();
        } catch (failure) {
          failedAppearanceKey = appearanceKey;
          zoomDetail?.dispose();
          zoomDetail = null;
          packetCache.current = null;
          cancelRiverLoading();
          gridCache.current?.setEnabled(false);
          setLoading('');
          setError(
            `The complete world could not be displayed: ${failure instanceof Error ? failure.message : String(failure)}. Try a smaller world or reopen this world on a device with more graphics memory.`,
          );
        }
        lastUpdate = time;
      }
      activeRivers?.animate(
        time / 1000,
        displayReady && !gridPreparing && latest.current.animated,
        latest.current.flowSpeed,
      );
      if (zoomDetail?.tick(camera, width, height, time)) {
        needsDraw = true;
      }
      if (activeGrid && !gridDisplayError) {
        const nextGridCamera = [
          ...camera.matrixWorld.elements,
          ...camera.projectionMatrix.elements,
        ].join(',');
        if (gridNeedsCull || nextGridCamera !== gridCameraKey) {
          try {
            const visibility = activeGrid.updateVisibility(camera);
            renderer.domElement.dataset.gridVisibleBatches = String(visibility.visibleBatches);
            renderer.domElement.dataset.gridCulledBatches = String(visibility.culledBatches);
            renderer.domElement.dataset.gridDrawCalls = String(visibility.drawCalls);
            gridCameraKey = nextGridCamera;
            gridNeedsCull = false;
          } catch (failure) {
            gridDisplayError = failure instanceof Error ? failure.message : String(failure);
            gridCache.current?.setEnabled(false);
            activeGrid.visible = false;
            needsDraw = true;
            Object.assign(renderer.domElement.dataset, {
              gridVisibleBatches: '0',
              gridDrawCalls: '0',
            });
          }
        }
      }
      // Flow packets are complete, independently drawable assets. Loading the
      // optional cell grid or the unrelated river network must not pause a wind
      // or ocean-current layer that is already visible. The GPU fence below
      // still limits submission to one frame while background uploads continue.
      const animateParticles =
        activeSurfaces.length > 0 &&
        latest.current.animated &&
        latest.current.flowSpeed !== 0 &&
        !!overlays?.hasParticles;
      overlays?.animate(
        time / 1000,
        animateParticles,
        latest.current.flowSpeed,
        camera,
        width,
        height,
      );
      const nextAtlasVersion = symbolAtlas?.version ?? -1;
      if (nextAtlasVersion !== atlasVersion) {
        atlasVersion = nextAtlasVersion;
        needsDraw = true;
      }
      const animateRivers =
        displayReady &&
        !gridPreparing &&
        latest.current.animated &&
        latest.current.flowSpeed !== 0 &&
        activeRivers?.visible &&
        riverSegmentCount > 0;
      const installedCount = activeSurfaces.length + addedRiverBatches;
      const previewStride = Math.max(
        1,
        Math.ceil((packetCache.current?.manifest?.batches ?? 1) / 32),
      );
      const progressed =
        lastDrawnInstallation < 0 || installedCount - lastDrawnInstallation >= previewStride;
      const progressiveDrawAllowed =
        displayReady ||
        animateParticles ||
        cameraChanged ||
        (progressed && time - lastProgressDraw >= 500);
      const drawRequested = gridProgressDrawDue(
        gridDirty && activeGrid?.visible ? activeGrid.batches : 0,
        gridCache.current?.manifest?.batches ?? 0,
        lastDrawnGridBatches,
        time - lastGridDrawAt,
        needsDraw || controls.autoRotate || animateParticles || animateRivers,
      );
      let gpuReady = false;
      if (!failedDraw) {
        try {
          gpuReady = gpuFrames.poll(performance.now());
          if (gpuReady && progressiveDrawAllowed && drawRequested) {
            const startedAt = performance.now();
            const terrain = terrainVisibility.update(camera, {
              projection: latest.current.projection,
              complete: surfaceComplete,
              inwardDisplacement: zoomDetail?.maximumDisplacement ?? 0,
            });
            const terrainVisible = (surface: FixedSurface) => terrainVisibility.isVisible(surface);
            for (const surface of activeSurfaces) {
              surface.visible = terrainVisible(surface);
            }
            zoomDetail?.applyBaseVisibility(terrainVisible);
            Object.assign(renderer.domElement.dataset, {
              terrainHorizonEnabled: String(terrain.enabled),
              terrainHorizonRadius: String(terrain.occluderRadius),
              terrainHorizonVisibleBatches: String(terrain.visibleBatches),
              terrainHorizonCulledBatches: String(terrain.culledBatches),
              terrainHorizonVisibleTriangles: String(terrain.visibleTriangles),
              terrainHorizonCulledTriangles: String(terrain.culledTriangles),
              terrainHorizonReason: terrain.reason,
            });
            terrainBatches?.prepare(camera);
            const terrainDraws = terrainBatches?.stats;
            Object.assign(renderer.domElement.dataset, {
              terrainBatchMode: terrainDraws?.mode ?? 'ordinary',
              terrainDrawSlabs: String(terrainDraws?.slabs ?? 0),
              terrainVisiblePackets: String(terrainDraws?.visiblePackets ?? 0),
              terrainDrawCalls: String(terrainDraws?.drawCalls ?? 0),
              terrainBatchGpuBytes: String(terrainDraws?.gpuBytes ?? 0),
              terrainReplacedGpuBytes: String(terrainDraws?.replacedGpuBytes ?? 0),
              terrainBatchCpuBytes: String(terrainDraws?.cpuBytes ?? 0),
            });
            renderer.render(scene, camera);
            gpuFrames.submit(startedAt);
            needsDraw = false;
            cameraChanged = false;
            lastProgressDraw = performance.now();
            lastDrawnInstallation = installedCount;
            lastDrawnGridBatches = activeGrid?.visible ? activeGrid.batches : 0;
            lastGridDrawAt = performance.now();
            gridDirty = false;
            renderer.domElement.dataset.gridRenderedBatches = String(lastDrawnGridBatches);
            renderer.domElement.dataset.renderFrames = String(++renderedFrames);
          }
        } catch (failure) {
          failedDraw = true;
          zoomDetail?.dispose();
          zoomDetail = null;
          failedAppearanceKey = appearanceKey;
          packetCache.current = null;
          cancelRiverLoading();
          gridCache.current?.setEnabled(false);
          setLoading('');
          setError(
            `Graphics rendering failed: ${failure instanceof Error ? failure.message : String(failure)}`,
          );
        }
      }
      renderer.domElement.dataset.gpuPending = String(gpuFrames.pending);
      renderer.domElement.dataset.completedFrames = String(gpuFrames.completedFrames);
      renderer.domElement.dataset.frameCompleteMs = gpuFrames.frameCompleteMs.toFixed(2);
    };
    frame = requestAnimationFrame(render);
    return () => {
      alive = false;
      overlayEpoch++;
      selectionEpoch++;
      cancelAnimationFrame(frame);
      observer.disconnect();
      gpuFrames.dispose();
      zoomDetail?.dispose();
      zoomDetail = null;
      terrainBatches?.dispose();
      terrainBatches = null;
      disposeGridGeometry();
      for (const surface of activeSurfaces) {
        surface.dispose();
      }
      activeSurfaces = [];
      surfaceMaterial?.dispose();
      surfaceMaterial = null;
      const bankTexture = activeRivers?.bankTexture;
      activeRivers?.dispose();
      activeRivers = null;
      // Texture.dispose releases this renderer's GPU allocation, preserving the
      // asset's CPU pixels and identity for the replacement projection context.
      bankTexture?.dispose();
      symbolAtlas?.dispose();
      fantasySymbols?.dispose();
      fantasySymbols = null;
      controls.dispose();
      disposeRenderObject(scene);
      scene.clear();
      symbols = [];
      overlays = null;
      selection = null;
      region = null;
      renderer.dispose();
      renderer.domElement.removeEventListener('wheel', wheel);
      renderer.domElement.removeEventListener('atlas-camera', targetCamera);
      renderer.domElement.removeEventListener('pointerdown', pointerDown);
      renderer.domElement.removeEventListener('webglcontextlost', contextLost);
      renderer.domElement.removeEventListener('webglcontextrestored', contextRestored);
      renderer.domElement.removeEventListener('pointerup', pointerUp);
      renderer.domElement.remove();
      view.current = null;
    };
  }, [props.projection]);

  useEffect(
    () => () => {
      packetCache.current = null;
      gridCache.current?.dispose();
      gridCache.current = null;
      const cache = riverCache.current;
      riverCache.current = null;
      if (cache) {
        cache.cancelled = true;
        cache.packets.length = 0;
        cache.asset.dispose();
      }
    },
    [],
  );

  useEffect(() => {
    view.current?.command(props.command);
  }, [props.command]);
  return (
    <>
      <div ref={host} className="globe-canvas" />
      <svg
        className="axis-indicator"
        viewBox="0 0 72 84"
        role="img"
        aria-label="North is up on the map; globe rotates freely."
      >
        <circle cx="36" cy="36" r="19" fill="none" stroke="currentColor" opacity=".12" />
        <line x1="36" y1="60" x2="36" y2="12" stroke="currentColor" strokeWidth="1" />
        <text x="36" y="8">
          N
        </text>
        <text x="36" y="66">
          S
        </text>
        <text x="36" y="80" className="axis-caption">
          {props.projection === 'map' ? 'NORTH UP' : 'SPIN AXIS'}
        </text>
      </svg>
      {loading && (
        <div className="physical-load-status" role="status">
          {loading}
        </div>
      )}
      {error && <div className="globe-error">{error}</div>}
    </>
  );
}
