/** Canonical units: metres, seconds, steradians; seasonal rain/PET are mm. */
export const VERSION = '2.28.0';

export const YEAR = 365.25 * 86400;

export const SEASON = YEAR / 4;

export interface WorldConfig {
  seed: string;
  surfaceLevel: number;
  processLevel: number;
  refinementMinSpacing: number; // metres; target site spacing in selected surface regions
  refinementStrength: number; // 0 disables refinement; 1 resolves all selected features
  evolutionRefinements: number; // topology changes during the assigned recent landscape interval
  featureRefinementPasses: number; // bounded detail passes after final terrain and hydrology
  featureRefinementSpacing: number; // metres; target spacing around under-resolved final features
  featureRefinementBudget: number; // percent of cells before final feature passes, shared across passes
  featureDistrictStrength: number; // percent influence of broad lake-district refinement; 0 disables
  featureDistrictRadius: number; // metres; geographic neighborhood used to identify lake districts
  featureDistrictThreshold: number; // percent area-weighted shore evidence required for a district
  featureCoarseningBudget: number; // maximum percent of pre-final cells removable across final passes
  featureCoarseningSpacing: number; // metres; maximum spacing permitted in quiet land
  featureCoarseningTolerance: number; // metres; maximum height reconstruction error on removed sites
  landscapeBatches: number; // full drainage refreshes across the recent interval
  hillslopeStrength: number; // multiplier on fine loose-sediment creep
  irregularity: number;
  plates: number;
  oceanFraction: number;
  exposure: number;
  temperature: number;
  obliquity: number;
  erosion: number;
  radius: number;
  continentScale: number;
  reliefScale: number;
  tectonicWidth: number;
  tectonicDuration: number; // Myr of prescribed crust evolution
  plateSpeed: number; // cm/year at unit angular-motion magnitude
  volcanicActivity: number; // rate of fault and hotspot construction
  hotspotCount: number; // seeded intraplate sources with finite lifetimes
  waveErosion: number;
  windErosion: number;
  lakePersistence: number; // resistance of depressions to outlet erosion
  salinityYears: number; // explicit representative hydrologic years; independent of solver iterations
  weatheringSalinity: number; // dissolved catchment salts in runoff, kg/m³ (= g/L)
  inheritedMarineSalinity: number; // explicit initial lake salt scenario, kg/m³; never inferred from crust
  windStrength: number;
  circulationScale: number;
  currentStrength: number;
  evaporationScale: number;
  moistureLifetime: number; // days
  moistureMixing: number; // m²/s
  orographicStrength: number;
  recycling: number; // fraction of provisional actual evapotranspiration
  soilCapacity: number; // mm
  infiltration: number; // fraction reaching the soil bucket
  riverSourceArea: number; // km² of upstream land before a channel can start
  riverSourceFlow: number; // m³/s of soil drainage, overflow, or reservoir release
  floodplainExtent: number; // lateral extent of suitable alluvial habitat, before terrain limits
  fluvialDuration: number; // Myr of recent river landscape evolution, not a river's birth date
  bankMobility: number; // lateral migration on accessible alluvial plains
  depositFrequency: number; // multiplier on regional mineral occurrence frequency
  depositAmount: number; // multiplier on abstract quantity per deposit
}

export const DEFAULT_CONFIG: WorldConfig = {
  seed: 'AETHER-2408',
  surfaceLevel: 5,
  processLevel: 5,
  refinementMinSpacing: 100000,
  refinementStrength: 0,
  evolutionRefinements: 0,
  featureRefinementPasses: 0,
  featureRefinementSpacing: 10000,
  featureRefinementBudget: 20,
  featureDistrictStrength: 0,
  featureDistrictRadius: 300000,
  featureDistrictThreshold: 5,
  featureCoarseningBudget: 0,
  featureCoarseningSpacing: 250000,
  featureCoarseningTolerance: 25,
  landscapeBatches: 4,
  hillslopeStrength: 1,
  irregularity: 0.65,
  plates: 18,
  oceanFraction: 0.66,
  exposure: 1,
  temperature: 15,
  obliquity: 23.4,
  erosion: 0.35,
  radius: 6371000,
  continentScale: 1,
  reliefScale: 1,
  tectonicWidth: 1,
  tectonicDuration: 200,
  plateSpeed: 3,
  volcanicActivity: 1,
  hotspotCount: 8,
  waveErosion: 1,
  windErosion: 1,
  lakePersistence: 0.35,
  salinityYears: 100,
  weatheringSalinity: 0.05,
  inheritedMarineSalinity: 0,
  windStrength: 1.8,
  circulationScale: 1,
  currentStrength: 1,
  evaporationScale: 1.5,
  moistureLifetime: 18,
  moistureMixing: 800000,
  orographicStrength: 0.8,
  recycling: 0.65,
  soilCapacity: 140,
  infiltration: 0.85,
  riverSourceArea: 8000,
  riverSourceFlow: 1,
  floodplainExtent: 1,
  fluvialDuration: 1,
  bankMobility: 1,
  depositFrequency: 1,
  depositAmount: 1,
};

/** Fresh worlds resolve final features; legacy recipes keep their original topology. */
export const NEW_WORLD_CONFIG: WorldConfig = {
  ...DEFAULT_CONFIG,
  featureRefinementPasses: 1,
  featureDistrictStrength: 60,
  featureCoarseningBudget: 10,
};

/** Unit-sphere geometry with packed adjacency arrays. All IDs are zero-based.
 * A cell is a surface polygon; a corner is a meeting point of three cells.
 * Cell adjacency uses offsets[cell]..offsets[cell + 1]; corner adjacency has degree three.
 */
export interface Grid {
  count: number;
  level: number; // seed subdivision; adaptive resolution is described by actual geometry
  positions: Float64Array; // xyz unit vector per cell center
  triangles: Uint32Array; // three incident cell IDs per corner
  corners: Float64Array; // xyz unit vector per corner
  offsets: Uint32Array; // cell adjacency offsets, with one final sentinel
  cellCorners: Uint32Array; // corner IDs in cyclic order around each cell
  neighbors: Uint32Array; // neighboring cell IDs, indexed by the same offsets
  arcEdges: Uint32Array; // shared edge ID for each directed cell adjacency
  areas: Float64Array; // cell area in steradians; multiply by planet radius squared
  edgeCells: Uint32Array; // two incident cell IDs per edge
  edgeCorners: Uint32Array; // two endpoint corner IDs per edge
  edgeLength: Float64Array; // angular distance between edge endpoints, radians
  edgeDistance: Float64Array; // angular distance between incident cell centers, radians
  edgeNormal: Float64Array;
  cornerNeighbors: Uint32Array;
  cornerEdges: Uint32Array;
  flips: number;
  refinement?: {
    baseCount: number;
    insertedCount: number;
    passes: number;
    sourceCell: Uint32Array; // organizational nearest seed site, not polygon containment
  };
}

export interface Plate {
  seed: number;
  target: number;
  area: number;
  omega: [number, number, number];
  name: string;
}

export interface Geology {
  plate: Uint16Array;
  plates: Plate[];
  continental: Float32Array;
  age: Float32Array;
  uplift: Float32Array;
  volcanism: Float32Array;
  boundary: Uint8Array;
  crust?: CrustHistory;
  hotspots?: HotspotSource[];
}

/** Sparse mantle-frame sources retained independently of process-grid sampling. */
export interface HotspotSource {
  position: [number, number, number];
  start: number;
  end: number;
  radius: number;
  rate: number;
}

/** Volume attributed during the existing geological history, not a new eruption. */
export interface VolcanicConstructionSource {
  position: [number, number, number];
  plate: number;
  radius: number;
  volume: number;
  age: number;
}

/** Material reconstruction and inherited deformation; all fields use the process grid. */
export interface CrustHistory {
  volcanicSources?: VolcanicConstructionSource[];
  initialPlate: Uint16Array;
  initialBase: Float32Array; // raw basement metres relative to the initial datum
  base: Float32Array; // reconstructed raw basement, including inherited deformation
  deformation: Float32Array; // inherited collision uplift / rift subsidence, metres
  volcanic: Float32Array; // accumulated volcanic construction above basement, metres
  volcanicAge: Float32Array; // Myr since appreciable local emplacement
  materialBase: Float32Array; // noise sampled in the winning plate's reference frame
  material: Uint8Array; // 1: retained reference crust; 0: newly opened ocean
  inverse: Float64Array; // one inverse finite rotation matrix per plate
  seaThreshold: number;
  steps: number;
}

export interface Terrain {
  bedrock: Float32Array;
  sediment: Float32Array;
  height: Float32Array;
  surfaceChange: Float32Array; // net erosion / deposition in the landscape stage, metres
  ocean: Uint8Array;
  coastDistance: Float32Array;
  seaThreshold: number;
  fluvialIncision: Float32Array; // gross cell-average lowering by the recent river pass, m
  deltaSediment: Float32Array; // sediment deposited at river mouths, m
  oxbows: Oxbow[];
  migration?: RiverMigration[];
  saltMass?: Float64Array; // derived geographic inventory, kg per surface cell; parcels are authoritative when present
  saltParcels?: SaltParcels; // sparse immutable geographic inventory; preserves separate lakes sharing a cell
  saltAgeYears?: number; // modeled salt age; remeshing never advances this clock
}

/** Source supports survive remeshing without relocating or duplicating their salt. */
export interface SaltParcels {
  positions: Float64Array; // xyz unit-vector per source support
  masses: Float64Array; // kg per support, liquid plus bed/exposed salt
}

/** Persistent geographic bend history, independent of surface corner IDs. */
export interface RiverMigration {
  start: [number, number, number];
  end: [number, number, number];
  space: number;
  mobility: number;
  variation: number;
  elapsedMyr: number;
}

/** An abandoned subcell channel. Its water comes from the seasonal land-water budget. */
export interface Oxbow {
  cell: number;
  points: Float32Array; // unit-sphere centerline, inherited from a cut-off bend
  width: number; // physical full channel width, m
  area: number; // m², capped to the owning cell's available footprint
  capacity: number; // maximum standing-water depth, m
}

/** Four seasonal fields on the process grid. PET and SST retain their conventional
 * serialized names: potential evapotranspiration and sea-surface temperature.
 */
export interface Climate {
  temperature: Float32Array[];
  rain: Float32Array[];
  pet: Float32Array[]; // potential evapotranspiration, mm per quarter
  wind: Float32Array[];
  current: Float32Array[];
  sst: Float32Array[]; // sea-surface temperature, °C
  moisture: Float32Array[];
  evaporation: Float32Array[];
  atmosphereResidual: number;
  oceanDivergence: number;
}

/** Annual surface-cell budgets, plus seasonal samples. AET is actual evapotranspiration. */
export interface LandWater {
  rain: Float32Array;
  temperature: Float32Array;
  pet: Float32Array; // potential evapotranspiration, mm/year
  aet: Float32Array; // actual evapotranspiration, mm/year
  runoff: Float64Array; // annual mean water volume rate, m³/s
  channelRunoff: Float64Array; // subset of runoff: soil drainage and overflow, excluding quickflow
  soil: Float32Array;
  snow: Float32Array;
  aridity: Float32Array;
  seasonalRain: Float32Array[];
  seasonalTemperature: Float32Array[];
  seasonalLiquid: Float32Array[]; // rain plus actual snowmelt, mm per quarter
  seasonalPet: Float32Array[]; // potential evapotranspiration, mm per quarter
  seasonalRunoff: Float32Array[]; // mean m³/s within each quarter, before routing
  meltRunoff: Float32Array; // annual rapid snow/ice-melt runoff, m³/s
  baseflowRunoff: Float32Array; // annual slow soil-water release, m³/s; spring-flow proxy
  saturatedSeasons: Uint8Array; // sampled seasons with a nearly full soil store
  oxbowDepth: Float32Array[]; // seasonal water depth for Terrain.oxbows, m
  residual: number;
}

export interface Lake {
  id: number;
  outlet: number;
  spill: number;
  capacity: number;
  storage: number; // mean of season-end liquid stores, m³
  level: number; // routing high-water level; use seasonal.level for inspection, m
  area: number; // mean of season-end wet areas, m²
  inflow: number;
  outflow: number;
  evaporation: number;
  directRain: number;
  displacedRunoff: number;
  kind: 'closed' | 'spilling';
  seasonal?: LakeSeasons;
  salinity?: LakeSalinity;
}

/** Representative annual mixed-water chemistry, not a drinking-water assessment. */
export interface LakeSalinity {
  dissolvedSalt: number; // kg remaining in liquid water
  bedSalt: number; // kg precipitated or retained on a dry bed
  concentration: number; // kg/m³ (= g/L), zero when dry
  inflowSalt: number; // contemporary kg/s entering the reservoir
  outflowSalt: number; // contemporary kg/s leaving the reservoir
  elapsedYears: number;
}

export interface SalinityBudget {
  initialSalt: number; // kg, including explicit initial marine scenario
  weatheringSalt: number; // kg added over the assigned years
  exportedSalt: number; // kg leaving the modeled land/lake network
  retainedSalt: number; // kg in the geographic inventory after this solve
  residual: number; // kg; initial + weathering - exported - retained
  elapsedYears: number; // physical years advanced by this solve; zero for remeshing
}

/** Four representative quarters. Fluxes are m³/s; storage is m³ and area is m².
 * Storage change is retained explicitly, including any bounded spin-up remainder.
 */
export interface LakeSeasons {
  storage: number[];
  level: number[];
  area: number[];
  inflow: number[];
  directRain: number[];
  evaporation: number[];
  displacedRunoff: number[];
  outflow: number[];
  storageChange: number[];
  initialStorage: number;
}

/** Routing fields are per corner; lakeDepth and lakeCoverage are per surface cell. */
export interface Drainage {
  height: Float32Array;
  filled: Float32Array;
  receiver: Int32Array; // downstream corner; -1 marks a terminal node
  order: Uint32Array; // Priority-Flood order, from lower flood rank to higher
  discharge: Float64Array; // annual mean channel flow, m³/s
  seasonalPeak?: Float32Array; // maximum routed seasonal channel flow, m³/s
  basin: Uint32Array;
  lakeId: Int32Array;
  lakeDepth: Float32Array;
  lakeFraction: Float32Array; // maximum routing footprint; seasonal coverage controls land/water mixtures
  lakeCoverage: Float32Array; // area fraction per cell; independent of resolvable depth
  seasonalLakeCoverage?: Float32Array[]; // four wet fractions; lakeCoverage is their mean
  lakes: Lake[];
  runoffTotal: number;
  oceanDischarge: number;
  lakeExchange: number;
  riverSalinity?: Float32Array; // contemporary channel concentration, kg/m³ per corner
  soilSalinity?: Float32Array; // local exposed shore/bed porewater proxy, kg/m³ per cell
  soilSalinityFraction?: Float32Array; // affected exposed fraction of the whole cell
  salinityBudget?: SalinityBudget;
}

export interface Ecology {
  biome: Uint8Array;
  vegetation: Float32Array;
  riparian: Float32Array; // potential vegetation on accessible riverbanks
  riparianFraction: Float32Array; // fraction of cell area within those banks
  riverbankVegetation: Float32Array; // potential on each selected corner-to-receiver edge
  floodplains: Floodplains;
  riverHabitat: Uint8Array; // strongest local habitat, separate from the regional biome
  floodplainFraction: Float32Array; // seasonally accessible fraction of cell area
  ice: Float32Array;
  wetland: Uint8Array; // 0 none, 1 marsh, 2 swamp, 3 fen, 4 bog
  wetlandFraction: Float32Array; // local habitat fraction; regional biome is retained
}

/** Sparse reach records. Two bank values per corner, ordered like Grid.edgeCells. */
export interface Floodplains {
  corner: Uint32Array;
  width: Float32Array; // physical metres on each bank
  vegetation: Float32Array; // potential at the channel, decays across the bank
  habitat: Uint8Array; // 0 none, 1 meadow, 2 woodland, 3 wetland
  seasonalFlood: Float32Array[]; // relative overbank potential, not flood probability
}

/** Channel selection on Drainage.receiver; the full runoff graph remains authoritative. */
export interface Rivers {
  channel: Uint8Array;
  headwater: Uint8Array;
  catchmentArea: Float64Array; // m², includes land draining through upstream reservoirs
  supportFlow: Float64Array; // m³/s of non-storm supply, bounded by actual discharge
  system: Uint32Array; // shared terminal corner or closed-lake node, across spilling lakes
  streamOrder: Uint8Array; // Strahler order of selected channels; zero off-channel
  seasonalDischarge: Float32Array[]; // quarter-mean estimate; average equals annual discharge
  sourceFractions: Float32Array[]; // rainfall, rapid melt, slow baseflow, lake release; sum to one
  source: Uint8Array; // dominant delivery source; wetland context is assigned at headwaters
  regime: Uint8Array; // 0 none, 1 perennial potential, 2 seasonal, 3 intermittent potential
  courses: RiverCourses;
  deltas: Delta[];
}

/** Sparse polylines share exact receiver endpoints; bends stay inside the resolved valley. */
export interface RiverCourses {
  corner: Uint32Array;
  offsets: Uint32Array;
  points: Float32Array; // xyz unit directions
  sinuosity: Float32Array;
}

/** Terminal distributaries all enter the same receiving body. Fractions sum to one. */
export interface Delta {
  corner: number;
  lake: number; // -1 ocean, otherwise the receiving lake ID
  sedimentVolume: number; // m³ deposited in the resolved mouth neighborhood
  branches: { points: Float32Array; fraction: number }[];
}

export type ResourceType = 'copper' | 'tin' | 'iron' | 'gold' | 'corundum';

export type FormationCause =
  | 'magmatic-hydrothermal'
  | 'selected-intrusive'
  | 'deformation-associated'
  | 'inherited-sedimentary'
  | 'selected-volcanic';

/** One initial endowment. A display-cell association never owns another copy. */
export interface Deposit {
  id: string; // Stable within a fixed process baseline and resource recipe.
  resourceType: ResourceType;
  anchor: [number, number, number]; // Unit-sphere direction, independent of surface detail.
  extentKm: number; // Approximate footprint radius; separate from marker size.
  amount: number; // Abstract units of this resource, not tonnage, purity, or economic value.
  formationCause: FormationCause;
}

export interface Resources {
  recipe: string;
  deposits: Deposit[];
  fertility: Float32Array; // Annual/general land potential, 0–100 per surface cell.
}

export interface World {
  version: string;
  config: WorldConfig;
  grid: Grid; // detailed surface geometry for terrain, hydrology, ecology, and rendering
  process: Grid; // coarser geometry for plate evolution and seasonal climate
  transfer: Uint32Array; // process-cell ID for each surface cell
  geology: Geology;
  terrain: Terrain;
  climate: Climate;
  water: LandWater;
  drainage: Drainage;
  rivers: Rivers;
  ecology: Ecology;
  resources: Resources;
  timings: { name: string; ms: number }[];
  elapsed: number;
  bytes: number;
  sedimentExport: number; // m³ of unresolved downstream sediment export, including ocean delivery
  evolution: LandscapeEvolution;
  refinementPlans: import('./grid/refinement-plan').ResolvedRefinementPlan[];
  featureRefinementPlans?: import('./grid/feature-refinement').ResolvedFeatureRefinementPlan[];
  featureRefinementStats?: import('./grid/feature-refinement').FeatureRefinementPassStats[];
  featureCoarseningPlans?: import('./grid/feature-coarsening').ResolvedFeatureCoarseningPlan[];
  featureCoarseningStats?: import('./grid/feature-coarsening').FeatureCoarseningStats[];
  refinementWork: import('./grid/refinement-work').RefinementWorkEstimate[];
  execution: { climateWorkers: number }; // runtime choice, never part of the physical recipe
  regionalRefinements?: ResolvedRegionalRefinement[];
  climateReferenceHeight?: Float32Array; // process heights underlying retained climate after local remeshing
}

/** Resolution requests act on an existing evolved snapshot without advancing time. */
export type RegionalRefinementRequest =
  | {
      kind: 'region';
      center: [number, number, number];
      radiusMetres: number;
      targetSpacingMetres: number;
    }
  // The entire final river-system watershed containing this corner, not only its upstream reach.
  | { kind: 'watershed'; corner: number; targetSpacingMetres: number };

/** Sparse, resolved geographic footprint; replay never reselects a changed watershed. */
export interface ResolvedRegionalRefinement {
  format: 'atlas-regional-refinement/v1';
  sourceGeometryHash: string;
  sourceCellCount: number;
  configSignature: string;
  planetRadiusMetres: number;
  baseSpacingMetres: number;
  gradation: number;
  request: RegionalRefinementRequest;
  caps: { center: [number, number, number]; radiusMetres: number }[];
}

export interface LandscapeEvolution {
  durationMyr: number;
  batches: number;
  drainageRefreshes: number;
  remeshes: {
    beforeCells: number;
    afterCells: number;
    elapsedMyr: number;
    sedimentBefore: number;
    sedimentAfter: number;
  }[];
  hillslopeMoved: number;
  windMoved: number;
  coastalMoved?: number;
}

export type Progress = (stage: string, completed: number, total: number) => void;

export type Layer =
  | 'world'
  | 'initial'
  | 'deformation'
  | 'volcanism'
  | 'weathering'
  | 'elevation'
  | 'tectonics'
  | 'crust'
  | 'age'
  | 'uplift'
  | 'wind'
  | 'currents'
  | 'sst'
  | 'temperature'
  | 'rainfall'
  | 'moisture'
  | 'aridity'
  | 'drainage'
  | 'lakes'
  | 'floodplains'
  | 'sources'
  | 'landforms'
  | 'wetlands'
  | 'biomes'
  | 'vegetation'
  | 'ice'
  | 'sediment'
  | 'resources'
  | 'fertility';
