import type { Deposit, Lake, Layer, ResourceType, World, WorldConfig } from '../model';
import type { FertilityEvaluation } from '../generation/fertility';
import type { Vec3 } from '../math';
import type { PhysicalMeshManifest, PhysicalMeshPacket } from './physical-mesh-types';
import type { FixedGridManifest, FixedGridPacket } from './fixed-grid-types';
import type { FixedRiverBatch, FixedRiverRequest } from './river-render-types';

export interface WorldSummary {
  version: string;
  config: WorldConfig;
  surfaceCells: number;
  processCells: number;
  bytes: number;
  elapsed: number;
  oceanFraction: number;
  landAreaKm2: number;
  landRainMm: number;
  minimumHeight: number;
  maximumHeight: number;
  lakeCount: number;
  riverCount: number;
  deltaCount: number;
  oxbowCount: number;
  depositCount: number;
  resourceTotals: Record<ResourceType, { count: number; amount: number }>;
  timings: World['timings'];
  evolution: World['evolution'];
  refinementWork: World['refinementWork'];
  featureRefinementStats?: World['featureRefinementStats'];
  featureCoarseningStats?: World['featureCoarseningStats'];
  refinement?: { baseCount: number; insertedCount: number; passes: number };
  execution: World['execution'];
  atmosphereRelativeResidual: number;
  oceanFluxDivergence: number;
  oceanDischarge: number;
  lakeExchange: number;
  sedimentExport: number;
  nearestCenterSpacingM: {
    min: number;
    max: number;
    mean: number;
    p10: number;
    median: number;
    p90: number;
  };
}

export interface WorldHandle {
  snapshotId: string;
  /** Legacy handles are saved; new generated views explicitly start unsaved. */
  saved?: boolean;
  name?: string;
  version: string;
  config: WorldConfig;
  summary: WorldSummary;
}

/** Explicit renderer packet: no complete World or sparse World-shaped proxy. */
export interface CellSampleBatch {
  cellIds: Uint32Array;
  heights: Float32Array;
  colors: Float32Array;
  bankLand: Float32Array;
  surfaceTerrain: Float32Array;
  surfaceClimate: Float32Array;
  surfaceHabitat: Float32Array;
  surfaceDelta: Float32Array;
  surfaceWater: Float32Array;
  surfaceBank: Float32Array;
}

export interface CellInspection {
  cell: number;
  position: Vec3;
  latitude: number;
  longitude: number;
  season: number;
  areaM2: number;
  nearestCenterMetres: number;
  outline: Float32Array;
  height: number;
  bedrock: number;
  sediment: number;
  ocean: boolean;
  lakeCoverage: number;
  temperature: number;
  annualTemperature: number;
  rain: number;
  annualRain: number;
  pet: number;
  aet: number;
  biome: number;
  vegetation: number;
  riparian: number;
  riparianFraction: number;
  riverHabitat: number;
  floodplainFraction: number;
  wetland: number;
  wetlandFraction: number;
  /** Null means the snapshot predates salt modeling. Concentration is g/L. */
  soilSalinity: number | null;
  soilSalinityFraction: number | null;
  seasonalFlood: number | null;
  crustAge: number;
  volcanic: number;
  surfaceChange: number;
  fluvialIncision: number;
  deltaSediment: number;
  plate: number;
  river: null | {
    corner: number;
    discharge: number;
    catchmentArea: number;
    system: number;
    streamOrder: number;
    source: number;
    regime: number;
    supportFlow: number;
    salinity: number | null;
    seasonalDischarge: number[];
    sourceFractions: number[];
    sinuosity: number | null;
    destination: string;
  };
  lake: Lake | null;
  delta: null | { lake: number; fractions: number[] };
  oxbow: null | {
    area: number;
    width: number;
    capacity: number;
    depth: number;
    seasonalDepth: number[];
  };
  fertility: FertilityEvaluation;
  storedCellFertility: number;
}

export interface DepositInspection {
  deposit: Deposit;
  cell: number;
  surface: 'Beneath ocean' | 'Beneath inland water' | 'Land';
  latitude: number;
  longitude: number;
}

export interface DepositPage {
  items: Deposit[];
  nextCursor: number | null;
  total: number;
  amount: number;
}

/** Radians, north/east positive. Wrapped west/east intervals cross the dateline. */
export interface ViewBounds {
  west: number;
  east: number;
  south: number;
  north: number;
}
/** Camera-centered spherical cap used only by globe cell-grid queries. */
export interface GlobeGridFootprint {
  /** Unit geographic direction of the camera. */
  center: Vec3;
  /** Conservative visible angular radius in radians, from zero through pi. */
  radius: number;
}
export interface OverlayRequest {
  bounds: ViewBounds;
  layer?: Layer;
  season: number;
  rivers?: boolean;
  coasts?: boolean;
  boundaries?: boolean;
  resources?: boolean;
  resourceFilter?: ResourceType | 'all';
  maxSegments?: number;
  maxResources?: number;
  riverThreshold?: number;
  vectors?: boolean;
  maxVectors?: number;
  gridLines?: boolean;
  gridGlobeFootprint?: GlobeGridFootprint;
  drift?: number;
}
export interface OverlayLines {
  /** Packed xyz pairs on the unit sphere, with physical heights/widths separate. */
  positions: Float32Array;
  heights: Float32Array;
  widths: Float32Array;
  discharge: Float32Array;
  /** Optional continuous flow paths, expressed as offsets into endpoint-pair segments. */
  pathOffsets?: Uint32Array;
  /** Seasonal field strength relative to 15 m/s wind or 0.5 m/s current, in [0, 1]. */
  pathSpeeds?: Float32Array;
}
export interface OverlayPacket {
  rivers: OverlayLines;
  coasts: OverlayLines;
  coastStatus?: 'visible' | 'zoom-in';
  boundaries: OverlayLines;
  flow: OverlayLines;
  grid: OverlayLines;
  /** A complete physical grid is shown only when the viewport fits its bounded packet. */
  gridStatus?: 'visible' | 'zoom-in';
  drift: OverlayLines;
  deposits: Deposit[];
  truncated: boolean;
}

export interface WorldViewSource {
  gridManifest(): Promise<FixedGridManifest>;
  gridBatch(batch: number): Promise<FixedGridPacket>;
  /** Release the idle preparation reader after all reusable grid packets load. */
  releaseGridRender?(): boolean;
  /** Cancel only pending grid preparation when its world/view is discarded. */
  cancelGridRender?(): void;
  physicalManifest(layer: Layer, season: number): Promise<PhysicalMeshManifest>;
  physicalBatch(layer: Layer, season: number, batch: number): Promise<PhysicalMeshPacket>;
  riverRender(request: FixedRiverRequest): Promise<FixedRiverBatch>;
  /** Release preparation storage once the viewer owns the complete river asset.
   * Returns false while a different variant or an in-flight query owns the lane. */
  releaseRiverRender?(request: Pick<FixedRiverRequest, 'season' | 'threshold'>): boolean;
  sample(directions: Float32Array, layer: Layer, season: number): Promise<CellSampleBatch>;
  inspect(direction: Vec3, season: number): Promise<CellInspection>;
  overlays(request: OverlayRequest): Promise<OverlayPacket>;
  inspectDeposit(id: string): Promise<DepositInspection | null>;
  listDeposits(
    filter?: ResourceType | 'all',
    cursor?: number,
    limit?: number,
  ): Promise<DepositPage>;
  diagnostics(): Promise<WorldSummary>;
}
