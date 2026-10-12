# World Forge — Minerals, Precious Stones, and Land Fertility

## A simplified extension to the existing world-generation architecture

**Status:** Proposed design; not implemented by this document.  
**Date:** 2026-09-07.  
**Environmental baseline:** Application **v2.9.4**, generator **v2.9.0**.  
**Baseline source revision:** `edb5ac85f11a281f5bc23bc0a7f989b583c5b75b`, as recorded in the supplied archive.  
**Implementation direction:** Native **C3**. TypeScript remains the executable environmental prototype and behavior reference.

> Add two outputs to the completed environmental world: **mineral and gemstone deposits with locations and amounts**, and **a simple land-fertility score**. Reuse the existing geological and environmental processes instead of introducing a second simulation.

This document consolidates the simplified resource model and explains its integration with the current architecture. It supersedes the earlier detailed mineral, soil, agricultural, and biological-budget proposals **as prerequisites for the first resource release**. Their additional detail is deferred, not an obligation to implement later. [1–3]

## Contents

1. [Purpose and scope](#1-purpose-and-scope)
2. [How this builds on the existing architecture](#2-how-this-builds-on-the-existing-architecture)
3. [The new pipeline stage](#3-the-new-pipeline-stage)
4. [Mineral and gemstone deposits](#4-mineral-and-gemstone-deposits)
5. [Geological placement and formation rules](#5-geological-placement-and-formation-rules)
6. [Generating locations and amounts](#6-generating-locations-and-amounts)
7. [Simple land fertility](#7-simple-land-fertility)
8. [Visualization and inspection](#8-visualization-and-inspection)
9. [Data ownership and C3 integration](#9-data-ownership-and-c3-integration)
10. [Performance and resolution](#10-performance-and-resolution)
11. [Next steps and sufficient verification](#11-next-steps-and-sufficient-verification)
12. [Deferred work and source basis](#12-deferred-work-and-source-basis)

---

## 1. Purpose and scope

The eventual history simulation needs geographically distinct opportunities: mineral-bearing uplands, productive valleys, less favorable dry regions, and resources that are not distributed evenly across every continent.

The first resource release should answer:

- **What occurs here?** The mineral or precious-stone type.
- **How much is present, and why here?** A finite amount and a geological explanation tag.
- **Where is the land more favorable?** An inspectable fertility score derived from existing environmental factors.

It does not yet need to answer how a mine operates, what a deposit is worth, which crop grows best, or how many people a region can support.

| Include now | Defer |
| --- | --- |
| Mineral/gem locations, simple geographic extents, finite amounts, and formation causes | Purity, concentration, mineral forms, underground geometry, depth/access zones, and processing recovery |
| Fertility from sediments, freshwater access, rainfall, and volcanic context | Soil layers, nutrient chemistry, crop/practice profiles, irrigation, and harvest prediction |
| Resource markers, numerical inspection, and a fertility heatmap | Discovery systems, extraction, markets, settlements, and historical depletion |
| One post-environment generation stage | New geological timelines, agricultural solvers, and per-resource transport simulations |

Common stone and wood availability remain useful follow-ups, but neither detailed forestry nor quarry accounting is a prerequisite for these two outputs. [1]

## 2. How this builds on the existing architecture

### 2.1 Preserve the environmental foundation

The supplied generator already contains a process grid for broad geology and climate, a detailed surface grid, prescribed crust evolution, volcanic construction, landscape weathering, sediment redistribution, seasonal climate, lake-aware drainage, river courses, and local ecological habitats.

The new layer **interprets that completed world**. It does not replace the mechanisms that produced it. The existing separation between headless generation, application lifecycle, and rendering remains intact. [4]

### 2.2 Reuse existing fields with their existing meanings

The following field names were checked against `source/src/core/model.ts` in the revised supplied archive. They are inputs, not new resource fields. [4]

| Existing data | Use in this extension | Meaning to preserve |
| --- | --- | --- |
| `World.process`, `World.grid`, `World.transfer` | Broad resource placement, detailed fertility, and mapping between the two | Surface detail and process resolution remain distinct |
| `Geology.plate`, `.continental`, `.boundary`, `.volcanism` | Broad continental, boundary, and magmatic context | A plate or present boundary is not automatically a mineral-bearing region |
| `Geology.crust.deformation`, `.volcanic`, `.volcanicAge` | Inherited deformation, accumulated volcanic construction, and recent-emplacement context | These are geometric/contextual proxies, not composition or mineral-formation dates |
| `Geology.crust.initialPlate`, `.inverse`, `.material` | Sample coherent inherited presets in the same reference frame as the selected crust | `material` is a retained-reference/opened-ocean flag, not a rock type |
| `Terrain.height`, `.sediment`, `.deltaSediment` | Ground setting, deposited lowlands, and sediment benefit | Sediment thickness does not establish chemistry; mouth deposits are not additional independent material to count twice |
| `Terrain.surfaceChange`, `.fluvialIncision` | Context for landscape modification or exposure where useful | Net change and gross recent lowering are different; neither is a mineral inventory |
| `LandWater.rain`, `.pet`, `.temperature`, `.saturatedSeasons` | Rain suitability, existing evaporative demand, cold limitation, and persistent wetness | Soil-water and climate fields do not become a new agricultural model |
| `Rivers.supportFlow`, `.seasonalDischarge`, and existing lake/shore information | Local freshwater-access potential | Four-season supply is not proof of daily reliability or measured water chemistry |
| `Ecology.floodplains`, `.riparianFraction`, `.floodplainFraction`, `.wetlandFraction`, `.ice` | Physical local reach and basic land limitations | Habitat fractions may overlap; display width does not increase physical area |

The current source has **no mineral inventory or fertility field**. Those are the additions proposed here.

### 2.3 Add presets only where information is missing

The environmental model does not retain enough composition or ancient depositional information to infer every mineral setting uniquely. Use a few broad, spatially coherent seeded eligibility presets where needed—for example, a selected intrusive setting for tin or an inherited sedimentary setting for iron.

These presets are procedural assumptions, not results of simulated chemistry. They do not require a full lithology atlas, stratigraphic column, or public hierarchy of province and district objects.

### 2.4 What must remain unchanged

Enabling resources must not alter the existing terrain, climate, water budgets, drainage receivers, river courses, or accepted lake/bank/delta geometry. It adds data and inspection layers only.

The water graph remains authoritative. No resource-specific Priority-Flood, climate pass, or alternative river network is introduced. [1, 4]

## 3. The new pipeline stage

Insert resources **after final ecology and before world publication**:

```text
Existing process/surface grids and transfer
    → plates and initial geology
    → optional crust evolution and volcanic construction
    → terrain and oceans
    → provisional climate and land water
    → existing landscape weathering and sediment work
    → drainage and reservoirs
    → existing recent river shaping and final feedback, when enabled
    → final channels, river courses, and deltas
    → biomes, floodplains, and wetlands
    → NEW: mineral/gem deposits and land fertility
    → publish completed world
```

This summarizes the existing conditional pipeline; it does not make optional environmental passes mandatory. The actual insertion point is immediately after `classifyEcology` and before `Publish world` in `src/core/pipeline.ts`. [4]

The two calculations inside the new stage are ordinary functions:

```text
resources.deposits  = generate_deposits(environment, resource_settings)
resources.fertility = generate_fertility(environment, fertility_settings)
```

These are proposed responsibilities, not existing or compiled APIs. They read the completed environmental state and allocate only their own results and temporary working data.

## 4. Mineral and gemstone deposits

### 4.1 One record for both

```text
Deposit
    id
    resource_type
    anchor_on_sphere
    extent_km
    amount
    formation_cause
```

| Field | Meaning |
| --- | --- |
| `id` | Stable identity within a fixed environmental baseline and resource recipe |
| `resource_type` | Copper, tin, iron, gold, ruby, sapphire, or another enabled type |
| `anchor_on_sphere` | Geographic position as a unit vector; a surface-cell index is a derived lookup |
| `extent_km` | Simple geographic extent, independent of marker size and mineral concentration |
| `amount` | Finite quantity in abstract units of this resource |
| `formation_cause` | The placement rule that explains the occurrence |

Use **deposit** as the umbrella term for veins, broader bodies, and gemstone occurrences. A vein can initially be shown as a marker or patch. No subsurface geometry is required. [2]

### 4.2 Amount means quantity, not quality

An example inspector entry is:

```text
Resource: Copper
Amount: 24,000 units
Extent: 8 km
Formation: Magmatic / hydrothermal (procedural)
```

The number is not ore tonnage, concentration, purity, price, or estimated recoverable metal. Abstract units allow the world to contain explicit finite quantities before those distinctions are modeled.

Precious stones use exactly the same representation. Clarity, cut, crystal size, and gem-quality fractions remain deferred. Amounts can be compared within a resource type; equal quantities of different resources do not imply equal economic value.

### 4.3 Separate frequency from amount

Occurrence frequency controls **how often deposits appear**. A type-specific amount preset with bounded seeded variation controls **how much each contains**.

Suitability should not automatically select the largest quantity. A rare type may have an occasional large deposit, and a favorable region may contain several modest ones. The distribution and amount ranges remain tuning choices.

Sample each amount once when its deposit is generated. Do not derive it from the number of intersected cells or the apparent size of a marker.

## 5. Geological placement and formation rules

### 5.1 A small rule table

The following are the broad associations already selected in the simplified mineral design. They are permissive worldbuilding presets, not claims that the generator simulates the underlying chemical processes. [2]

| Formation cause | Suggested resources | Initial placement approximation |
| --- | --- | --- |
| **Magmatic / hydrothermal activity** | Copper and some gold | Favor selected magmatic regions with suitable fracture context; approximate mineral-bearing fluid deposition with a rule |
| **Selected intrusive cooling** | Tin | Use a rare, coherent granite-compatible preset within continental magmatic context; do not assign tin to every volcano |
| **Mountain building / metamorphic context** | Some gold and ruby/sapphire occurrences | Favor selected compressed or inherited deformation belts with a compatible preset; elevation alone is insufficient |
| **Inherited sedimentary mineralization** | Iron; selected copper later | Seed inherited continental/reference settings independently of present volcanic boundaries; do not treat modern loose sediment as ancient mineralized rock |
| **Selected volcanic gemstone setting** | Sapphire | Allow rare compatible volcanic-source settings, potentially representing emplacement of gem-bearing material |
| **Erosion and redeposition — optional later** | Gold, tin, ruby/sapphire | Relocate part of an existing amount into a downstream occurrence rather than creating mineral merely because a river exists |

Start with **copper, tin, iron, gold, and one ruby/sapphire family** as a proposed small palette. Exact enabled types remain to be selected. A resource may have multiple permitted causes, while most compatible locations still contain no deposit.

### 5.2 Formation, exposure, and redistribution

Keep three behaviors conceptually distinct:

- **Formation:** a geological setting permits a new generated deposit.
- **Exposure:** landscape change reveals existing material; it does not increase its amount.
- **Redistribution:** some existing amount is moved to another occurrence.

This distinction requires no new access model. It simply prevents erosion from becoming a universal mineral source.

If secondary deposits are later added, partition an amount between its source and destination. Do not retain the full source quantity and create a second full copy downstream. Detailed particle transport remains unnecessary for the initial release.

### 5.3 Interpret geological history retrospectively first

Generate deposits once from the completed environmental context. `formation_cause` explains the rule used; it does **not** identify an exact dated mineral-forming event.

The retained crust and volcanic fields do not record every unique episode or an irreversible history of rock parcels. This release therefore does not place resource generation inside every tectonic step. [2, 4]

Later, a coherent geological episode could call the same creation routine near its affected region. Such an extension must be tied to an episode or physical duration/activity, not a fixed new chance at every numerical step. Changing the step count must not become an abundance control.

Redrawing the map, changing the selected overlay, or advancing civilization time must not generate new veins.

## 6. Generating locations and amounts

### 6.1 Placement sequence

1. Read existing process-grid geological context and the relevant retained reference state.
2. Build temporary suitability weights for one resource, adding a coherent eligibility preset only where needed.
3. Select a modest number of regional anchors using suitability weighted by physical cell area.
4. Place a few nearby deposits at physical distances and assign each its type, extent, amount, and cause.
5. Repeat for the small palette, then map the resulting anchors to the detailed surface for inspection.

Regional seeds create clusters without requiring a persistent district subsystem. Reuse one temporary suitability array across resource types. Do not draw an independent deposit lottery on every surface cell. [2]

### 6.2 Physical scale and reference frames

Use area-weighted eligibility:

```text
eligible_area = sum(process_cell_area × resource_suitability)
```

Frequency settings operate on eligible physical area. Cluster spacing and deposit extents use kilometres, not graph-hop counts.

Where an inherited preset follows crust, sample it through the existing selected carrier and reference lookup. Do not repeat the all-plate reconstruction. In the zero-duration branch, current and reference coordinates coincide; no `CrustHistory` object is required.

### 6.3 Reproducibility boundary

Use independent resource-family seeds. Adding a gemstone type should not relocate established copper deposits.

With the **process inputs and resource recipe fixed**, surface-only refinement must not multiply primary deposits or change their stored amounts. Fine surface lookups and presentation can change. Changing geological duration, process resolution, or the resource recipe changes the baseline and is outside this guarantee.

Keep primary eligibility and inventory decisions independent of fine-mesh sampling; otherwise the same resolution dependence would return through a later filtering step. This is an integration consequence of the agreed stability requirement, not a new simulation.

## 7. Simple land fertility

### 7.1 One score

Store one value per surface cell:

```text
fertility: 0–100
```

Label it **Fertility — general land potential**. It combines favorable ground and growing conditions for a soft worldbuilding simulation. It is not measured nutrient content, crop-specific yield, an existing farm, or population capacity. [3]

### 7.2 Four contributors

| Factor | Starting response | Existing evidence |
| --- | --- | --- |
| **Sediment benefit** | Deposited/alluvial lowlands receive a capped benefit; more thickness does not help indefinitely | Final sediment, mouth-deposition context, terrain, and floodplain setting |
| **Freshwater access** | Supported rivers and suitable inland shores help nearby accessible land; benefit weakens outside that reach | Physical bank/floodplain footprints, river support, shores, and terrain |
| **Rain suitability** | Very dry ground scores poorly; adequate moisture helps; the response then plateaus | Annual rain and, where useful, existing PET/aridity |
| **Volcanic benefit** | Established volcanic surroundings can receive a modest benefit; fresh substantial emplacement does not immediately help | Accumulated construction, recent-emplacement context, climate, and cover |

These are deliberately coarse relationships. Sediment is unclassified, volcanic context does not supply soil chemistry, and the sources do not establish exact response curves or thresholds. Keep those as tunable presets rather than adding the previous soil model. [3]

**Sediment:** apply the benefit once. `deltaSediment` can identify mouth deposits, but must not be added as another independent thickness on top of the same recorded `sediment`. A baseline ground value allows productive land without recent modeled deposition.

**Fresh water:** prefer the existing physical riverbank/floodplain reach. A nearby ridge should not receive a full benefit simply because its straight-line distance to water is short. Use a bounded terrain-aware shore lookup only where existing information is insufficient. Ocean proximity provides no freshwater credit.

The baseline has no salinity solver. Eligible inland water is **assumed fresh for this preview** unless excluded by a scenario; that is not a chemical result or a water withdrawal.

**Rain:** reuse the existing evaporative-demand information when interpreting how adequate rainfall is. Persistent saturation can supply a mild penalty, without making all high-rainfall regions poor or introducing nutrient-leaching simulation.

**Volcanism:** distinguish established ground from fresh substantial cover. A simple age/cover factor can suppress the immediate bonus and allow it later. `volcanicAge` is a broad emplacement proxy, not a precise soil-development clock. No ash-dispersal or additional weathering solver is required.

### 7.3 Provisional combination rule

Normalize the four contributors to `[0,1]`:

```text
S = sediment benefit
W = freshwater access
R = rain suitability
V = volcanic benefit

ground = clamp01(0.35 + 0.40 × S + 0.25 × V)
water = 1 − (1 − R) × (1 − W)
fertility = 100 × ground × water × suitability
```

The weights are **provisional artistic parameters**, not scientific constants. `suitability` is a simple existing-context limiter in `[0,1]`: zero on standing water and permanent ice, reduced for strongly cold, steep, persistently waterlogged, or freshly barren ground.

The nonzero baseline permits moderate rainfed potential without recent alluvium or volcanism. The water term lets local freshwater compensate for low rainfall, caps combined water benefits, and prevents dry material-rich ground from scoring highly on material alone.

For illustration, a local corridor with `S=1`, `V=0`, `R=0.1`, `W=0.95`, and `suitability=1` receives approximately **72/100**. These are hypothetical inputs demonstrating the formula, not measured environmental values.

### 7.4 Preserve local river corridors without land parcels

A narrow fertile corridor must not turn its entire large cell into excellent farmland. Scale local river/depositional enhancement by the existing physical coverage when forming the representative cell score.

The inspector may also evaluate the same rule for the local corridor. This permits “high local bank potential, dry surrounding region” without storing subcell land-unit objects.

Use a capped shared envelope where habitat summaries overlap, not their unbounded sum. Do not infer physical area from exaggerated rendered bank widths or add another vegetation-based river bonus. [3]

### 7.5 Expected qualitative results

| Landscape | Intended result |
| --- | --- |
| Dry plain far from water | Low even when sediment is present |
| Desert river with deposited lowland banks | High local corridor potential; low surrounding potential |
| Rainfed temperate ground without recent deposition | Moderate potential from baseline ground and sufficient moisture |
| Established volcanic foothills with adequate moisture | Higher than otherwise comparable ground |
| Fresh substantial volcanic cover | Low initial potential rather than an immediate maximum |
| Steep cold mountain or persistently flooded ground | Limited general land potential despite other benefits |

These are visual tuning targets, not a demand for an agricultural test suite.

## 8. Visualization and inspection

### 8.1 Deposits

Provide a resource-type selector and deposit markers on the existing globe and flat-map views. Selecting a deposit shows its type, numerical amount, extent, and formation cause.

Marker size may encode amount using a fixed legend. Show geographic extent separately. A regional summary sums each deposit once; a deposit crossing several cells still owns only one amount.

A selected-resource amount heatmap is optional. If it distributes quantities into display cells, its shares must sum to the stored quantity. It is not a concentration map, and its display values are not additional inventory. [1, 2]

### 8.2 Fertility

Provide a fixed `0–100` heatmap and an inspector breakdown of sediment, freshwater access, rainfall, volcanic benefit, and major limitations.

Use the same evaluation helpers for generation and explanation. The inspector must not invent a plausible reason after calculating a score by a different rule.

Compute factor breakdowns on selection or in reusable scratch. Retain only the fertility result by default. Existing natural terrain and water presentation remain unchanged; these are additional diagnostic views. [3]

## 9. Data ownership and C3 integration

### 9.1 Minimal retained state

```text
World
    existing environmental fields
    resources
        Deposit[] deposits
        float32[] fertility
```

`amount` belongs to its deposit; fertility is a surface-cell field. Existing water, sediment, and habitat arrays are borrowed inputs rather than duplicated resource data.

This is a language-neutral contract. In C3, use an ordinary array of deposit structs, an enum or integer for resource/cause IDs, a flat fertility array, and explicit persistent/scratch allocation. No object hierarchy, dynamic property framework, or C3 compiler-version decision is required by this document.

### 9.2 Small source changes when implementation begins

| Responsibility | Proposed change |
| --- | --- |
| `src/core/model.ts` | Add `Deposit`, resource result types, and `World.resources` |
| `src/core/generation/resources.ts` | Own deposit generation and fertility evaluation; split only when readability requires it |
| Configuration/presets | Hold the small palette, eligibility/frequency settings, amount ranges, and fertility response parameters |
| `src/core/pipeline.ts` | Add one stage after ecology; update stage count and publish the result |
| Existing render/inspection adapters | Add resource markers, optional amount view, fertility heatmap, and factor inspection |
| Existing project metadata | Record the resource recipe identity when resource generation is introduced |

Names for new code are proposals. Existing paths and the publication sequence come from the supplied source. [4]

### 9.3 History stays downstream

The generated amounts are initial endowment. Later history can own remaining quantities and resource use against a frozen baseline. Regenerating geology creates another world baseline; it must not replenish an ongoing mine.

Fertility does not consume water, generate a harvest, or imply a settlement. Those uses remain future consumers, not reasons to add an economy now. [1, 2]

## 10. Performance and resolution

Let `M` be process cells, `N` surface cells, `K` the small resource palette, and `D` generated deposits.

| Work | Intended scale |
| --- | --- |
| Geological eligibility | `K` process-grid passes, reusing scratch |
| Regional/deposit sampling | Sparse placement with bounded local work; no whole-world scan per deposit |
| Fertility | One or a few surface passes with existing metrics and bounded lookups |
| Markers | Work proportional to displayed deposits |
| Optional diagnostic overlays | Generate only the selected view, reusing its buffer |

The intended core is approximately `O(KM + N + D)` when per-anchor/local work is bounded. Additional spatial lookups or overlay rasterization have their own costs. This is a design target, **not a measured runtime claim**.

A Float32 fertility array at 655,362 cells uses **2,621,448 bytes**, approximately **2.5 MiB**. One optional Float32 surface overlay costs the same. Sparse deposits, indices, scratch, and GPU copies are additional.

The existing browser buffer collector will include added typed arrays. It does not make JavaScript object overhead disappear; reported typed-buffer bytes should not be presented as total memory for an object-based deposit catalogue. C3 struct sizes should be measured after a concrete layout exists. [4]

Do not add per-mineral full-resolution arrays, another all-plate reconstruction, climate reruns, per-deposit river traversals, or GPU compute before a measured need exists.

## 11. Next steps and sufficient verification

The reduced R1 outcome is: **inspect plausible mineral/gem geography, see explicit amounts, and understand the fertility map**. The earlier detailed R1 task descriptions must not silently reintroduce deferred requirements. [5]

First settle the proposed palette, abstract amount ranges, and broad placement presets. Keep the fertility formula as a starting sketch; its factor curves and weights remain open for visual tuning.

When implementation starts, use three slices:

1. Generate and inspect deposits with type, location, cause, and amount.
2. Add the fertility heatmap and its contributor breakdown.
3. Integrate publication, recipe identity, and existing stage timing/storage reporting.

Keep existing environmental checks. Add only focused evidence for this layer: deterministic primary locations/amounts under fixed-process surface refinement; bounded fertility and water/ice exclusions; and a dry-region versus river-corridor comparison. Inspect one representative world and record actual added time and memory.

No source implementation, build, generator run, benchmark, or new test execution was performed to write this document.

## 12. Deferred work and source basis

### 12.1 Deferred, not hidden prerequisites

Purity, concentration, access zones, mineral quality, processing, extraction, discovery, prices, detailed geological event tracking, soil profiles, nutrient budgets, crops, irrigation, land allocation, forestry recovery, and civilization mechanics remain outside this release. Secondary deposits are an optional later extension.

The durable starting point is deliberately small:

```text
Existing geological context → deposits and finite amounts
Existing environmental context → explainable fertility
```

### 12.2 Source precedence

This document follows the user's simplified scope and the current simplified Notion chapters. The recorded environmental baseline is the revised archive, not the initial prototype.

`ARCHITECTURE_CHANGES.md` describes earlier work through `f3b8cbc`. Its old deferred-feature list and descriptions of circulation/drainage must not replace the v2.9-based architecture. The earlier detailed resource/soil drafts likewise remain background ideas rather than current prerequisites.

### 12.3 Project references

**[1] [04 Resource endowment — simplified starting model](https://app.notion.com/p/3d4cb7903a588131ad39c1c1b00b75bc).** Scope, downstream integration, minimal outputs, and deferrals.

**[2] [04.1 Mineral placement, formation triggers & amounts](https://app.notion.com/p/3d4cb7903a588162bcdcc90ab470bc3f).** Deposit contract, procedural associations, quantities, retrospective formation, and display rules.

**[3] [04.3 Simple land fertility](https://app.notion.com/p/3d4cb7903a58815abbc1c8b11de4eef2).** Four factors, provisional formula, physical corridor coverage, assumptions, and limits.

**[4] Revised supplied archive: `worldbuilding_architecture_illustrated(1).zip`.** The root illustrated architecture and `SOURCE_REVISION.txt` establish the recorded baseline. `source/src/core/model.ts:119–310` and `source/src/core/pipeline.ts` were inspected for current fields and the insertion point. The archive is supplied separately; this Markdown does not embed the source.

**[5] [R1 — revised scope](https://app.notion.com/p/3d4cb7903a5881e0a37ef7da49a89e76).** Reduced milestone outcome and implementation boundary, as recorded in the preceding project discussion.

The geological and fertility relationships are carried forward from the simplified project sources, which contain their research references. This is an architecture consolidation, not new external research or scientific validation. Numerical abundance, response curves, and fertility weights remain provisional.
