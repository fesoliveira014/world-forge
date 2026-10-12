# Resource-plan reconciliation — supplied v2.9.4 application / v2.9.0 generator

**Purpose:** Record the evidence used to update the next resource milestones, without turning the source review into a new geology implementation.  
**Method:** Static inspection of the uploaded architecture, revision notes, model, pipeline, and relevant generation modules; comparison with the prior v2.4.1 bundle/resource proposal.  
**Not performed:** No generator run, build, test suite, browser inspection, or benchmark was executed for this reconciliation. The resource architecture is proposed work; original source code is unchanged.

## 1. Exact input and document precedence

- Input archive: `worldbuilding_architecture_illustrated(1).zip`.
- SHA-256: `717194ca3e747a9757f272b7ff25e6b38f412e25bf3ee05c452507176de5add7`.
- Source revision recorded by `SOURCE_REVISION.txt`: `edb5ac85f11a281f5bc23bc0a7f989b583c5b75b`.
- Root README identifies application v2.9.4; `source/src/core/model.ts` identifies generator v2.9.0.
- The previous resource proposal inspected generator v2.4.1 at `daead72ec2fd3c2c80b59dff2f693497d7b36044`. Its source-gap table must not be read as a description of the new bundle.

The current root illustrated architecture and the included source are the baseline. The copied older `source/docs/worldbuilding_planet_generator_architecture_v2.md` remains historical material; its filename alone does not make it the latest design.

The integrated package preserves every original archive file byte-for-byte and adds this note and the revised resource plan. Source identity is reported from the bundle, not verified against a remote repository. No outside research or scientific validation is claimed here.

## 2. Evidence-to-decision map

| Observation supported by supplied files | Source locations | Change to next steps |
| --- | --- | --- |
| Crust evolution now changes final geography, separately from the drift display. | Architecture §6.4; `crust-evolution.ts`; `pipeline.ts`. | Remove “implement moving crust” from resource prerequisites. |
| The final snapshot retains reference ownership, material/gap flags, inverse carrier rotations, and reconstructed fields. | `model.ts`, `CrustHistory`; `evolveCrust`. | Interpret inherited host material in existing reference frames. |
| Overlap is reversible selection, gap aging is local, and initial ages are synthetic. | Architecture §6.4 model boundary; revision 2.5.0. | Do not promise irreversible ore-parcel provenance. Freeze an endowment baseline for history. |
| Volcanic construction and recent-emplacement age are distinct from present magmatic influence. | `volcanism.ts`; `crust-evolution.ts`; `updateTectonicRelief`. | Reuse accumulated context, but add explicit composition/host presets. |
| Fault/hotspot contributions collapse into a scalar construction field; no lithology or unique material source record is exposed. | `volcanicRates`; `CrustHistory`; `Geology`. | A source-class hint is conditional new data, not an already available field. |
| Regional rock resistance is sampled from seeded noise in material coordinates. | `landscape.ts`. | Preserve current terrain behavior initially; do not describe the resistance field as a rock catalogue. |
| Basin reshaping is not sediment deposition; later weathering and basin delivery are separate. | Architecture §§6.3, 12.1; `continental-basins.ts`, `sediment.ts`. | Do not turn constructed basin depth into clay or sediment inventory. |
| Regional sediment delivery has its own temporary cell escape path; final water routing is recomputed. | Architecture §12.1; `sediment.ts`; `pipeline.ts`. | Reuse current cover. A final-network mineral tracer must be labeled a snapshot approximation. |
| Outlet erosion exports material without resolving it into recent mouth fans. | Architecture §12.1; `landscape.ts`, `outlet-erosion.ts`. | Do not assign all global exported sediment to present deltas. |
| Delta volumes are neighborhood summaries and can overlap. | Architecture §11.6; `deltas.ts`. | Cell material stock must be owned/countable once, not duplicated per fan. |
| Seasonal flows and four delivery-pathway fractions now exist. | Architecture §11.4; `model.ts`, `rivers.ts`. | Use these before adding a separate seasonality model for resource access. |
| Broader alluvial habitat, flooding potential, wetland classes, and cutoff pools exist. | Architecture §§9.2, 11.5, 12.3–12.4; `model.ts`, `wetlands.ts`. | Reuse physical habitat fractions; add stock and production semantics only. |
| Wetland labels do not supply peat chemistry/stock. | Architecture §12.4; comment and rules in `wetlands.ts`. | Defer harvestable peat until explicitly modeled. |
| Environmental World still has no resource or historical state. | Complete `World` interface and stage order. | Add one endowment stage and a later separate history owner. |
| App v2.9.2–v2.9.4 preserves accepted lake/bank/delta/river presentation. | README and revision notes 2.9.2–2.9.4. | Resource inspection must not reintroduce removed water patches or bank/delta meshes. |

## 3. Selected exact excerpts

The numbered lines below refer to original files inside the supplied archive. Surrounding interpretation is new; excerpts are unmodified.


### Identity

**Source:** `README.md:13–17`

```text
  13 Application v2.9.4 cleans up the full authored source with descriptive names, separate declarations, clear control blocks, readable shaders, documented array layouts, and focused mesh builders. Start with source/docs/CODE_STYLE.md; source/docs/REVISION_2.9.4.md records the exact before/after numerical and rendering-buffer comparisons. Run npm run format to maintain formatting. Generator identity and the accepted visual behavior remain unchanged.
  14 
  15 Application v2.9.3 joins visible river reaches into continuous main/tributary ribbons made of rectangular spans and bounded bevel joins. The old width pinches and folded quads are removed; sub-width bends and anchored water approaches are simplified for display. Seasonal activity and downstream flow animation remain. See source/docs/REVISION_2.9.3.md for the AETHER-0004 regression and focused verification.
  16 
  17 Application v2.9.2 restores lakes to the main surface, including shallow flat lakes. Separate triangular lake patches, green bank meshes, delta fan lines and island meshes have been removed. Banks now blend through a soft, filtered surface texture. Deltas use up to two adjoining green-blue or brown-blue cells with seasonal coloring. Globe and Flat map share the same masks. Generator identity remains 2.9.0; terrain and hydrology are unchanged by this rendering correction.
```

### Generator identity

**Source:** `source/src/core/model.ts:1–6`

```text
   1 /** Canonical units: metres, seconds, steradians; seasonal rain/PET are mm. */
   2 export const VERSION = '2.9.0';
   3 
   4 export const YEAR = 365.25 * 86400;
   5 
   6 export const SEASON = YEAR / 4;
```

### Retained geology and material-frame fields

**Source:** `source/src/core/model.ts:119–148`

```text
 119 export interface Geology {
 120   plate: Uint16Array;
 121   plates: Plate[];
 122   continental: Float32Array;
 123   age: Float32Array;
 124   uplift: Float32Array;
 125   volcanism: Float32Array;
 126   boundary: Uint8Array;
 127   crust?: CrustHistory;
 128 }
 129 
 130 /** Material reconstruction and inherited deformation; all fields use the process grid. */
 131 export interface CrustHistory {
 132   initialPlate: Uint16Array;
 133   initialBase: Float32Array; // raw basement metres relative to the initial datum
 134   base: Float32Array; // reconstructed raw basement, including inherited deformation
 135   deformation: Float32Array; // inherited collision uplift / rift subsidence, metres
 136   volcanic: Float32Array; // accumulated volcanic construction above basement, metres
 137   volcanicAge: Float32Array; // Myr since appreciable local emplacement
 138   materialBase: Float32Array; // noise sampled in the winning plate's reference frame
 139   material: Uint8Array; // 1: retained reference crust; 0: newly opened ocean
 140   inverse: Float64Array; // one inverse finite rotation matrix per plate
 141   seaThreshold: number;
 142   steps: number;
 143 }
 144 
 145 export interface Terrain {
 146   bedrock: Float32Array;
 147   sediment: Float32Array;
 148   height: Float32Array;
```

### Surface-change and cutoff fields

**Source:** `source/src/core/model.ts:145–168`

```text
 145 export interface Terrain {
 146   bedrock: Float32Array;
 147   sediment: Float32Array;
 148   height: Float32Array;
 149   surfaceChange: Float32Array; // net erosion / deposition in the landscape stage, metres
 150   ocean: Uint8Array;
 151   coastDistance: Float32Array;
 152   seaThreshold: number;
 153   fluvialIncision: Float32Array; // gross cell-average lowering by the recent river pass, m
 154   deltaSediment: Float32Array; // sediment deposited at river mouths, m
 155   oxbows: Oxbow[];
 156 }
 157 
 158 /** An abandoned subcell channel. Its water comes from the seasonal land-water budget. */
 159 export interface Oxbow {
 160   cell: number;
 161   points: Float32Array; // unit-sphere centerline, inherited from a cut-off bend
 162   width: number; // physical full channel width, m
 163   area: number; // m², capped to the owning cell's available footprint
 164   capacity: number; // maximum standing-water depth, m
 165 }
 166 
 167 /** Four seasonal fields on the process grid. PET and SST retain their conventional
 168  * serialized names: potential evapotranspiration and sea-surface temperature.
```

### Optional reconstruction and following terrain stage

**Source:** `source/src/core/pipeline.ts:51–73`

```text
  51   const geology = runStage('Plates & tectonics', () => buildGeology(processGrid, config));
  52 
  53   if (config.tectonicDuration > 0) {
  54     runStage('Crust evolution', () =>
  55       evolveCrust(processGrid, geology, config, (elapsed) =>
  56         progress(
  57           `Crust evolution · ${Math.round(elapsed)} / ${config.tectonicDuration} Myr`,
  58           completedStages,
  59           totalStages,
  60         ),
  61       ),
  62     );
  63   }
  64 
  65   const terrain = runStage('Terrain & oceans', () =>
  66     createTerrain(surfaceGrid, processGrid, transfer, geology, config),
  67   );
  68   const identityTransfer = Uint32Array.from(
  69     { length: processGrid.count },
  70     (_, cellIndex) => cellIndex,
  71   );
  72   const referenceOceanMask = createTerrain(
  73     processGrid,
```

### Exposed reference versus newly opened ocean

**Source:** `source/src/core/generation/crust-evolution.ts:166–204`

```text
 166         if (initialPlate[source] !== plateIndex) {
 167           continue;
 168         }
 169 
 170         const sampledBase = sampleUplift(grid, initialBase, sourceX, sourceY, sourceZ, source);
 171 
 172         if (sampledBase > 0) {
 173           overlap[cellIndex]++;
 174         }
 175 
 176         // Continental material overrides ocean floor. Among like crust, retain
 177         // the more buoyant candidate (younger seafloor or higher continental basement).
 178         const score = sampledBase > 0 ? 10 + clamp(sampledBase / 8000) : -initialAge[source] / 1000;
 179 
 180         if (score <= best) {
 181           continue;
 182         }
 183 
 184         best = score;
 185         owners[cellIndex] = plateIndex;
 186         material[cellIndex] = 1;
 187         baseline[cellIndex] = sampledBase;
 188         continental[cellIndex] = initialContinental[source];
 189         age[cellIndex] = initialAge[source] + elapsed;
 190       }
 191 
 192       if (!material[cellIndex]) {
 193         owners[cellIndex] = gapPlate;
 194         age[cellIndex] = crust.material[cellIndex] ? 0 : geology.age[cellIndex] + timeStep;
 195         continental[cellIndex] = 0;
 196         // Young opened ocean subsides toward an older abyssal floor.
 197         baseline[cellIndex] = -4200 - 1800 * (1 - Math.exp(-age[cellIndex] / 65));
 198       }
 199 
 200       const matrixOffset = owners[cellIndex] * 9;
 201       const stepMatrix = increment;
 202       const sourceX =
 203         stepMatrix[matrixOffset] * x +
 204         stepMatrix[matrixOffset + 1] * y +
```

### Volcanic transport is conditional on the receiving plate

**Source:** `source/src/core/generation/crust-evolution.ts:219–232`

```text
 219       // Unlike reference basement, new volcanic deposits also travel on opened ocean.
 220       // Do not import an edifice from an unrelated plate when ownership changes.
 221       const samePlate = geology.plate[from] === owners[cellIndex];
 222       volcanic[cellIndex] = samePlate
 223         ? sampleUplift(grid, crust.volcanic, sourceX, sourceY, sourceZ, from) *
 224           Math.exp(-timeStep / 220)
 225         : 0;
 226       volcanicAge[cellIndex] = samePlate
 227         ? sampleUplift(grid, crust.volcanicAge, sourceX, sourceY, sourceZ, from) + timeStep
 228         : timeStep;
 229 
 230       if (overlap[cellIndex] > 1) {
 231         target[cellIndex] = 1800;
 232         weight[cellIndex] = 1;
```

### Recent-emplacement age proxy

**Source:** `source/src/core/generation/crust-evolution.ts:322–333`

```text
 322       crust.deformation[cellIndex] = deformation[cellIndex];
 323       crust.base[cellIndex] = baseline[cellIndex] + deformation[cellIndex];
 324       crust.volcanic[cellIndex] = emplaceVolcanics(
 325         volcanic[cellIndex],
 326         construction[cellIndex],
 327         timeStep,
 328       );
 329       crust.volcanicAge[cellIndex] = construction[cellIndex] > 5 ? 0 : volcanicAge[cellIndex];
 330     }
 331 
 332     geology.plate.set(owners);
 333     geology.continental.set(continental);
```

### Fault and hotspot contributions are combined

**Source:** `source/src/core/generation/volcanism.ts:85–103`

```text
  85   for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
  86     let construction = 200 * Math.exp(-cost[cellIndex]);
  87 
  88     for (const hotspot of active) {
  89       const cosineDistance =
  90         grid.positions[cellIndex * 3] * hotspot.position[0] +
  91         grid.positions[cellIndex * 3 + 1] * hotspot.position[1] +
  92         grid.positions[cellIndex * 3 + 2] * hotspot.position[2];
  93       // Chord distance is adequate over a volcanic province; avoids an acos per source.
  94       const distanceSquared = 2 * Math.max(0, 1 - cosineDistance) * config.radius ** 2;
  95       construction += hotspot.rate * Math.exp(-distanceSquared / hotspot.radius ** 2);
  96     }
  97 
  98     rate[cellIndex] = construction * config.volcanicActivity;
  99   }
 100 
 101   return rate;
 102 }
 103 
```

### Existing material-frame erodibility preset

**Source:** `source/src/core/generation/landscape.ts:63–81`

```text
  63     const materialPosition = geology.crust
  64       ? referencePoint(geology.crust.inverse, geology.plate[processCell], x, y, z)
  65       : [x, y, z];
  66     const scale = config.radius / 180000;
  67     const erodibility =
  68       0.8 +
  69       0.7 *
  70         rock(materialPosition[0] * scale, materialPosition[1] * scale, materialPosition[2] * scale);
  71     const wetness = clamp(rain / 1200);
  72     const aridity = clamp(1 - rain / Math.max(1, potentialEvapotranspiration));
  73     const active = Math.max(
  74       clamp(geology.uplift[processCell] / 3500),
  75       (geology.crust?.volcanic[processCell] ?? 0) > 500
  76         ? Math.exp(-(geology.crust?.volcanicAge[processCell] ?? 0) / 20)
  77         : 0,
  78     );
  79     // Cold high-latitude terrain retains younger drainage. This is a preservation
  80     // proxy; no ice-sheet excavation or glacial chronology is claimed.
  81     const coldRegion = clamp((Math.abs(y) - 0.7) / 0.22) * clamp((8 - temperature) / 15);
```

### Sediment delivery owns only a temporary geological path

**Source:** `source/src/core/generation/sediment.ts:4–15`

```text
   4 /** Temporary cell flood for geological sediment delivery, not river routing.
   5  * Detached material follows escape paths, fills downstream depressions from their
   6  * floors up, and exports the remainder. The final corner graph still owns water.
   7  */
   8 export function depositInBasins(
   9   grid: Grid,
  10   terrain: Terrain,
  11   supply: Float64Array,
  12   config: WorldConfig,
  13 ): number {
  14   const { height, ocean } = terrain;
  15   const cellCount = grid.count;
```

### Current river seasonality and source contracts

**Source:** `source/src/core/model.ts:262–276`

```text
 262 export interface Rivers {
 263   channel: Uint8Array;
 264   headwater: Uint8Array;
 265   catchmentArea: Float64Array; // m², includes land draining through upstream reservoirs
 266   supportFlow: Float64Array; // m³/s of non-storm supply, bounded by actual discharge
 267   system: Uint32Array; // shared terminal corner or closed-lake node, across spilling lakes
 268   streamOrder: Uint8Array; // Strahler order of selected channels; zero off-channel
 269   seasonalDischarge: Float32Array[]; // quarter-mean estimate; average equals annual discharge
 270   sourceFractions: Float32Array[]; // rainfall, rapid melt, slow baseflow, lake release; sum to one
 271   source: Uint8Array; // dominant delivery source; wetland context is assigned at headwaters
 272   regime: Uint8Array; // 0 none, 1 perennial potential, 2 seasonal, 3 intermittent potential
 273   courses: RiverCourses;
 274   deltas: Delta[];
 275 }
 276 
```

### Delta summary recomputes a local volume from shared cells

**Source:** `source/src/core/generation/deltas.ts:68–78`

```text
  68     let sedimentVolume = 0;
  69 
  70     for (const cellIndex of cells) {
  71       sedimentVolume +=
  72         terrain.deltaSediment[cellIndex] * grid.areas[cellIndex] * config.radius ** 2;
  73     }
  74 
  75     if (sedimentVolume < 1e7) {
  76       continue;
  77     }
  78 
```

### Wetland classification is not accumulated peat

**Source:** `source/src/core/generation/wetlands.ts:7–13`

```text
   7 /** Habitat fractions from saturation and water access, not a replacement climate biome.
   8  * Bogs are rain-fed, relatively isolated peatland potential; river-fed wet ground
   9  * is a marsh, swamp or fen. Chemistry and accumulated peat are not simulated.
  10  */
  11 export function classifyWetlands(
  12   grid: Grid,
  13   terrain: Terrain,
```

### Current environment ends before resource generation

**Source:** `source/src/core/pipeline.ts:196–236`

```text
 196   const rivers = runStage('Headwaters & channels', () =>
 197     selectRivers(surfaceGrid, terrain, landWater, drainage, config),
 198   );
 199   runStage('River courses & deltas', () => {
 200     rivers.courses = buildRiverCourses(surfaceGrid, terrain, drainage, rivers, config);
 201     rivers.deltas = buildDeltas(surfaceGrid, terrain, drainage, rivers, config);
 202   });
 203   const ecology = runStage('Biomes & ecology', () =>
 204     classifyEcology(surfaceGrid, terrain, landWater, drainage, rivers, config),
 205   );
 206   const world: World = {
 207     version: VERSION,
 208     config: { ...config },
 209     grid: surfaceGrid,
 210     process: processGrid,
 211     transfer,
 212     geology,
 213     terrain,
 214     climate,
 215     water: landWater,
 216     drainage,
 217     rivers,
 218     ecology,
 219     timings,
 220     elapsed: 0,
 221     bytes: 0,
 222     sedimentExport,
 223   };
 224   runStage('Publish world', () => {
 225     world.bytes = collectWorldBuffers(world).reduce(
 226       (totalBytes, buffer) => totalBytes + buffer.byteLength,
 227       0,
 228     );
 229   });
 230   world.elapsed = performance.now() - generationStartedAt;
 231 
 232   return world;
 233 }
 234 
 235 /** Deduplicate shared geometry before transferring ownership or reporting retained bytes. */
 236 export function collectWorldBuffers(value: unknown): ArrayBuffer[] {
```

### Limits of geological reconstruction

**Source:** `worldbuilding_planet_generator_architecture_v2.md:410–418`

```text
 410 #### Model boundary
 411 
 412 Plate axes and speeds are prescribed and do not respond to forces. Initial patches move rigidly. Continents can separate along different initial carriers, but the solver does not create new plate identities or mechanically deform a plate interior.
 413 
 414 Overlap resolution is surface clipping plus a deformation proxy. It does **not** permanently consume a subducted patch, weld colliding continents, conserve a lithospheric mass/thickness budget, or reconstruct irreversible subduction. A reference patch can be exposed again after an overlap ends. New gap crust uses a local age approximation rather than a separate material mesh. Initial ages are synthetic.
 415 
 416 These limits matter for later mineral provenance. Current outputs describe generated environmental context; they are not validated histories of individual rock parcels. Future irreversible transfer should replace the overlap rule within this module and retain one terrain authority.
 417 
 418 Some coasts can remain smooth: a rigid rotation preserves an untouched margin. Wave erosion now runs in the later landscape stage (section 12.1). Deltas, glacial fjords, and changing sea level remain outside the model. Its goal is for continental arrangement and broad deformation to depend on motion through time, without imposing universal jaggedness.
```

### Volcanic fields are not stratigraphy or mineral provenance

**Source:** `worldbuilding_planet_generator_architecture_v2.md:484–488`

```text
 484 newVolcanic = carried + (10,000 m - carried)
 485                         × (1 - exp(-rate × dt / 10,000 m))
 486 ```
 487 
 488 `volcanicAge` increments with the carried material and resets where emplacement exceeds 5 m/Myr. Young large deposits resist the separate long-term erosion pass. These arrays describe accumulated construction and a recent-emplacement proxy, not lava stratigraphy, lithology, eruption hazards, or irreversible mineral provenance.
```

### Distinct sediment and outlet-export paths

**Source:** `worldbuilding_planet_generator_architecture_v2.md:1027–1037`

```text
1027 #### Infill and outlet incision
1028 
1029 Two complementary mechanisms are required. The first full-resolution trial showed that infill alone left too much lake area; adding a lake display threshold would have reintroduced the previously fixed disappearing-water problem.
1030 
1031 `sediment.ts` uses a temporary cell priority flood solely to deliver geological sediment. It is not a second river or water receiver forest. Connected depressions with a common escape height accumulate upstream detached material. A sorted height/area curve raises the floor from the bottom upward, limited by available material and the escape sill. Lake persistence controls the effective fraction retained as basin infill; the remainder represents bypass/unresolved downstream sediment export. Excess sediment is accounted for as export.
1032 
1033 `outlet-erosion.ts` uses `floodCorners`, the same geometric routine used by `drainage.ts`. For each flooded patch it finds the floor and escape anchor. A climate-, resistance-, duration-, and persistence-dependent incision budget determines how far its sill may lower. A shallow basin can get a complete escape; a deeper basin can retain a reduced water-storage depression.
1034 
1035 Before editing, it follows a complete parent path to lower ground or the ocean. The path must fit a 750 km length bound and the allowed cut depth, including the actual incident-cell elevations. It cuts all three incident cells where needed so the reconstructed corner surface genuinely opens. A tiny descending grade avoids replacing a lake with an exactly flat channel. Rejected paths leave the basin unchanged. Excavated volume is accounted for as unresolved downstream sediment export; grain classes are not modeled, and this geological outlet-excavation export does not feed the separate recent fluvial mouth fans.
1036 
1037 Final `routeWater` recomputes heights, priority flood, receivers, reservoirs, discharge, headwaters, and river-system metadata from the changed terrain. This preserves real river destinations and avoids treating an erosion-only path as authoritative water routing.
```

### Delta neighborhoods cannot be summed as a global budget

**Source:** `worldbuilding_planet_generator_architecture_v2.md:976–982`

```text
 976 ### 11.6 Sediment-supported deltas
 977 
 978 The erosion pass transports excavated volume and deposits some in local mouth fans (section 12.1). Final channels can form a delta when they carry at least 250 m³/s, reach a resolved lake or ocean, have slope at most 0.006, and have at least ten million cubic metres of nearby recorded mouth sediment. These numerical thresholds are worldbuilding parameters, not a geomorphic classification standard.
 979 
 980 `deltas.ts` searches a bounded wet neighborhood: at most 24 processed corners and 60 km reach. Two or three candidate branches remain in the same receiving body. An interior branch crossing land more than 35 m above receiving water is rejected. Lake branches end inside an explicit wet patch; ocean branches extend into an ocean cell. A fan with fewer than two valid branches is not labeled a delta.
 981 
 982 Two branches divide discharge 65%/35%; three divide it 55%/25%/20%. For each season and annual mean, `sum(Qbranch) = Qtrunk`. These branch records remain in generated data, but application v2.9.3 no longer draws their lines. The renderer keeps one trunk mouth and shades adjoining delta cells. The water solver still delivers the original total to its existing receiving body. These terminal fans do not model delta-lobe switching, tidal circulation, distributary hydraulics, or a braided interior network. Nearby deposit volumes can overlap between fan records and must not be summed as an independent global sediment budget.
```

### Habitat fractions, physical widths, and vegetation meaning

**Source:** `worldbuilding_planet_generator_architecture_v2.md:1150–1163`

```text
1150 #### Algorithm: localized vegetation and habitat
1151 
1152 At the channel edge, bank potential is the greater of background cover and `clamp((warmest−1)/14) × (0.75 + 0.24 × (1−exp(−S/5)))`. Thus available river water can raise dryland cover and also increase canopy potential in fertile regions. A bank whose warmest season is below 10°C or potential below 0.65 is meadow; otherwise it is woodland. Where at least two sampled seasons exceed bankfull, flood share exceeds 0.6, and stored soil water exceeds 100 mm, its local category is floodplain wetland. These thresholds are habitat heuristics, not species or succession models.
1153 
1154 Each bank contributes `L × bankWidth / cellArea` to local coverage. Overlapping reach fractions are summed and capped at one. The renderer retains a productive core over the first 30% of width, then fades using `1−smoothstep(0.3,1,distanceAcrossBank)`. The mean of this profile is `(1 + 0.3) / 2 = 0.65`; ecology uses the same lateral enhancement:
1155 
1156 ```text
1157 cellVegetation = background
1158   + max(0, averageBankPotential − background) × cappedBankFraction × 0.65
1159 ```
1160 
1161 `Floodplains` stores sparse selected-corner records with two widths, vegetation potentials, habitat IDs, and four seasonal overbank indices per reach. Cell `riparianFraction`, `riparian`, `riverHabitat`, and `floodplainFraction` summarize local habitat for inspection and future settlement rules. Regional `biome` remains separate. Rendering exaggerates physical bank width by 2.5 alongside the already exaggerated river, but reports coverage using physical widths.
1162 
1163 No atmospheric humidity increment, nutrient concentration, crop yield, additional AET, or irrigation water is invented. Water access, deposited sediment, and flood reach are habitat proxies. Explicit sediment nutrient delivery, lateral groundwater, water withdrawals, and daily flood chronology remain future extensions requiring additional budgets. Modern Mesopotamian greenness includes both natural marshes and irrigated farming; this pass represents natural habitat potential, not the agricultural footprint.
```

### Wetland potential and missing peat chemistry

**Source:** `worldbuilding_planet_generator_architecture_v2.md:1165–1180`

```text
1165 ### 12.4 Marshes, swamps, fens, and bogs
1166 
1167 `wetlands.ts` classifies local habitat potential after regional biomes and riverbanks. Ocean, permanent ice, fully resolved lake beds, and land without a thawed representative season are excluded. A flatness factor `1/(1+(slope/0.003)^2)` limits the influence of soil saturation and adjacent lake water. Humidity uses annual rain/PET; saturation uses the retained count of wet soil seasons.
1168 
1169 The local fraction is the maximum of 85% of flood-accessible area, nearby lake-shore influence, humid saturated flat ground, and low delta deposition with water access. Fractions below 2.5% are omitted and the retained fraction is capped at 85%. Classification follows this order:
1170 
1171 | Habitat | Implemented conditions | Interpretation |
1172 | --- | --- | --- |
1173 | Bog | Strong humid saturation, temperature below 16°C, little river/shore/delta access. | Isolated rain-fed peatland potential. |
1174 | Fen | Temperature below 14°C, at least two saturated seasons, river access and substantial slow soil release. | Mineral-water peatland potential using a subsurface-flow proxy. |
1175 | Swamp | Temperature above 12°C, high vegetation potential, at least three saturated seasons. | Potential woody wetland. |
1176 | Marsh | Other qualifying shallow wet ground. | Potential herbaceous wetland. |
1177 
1178 Peat accumulation, acidity, nutrient chemistry, salinity, and tree succession are not simulated. A Bog or Fen label therefore identifies favorable model conditions rather than proving those missing properties. Bogs are not a default category for every riverbank.
1179 
1180 Fresh deposited delta flats receive an additional bounded river-access credit: 2% of supported annual flow, shared among nearby deposited land cells and compared with local PET demand. It can support at most 45% local coverage and lift vegetation toward 0.8 within that fraction. As with existing bank vegetation, this is an access-potential calculation, not a new water withdrawal, evaporation flux, or rainfall source. Regional biome IDs remain unchanged; natural and biome views reveal local wetland cover within them.
```

### Current history boundary

**Source:** `worldbuilding_planet_generator_architecture_v2.md:1527–1547`

```text
1527 ## 16. Future civilizations and history
1528 
1529 This section describes the next architectural boundary, not implemented features. The new kinematic crust fields provide additional present-world context, but their overlap clipping and synthetic initial ages do not yet support strong claims about irreversible mineral provenance.
1530 
1531 The environmental `World` should remain the input to a separate history state. The first settlement model can read terrain, climate, water bodies, selected river systems, and bank access without changing the generator's receiver graph or using display width as physical evidence.
1532 
1533 | Existing input | Possible settlement use | Missing before stronger claims |
1534 | --- | --- | --- |
1535 | `Rivers.system` | Group sites along connected river systems and real lake spills. | Persistent identities across regeneration. |
1536 | Stream order and catchment area | Distinguish small branches from established trunks. | Channel depth, width, and navigability model. |
1537 | Annual/seasonal discharge and support flow | Coarse freshwater access and seasonal contrast. | Daily reliability, channel losses, salinity, water quality. |
1538 | Lake level, area, storage, and outflow | Shore access and terminal/shared-basin context. | Seasonal lake levels, salinity, water-use response. |
1539 | Source mixture and seasonal regime | Separate melt timing, rainfall dependence, slow release, and lake-buffered supply. | Actual aquifers, glacier mass balance, daily flow reliability. |
1540 | Wetland class/fraction and cutoff water depth | Identify local wet ground, peatland potential, and seasonal pools. | Peat chemistry, disease, resources, drainage costs. |
1541 | Mouth deposits and delta branches | Candidate lowland delta settlement context. | Salinity, storm surge, avulsion, navigability, channel engineering. |
1542 | Bank fraction, local habitat and overbank potential | Identify accessible corridors and seasonal flood exposure. | Nutrient budgets, crop yields, daily flood depth, actual irrigation demand. |
1543 | Terrain and climate | Basic slope, elevation, cold, heat, and rainfall constraints. | Travel costs, resources, disease, ecological succession, societal adaptation. |
1544 
1545 A small next implementation would add a separate civilization seed and time-indexed state, derive candidate settlement sites from these inputs, and connect sites using explicit travel costs. Scores should expose their component factors rather than imply that one annual discharge number predicts a successful city.
1546 
1547 If history later includes dams, extraction, canals, irrigation, or changed land cover, those actions need explicit water-budget and routing updates. A decorative river overlay or green bank strip must not silently become a hydraulic intervention. Annual snapshots also need a new persistence contract before they can represent historical continuity.
```

## 4. What is retained, removed, and deferred

**Retained from the previous resource proposal:** physical endowment versus capability/knowledge/use; correlated host context; district-scale sparse finite occurrences; independent family seeds; physical-area sampling; material-budget conservation; biomass versus timber; shared land allocation; separate historical persistence; C3-oriented explicit data and ownership.

**Removed from immediate prerequisites:** another crust/volcanism model, another landscape/sediment generator, a new river network, a new seasonality model, a resource-geology stage forced before terrain, and automatically adding dense fields for hypothetical future chemistry.

**Updated:** reference-frame hosts; accumulated volcanic context; surface access from the newer erosion/cover fields; alluvial/wetland resource area accounting; unique ownership beneath overlapping delta summaries; the distinction between plate, recent fluvial, and human time.

**Still new work:** material composition and lithology, mineral inventories/quality/access, biological stocks, explicit food-production suitability, discoveries, working operations, depletion, transport cost, and persistent civilization state.

**Deferred:** irreversible geological parcel histories, full stratigraphy, chemical/mineral transport, peat accumulation, aquifers, salinity dynamics, species succession, and fully coupled human hydraulic interventions.

## 5. Package use

Read the revised resource architecture (`worldbuilding_resource_architecture_v2_9.md` in the original bundle) alongside the current supplied environmental architecture (`worldbuilding_planet_generator_architecture_v2.md` in the original bundle). The original standalone HTML, all illustrations, and source remain present.

The new documents are an architectural integration proposal. They do not alter existing algorithms, report new timing measurements, or certify the scientific calibration of the source's approximations.
