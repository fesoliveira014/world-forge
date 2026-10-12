# World Forge — Resource Endowment and Civilization Foundations

**Status:** Proposed architecture extension; not implemented in the supplied source.  
**Baseline inspected:** Generator v2.4.1, source revision `daead72ec2fd3c2c80b59dff2f693497d7b36044`, as identified by `worldbuilding_architecture_illustrated.zip`.  
**Implementation direction:** Native C3 is the intended destination. TypeScript remains the executable prototype and a convenient place to validate generation behavior.  
**Scope:** Natural materials, mineral occurrences, biological production capacity, and the interfaces needed by a later history simulation. Not a new climate engine, full stratigraphic simulator, or complete economy.

## 1. Recommendation and decision boundary

Add a **resource-endowment layer** between the environmental generator and historical simulation. It should answer three questions separately:

1. **What exists?** Host rock, ore-bearing material, clay, woodland, productive land, and water-associated opportunities.
2. **What could a particular society use?** Access, mineral form, production capabilities, labor, energy, water, and transport.
3. **What does that society know or control?** Discoveries, workings, stocks, land use, ownership, and claims.

The first is generated geography. The second is an evaluation against a society and a date. The third belongs to mutable history state. Do not bake the last two into the natural resource map.

The next implementation should produce useful material geography and a small number of coherent resource districts, not a large catalogue of independently randomized resource icons. The first economic scenario should connect copper, tin, woodland/fuel, clay, building stone, salt, and food-growing potential. Gold and a small gemstone family can exercise the same sparse occurrence machinery after that foundation works.

### Requirements versus design assumptions

| Category | Statement |
| --- | --- |
| Explicit requirement | Resources should provide inputs to settlements, commerce, competition, and eventual civilization history. |
| Explicit requirement | The final architecture must fit C3 and remain small enough for solo development. |
| Verified baseline | The current system already has two grids, physical areas, one corner drainage authority, lake-aware river systems, and climate/ecological fields. |
| Verified gap | It does not contain lithology, mineral bodies, actual wood stock, agricultural yield, or resource discovery/depletion state. |
| Proposed simplification | Generate a shallow geological description and sparse mineral occurrences; do not simulate crustal chemistry or a 3D mineable volume. |
| Proposed first scenario | Use a preindustrial production catalogue. This is a test scenario, not a permanent restriction on the world's technology or history. |
| Unresolved tuning | Deposit frequency, tonnage, grade, woodland biomass, regeneration rates, and crop productivity coefficients require prototype tuning. The suggested architecture does not establish Earth-calibrated values. |

Resource distributions create opportunities and constraints. They do not determine that a settlement succeeds, a market forms, or a war happens.

## 2. What the current implementation can actually supply

The source integration notes in `SOURCE_INTEGRATION.md` record exact file paths and line ranges. These are observations of the uploaded version, not assumptions imported from older architecture reviews.

| Existing data | Reuse | Do not infer |
| --- | --- | --- |
| `Geology.plate`, `.continental`, `.boundary`, `.uplift`, `.volcanism` | Broad tectonic environment and some spatial context for inherited geological provinces. | A complete rock map, mineral concentrations, or historical ore-forming events. |
| `Geology.age` | Existing procedural age-like field. | Absolute crust chronology or an adequate map of ancient shields. The code generates a noise-derived value scaled by 220. |
| `Terrain.bedrock` | Bedrock **elevation**, in metres. | Rock type, hardness, granite, limestone, or underground reserves. |
| `Terrain.sediment` | Loose sediment thickness produced by the bounded erosion pass. | Sedimentary bedrock, a stratigraphic column, soil fertility, or a sediment provenance model. It is initialized to zero. |
| `LandWater.soil` | Soil-water storage, in mm. | Soil depth, texture, nutrient content, or agricultural productivity. |
| `LandWater` seasonal temperature/rain, AET and PET | Growing conditions, seasonal limitations, and an existing water-availability estimate. | A cultivated crop, food surplus, or irrigation entitlement. |
| `Ecology.biome`, `.vegetation` | Regional ecological classification and total vegetation potential. | Tree cover, harvestable stems, or cubic metres of timber. |
| `Ecology.riparian`, `.riparianFraction` | Bounded potential within accessible banks. | An additional full-cell forest or unallocated irrigation water. `.vegetation` already includes a bank contribution. |
| `Drainage.receiver`, `.order`, `.lakes` | The existing routes and actual lake terminations/spills. | A second independently calculated resource-transport network. |
| `Rivers.system`, `.supportFlow`, `.streamOrder` | Shared river-system context and annual channel-support proxies. | Stable IDs across regenerated meshes, guaranteed dry-season supply, navigability, or water quality. |
| `Lake.kind` | Closed versus spilling under the model's annual balance. | Salinity. Closed lakes are not automatically salt deposits. |

The existing document's section 16 already establishes the correct boundary: the environmental `World` is an input to separate history state. Keep that boundary. The old wording that a native port is merely optional is superseded by the user's current C3 direction.

## 3. A small initial resource catalogue

Organize resources by **production behavior**, not by one universal abundance number.

| Family | Initial natural endowments | Why include it | Representation |
| --- | --- | --- | --- |
| Food and basic livelihoods | Cultivable land potential, pasture/forage potential, freshwater access; fisheries potential later. | A mineral-rich region need not support a resident population. Food access is a prerequisite for the settlement model, including imported food. | Area fractions and suitability functions; not randomly placed farms. |
| Construction and ceramics | Limestone, sandstone, granite, basalt, slate, marble; clay, sand, gravel. | Different building traditions, extraction costs, bulk transport, and substitutions. | Dominant material fields plus sparse exceptional outcrops or high-quality stone occurrences. |
| Wood and fuel | Functional woodland groups, standing woody stock, merchantable fraction, regeneration potential. | Construction, fuel, and later industrial competition for the same landscape. | A few dense biological fields; history allocates actual harvest. |
| Metals | Copper and tin first; iron and gold next. Silver/lead can follow using the same framework. | Complementary supply chains, changing processing requirements, and geographically concentrated supply. | Sparse ore occurrences with physical inventories, mineral form, and access properties. |
| Decorative materials | A small crystalline gemstone family, such as gem corundum, plus ornamental stone; additional varieties later. | Scarce, quality-sensitive materials without needing a complete gemological model. | Sparse occurrences and material-quality traits, not an intrinsic price field. |
| Other strategic inputs | Salt and suitable saline/coastal processing locations; later obsidian, pigments, fibres, reeds, resin. | Alternatives to a metal-only account of trade and settlement. | Finite occurrences or environmental production opportunities, according to the material. |

**Charcoal, bronze, bricks, lime, boards, and finished gemstones are products, not geological deposits.** Their inputs may exist in the world, but their output requires production activity.

Do not initially generate oil, gas, uranium, a complete coal history, every gemstone, or a detailed species catalogue. Their later addition should be a new rule family or production profile, not a redesign.

### Geological inspiration, not hard placement laws

The following are deliberately incomplete generation presets based on documented associations. They specify plausible environments, not guarantees that every compatible region contains a resource.

| Resource / process family | Plausible template | Important qualification |
| --- | --- | --- |
| Copper-bearing systems | Selected intrusive/magmatic belts, plus a separate sediment-hosted template. | Copper is not exclusive to currently active mountains. USGS treats porphyry and sediment-hosted copper as distinct model families. [R1–R3] |
| Tin | Selected evolved granitic/intrusive districts, with source-related cassiterite placers. | A generic granite cell is not necessarily tin-bearing. Tin provinces should be a subset of suitable intrusive geology. [R4] |
| Iron-rich rock | Inherited iron-bearing sedimentary/metamorphic units; other ironstone templates can be added later. | Do not make current volcanism the sole source of iron. Old iron-formations are an important distinct setting. [R5] |
| Gold and placers | Gold-bearing source regions and, where suitable, downstream sediment concentrations. | A placer source may be diffuse mineralized rock rather than an economically mineable lode. [R6] |
| Ruby/sapphire-like gem corundum | Selected metamorphic host assemblages or appropriate magmatic-source provinces; resistant grains may form placers. | Not all metamorphic rocks or all basalts contain gems. Host compatibility and a rare mineralizing event are separate conditions. [R7] |
| Rock salt / brine | Inherited evaporitic geology or chemically supplied evaporative basins. | Present-day aridity or a closed drainage basin alone does not establish salt availability. [R8] |
| Obsidian, later | Suitable glass-forming volcanic composition and preservation. | Do not assign it to every volcano; USGS describes why silica-poor volcanism generally does not provide the same setting. [R9] |

All frequency, quality, tonnage, and access distributions remain fictional-world parameters until calibrated. Avoid copying modern production shares into an ancient-world resource map.

## 4. Extend geology just enough to explain resources

### 4.1 Add a geological substrate, not a second tectonics simulation

Introduce `ResourceGeology` as a complement to the existing broad geology. Its initial purpose is to describe material context. It must not silently reinterpret existing elevation fields as rock identity.

Use the process grid for broad provinces. A province is an area sharing a generated geological background, not a plate and not a political region. Several provinces can occur within one plate; inherited provinces need not follow present plate boundaries.

A compact first set of background templates is sufficient:

- Crystalline/intrusive basement.
- Inherited metamorphic belts.
- Siliciclastic sedimentary cover/basins.
- Carbonate sedimentary cover.
- Volcanic districts, distinguishing broad composition families where a resource needs it.
- Evaporitic sedimentary districts.

These are procedural heritage labels, not claims that the generator has reconstructed their true chronology. Use an enum such as `HeritageClass`, not invented radiometric ages.

### 4.2 Generation procedure

1. Seed a small number of broad background provinces on the process domain, using a separate deterministic stream and physical-size controls.
2. Grow or sample correlated regions using the existing graph/noise tools. Do not use independent cell rolls that produce lithological confetti.
3. Overlay compatible tectonic effects. Existing volcanism is a useful input. Where intrusive or metamorphic influence needs information that is currently lost, retain a small hint from the already classified boundary-source families in `geology.ts`.
4. Assign dominant host lithology through explicit table rules. A carbonate region overprinted by metamorphic influence may acquire marble; a siliciclastic region can retain sandstone or acquire slate-like/metamorphic material according to the chosen template.
5. Sample the substrate onto the surface grid and resolve superficial cover/exposure using final terrain, sediment, slope, and wetness proxies.

The rock-transform examples above are simplified generation rules. They do not substitute for pressure/temperature histories, sediment composition, or a geological column.

Avoid a new distance solve for every commodity. Intrusive, metamorphic, basin, and exposure context should be calculated once and reused by all compatible families. Prefer retaining needed hints during existing tectonic work over reconstructing them from the final uplift scalar.

### 4.3 Keep host rock, superficial cover, and ore separate

At one location the world may contain sandstone bedrock, a layer of alluvium, and a small mineral occurrence. One `resourceType[cell]` cannot represent that.

Use three levels:

```text
Dominant bedrock material
    + superficial cover / weathering context
    + zero or more localized resource occurrences
```

A mineral occurrence may describe a subcell host exception associated with its source district. At global resolution, a narrow vein does not need to replace the rock class of a 50 km-wide cell.

For the first release, sediment and slope are exposure hints. The current erosion module does not carry grain size or provenance; do not present a derived clay/gravel classification as an output of simulated particle sorting.

### 4.4 Do not couple this back into erosion yet

A lithology-dependent erodibility law is a plausible later improvement. It is not required to add resources. Initially, existing terrain generation and water budgets remain unchanged; the resource layer reads their outputs.

When material-dependent erosion is actually introduced, its owning stage must consume the substrate before erosion and the resulting surface exposure must be refreshed afterward. That should be a separate terrain change with its own visible effect, not an accidental side effect of adding a mineral catalogue.

## 5. Generate mineral districts, then localized occurrences

### 5.1 Why district-scale generation

An ore-bearing district is a spatial cluster of related occurrences. It supports both geographic coherence and economies of scale without a 3D geological simulation. It also avoids equating one enormous surface polygon with one physical orebody.

The hierarchy is:

```text
Permissive geological province
    -> occasional resource-bearing district
        -> a few localized occurrences / deposit zones
```

Resource richness should vary between provinces and districts. Suitable geology creates opportunity, not guaranteed supply. Do not force every continent to have every strategic material by default. An explicitly labelled scenario-balancing option can do that later without pretending to be natural generation.

### 5.2 Physical-area sampling

For resource family `f`, province `p`, and process cells `j`, compute a compatibility weight `S[f,j]` between zero and one. Define:

```text
eligible_area[p,f] = sum_j(area_km2[j] * S[f,j])
expected_districts[p,f] = density_per_km2[f] * eligible_area[p,f]
```

Sample a count from a Poisson distribution or an explicitly specified count distribution appropriate to the preset. Then choose district anchors from the corresponding area-weighted spatial distribution.

The design requirement is **frequency per physical area**, not a particular random-number algorithm. Counts, grade, and tonnage should not be rolled independently for every new surface cell.

Generate each district's handful of child anchors within its angular footprint. Use the district's host rules to retain spatial coherence; sample size/grade/depth jointly from a family profile where correlations matter. Start with bounded empirical distributions, not a universal lognormal claim for all deposit families.

Store a unit-sphere anchor, a physical footprint/radius, a stable ID, and a source district. A surface-cell index is only a lookup cache for the current mesh.

### 5.3 Reproducibility and resolution

Use independent deterministic keys:

```text
resource_seed = hash(world_seed, resource_version, resource_seed_offset)
province_key = stable generated province identity
site_key = (province_key, family, district_ordinal, site_ordinal)
```

Adding a gemstone family should not move the copper deposits. Changing the number of surface cells should not change the number, anchor positions, initial primary inventories, or assays of existing primary occurrences.

This guarantee assumes the same process definition, substrate rules, and resource configuration. Changing those creates a new geological/resource world. Fine-grid exposure, surface reachability, and secondary placer placement can change with terrain/drainage refinement and should be described accordingly.

Do not derive persistent IDs from floating-point position bits, the current surface-cell index, or a display list sorted by price. A 64-bit ID is natural in C3. In TypeScript, preserve it with `bigint` or a canonical hexadecimal string; do not round-trip it through an ordinary JSON number.

### 5.4 What an occurrence records

An occurrence is a generated natural feature, not a mine. A compact record needs:

| Field | Meaning |
| --- | --- |
| Stable ID, district, source/provenance | Identity and an explanation of why the occurrence exists. |
| Geographic anchor and footprint | A physical location independent of display resolution. |
| Family and host material | Which generation rule created it. |
| Mineral form | For example native material, oxide ore, sulfide ore, or placer material. |
| Initial material inventory | Finite amount of source material, in a declared unit such as tonnes of ore. |
| Assay / contained fraction | Commodity content per unit of source material. |
| Depth / cover class | A coarse access parameter, not a voxelized body. |
| Material workability | A small hardness/extraction-effort profile. |
| Natural exposure / visual clue strength | Whether early observation could reveal the occurrence. |
| Quality traits | For gems, usable crystal fraction and quality; for stone, block quality. |

Depth can initially be a nominal geometric-access parameter relative to a documented reference surface. Surface refinement may update exposure estimates without changing the stored mineral inventory. Do not claim that an unmodeled underground body has been physically excavated by the generator's one erosion pass.

Allow at most a few zones for a deposit when useful: shallow weathered material, deeper primary material, or a high-grade pocket. Each zone has a **disjoint** material inventory. This is enough to make technological change meaningful without a 3D mine.

For mixed ores, a zone's multiple products share one material inventory. Extracting copper and a silver by-product is not two independent mining operations against two copies of the ore.

### 5.5 What it explicitly does not record

Do not put `price`, `owner`, `discovered`, `technologyLevel`, `annualOutput`, or `remainingOre` into immutable geological truth.

Those are respectively market state, political state, society-specific knowledge, production capabilities, an activity result, and depletion state. An occurrence's initial material inventory is not automatically an economically recoverable reserve.

### 5.6 Small worked example: quantity is not early accessibility

The following is a fictional test fixture, not a geological measurement:

| Zone | Ore mass | Copper fraction | Access |
| --- | ---: | ---: | --- |
| Exposed weathered zone | 2,000 t | 0.04 | Small shallow working; compatible with a simple copper-ore processing profile. |
| Primary sulfide zone | 500,000 t | 0.008 | More difficult ore handling and deeper access. |

At 70% recovery, processing all of the first zone would yield at most `2,000 × 0.04 × 0.70 = 56 t` of copper, before considering labor, fuel, transport, or the rate at which it can be worked.

The second zone does not need to disappear during early history. It can exist, be partly known, and still contribute no production under the currently available processing and access methods. A richer or more technologically capable society can revisit the same occurrence later.

## 6. Secondary concentrations: reuse drainage, do not repaint rivers with gold

This is the first worthwhile extension after primary districts work. It supports placers and some alluvial material opportunities.

### 6.1 Source and transport are both necessary

A river is not gold-bearing merely because it is large. A source district can contribute resistant mineral material; erosion and hydraulic sorting can concentrate part of that material downstream. The source does not have to be an individually mineable lode. USGS describes a placer region where diffuse source-rock gold is relevant. [R6]

GIA similarly distinguishes primary corundum sources from secondary deposits created by erosion and transport. [R7] Do not apply one identical transport model to all gemstones; mineral durability differs.

### 6.2 First reduced-order algorithm

1. Assign each source district a bounded **inherited mobile-material budget** for an eligible placer family. This represents omitted long-term landscape history; it is not calculated by multiplying the current erosion pass by an invented geological duration.
2. Inject that finite budget at nearby source-draining corners.
3. Process the existing lake-aware downstream topology once, upstream to downstream, accumulating each family's remaining transported material.
4. Capture a fraction in plausible reaches according to a bounded trapping rule based on physical reach length, slope reduction, and available depositional setting. For a per-metre capture rate `k`, a useful form is `capture_fraction = 1 - exp(-k * reach_length_m)`.
5. Treat a lake as a depositional sink in the first version. Carrying material across a spilling lake can be added later with an explicit export fraction; do not assume that water outflow transports every sediment grain.
6. Merge nearby selected capture reaches into a few occurrence records. Record any unrepresented remainder as background sediment or named downstream export, rather than creating one mine per river edge.

A confluence or a slope change is a **candidate setting**, not a guaranteed placer. The topology need not resolve individual bars, meanders, or bedrock traps.

### 6.3 Avoid creating mineral mass twice

At initialization, a parent source budget is partitioned:

```text
initial source commodity
    = retained primary commodity
    + allocated secondary commodity
    + unrepresented dispersed/exported commodity
```

When the source is an ore-bearing zone, its retained inventory must reflect the chosen partition. When the source is diffuse background mineralization, record that separate source budget instead of inventing a mineable parent.

This is a resource-generation ledger. It does not claim that the existing sediment-volume solver tracks element mass. Ongoing geological replenishment should be zero on the initial history horizon unless a specific renewable source model is later introduced.

### 6.4 Reuse one graph, including lakes

`Drainage.order` alone is not a license to ignore reservoirs. The current river metadata builder constructs a temporary corner/lake graph that represents real spill connections. Factor that small construction into a shared helper when the placer pass needs it, or consume a retained view only during generation.

Do not introduce another Priority-Flood pass, route along visually exaggerated river widths, or run a downstream walk from every deposit to the sea. Batch families through one topological sweep, reusing scratch storage.

## 7. Woodland: potential cover, stock, products, and regeneration

### 7.1 Do not multiply current greenness by a global timber constant

The current `Ecology.vegetation` measures moisture-supported vegetation potential. Grass, shrubs, and a mature forest are not interchangeable wood supplies. Forestry terminology distinguishes woody biomass, merchantable stems, stock growth, and removals; use that separation as the conceptual model. [R10–R11]

Add a small set of **functional woodland groups**, such as conifer-dominated, temperate broadleaf, tropical broadleaf, dry woodland/scrub, and riparian woodland. These are procedural ecological profiles, not a claim that species evolution or migration was simulated.

Each group supplies a few traits: likely woody cover, reference biomass density, merchantable-stem fraction, a coarse growth timescale, and optional timber-use traits. Timber-use traits can include maximum stem-size class, straightness, workability, and durability. Do not make a universal hardwood-versus-softwood strength ranking.

### 7.2 Respect the existing bank model

The current final vegetation field already mixes background potential with accessible banks. Adding another riparian bonus to it would double-count those banks.

Either expose the existing background-potential calculation as a small helper in `ecology.ts`, or evaluate it once alongside woodland generation from AET/PET and the warmest seasonal temperature. Keep one owning formula, not two drifting copies.

Let `f_bank` be the existing bounded accessible bank fraction. A first total woody-capacity estimate can be:

```text
capacity_kg = area_m2 * (
    (1 - f_bank) * tree_fraction_background * density_background_kg_m2
  + f_bank       * tree_fraction_bank       * density_bank_kg_m2
)
```

The background and bank tree fractions are conditioned on their respective ecology profiles. They are not equal to generic greenness. Underwater/ice cells cannot acquire accessible woodland merely because an adjoining river is large.

This preserves the successful distinction between a narrow productive river corridor and an entire desert cell turning into forest.

### 7.3 The generator's outputs

Generate a capacity, an initial stock consistent with that capacity, a merchantable fraction, and a growth profile. Use one declared material basis—for example **dry above-ground woody kilograms**, excluding roots and foliage. A timber volume query can convert the relevant stem mass using the selected group's density.

The numbers are modeled potentials and stocks, not calibrated forest measurements. Do not label a growth coefficient as a guaranteed sustainable harvest.

### 7.4 The history system's accounting

Timber cutting and fuelwood collection draw from the same woody material. Charcoal production consumes harvested wood; it is not another independent natural stock.

A minimal biological update can use bounded relaxation toward habitat capacity:

```text
B_after_growth = K - (K - B_before_growth) * exp(-elapsed_years / recovery_years)
B_next = max(0, B_after_growth - actual_harvest)
```

This is a convenience model, not forestry science. It assumes local recruitment remains possible and no separate succession is required. Land conversion lowers the available habitat/capacity. A later stand-dynamics model can replace this function without changing ownership boundaries.

Before actively simulating timber extraction, track merchantable material as a subset with a slower recovery/maturation rule. Otherwise a harvested old-growth stand can incorrectly regrow ship-sized stems as soon as generic biomass returns. Two biomass pools are enough for this distinction; individual trees and age cohorts are not required now.

Harvest updates belong to active historical regions. Unused forest can remain at its initialized state or be advanced lazily when needed; a full-world vegetation simulation each history tick is unnecessary.

## 8. Building stone, clay, salt, soils, and other livelihood inputs

### 8.1 Construction materials: occurrences are not quarries

The geological model provides stone. A society chooses whether and where to quarry it. BGS's building-stone work treats geology, material identity, and source locations as useful linked information rather than a single generic stone category. [R12–R13]

A material profile can contain workability, density, likely block yield/fracturing, and weathering resistance. These are independent traits. The first catalogue may use family defaults with limited district-level variation; do not claim every granite or limestone has identical engineering properties.

Availability should depend on exposed area, cover, slope/access, and block quality. Rubble stone can be common while fine dimension stone remains geographically selective. A marble-bearing geological region is not a free finished monument.

For common bulk materials, do not create a finite stock for every square metre of bedrock. Store extent/accessibility and instantiate a bounded working inventory only when a historical quarry is opened. That inventory is a subdivision of the modeled natural occurrence or working footprint, not a replenishing source on every query. Exceptional building-stone sources can be explicit sparse occurrences from the start.

### 8.2 Clay, sand, and gravel

Assign a dominant superficial material and a small quality profile. Use parent-material context, weathering, and depositional proxies. Existing `sediment` thickness can inform cover, but it does not by itself distinguish clay from gravel.

A simple common-clay potential is useful for pottery and bricks. It must still be combined with temper/additives when required by the chosen recipe, fuel, labor, and a firing capability. Do not implement detailed clay mineral chemistry for the first production chain.

### 8.3 Salt: finite rock versus processing opportunity

Distinguish inherited rock-salt occurrences from locations suitable for obtaining salt from saline water. Coastal evaporative processing is an environmental opportunity whose production is constrained by area, energy/weather, technique, and labor. It is not an ore deposit with the same depletion law as copper.

Inland salt needs an explicit saline-source/evaporitic provenance assumption. Existing closed-lake classification does not supply salinity. The relation between brine recharge, dissolution, evaporation, and salt crusts is more conditional than "desert lake = salt". [R8]

Until a salt concentration model exists, label candidate inland locations `salt potential / salinity unresolved` or generate a declared inherited evaporite source. Do not simultaneously promise that the same unknown lake is potable water and a proven salt reserve.

### 8.4 Food-growing potential belongs in the first settlement interface

Do not postpone every food-related field until after rare metals. Add a modest soil/land profile: parent-material/texture class, approximate rooting-depth class, drainage limitation, potentially cultivable fraction, and a coarse flood-exposure flag. These are new heuristics, not quantities already present in `LandWater.soil`.

Evaluate a few crop or livelihood guilds against seasonal temperature/moisture and the soil/terrain profile—for example a cool-season grain, a drought-tolerant grain, and pasture. Use generic guild names until the scenario introduces species and domestication history. Suitability is not evidence that a crop has been domesticated, planted, or harvested.

FAO/IIASA's land-suitability approach separates the soil/terrain/climate inventory from crop requirements and management assumptions. That is the useful principle to borrow, not its global datasets or modern yield coefficients. [R14]

Store land capacity rather than a single universal `fertility -> population` number. Forest clearing, cultivation, grazing, and settlement compete for area; their allocations cannot all claim the same hectare at full output.

Irrigated potential remains conditional on an explicit future water allocation. Accessible green banks are not an additional unlimited water source. Fisheries, wild food, fibres, medicinal plants, and livestock habitat can follow using the same distinction between capacity, actual stock/production, and human knowledge.

## 9. Civilizations: access, discovery, production, and exchange

### 9.1 Natural facts should not encode an age ladder

Generate both easy and difficult occurrences. Evaluate extraction through capabilities such as surface collection, excavation depth, drainage/pumping, ore separation, suitable metal processing, quarry tooling, and transport.

Avoid `requiredTechnology = 4`. Different cultures can develop different combinations of capabilities, and geography may make the same technique economical in one place and unhelpful in another.

### 9.2 Production has bottlenecks, not just bonuses

A later activity can bound source-material throughput by:

```text
material_processed <= min(
    accessible_material_remaining,
    labor_capacity,
    tool_and_working_capacity,
    fuel_supported_capacity,
    water_supported_capacity,
    input_transport_capacity
)
```

For commodity `r` from one material zone:

```text
output_r = material_processed * contained_fraction_r * recovery_r
```

The recovery profile depends on material form and technique. Transport to the consuming settlement is evaluated after production as well. Do not subtract the full contained commodity from nature while also leaving it in a mine waste stock; allocate extraction products and waste once.

A small table of recipes/capabilities is sufficient. The first test chain can be:

```text
copper-bearing material + processing capability + fuel -> copper
cassiterite-bearing material + processing capability + fuel -> tin
copper + tin + alloying capability -> bronze product
wood + carbonization capability -> charcoal
clay + fuel + firing capability -> ceramics
```

These are abstract simulation relationships, not engineering recipes. Alloy proportions and recoveries are scenario parameters. Alternative copper alloys and other material substitutions can be introduced without relocating resources.

### 9.3 Discovery and knowledge

The omniscient authoring view can display all occurrences. A society must have its own knowledge state: unknown, clue/rumor, located, or roughly assessed. A single global `discovered` flag is insufficient once more than one society exists.

Exposure and material clues can affect discovery; knowledge can move through contact and trade. A society may know a deposit exists but lack the ability or incentive to work it. Estimates should not automatically reveal the generator's exact ore tonnage.

Store knowledge only for encountered occurrences, keyed by society and occurrence ID. No civilization-by-every-cell-by-every-resource matrix is needed.

### 9.4 Settlement opportunities, not resource-determined cities

Construct candidate sites from accessible riverbanks, confluences, usable lake shores, broad cultivable areas, coast access, and resource districts. A resource point and a settlement are distinct entities: a mine can be supplied from a valley town.

Evaluate viability before optional commercial advantages. Food and water may be locally supplied or imported, but a huge buried mineral body cannot numerically compensate for their absence in a new isolated settlement.

Keep component outputs such as local food potential, uncertain dry-season water access, construction materials, fuel supply, known extractable materials, travel cost, and hazard exposure. Score separately for a farming settlement, mining camp, trading stop, or port candidate rather than declaring one universal best city location.

The present resolution describes regional opportunity. It does not justify a precise harbor, defensible hilltop, ore adit, or field boundary. Store continuous candidate anchors with uncertainty/region scale; do not impose one civilization or one city per surface cell.

### 9.5 Transport and commerce

`Rivers.system` is useful for shared-basin context, not automatic boat travel. Actual navigability needs another model, including barriers and seasonality. For the first history prototype, overland travel can work with terrain costs; river/coastal transport can be a separately labelled capability and suitability model.

Use a modest graph of selected settlements, workings, crossings, and ports later. Run path searches on demand or in bounded local regions. Do not compute shortest paths from every surface cell to every resource before any society exists.

Geography gives the economy differentiated inputs. Prices and traded quantities arise from demand, production, transport, substitution, risk, and institutions. They do not belong in `World.resources`.

For a demonstration world, separate a copper district, a tin-bearing intrusive upland, a productive floodplain, a woodland/fuel region, and a salt source. This creates possible interdependence. It does not require those regions to become hostile; trade, migration, tribute, cooperation, or conflict are all compatible outcomes for the later history model.

## 10. State and ownership suitable for C3

### 10.1 Three lifetimes

```text
WorldDefinition
    generator version + full environment config
    resource version + resource seed + catalogue/config

World snapshot (immutable)
    existing environmental fields
    geological substrate and resource occurrences
    biological capacity and initial stock

HistoryState (mutable)
    extraction, land use, biological stock changes
    society knowledge, production sites, ownership/claims
    inventories, transport and markets
```

A resource definition is a physical baseline. History changes its use, not its initial identity. A mine and a quarry are historical activities attached to natural occurrences/working footprints.

### 10.2 Proposed data shapes

The following is a **C3-oriented layout sketch**, not compiled implementation code. The scalar widths and ownership are intentional; exact naming and syntax can follow the pinned C3 version used by the native project.

```c
struct MaterialFields
{
    char[] rock_type;          // U8 catalogue ID: dominant bedrock.
    char[] surface_material;   // U8 cover class, not geological bedrock.
    char[] exposure;           // Quantized 0..1 fraction/proxy.
    char[] block_quality;      // Quantized dimension-stone quality proxy.
}

struct BiologicalFields
{
    char[] wood_group;
    char[] tree_cover;
    char[] merchantable_share;
    char[] recovery_class;
    float[] woody_capacity_kg_m2; // Whole-cell areal density, includes cover fraction.
    float[] initial_woody_kg_m2;
}

struct LandPotentialFields
{
    char[] soil_profile;
    char[] rooting_depth_class;
    char[] drainage_class;
    char[] flood_potential;
    float[] cultivable_fraction;
}

struct OccurrenceZone
{
    ulong id;
    uint district;
    uint parent_occurrence;   // Sentinel where none; provenance, not a second inventory.
    double[3] position;       // Unit-sphere anchor.
    float footprint_m;
    float nominal_depth_m;
    double initial_material_t;
    ushort material_profile;
    ushort assay_profile;
    ushort quality_profile;
    ushort flags;
}

struct ResourceEndowment
{
    MaterialFields materials;
    BiologicalFields biology;
    LandPotentialFields land;
    OccurrenceZone[] occurrences;
    // Compact catalogue/profile arrays and process-cell spatial buckets.
}
```

The byte arrays above are intended as unsigned 8-bit catalogue IDs or quantized values. Pin and check the corresponding native type when implementing against the selected C3 version; this is not a compiled API. TypeScript uses `Uint8Array`, `Uint16Array`, `Uint32Array`, `Float32Array`, and `Float64Array` for the corresponding bulk data.

Use SoA for dense per-cell fields because generation visits a few arrays at a time. Compact records are fine for comparatively sparse deposits; an AoS record for these is not a rejection of the field-oriented design. A small assay/profile table can encode up to a few product fractions without strings or dynamic maps per occurrence.

Working `remaining_material_t` and knowledge records live in `HistoryState`, not in these immutable initial records. One shared remaining-material counter per working zone prevents by-products from duplicating ore inventory.

### 10.3 Readable function boundaries

```text
buildResourceGeology(process, geology, resourceConfig, scratch)
buildMaterials(surface, process, transfer, terrain, water, substrate)
generatePrimaryOccurrences(process, substrate, resourceConfig, scratch)
generateSecondaryOccurrences(environment, primarySources, scratch)
buildBiologicalEndowment(environment, materials, resourceConfig)
assembleResourceEndowment(...)
```

These are proposed ordinary functions. They need neither an ECS nor a generic resource plugin framework. In TypeScript, a catalogue can be a normal typed constant array; in C3, a constant array/struct table is sufficient. External modding formats are not a prerequisite.

### 10.4 Saving history is a stronger contract than saving a generator preset

The current UI saves `{version, config}` and regenerates on load. That is appropriate for the present generator, but not enough to attach a long history to changing resource algorithms.

Before history exists, add explicit resource algorithm/catalogue versions and stable occurrence IDs. When history saves are introduced, store either the environmental/resource baseline with the history or require a reproducibly pinned generator/catalogue version. The recommended default is a baseline snapshot plus mutable history state/deltas. It costs storage but avoids silently moving a mine under an existing town.

Do not reinterpret old history with current defaults. Mesh regeneration should invalidate derived cell/corner lookups unless explicitly remapped. Source-defined geography and entity IDs survive display-level changes; raw `Rivers.system` indices do not by themselves establish persistent identities.

Native serialization should write explicit fields and array blocks, not dump in-memory C3 structs whose padding and layout may change. This needs a small versioned format, not a generic schema migration platform.

## 11. Integration into the existing generation pipeline

### 11.1 Proposed stage insertion

```text
Simulation grid -> surface grid -> spatial transfer
    -> existing plates and tectonics
    -> NEW: resource geological substrate
    -> existing terrain/oceans
    -> existing provisional climate/water/drainage
    -> existing optional erosion and final climate/water/drainage
    -> existing headwaters/channels
    -> existing ecology
    -> NEW: resource endowment
         surface materials and land profiles
         primary occurrences
         optional secondary concentrations
         woody capacities and initial stocks
    -> publish immutable world
```

`buildResourceGeology` is inserted early to give inherited material context a clear home. In the initial implementation it does not change terrain erosion or climate. `buildResourceEndowment` consumes finalized hydrology/ecology. No new feedback loop is added.

The resulting public change is `World.resources: ResourceEndowment`, with configuration and version metadata. The existing buffer walker already traverses object fields and deduplicates typed-array buffers, so new typed arrays can participate without a separate resource-transfer mechanism. IDs represented as strings/metadata remain ordinary small message data.

### 11.2 Proposed file changes

| Existing/proposed path | Work | Boundary |
| --- | --- | --- |
| `src/core/model.ts` | Add resource config/version, endowment types, and the `World.resources` member. | Do not add mutable civilization ownership here. |
| `src/core/config.ts` | Expose a few resource controls and validate catalogue/config boundaries once. | No slider per mineral coefficient initially. |
| `src/core/generation/geology.ts` | Retain small existing feature hints only if substrate templates need them. | Do not redo tectonics or treat `.age` as ancient chronology. |
| `src/core/generation/resource-geology.ts` (new) | Province heritage, host materials, exposure context. | No 3D strata solver. |
| `src/core/generation/resource-catalog.ts` (new) | Small data tables for material profiles, occurrence families, wood groups. | No reflective plugin registry. |
| `src/core/generation/resources.ts` (new) | Sparse occurrence generation, ledgers, indexing, endowment assembly. | Split secondary concentration into its own file only when that pass is implemented. |
| `src/core/generation/woodlands.ts` (new) | Woody capacity, initial stock, and merchantable traits. | Future harvesting belongs to history. |
| `src/core/generation/ecology.ts` | Expose/reuse background potential if needed to avoid double-counting banks. | Existing biome and bank formulas retain their meaning. |
| `src/core/generation/rivers.ts` | Share temporary lake-aware topology with secondary-resource routing when needed. | Keep one drainage authority. |
| `src/core/pipeline.ts` | Call the new stages and include their timings/arrays. | Existing environmental stage order remains unchanged. |
| `src/render/palette.ts`, `src/app/Inspector.tsx`, controls | Material, woodland, occurrences, and explanation views. | Render immutable data; do not infer hidden deposits from color noise. |
| Project import/export in `src/app/WorldStudio.tsx` | Resource version/config now; baseline history persistence later. | Do not silently replay history on changed algorithms. |

A native counterpart can use a small `world::resources` module with `materials`, `deposits`, and `woodlands` implementation files. The generation core requires no new graphics or geology binding. Rendering can later use `gpu.c3l`; the mesh integration can use the chosen `c3cg.c3l` functionality without coupling resource semantics to either library.

### 11.3 Regeneration and worker behavior

Resource catalogue or abundance changes have no physical dependency on another climate solve. That does not mean partial regeneration already exists: the current worker transfers the finished snapshot, detaches its buffers, and terminates.

Initially, include the resource stages in full generation. If resource-only iteration becomes important, implement one explicit resource rebuild using a deliberately owned snapshot or a compact subset of environmental inputs. Do not transfer buffers away from the main thread while its renderer still uses them, and do not introduce a general job graph or a permanent worker pool merely for this feature.

A C3 generation thread can read an immutable environmental snapshot and publish a new endowment. Snapshot lifetime must cover the job; the application can swap the completed result at its normal publication boundary.

## 12. Performance and memory boundaries

### 12.1 Expected complexity

Let `M` be process cells, `N` surface cells, `D` sparse occurrences, and `P` the small number of secondary-mineral families.

| Work | Intended complexity / restriction |
| --- | --- |
| Province/material context | A fixed number of process-grid passes or bounded graph growths, usually O(M) or O(M log M). |
| Material and woodland fields | O(N), reusing existing transfer and local metrics. |
| Primary district selection | O(F M) for a fixed small family catalogue, plus weighted sampling and O(D) record creation. Prefix searches can make anchor selection O(D log M). |
| Occurrence lookup | Bucket by process cell in O(M + D); nearest-cell lookup reuses the existing mesh walk. |
| Secondary concentrations | O(P N) with a small constant and one lake-aware topology; no O(D N) per-source downstream walks. |
| One commodity overlay | O(N + local occurrence work) on demand; reuse one scalar GPU field where practical. |
| Future economic activity | Update active workings, knowledge entries, and managed biological regions rather than all goods at all cells. |

These are architectural cost targets, not measurements of new code. Do not call a predicted cost a measured bottleneck.

Avoid all-pairs deposit distance checks, a full flood per commodity, a new global hull, or recalculating atmospheric gradients in resource loops. Use physical area and distance so increasing surface detail neither multiplies occurrences nor shortens geologic influence widths.

### 12.2 Illustrative retained-memory allowance

The concrete dense-field sketch above totals **24 bytes per surface cell**:

| Fields | Bytes/cell |
| --- | ---: |
| Four material IDs/proxies | 4 |
| Four woodland IDs/fractions | 4 |
| Capacity and initial woody density, Float32 | 8 |
| Four soil/land classes | 4 |
| Cultivable fraction, Float32 | 4 |
| Total | 24 |

At `N = 655,362`, that is **15.0 MiB**. An additional **12 bytes per process cell** would be about **0.47 MiB** at `M = 40,962`. A planning allowance of **128 bytes per sparse occurrence** is **2.44 MiB for 20,000 occurrences**. The occurrence count and per-record allowance are examples, not selected world parameters or compiled `sizeof` results.

Thus a first static resource layer can plausibly remain in the tens of MiB rather than allocating one dense abundance array for every commodity. This is a layout estimate, not a measured implementation budget. Index arrays, catalogue records, history state, temporary memory, UI objects, and GPU copies are additional.

One reusable Float32 surface overlay costs about **2.5 MiB** at maximum detail. One Float64 scratch array over `2N−4` corners costs about **10 MiB**; reuse it between placer families and release it before publication. A second ledger accumulator may double that scratch, so do not retain every family simultaneously without a need.

Quantized bytes are sufficient for categorical IDs and heuristic 0–1 proxies. Keep inventories, cumulative material transfers, and totals in Float64. Quantization must not be used to hide unit confusion.

### 12.3 Preserve coarse/fine ownership

A process-level district is not a dense field of ore tonnage. Surface rasterization may show influence or probability, but exact finite inventory stays on occurrence records. Summing an influence overlay across cells must not be interpreted as summing ore.

For widespread biomass, use areal density and actual cell area. For deposits, keep a fixed inventory per occurrence. For a footprint split into subregions later, distribute a parent inventory among children instead of granting each child the full amount.

## 13. Inspection and controls

Add a few useful layers rather than a separate visualization subsystem:

| Layer / inspector view | Shows |
| --- | --- |
| Bedrock and cover | Dominant lithology, superficial material, exposure. |
| Material sources | Common clay/stone availability and selected exceptional outcrops. |
| Woodland | Woody capacity, initial stock, merchantable fraction, and bank contribution. |
| Mineral occurrences | Selected family, anchor/footprint, mineral form, nominal depth, initial inventory. |
| Geological explanation | Source province, host template, inheritance/tectonic hints, and any placer source. |
| Scenario access preview | A selected capability profile's usable material and stated limitations; not a permanent resource field. |

Default controls can be limited to resource seed, province scale, mineral-occurrence abundance, and a scenario/catalogue preset. Keep special coefficients in the typed catalogue until their tuning genuinely needs a user control.

The authoring view is omniscient by design. A later civilization view filters through that society's knowledge. A visible resource icon should not magically discover it for every society.

## 14. Implementation sequence and sufficient verification

### Milestone R1 — Usable material geography

Deliver host provinces, bedrock/cover types, common stone/clay availability, woody capacity/stock profiles, and a small land-suitability interface. Add inspectors that explain the contributing fields. Keep terrain/climate/hydrology unchanged.

This milestone should distinguish a green grassland from a timber-producing forest, a limestone region from a granite region, and accessible dry banks from submerged lake cells. No settlements are required yet.

### Milestone R2 — Sparse mineral endowment

Add copper and tin districts, then iron/gold as additional families. Include stable geographic IDs, mineral form, small disjoint access zones where useful, and a scenario access preview. The same framework can hold one gemstone family without a separate architecture.

The acceptance question is whether the world contains coherent and uneven supply opportunities, not whether every nation-sized area contains one icon of each type.

### Milestone R3 — Secondary materials and a resource-chain preview

Add one or two placer families using authoritative lake-aware drainage and a bounded material ledger. Add inherited salt occurrences or explicitly qualified salt-production opportunities. Demonstrate a copper/tin/fuel/clay/food supply-chain preview with no actors yet.

Keep this as an inspection query: "What could be produced here under this capability profile, and what input is missing?" It is not a global market-clearing solver.

### Milestone H0 — Minimal historical state

Only after the generated endowment behaves usefully, add society-specific discovery, a few settlements/workings, shared stock depletion, simple harvest recovery, and route-dependent exchange. Introduce a history save contract before recording long simulations.

Conflict, diplomacy, institutions, migration, and technological change should consume these conditions in their own later models. Resource generation should not directly emit historical events.

### Focused verification

Retain the existing environmental tests. Add a small number of fixtures at the owning boundaries:

1. **Stable primary endowment:** fixed substrate/process definition and resource seed retain primary IDs, anchors, and inventories when only surface detail changes; adding an unrelated family does not move existing deposits.
2. **Material accounting:** an ore-zone extraction plus by-products does not duplicate ore; primary/placer partition conserves the explicitly modeled commodity budget and terminates correctly at a closed lake.
3. **Biological accounting:** timber and fuel draw from one stock; bank area is not counted twice; submerged/ice cells do not receive terrestrial harvestable stock.
4. **Meaningful suitability:** a controlled host/woodland fixture yields the expected distinctions without asserting universal Earth resource proportions or one mandatory biome mix.

Catalogue/config validation belongs at load or generation boundaries. Do not repeat defensive checks in every already-validated neighbor iteration. Existing grid and water checks are not resource-layer responsibilities.

Use one retained representative world and one small controlled fixture for visual inspection. After implementation, add the new stages to existing timings and inspect retained/peak memory at a normal and a large surface resolution. No massive seed sweep, screenshot matrix, per-commodity benchmark suite, or hard-coded wall-clock test is required.

## 15. Explicitly deferred work

No new mantle model, advected geological history, full stratigraphy, underground voxel grid, groundwater solver, sediment-grain simulator, tree agents, crop domestication engine, daily ecology, general purpose economy, all-pairs route cache, or plugin scheduler is required for the resource milestone.

Future extensions that can reuse this design include rare regional timber species, additional ore families, crop diffusion/domestication, fisheries stock, land degradation, drainage-changing infrastructure, actual salinity, and industrial resources. They should be added when a historical behavior needs them, with the relevant owning model extended explicitly.

## 16. Proposed changes to the overall architecture

| Existing section | Proposed addition or clarification |
| --- | --- |
| 1. Architectural decisions | Add immutable natural endowment versus mutable historical use; add physical resource identity independent of surface cells. |
| 2. Runtime/module boundaries | Explicitly state C3 as the intended final platform; add the small resource modules. |
| 3. World identity/ownership | Add resource/catalogue version and seed; explain the stronger future history-save contract. |
| 4. Spatial support | Process provinces, surface material/biology fields, sparse geographic occurrences, and temporary drainage-based secondary transport. |
| 5. Pipeline | Insert resource geological substrate after broad geology and resource endowment after final ecology. No additional climate feedback. |
| 6. Geology/terrain | Add inherited host material; preserve the meaning of bedrock elevation and recent sediment thickness. |
| 12. Ecology | Add woody stock/capacity as distinct fields; retain background-versus-bank accounting. |
| 13–14. Presentation/controls | Add material, woodland, occurrence, provenance, and scenario-access views. |
| 15. Performance/verification | Add linear field passes, sparse inventory storage, reusable scratch, and four focused fixture groups. |
| 16. Future civilizations | Replace the resource gap with the endowment/history interface; keep navigability, water reliability, and production as explicit future models. |
| 18. Limits | Keep stock/yield coefficients and heritage templates labelled procedural, not validated geology/forestry/agronomy. |

The integrated proposal in the accompanying bundle preserves the implemented environmental description, marks the C3 policy change explicitly, replaces the short future-civilization outline with an extension pointer, and appends this proposed resource design. The source code remains unchanged.

## 17. Research references and their limited use

The sources below support geological/ecological distinctions. They do not establish the correctness of this generator, its numerical coefficients, its fictional reserve sizes, or its proposed runtime cost. Source-specific facts are paraphrased; all algorithms and software contracts above are design proposals unless identified as inspected baseline behavior.

- **[R1] USGS, Porphyry Copper Deposit Model (2010).** A primary model reference and catalogue starting point, not a mandate to implement all model variables. https://www.usgs.gov/publications/porphyry-copper-deposit-model
- **[R2] USGS, Undiscovered porphyry copper resources in the Urals (2017).** Supports permissive geological tracts associated with inherited magmatic belts. https://www.usgs.gov/publications/undiscovered-porphyry-copper-resources-urals-a-probabilistic-mineral-resource
- **[R3] USGS, Sediment-hosted copper deposits of the world (2003).** Supports a distinct copper family rather than one universal mountain rule. https://www.usgs.gov/publications/sediment-hosted-copper-deposits-world-deposit-models-and-database
- **[R4] USGS, Tin (2017).** Cassiterite, granitic associations, placer sources, and tin's role in copper alloys. https://www.usgs.gov/publications/tin
- **[R5] USGS, Bedded Precambrian iron deposits of the Tobacco Root Mountains.** An example of inherited iron-bearing geology separate from current volcanic activity. https://www.usgs.gov/publications/bedded-precambrian-iron-deposits-tobacco-root-mountains-southwestern-montana
- **[R6] USGS, Gold placers of the historical Fortymile River region, Alaska.** Supports the distinction between a mineralized source region and an individually mineable lode. https://www.usgs.gov/publications/gold-placers-historical-fortymile-river-region-alaska
- **[R7] Giuliani and Groat, GIA Gems & Gemology, Geology of Corundum and Emerald Gem Deposits: A Review (2019).** Primary/secondary deposit classifications and multiple host settings. https://www.gia.edu/gems-gemology/winter-2019-geology-of-corundum-and-emerald-gem-deposits
- **[R8] USGS, Hydrology and surface morphology of the Bonneville Salt Flats and Pilot Valley playa (1979).** Illustrates the role of brine/recharge/evaporation in salt crusts; not a world-scale salinity calibration. https://www.usgs.gov/publications/hydrology-and-surface-morphology-bonneville-salt-flats-and-pilot-valley-playa-utah
- **[R9] USGS, Volcano Watch — Obsidian, a scarce commodity in Hawaiʻi (2004).** Volcanism alone does not imply obsidian. https://www.usgs.gov/news/volcano-watch-obsidian-a-scarce-commodity-hawaii
- **[R10] FAO, Terminology in assessing and reporting forest carbon change.** Distinguishes biomass, growing stock, increment, and harvest/removals. https://www.fao.org/4/y4171e/Y4171E56.htm
- **[R11] FAO, Definition of the parameters and formulas used in the wood supply projection.** Distinguishes standing commercial stock and mean annual increment. No numerical growth rates from this historical report are adopted as generator defaults. https://www.fao.org/4/w7709e/w7709e04.htm
- **[R12] BGS, Building Stones Database for England.** Links building material types, geology, and source locations. https://www.bgs.ac.uk/mineralsuk/minerals/building-stones/building-stones-database-for-england/
- **[R13] BGS Earthwise, Building stones of Edinburgh: tests and properties.** Material suitability and durability are not reducible to one generic stone label. https://earthwise.bgs.ac.uk/index.php/Building_stones_of_Edinburgh%3A_tests_and_properties
- **[R14] FAO, World Agriculture: Towards 2015/2030, chapter 4, boxes 4.1–4.2.** Separates soil/terrain/climate conditions from crop requirements and management assumptions. Only that modeling distinction is adopted here. https://www.fao.org/4/y4252e/y4252e06.htm
