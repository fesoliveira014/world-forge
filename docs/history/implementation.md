# Implementation decisions and numerical contracts

This is a worldbuilding generator, not a predictive geophysical simulation. The v2 architecture's native C3 plan is implemented here as a browser TypeScript core, with the same stage separation. No GPU simulation, adaptive mesh, dependency-graph framework, or worker pool is introduced.

## World identity and grids

Each subsystem has an independently derived seeded random stream. The process grid is a saved setting. Surface refinement retains process plate seeds/motions, the reference sea-level quantile, noise functions, and ocean gyre selection from the fixed reference terrain. Fine coastlines and process land fractions can still change, so identical climate samples across detail levels are not promised.

Both grids use normalized icosphere subdivision, bounded tangent displacement, outward-orientation validation, and local convex-hull/Delaunay edge legalization. Circumcenters define the shared dual edges. Float64 geometry and metric accumulation are retained. Grid construction verifies cell closure and total spherical area once. The selected modest jitter can require few or no flips; legality follows the geometry rather than arbitrary topological edits.

The arrays explicitly distinguish site adjacency, cell polygon corners, edge endpoints, and corner adjacency. A dot-product walk on the Delaunay neighbors resolves the nearest cell without a global scan. The surface-to-process map uses the same walk. Areas are steradians; lengths are radians until multiplied by the radius.

An identity transfer is used when the grids match. Fine rainfall is distributed from process rainfall volume using actual child areas. Restriction keeps land height and ocean depth separate. Surface temperature is corrected by the difference between local height and the process land height, using the same 6°C/km lapse rate. PET is then recomputed at that temperature. No local rain redistribution is added. This does not recreate a rain shadow or strait absent from the process grid.

## Geology and terrain

Connected frontier growth has major, smaller, and micro plate weights normalized to area targets. Targets are soft; connectivity is obtained by construction. There is no boundary smoothing that would require a separate fragment repair. Crust, crust age, and inherited terrain are independent of plate ownership.

Plate angular motions classify convergence, divergence, and transform boundaries. Collision, subduction trench, overriding arc, rift, and ridge families propagate dominant-source envelopes within their source plate/crust context. Widths are in metres. Transform boundaries are visualized but do not have a separate fault-incision model.

Domain-warped 3D noise supplies inherited relief. A fixed process-grid area quantile determines the sea datum. A monotone, saturating lowland profile preserves broad drainage gradients without turning continental interiors into high plateaus. Narrow Gaussian tectonic envelopes add localized ranges, with small-scale texture concentrated on that uplift. Ocean depth is scaled separately; zero remains the same datum. The saved `seaThreshold` is the precompression generation threshold, not a second sea level. Erosion does not reselect it.

The largest connected below-datum component is the ocean. Other depressions are hydrological candidates. Kinematic drift rotates categorical plate geometry; it neither remaps crust nor evolves terrain, and clicking is disabled while drift is nonzero because gaps/overlaps do not have unique present-day cell ownership.

## Climate and transport

Four equal-duration seasonal samples use latitude, obliquity, elevation lapse rate, and different land/ocean amplitudes. Seeded circulation whorls plus weak rotation-consistent zonal flow define wind. A terrain-gradient term diverts and slows uphill flow. There is no solved pressure/momentum field.

A streamfunction evaluated at ocean corners defines ocean edge flux by endpoint difference. Coast corners share zero streamfunction; land interfaces carry no flow. Cell fluxes telescope to near-zero divergence. Displayed currents are reconstructed from that shared flux; no unrelated wind vector is added afterward.

Ocean temperature is transported as area × temperature for 180 days and relaxes toward the seasonal baseline on a 70-day timescale. Ocean currents/SST are surface mixed-layer approximations. Coastal air uses distance-based seasonal moderation and a nearest-coast SST anomaly correction decaying over 650 km; a full nonlocal coastal heat transport model is not claimed.

Atmospheric moisture is water-equivalent column inventory. Each shared edge is processed once using first-order upwind advection and equal-and-opposite transfers. Explicit eddy diffusion adds `K × face_length / center_distance × (column_a - column_b)` to that same ledger. The CFL bound includes both outgoing advective flux and diffusive conductance, preserving nonnegative inventories. The default diffusivity is 800,000 m²/s, independent of cell size. Thus refinement does not remove the only mechanism for lateral moisture spreading.

Each season spins up for the greater of 35 days or three moisture residence times, then samples 30 physical days. Rain and evaporation rates are converted to seasonal amounts. Longer residence, configurable mountain rainout, and actual wind advection allow moisture to penetrate continents. Ocean temperature affects evaporation; currents also affect coastal air through a physical-distance SST correction. Rain is an inventory sink and evaporation a source. Constant saturation capacities and sink fractions are computed outside the time loop.

Saturation, convection, orographic removal, and evaporation laws are empirical. Finite-volume accounting prevents invented or lost water within the represented atmosphere; it does not establish scientific climate accuracy. Atmosphere residuals measure the complete integration ledger, including the transient.

## Land water, drainage, and lakes

**v2.12.0 update:** Rainfall uses limited linear, parent-volume-preserving reconstruction. Reservoir inputs use retained seasonal liquid precipitation (rain plus actual snowmelt) and PET. The annual lake calculation described below now initializes a four-quarter storage model; its seasonal area and outflow are authoritative. Every quarter retains its storage-change term. Annual graph connectivity and the local nested-basin merge approximation remain.

`lake-state.ts` supplies shared fractional coverage and a throughflow-based freshwater suitability proxy. Only fully wet cells lose all land suitability. Seasonal coverage is rasterized from recorded area, including partial equal-height groups. Surface shaders blend these fractions without a separate lake mesh. See [v2.12.0](revisions/2.12.0.md) for current contracts and measured limitations.

The following paragraphs retain the original annual initializer and graph background.

Each surface cell has a soil bucket and snow-water storage. Four repeated years initialize seasonal storage; only the fourth contributes annual flux totals. Rain plus start-of-year storage equals final storage, actual ET, and runoff. PET is demand and ET is limited by available water. Configurable infiltration sends part of liquid precipitation/snowmelt directly to storm runoff; the remainder enters the soil. Overflow plus an 8% seasonal drainage of remaining soil water supplies slower runoff. Every term is deducted from available storage. This finite initialization is not a converged ice-sheet climatology.

One final climate pass returns a configurable fraction of the provisional, area-restricted actual land ET to the atmosphere. This bounds the source by water that was actually available, rather than inventing an inland humidity floor. It is a one-pass coupling, not a fully converged simultaneous land–atmosphere solution.

Cell runoff is m³/s and is divided equally among incident corners. The corner height is the mean of its three incident terrain cells. Priority-Flood starts at ocean-adjacent corners with water surface zero. Flood rank resolves flats without added elevation. Ordinary channel receivers prefer an admissible downhill neighbor and otherwise use the flood parent.

Connected filled-depression patches are lumped reservoirs. An annual equilibrium balance scans sorted corner-area samples. For wet samples, it removes the provisional land-runoff share, adds direct lake rain, and subtracts lake evaporation. A partially wet final sample closes the balance continuously. Closed reservoirs emit zero; spilling reservoirs pass only the excess. Storage is the height/area integral at the estimated level, separately from capacity to spill. For a closed patch with a dry internal minimum above its estimated lake level, `nested-lakes.ts` splits natural downhill catchments and builds their lowest-saddle merge tree. Child ponds balance independently, spilling into the receiving catchment; both full children merge before balancing toward the next saddle. Settled child states are retained: new spill updates the receiving branch and forwards only increased outflow. Already merged lakes rebalance directly, avoiding exponential subtree recomputation. Internal child transfers never increase the parent basin’s independently tracked inflow. Other patches keep the original lumped path. This is an annual equilibrium refinement, not a lake-filling chronology or exact shoreline-volume solve.

The corner-area wet footprint is a subcell approximation. Explicit wet polygons now include unresolved flat floors; see [v2.8.0](revisions/2.8.0.md). Cells with positive actual depth retain it; lake depth never gets copied blindly onto higher incident cells. River positions at lake outlets use water-surface elevation. Dry downhill channels inside a lumped reservoir retain internal flow, while wet portions terminate at the reservoir. Equal-height partially wet terminal corners belong to the wet footprint, fixing an invisible-lake endpoint case. Refined internal ponds have their own wet endpoints and spill edges; dry interior channels descend into those ponds. Distributary deltas are not simulated: the single receiver graph forms tributary trees.

`lakeExchange` is the **net sink relative to provisional land runoff**, not storage retention. It can be negative where direct lake rain supplies more water than replaced runoff and evaporation remove. Each lake exposes direct rain, displaced runoff, actual evaporation, inflow, and spill. The global runoff ledger is `runoffTotal = oceanDischarge + lakeExchange` at annual equilibrium.

Basin summaries come from the corner graph; a cell spanning a divide has one representative display basin. River strips, flow direction, erosion, and riparian flags consume the same receiver/discharge state. No independently computed cell drainage forest exists.

## Bounded feedback and ecology

One erosion pass converts a stream-power tendency into removed material volume, scatters it to the incident terrain cells, removes sediment before bedrock, and deposits volume downstream. Material delivered to the ocean is a named sediment export. After erosion, water classification, climate, runoff, and drainage are recomputed once. With erosion disabled, a final climate/water pass still runs if moisture recycling is enabled. If both controls are zero, provisional results are reused.

A small explicit biome function uses seasonal temperatures, precipitation, PET/aridity, snow accumulation, and channel proximity. Vegetation, riparian potential, and ice are separate arrays. Forests require sufficient moisture relative to PET, with lower rainfall cutoffs for cool humid climates. Tropical forest requires year-round warmth; the wettest category also checks the driest season. Tundra depends on the warmest sampled temperature rather than latitude, so alpine tundra remains possible on tropical mountains. Mediterranean classification requires a warm dry season relative to a meaningfully cooler wet season. Wetland and ice categories remain coarse heuristics; glacier flow and vegetation succession are absent.

## Rendering and ownership

The worker owns a one-shot job and transfers unique final buffers to the main thread. Cancel or regenerate terminates the old worker; a job ID prevents stale publication. There is no claim of retained canonical worker state after transfer. Full generation rebuilds geometry; stage caching across jobs is deliberately absent. World definitions remain stable through deterministic inputs rather than retained mutable workers.

Natural and scalar views share an indexed primal mesh. Natural world uses its own fragment shader and two vec4 surface-field attributes; analytic views use their original unlit palettes. Seamless seeded 3D noise adds pigment grain and small normal variations, with mountain detail gated by actual elevation and canopy detail by forest cover. Pixel footprints fade unresolved noise. A narrow antialiased transition sharpens the interpolated land/water boundary without noise moving coastlines. Water depth controls shelf color; local temperature and snow fields control winter cover. These are visual approximations, not extra simulated cells. Plate/biome/basin views lazily allocate indexed dual-cell fans with constant cell colors. Layer/season switches update colors, not terrain topology. A separate original-position buffer supports drift. Optional overlays rebuild only when their inputs change. Fine categorical views are the most expensive rendering mode; 655,362 surface cells are supported but are not a promise of smooth interaction on every device.

River ribbons use actual corner receivers and a bounded square-root width by annual discharge, making small tributaries much thinner than main channels. Seasonal temperature controls their activity: frozen channels are grey and static, thawed channels carry pulses. Entirely frozen surface segments are omitted. Width remains an annual mean. The inspector also reports routed seasonal estimates, and ribbon activity includes seasonal relative flow. Subglacial hydrology is not modeled. Shared distance-to-terminal coordinates keep moving pulses continuous through confluences. They stop at actual graph endpoints; animation does not invent connections. Wind/ocean tracers use the selected seasonal vector field, inverse-distance local interpolation, a tangent projection and normalized steps on the sphere. Nearest-cell walks are cached per tracer. Ocean tracers reset at coast contacts; calm fields reset or remain invisible. Respawning clears the trail, so no jump is drawn. A bounded pool (300–2,400 tracers) uses one dynamic line draw call with 22 history points each. These are time-compressed flow visualizations, not a forecast clock.

Animation can be paused independently from planet rotation. Reduced-motion preferences start flows paused, with initial short traces still visible. Reset view restores the camera and drift. A small camera-relative N/S indicator and dashed polar axis identify the rotation axis.

The world geometry, typed fields, and GPU allocations are separate; the displayed retained-buffer size excludes JS objects, temporary construction arrays, and GPU copies.

## Verification scope

The retained tests are deliberately narrow: an unequal-area transport fixture, a periodic diffusion fixture comparing coarse/fine physical reach, a two-pond saddle spill fixture, a deep pond-chain regression, and one generated-world check covering spherical area, atmospheric accounting, ocean divergence, reservoir balances, domain ordering, soil accounting, and visible confluences. A read-only audit also identified and corrected process quality exceeding surface detail, gyre reselection on refinement, and lake depth copied onto above-water terrain. The production build and TypeScript check are separate gates. No browser interaction or visual QA was requested or performed.

The original v2.0 headless timing observations are in [measurements](../observations/history/measurements.json). The v2.1 climate comparison and revised timing observation are described in [revision notes](revisions/2.1.md). The [v2.2 comparison](revisions/2.2.md) records terrain, biome, and drainage observations on the default seed at two surface resolutions. They are single runs on this machine, not performance targets. There is no large seed sweep, image snapshot suite, custom benchmark framework, or machine-specific timing assertion.

## References

- [three.js documentation](https://threejs.org/docs/): renderer, buffers, camera controls, and line rendering API.
- The supplied v2 architecture contains the design's external research references and explicit deferred work. They are not claims that this implementation reproduces MPAS or Fill–Spill–Merge.

- [Andy Gainey’s planet generator](https://github.com/againey/planet-generator): whorl-based air-current field and surface arrow rendering used as a visual reference. Its repository renders static arrows; this implementation adds original animated tracers and river ribbons. The UI layout and amber/teal treatment follow the user-supplied earlier World Forge source.


## v2.13.0 performance update

`prepareTransport` compiles signed edge flux and mixing into two rates in inverse seconds, each divided by its donor cell area. `transportInventory` applies their net exchange symmetrically. Rebuild this operator when the seasonal wind/current field changes; do not retain it after that season. The unchanged CFL estimate includes outgoing advection and diffusion. `exchangeAtmosphericWater` is a small allocation-free hot loop with the original evaporation/saturation/rainout order; fractional final steps receive recomputed sink weights.

`solveClimate` shares physical cell areas, height gradients and ocean coast distances across its four seasons. These are rebuilt in the final climate pass because erosion can change the surface. `buildGrid` preallocates coordinates and each subdivided face array, preserving cell ordering and the seeded stream. Terrain level 9 and process level 7 are optional; defaults remain 5/5. Detailed measurements and limits are in [REVISION_2.13.0.md](revisions/2.13.0.md).
