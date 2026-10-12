# World Forge — Resource Endowment on the Revised Geological Baseline

**Status:** Revised next-step architecture; resource code is not implemented by this document.  
**Environmental baseline:** Application **v2.9.4**, generator **v2.9.0**.  
**Source revision recorded in the supplied bundle:** `edb5ac85f11a281f5bc23bc0a7f989b583c5b75b`.  
**Intended implementation:** Native **C3**; the supplied TypeScript core remains the behavior reference.  
**Input:** `worldbuilding_architecture_illustrated(1).zip`.  
**Supersedes:** The v2.4.1 environmental assumptions and stage-insertion plan in the previous resource proposal. The distinction between natural endowment, societal capability, and historical knowledge/use is retained.

## 1. The revised decision

**Build material and resource interpretation on the existing geological reconstruction and landscape stages. Do not create another geology, volcanism, weathering, or drainage simulation for resources.**

The revised generator already moves reference crust, constructs volcanic relief, ages landscapes, supplies and deposits sediment, incises real outlets, resolves river systems and seasonal delivery, and classifies local alluvial and wetland habitats. These were absent or much less developed in the resource proposal's v2.4.1 baseline.

What is still missing is material identity and usable inventory: host lithology, mineral form, composition/assay, finite occurrences, woody stock, and capability-dependent production. The existing processes make those additions better grounded, but do not supply them automatically.

The first resource release should remain an observational consumer of the completed environmental world. Adding resources must not change accepted terrain, climate, lake, river, or bank-rendering output. A future material-dependent erosion change is a separate generator revision, not an incidental effect of enabling a mineral catalogue.

### 1.1 Requirements, source observations, and proposals

| Status | Statement |
| --- | --- |
| User requirement | Resources support eventual settlements, commerce, competition, and civilization history; C3 is the destination. |
| Verified in the supplied architecture and source | The current core retains a process-grid crust reconstruction and exposes newer landscape, river, sediment, and habitat fields. |
| Verified model boundary | Rigid prescribed motion, reversible overlap selection, relief aging, and local gap aging are approximations; they are not a conserved material-history model. |
| Proposed next step | Add a small material interpretation and resource-endowment stage after the existing final ecology stage. |
| Proposed simplification | Infer material families through explicit presets, use sparse deposits, and retain only the provenance actually needed for their interpretation. |
| Not established | Earth-calibrated ore frequency, mineralizing chemistry, resource tonnage, wood yields, crop yields, or performance of the unimplemented resource stage. |

This document draws its baseline from the supplied files. New design choices below are proposals, not claims that the bundle already implements them. Source paths, line ranges, and selected exact excerpts are in the reconciliation notes (`worldbuilding_resource_reconciliation_v2_9.md` in the original bundle).

## 2. What the new baseline replaces

| Previous resource-plan assumption | Current baseline | Updated next step |
| --- | --- | --- |
| Geological motion was only a display transform. | `evolveCrust` changes final basement, ownership, age context, inherited deformation, and subsequent geography. A separate display drift still exists. | Tie inherited material interpretation to the same reference frames and overlap decisions as terrain. |
| Age was only a noise-derived field. | Initial ages remain synthetic, but exposed reference crust receives elapsed time and opened ocean receives approximate local aging. | Use relative age/context with its documented limits; do not call it radiometric dating or mineral formation time. |
| Volcanism was mainly a present-boundary hint. | Fault and stationary mantle-frame hotspot sources build and transport volcanic relief with a recent-emplacement proxy. | Use accumulated construction and emplacement context. Do not infer rock composition from relief alone. |
| Loose sediment came from a small bounded erosion pass. | Regional weathering, basin infill, outlet incision/export, and recent river incision/deposition now exist. | Use finalized cover and exposure evidence rather than adding a duplicate sediment landscape. |
| River resource access relied mainly on annual support flow. | Four seasonal discharges, delivery mixtures, regimes, lake effects, courses, and delta context are available. | Read these directly for seasonal access and later production constraints. |
| River vegetation was mainly an immediate-bank adjustment. | Persistent alluvial corridors, seasonal flood-access potential, local habitats, wetlands, and cutoff pools are represented. | Estimate biological stock by bounded habitat area, without adding the same green corridor again. |
| Resource geology needed a new stage before terrain by default. | The snapshot retains enough reference and final context for a first material interpretation after generation. | Start with one new post-environment resource stage; insert earlier only when a specific missing history hint is actually required. |

The supplied architecture's section 16 already describes environmental state as input to a separate civilization/history state. Preserve that boundary.

## 3. Field contract: reuse versus inference

The following distinctions are prerequisites for resource rules, not a request to add defensive checks to every simulation loop.

| Current data | What it supports | What it does not establish |
| --- | --- | --- |
| `Geology.plate`, `CrustHistory.initialPlate`, `.inverse`, `.material` | Selected exposed carrier, reference-frame sampling, and retained-reference versus opened-ocean distinction. | Lithology, continuous parcel identity through irreversible subduction, or a conserved buried stack. |
| `CrustHistory.initialBase`, `.materialBase`, `.base` | Reference and reconstructed raw basement elevation/context. | Rock types or underground inventories. |
| `Geology.age` | Synthetic initial age plus the reconstruction's exposed-reference/local-gap update. | A verified geological chronology or the age of a mineral deposit. |
| `CrustHistory.deformation` | Transported, decaying collision/rift relief context. | Pressure–temperature paths, metamorphic grade, strain history, or ore enrichment. |
| `Geology.boundary`, `.uplift`, `.volcanism` | Current boundary classification and propagated mechanical/magmatic context. | A complete persistent history of every boundary source. |
| `CrustHistory.volcanic`, `.volcanicAge` | Accumulated geometric volcanic construction and time since appreciable modeled emplacement. | Conserved magma volume, composition, alteration chemistry, mineralization age, or a unique source identity. |
| `Terrain.bedrock`, `.height`, `.sediment` | Elevation and loose-cover thickness, with the current height decomposition. | A lithological map, grain classes, consolidated sedimentary beds, or ore assay. |
| `Terrain.surfaceChange` | Net terrain change over the landscape/fluvial sequence. | Gross erosion or the volume of a particular removed mineral. |
| `Terrain.fluvialIncision` | Gross recent cell-average lowering before subsequent deposition. | The depth of a particular orebody or a unique parcel-excavation record. |
| `Terrain.deltaSediment` | Recorded mouth-deposit thickness per cell. | A separate independent stock for every nearby delta metadata record. |
| `Delta.sedimentVolume` | A neighborhood summary used to qualify a terminal fan. | Non-overlapping ownership of that sediment; nearby delta records can overlap. |
| `LandWater.baseflowRunoff`, `Rivers.sourceFractions` | Budgeted delivery pathways including slow soil release and lake release. | Aquifer geometry, individual spring locations, salinity, or a water right. |
| `Rivers.seasonalDischarge`, `.regime` | Four-season supply contrasts and regime potential. | Daily reliability, channel depth, or navigability. |
| `Floodplains`, `Ecology.riparianFraction`, `.floodplainFraction` | Physical local habitat widths and modeled seasonal access. | Additive disjoint land parcels, crop yields, nutrients, or allocated irrigation withdrawals. |
| `Ecology.wetland`, `.wetlandFraction` | Marsh/swamp/fen/bog potential and local extent. | Peat accumulation, acidity, mineral-water chemistry, salinity, or mature tree stocks. |
| `Terrain.oxbows`, `LandWater.oxbowDepth` | Local cutoff footprints with budgeted seasonal water. | Annual migration history, fishing yield, or independent additional freshwater. |

In particular, **`CrustHistory.material` is a reference/gap flag, not a rock enum**. Preserve the existing field's meaning. Give new material fields explicit names.

## 4. Three timescales and three state lifetimes

### 4.1 Geological reconstruction time

`tectonicDuration` governs prescribed crust evolution and the existing long-term aging approximations. The default is 200 Myr in the supplied generator. Volcanic schedules are seeded independently of the requested end date.

This time changes the environmental baseline. It is not the age of every deposit, every forest, or every river.

### 4.2 Recent landscape time

`fluvialDuration` is a separate assumed recent shaping interval, with a default of 1 Myr in the supplied model. It controls bounded river incision and course-related features. It is not a named river's birth date and must not be multiplied into resource production rates without a defined process.

### 4.3 Civilization time

The history simulation starts from one completed environmental/resource baseline. Its years, seasons, or turns govern discovery, construction, extraction, land use, inventories, and biological recovery.

Do not rerun geological generation every historical turn. Do not use the plate interval to calculate peat stock or forest age. A depleted ore inventory must never be restored merely because environmental inputs are resampled.

### 4.4 Ownership

```text
World definition and algorithm versions
    -> immutable environmental snapshot
    -> immutable natural resource endowment
    -> mutable history state
```

The endowment records what initially exists and its interpretation. History records what remains, who knows about it, who controls it, and what operations have been built. Capabilities and production methods are evaluated against those records; they are not global properties of the deposit.

## 5. Material interpretation follows the existing crust

### 5.1 Reference material atlas

Generate a modest, correlated map of inherited host families in the same reference domain as the initial basement. Use a resource-specific deterministic seed and existing reference fields. Broad families may include crystalline/intrusive, inherited metamorphic, siliciclastic, carbonate, and selected evaporitic backgrounds.

These are procedural labels for material history omitted by the generator. They should be identifiable as such in the inspector. Neither present height nor present plate ID alone determines a host family.

For the first release, this atlas can be constructed at the resource stage from the retained reference snapshot. It does not need to run before or inside every crust step. Do not regenerate the physical geology to make it.

If a chosen reference descriptor is no longer retained, either retain that small descriptor where it is originally produced or use a clearly labeled simpler preset. Do not recreate a second geological timeline merely to infer it.

### 5.2 Resolve material on the final process grid

For a process cell containing retained reference crust:

```text
plate = existing final exposed carrier
reference position = existing inverse rotation for that plate × final position
reference host = categorical lookup in the initial material atlas
```

Use the same footprint membership convention as the existing reconstruction. If shared code is helpful, extract only the reference-lookup helper; a new general remapping framework is unnecessary.

For a cell marked as opened ocean, use an explicit newly opened ocean-floor material profile. Do not claim that inverse-rotating it retrieves a surviving reference parcel.

For `tectonicDuration == 0`, use the existing static branch: reference coordinates equal current coordinates and no `CrustHistory` object is required. Resource generation must work in both supported modes.

### 5.3 Resolve volcanic and deformation context separately

Inherited host, constructed volcanic terrain, and loose surface sediment are different contributions. A useful reduced representation is:

```text
Inherited host family
    + generated construction/deformation context
    -> dominant consolidated rock interpretation
    + finalized superficial cover
    -> accessible surface-material interpretation
```

Use `CrustHistory.volcanic` and `.volcanicAge` as evidence that the current world contains a constructed/aged volcanic feature. A decayed volcanic-height field is not a deposited-volume ledger. Multiplying that height by area must not create a supposedly conserved magma or ore inventory.

The current volcanic pass combines fault and hotspot rates into construction fields. It does not preserve a unique compositional or source history for every cell. Therefore start with a broad volcanic material family or an explicit composition preset. Do not label all constructed volcanic terrain as granite, basalt, obsidian, or metal-bearing rock by default.

Likewise, use inherited deformation as a contextual modifier, not as a metamorphic pressure calculation. Preset metamorphic hosts remain permissible, but the inspector must not say that their mineral grade was physically simulated.

### 5.4 Only retain more provenance when a rule needs it

If a selected resource family genuinely requires distinguishing arc, rift, and hotspot context, add a small source-class hint alongside the existing calculation. Prefer `unspecified` or `mixed` when the model cannot uniquely support a label.

A current boundary hint is not automatically the origin of older transported volcanic relief. A historical dominant-source hint, if added, must follow the same incremental transport and ownership rules as that construction, and still be described as an approximation. Do not run another heap sweep for each mineral family or record full per-step worlds.

This is conditional follow-on work, not a prerequisite for the initial building-material and copper/tin vertical slice. Missing composition can be supplied as an explicit procedural family parameter without pretending to infer it uniquely.

### 5.5 Surface interpretation

Sample the process material interpretation to surface locations. Categorical rock IDs use categorical lookup; never interpolate enum numbers. Continuous exposure factors may use existing interpolation.

Read finalized sediment, slope, gross incision context, water coverage, and climate to estimate access and superficial material. The purpose is to distinguish exposed rock, loose alluvium, wet lowlands, and covered sources—not to resolve geological strata below every cell.

`Terrain.bedrock` stays an elevation array. Suggested new names are `hostRock`, `surfaceCover`, and `exposureClass`, held under `World.resources.materials` rather than overloading old fields.

## 6. Districts, finite occurrences, and stable identity

### 6.1 Retain the previous resource hierarchy

```text
Compatible material context
    -> occasional resource-bearing district
    -> a few localized occurrences
    -> optional shallow/deep access zones
```

Compatibility does not guarantee mineralization. Primary quantities, grade, composition, quality, and access still need explicit resource-family presets. Do not derive ore tonnage directly from uplift, volcanic height, or basin depth.

Keep the initial catalogue small: construction rock and clay, woodland/fuel, cultivable/forage potential, copper and tin. Iron, gold, one decorative mineral family, salt opportunities, and secondary concentrations can extend the same machinery.

Products such as charcoal, bronze, bricks, boards, and worked stone remain production outputs rather than natural deposits.

### 6.2 Physical-area sampling

Select district counts and locations on a stable process/reference domain using physical compatible area, not a per-surface-cell probability:

```text
eligible area = sum(process-cell area × family compatibility)
expected district count = family abundance density × eligible area
```

Keep the count distribution and parameterization simple. A process-grid suitability pass can accumulate eligible area for a small family without retaining a dense map for every commodity.

Resolve inherited district anchors through the same final carrier transform as their host material, or generate a final-snapshot district in the resolved host domain with a declared fixed-baseline identity. Do not mix those two semantics silently. The first release can use final-snapshot districts, while retaining the sampled reference identity as explanatory context.

Adding surface detail must not multiply the primary occurrence catalogue, stock, or IDs when process configuration, resource recipe, and environmental baseline remain fixed. Fine exposure, access, hydrology, and secondary placement can change with detail. Changing geological duration or process resolution changes the baseline and is not covered by that guarantee.

### 6.3 Occurrence records

Use sparse records with stable identity, a unit-sphere anchor, host/source district, resource family, mineral form, bounded material inventory, assay/quality, and access zones. A current surface-cell ID is a derived cache.

For deposits with by-products, every commodity draws from the same ore-bearing material inventory. Shallow and deep zones are disjoint inventories, not two ways to count the same body.

Use family-specific seed/version keys so adding an unrelated family does not relocate established resources. A world/resource schema version records compatibility; it need not be injected into every family's random stream whenever a new display or unrelated catalogue entry is added.

### 6.4 Respect reversible overlap

The geological reconstruction can expose a reference patch again after overlap ends. It does not permanently consume subducted material or preserve a conserved hidden crust column. Resource endowment must inherit that limitation rather than invent irreversible deletion or burial history.

For the first history release, freeze one final environmental/resource snapshot and give each occurrence one inventory. Changing the geological reconstruction produces a new baseline; it does not replenish a mine in an ongoing civilization history.

Strong parcel-level mineral provenance can wait for an explicit irreversible material model. It is not necessary to generate plausible present-day occurrences or simulate their subsequent human use.

## 7. Sediment and secondary resources: reuse the right evidence

### 7.1 First release: material interpretation, not particle tracking

The new regional weathering and fluvial stages already supply useful physical cover and deposition context. Use them to locate plausible loose construction materials, deposited lowlands, exposed rock, and covered occurrences.

Clay, sand, gravel, and mineral assay still require explicit material presets because the current sediment is unclassified. The existence of a large sediment volume does not identify its particle size, chemistry, consolidation, or fertility.

Do not treat the initial inland-basin reshaping formula as deposited sediment. The supplied architecture explicitly distinguishes that terrain-construction operation from later material-accounted infill.

### 7.2 Distinguish three sediment pathways

| Existing pathway | Resource interpretation |
| --- | --- |
| Regional weathering followed by temporary cell-based basin delivery | Inherited/aged cover and basin-infill context. Its temporary transport path is not the current river network. |
| Geological outlet incision and unresolved export | Exposed/cut terrain context. Exported material has no resolved receiving resource body in the current model. |
| Recent fluvial incision and local/mouth deposition | Recent erosion/cover and mouth-deposit context linked to a provisional drainage graph. |

Final drainage is rebuilt afterward. Routing a new mineral tracer on the final graph is a new reduced-order approximation, not a reconstruction of where every earlier sediment parcel actually traveled.

Do not reassign `World.sedimentExport` to the nearest modern delta. Do not feed outlet-export volume into a recent fan merely because both quantities are sediment.

### 7.3 Secondary mineral generation when added

A minimal placer-like extension needs a finite mineral-bearing source and an explicit transport/capture rule. Use the existing final lake-aware drainage authority for a bounded snapshot approximation, with no new hydrological solve:

```text
Tagged source mineral budget
    -> source injection
    -> one upstream-to-downstream transport pass
    -> compatible local capture
    -> terminal storage/export
```

A transport/capture fraction should depend on physical reach length rather than a fixed amount per graph hop. Process a small number of families one at a time and reuse scratch storage.

Start with a declared inherited mobile-material budget that is separate from retained primary inventory, or remove the mobilized amount from an explicitly shared total. Do not duplicate a source's mineral mass in a lode and its downstream concentrations.

Alternatively, tag material during an existing erosion pass once lithology and assay truly need to affect its destinations. That requires explicit access to its already-computed gross source volumes and routes. It is a later provenance improvement, not a reason to rerun all geological or fluvial steps for every resource.

### 7.4 Do not count a delta twice

`Delta.sedimentVolume` is assembled from nearby `Terrain.deltaSediment` cells. The architecture explicitly warns that neighborhoods of adjacent fan records can overlap.

For finite extraction accounting, use unique cell material volumes or a single ownership/allocation of each underlying volume. A delta record can reference that stock but cannot each own another complete copy. This matters for aggregate, clay, and any later mineral concentrations.

Similarly, delta branch fractions partition one terminal water delivery. Branch records are not independent sources of full river supply or sediment. The accepted renderer no longer draws the branch fan lines; resource generation should not reintroduce them.

## 8. Biological resources use habitat extent, not color

### 8.1 Woodland capacity and stock

The updated ecology provides regional background cover, local riparian woodland, wider alluvial access, wetlands, and seasonality. Use those contexts to select a small functional woodland profile and calculate physical woody capacity and initial stock.

The endowment should distinguish woody stock from vegetation potential, and merchantable timber from total woody biomass. Fuel and timber harvesting draw from shared biological stock. Charcoal is produced from harvested wood.

A few profiles are sufficient. There is no need to add a species catalogue, individual trees, or ecological succession before the first production scenario. Material quality and recovery parameters remain explicit fictional-world presets.

### 8.2 Avoid overlapping area claims

`riparianFraction`, `floodplainFraction`, and `wetlandFraction` are not independent, disjoint hectares. A swamp may occupy the same alluvial corridor as a woodland or floodplain summary.

Exclude existing standing-water/ice footprints as appropriate, then allocate local habitat within the remaining land. Until exact overlap is needed, use one documented bounded allocation of local habitat rather than summing these fractions into additional land. A conservative fallback can use the larger overlapping local envelope and assign its dominant habitat once; it should not claim to have reconstructed an exact spatial union.

Preserve the source distinction between perennial alluvial habitat and seasonal inundation. Inundation does not create more land, another rainfall source, or an unallocated irrigation entitlement.

The existing total vegetation value already includes local habitat adjustments. Either reuse an exposed background-cover helper and the original physical habitat factors, or interpret the combined value once. Do not multiply the total by a new bank multiplier.

### 8.3 Wetlands and peat

Marsh/swamp/fen/bog categories now make reed/herbaceous versus woody-wetland opportunities easier to describe. A peatland label is still only favorable habitat potential.

Defer finite peat fuel until there is an explicit organic accumulation, persistence, accessible depth/density, and stock assumption. Do not multiply wetland area by `tectonicDuration` or `fluvialDuration` to manufacture peat. Chemistry and real peat growth are not supplied by the existing code.

### 8.4 Land production potential

Use finalized terrain, water regimes, cover, deposited lowlands, and climate as components of cultivability and forage potential. Keep flood exposure and seasonal supply visible as separate limitations.

Neither a green delta nor a thick alluvial deposit proves crop fertility. Soil texture and simple suitability profiles remain new presets; nutrients, irrigation, agriculture, and land allocation belong to their later owning models.

## 9. Settlement and production interfaces

The resource layer supplies natural quantities and opportunities. The history layer selects methods and pays their input costs.

For mineral production:

```text
material processed per time
    = limited by accessible inventory and the operation's inputs/capacity
commodity produced
    = material processed × assay × method recovery
```

Labor, fuel, water, tools, facility capacity, and transport limits must be expressed in compatible units before comparing them. Capabilities are specific, not one universal technology score.

For woodland, history tracks remaining/managed stock and a small recovery model. Merchantable maturation must not be confused with fast return of young biomass. Land allocated to farms, settlements, and forestry shares the same physical footprint.

For settlement context, the new source mixtures and seasonal discharges are better than the previous annual-only inputs. They still do not supply daily reliability, actual aquifers, salinity, navigability, disease, or flood return periods. Do not add those capabilities by renaming an existing field.

The first test scenario remains a few complementary regions: copper, tin, usable woodland, construction material, and food/water access. These can support trade or specialization without requiring that every continent contain every resource or that scarcity automatically cause war.

## 10. Minimal pipeline and file changes

### 10.1 First implementation: one new owning stage

Preserve the supplied stage order:

```text
Process/surface grids and transfer
-> plates and initial tectonics
-> optional kinematic crust evolution and volcanic construction
-> terrain/ocean construction
-> provisional climate and land water
-> optional regional weathering, infill, and outlet erosion
-> provisional corner drainage/reservoirs
-> optional recent river landscape evolution
-> existing final climate/water/drainage feedback when required
-> final headwaters/channels
-> shared river courses and deltas
-> ecology, alluvial habitat, wetlands
-> NEW: material interpretation and resource endowment
-> publish immutable snapshot
```

The resource stage internally constructs reference material context, resolves final process materials, samples surface access, creates sparse occurrences, and estimates biological/land endowment. Internal function order is explicit; it does not require new public stage infrastructure.

This replaces the previous default instruction to insert a separate resource-geology stage before terrain. Earlier insertion is only needed when a future rule must retain information that the environment does not keep. It must not become a second geological evolution.

### 10.2 Suggested changes

| File or responsibility | Change |
| --- | --- |
| `src/core/model.ts` | Add resource/material/endowment types and `World.resources`; preserve meanings of existing fields. |
| `src/core/generation/resource-geology.ts` | Reference-frame host presets, final material/context interpretation, and shared surface-access sampling. |
| `src/core/generation/resources.ts` | Explicit endowment assembly and sparse district/occurrence creation; small woodland helpers can remain here initially. |
| `src/core/resource-catalog.ts` | Compact static material, occurrence-family, and production-capability profiles. |
| `src/core/pipeline.ts` | One stage after ecology and before publish. Existing buffer collection visits added typed fields. |
| Existing inspector/layer adapters | Material, resource, and stock views using the current rendering architecture. No new riverbank/lake geometry. |
| Existing project persistence | Add resource recipe/catalogue identity now; add baseline snapshot plus history state before long-running civilization saves. |

Do not create placeholder files for every eventual commodity, climate process, or economic institution. Split helpers only when the implementation becomes difficult to read.

### 10.3 Runtime ownership

The TypeScript worker remains a one-shot owner that transfers its completed arrays. Resource-only regeneration is not implied by adding a stage; retaining or returning canonical state is a separate ownership decision.

In C3, use one generation task/thread with explicit persistent and scratch allocation and publish an immutable snapshot. A renderer can retain its previous completed world until the next snapshot is ready. Do not carry React lifecycle, transferable-buffer plumbing, dynamic object traversal, or browser workarounds into the numerical core.

## 11. C3-oriented state without premature framework work

A sufficient model is:

```text
NaturalResources
    MaterialFields                 dense cell fields
    WoodlandAndLandEndowment        dense capacity/initial-stock fields
    ResourceDistrict[]              compact records
    MineralOccurrence[]             compact records
    ProfileTables                  shared immutable catalogue

HistoryState                       later
    discoveries by society
    workings and extraction
    remaining occurrence inventory
    managed biomass and land use
    settlements and commodity stocks
```

Use flat arrays for dense fields and integer IDs for relationships. Sparse occurrence records can use an ordinary array of structs; structure-of-arrays is not a universal requirement.

Use clear units in names or documentation: metres for physical cover/access descriptors, square metres for area, kilograms or tonnes for material stock, dimensionless mass fractions for assay, and a stated time unit for production. Use Float64 for inventory and accumulated volume/mass arithmetic. Quantized classifications and bounded potential indices can be bytes where their precision is sufficient.

The first port should mirror the readable TypeScript algorithms and ownership boundaries. Port only the geometry/matrix/nearest-cell operations actually used by resources. Existing C3 geometry and GPU libraries remain integration targets, not a reason to redesign the resource model around a new rendering abstraction.

No C3 source or API implementation is claimed by this architecture.

## 12. Performance: add interpretation passes, not more simulations

Let `M` be process cells, `N` surface cells, `P` plates, `S` geological steps, `D` occurrences, and `F` the small number of resource families being evaluated.

| New work | Intended cost / boundary |
| --- | --- |
| Reference host assignment | A small, fixed set of correlated regional presets on the process domain. Bound province count; account for it explicitly if evaluating every province at every site. |
| Final material lookup | One pass over process cells using the already-selected carrier and local reference lookup. No repeated `P`-plate search at every geological step. |
| Surface material/access sampling | One or a few linear surface passes for fixed local sampling work. |
| District selection | Process-grid eligibility for a small `F`, followed by sparse record creation. Reuse scratch suitability arrays. |
| Woodland and land potential | Linear surface/selected-habitat work, reusing environmental fields. |
| Secondary mineral routing, later | One topological pass per small source family plus sparse capture records, not one whole-network traversal per occurrence. |
| Resource visualization | One selected diagnostic field or a bounded set of occurrence markers; no dense GPU attribute for every commodity. |

The existing geological loop already performs `S × M × P` reference queries plus source propagation. The resource proposal should not multiply that work by the resource catalogue. Do not add climate solves, full world histories, new sediment floods, or new river-routing solves for ordinary endowment generation.

The current lookup cache contains one entry per plate/process-cell pair. Reuse existing context or a small final-source cache; do not create a second resource-specific copy of the whole matrix.

### 12.1 Illustrative memory arithmetic, not measurements

At 40,962 process cells:

- A Uint16 reference host field uses 81,924 bytes, about 80 KiB.
- An optional Uint32 final reference-cell cache uses 163,848 bytes, about 160 KiB.
- One optional Uint8 source-family hint uses 40,962 bytes, about 40 KiB.

At 655,362 surface cells:

- Four bytes of material IDs/cover/exposure per cell use about 2.5 MiB.
- A total resource surface allowance of 16–24 bytes per cell uses about 10–15 MiB.
- One reused Float32 diagnostic layer uses about 2.5 MiB.

These are layout allowances, not measured C3 struct sizes or an implemented memory budget. Sparse records, indices, scratch buffers, and GPU copies are additional. Do not replicate already-owned water, habitat, and sediment arrays under the resource object merely to simplify access.

No new timings were produced for this revision. Retained timings in the supplied architecture concern named earlier/component runs and should not be relabeled as a current resource benchmark.

## 13. Revised implementation sequence

### R1 — Material geography and renewable capacity on the current world

Implement reference-frame material families and final surface cover/access, construction-material availability, functional woodland capacity/initial stock, and basic land-potential components. Reuse seasonal river/habitat context. Add a material/resource inspector and keep existing environmental/rendered geometry unchanged.

Deliverable: one world where an inspector can explain why a location has its material interpretation, whether it is covered or exposed, and what physical area/stock a woodland estimate describes.

This is the next step. It is no longer a project to add crust motion, volcanism, landscape aging, or floodplains; those are already in the baseline.

### R2 — Copper/tin districts and finite occurrence inventories

Add sparse, independently seeded districts, primary material inventories, assays, forms, and shallow/deep access. Provide a production-capability preview with fuel/material inputs but no complete economy.

Deliverable: stable primary occurrences under surface-only refinement and an explainable production chain. Host context and finite material quantities remain separate.

### R3 — Selected secondary and habitat-associated resources

Add a small source-linked placer approximation, selected loose-material deposits, reeds or other simple wetland products, and a salt opportunity only where an explicit source/composition preset exists. Add gold/one decorative family through the same occurrence catalogue when useful.

Do not infer salt from closed drainage, peat from a wetland label, or mineral abundance from a delta's size. Exact particle provenance and peat accumulation can remain deferred.

### H0 — First civilization/resource loop

Freeze the baseline, add stable society/settlement identity and known versus unknown occurrences, then implement working construction, bounded extraction, commodity inventories, woodland recovery/land allocation, and explicit travel costs between a few sites.

Start with food/water, fuel, construction, and copper/tin complementarity. Detailed war, diplomacy, demographics, disease, and fully dynamic hydraulic infrastructure are not prerequisites.

## 14. Sufficient verification and explicit deferrals

Keep the current focused environmental tests. Do not rebuild their entire suite for the resource stage.

Add checks alongside the features that need them:

1. **Material-frame fixture:** a known reference patch moves with its carrier; opened-ocean cells do not claim unrelated retained reference material; the zero-duration branch works.
2. **Inventory fixture:** one source body cannot fund duplicate primary/by-product/secondary material. Include overlapping delta summaries when aggregate extraction is introduced.
3. **Habitat-area fixture:** overlapping alluvial/wetland summaries do not create extra land or independent timber/fuel stocks.

As one integration comparison, use the same process configuration with two surface levels and compare the primary occurrence catalogue and quantities. Access and secondary geometry are allowed to differ according to their documented support. This is not a demand for a large seed sweep or cross-language bitwise floating-point equality.

When implemented, record the resource stage's elapsed time and retained bytes through the existing reporting. Run the normal language/build gates. Do not add custom benchmark infrastructure, exhaustive statistical geology validation, or UI pixel snapshots to justify a small resource layer.

Defer full lithospheric material conservation, irreversible mineral parcel histories, crustal chemistry, a 3D stratigraphic column, sediment size/chemistry solvers, aquifers, salinity dynamics, peat growth, ecological succession, and automatic civilizations. Add any of these only to solve a demonstrated requirement in its owning subsystem.

## 15. Bottom line

The revised geological and landscape algorithms are now the starting point, not future work. The next architectural extension is **material meaning and usable endowment**: interpret what the generator has produced, supply explicit presets for what it does not model, and keep resource stock and historical use separate.

The first implementation should add one resource stage, a small catalogue, compact material fields, and sparse inventories—not another planetary simulation.

## Source guide

- Current supplied illustrated architecture (`worldbuilding_planet_generator_architecture_v2.md` in the original bundle): sections 6.4–6.5, 11.4–11.6, 12.1–12.4, 15–18.
- Current model (`model.ts` in the original bundle) and pipeline (`pipeline.ts` in the original bundle).
- Crust reconstruction (`crust-evolution.ts` in the original bundle), volcanism (`volcanism.ts` in the original bundle), landscape aging (`landscape.ts` in the original bundle), sediment delivery (`sediment.ts` in the original bundle).
- Fluvial evolution (`erosion.ts` in the original bundle), delta metadata (`deltas.ts` in the original bundle), wetlands (`wetlands.ts` in the original bundle).
- Exact reconciliation and source excerpts (`worldbuilding_resource_reconciliation_v2_9.md` in the original bundle).

These relative links resolve inside the integrated ZIP. The standalone Markdown does not embed the TypeScript source or duplicate the original illustrations.
