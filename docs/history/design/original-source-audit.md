# Planet generator — source audit and performance evidence

**Date:** 2026-09-04  
**Scope:** The attached TypeScript source archive and `ARCHITECTURE_CHANGES.md`, compared with the earlier architecture. This is a design review, not a patch or a certification of the application.  
**Companion:** Revised architecture (`worldbuilding_planet_generator_architecture_v2.md` in the original bundle) · Raw measurements (`planet_generator_review_measurements.json` in the original bundle)

## 1. What was inspected and executed

The archive was extracted without changing its contents. The generation modules, grid builders, graph operators, state types, pipeline, worker lifecycle, and relevant rendering/picking paths were inspected. The change log identifies work through `f3b8cbc`; the attached snapshot, rather than an independently verified checkout of that commit, is the object of this review.

Two headless generation runs were executed with Node.js v22.16.0, the prototype's default configuration except subdivision, and seed text `tectonic-regression`. The core was transpiled with the installed TypeScript compiler to ES2022, and relative imports were given `.js` extensions for Node. The unavailable D3 package was represented by a stub that throws if its low-resolution function is called. Subdivisions 6 and 7 use the prototype's existing non-D3 path; that path and the generation algorithms were not changed. This exercise is not a TypeScript type-check, application build, browser benchmark, or execution of the repository's complete test suite.

The harness calls the generation stages in pipeline order; it omits final summary/repackaging and the diagnostic copy of provisional erosion/deposition arrays into the final hydrology object. Those omissions do not change the climate, terrain, routing, or ecology calculations being timed.

The level-6 run also collected a V8 CPU profile; level 7 did not. These are single observations, not medians or statistically controlled scaling measurements. Stage timings exclude browser rendering, GPU allocation, interaction, worker transfer, and Cloudflare deployment. Process memory was sampled at stage boundaries; it is not a continuously measured peak. No C3 implementation was benchmarked.

A separate geometric probe normalized the stored sites in Float64 and checked the local convex-hull condition across every primal edge. An opposite vertex more than `1e-9` unit-sphere distance outside the outward adjacent face plane counted as a violation. This is a focused examination of the known high-resolution Delaunay limitation, not a general mesh-validation suite.

## 2. Measured generation costs

| Stage | 40,962 cells, level 6 | 163,842 cells, level 7 |
|---|---:|---:|
| Grid | 0.272 s | 0.641 s |
| Tectonics | 0.293 s | 0.820 s |
| Initial topography | 0.178 s | 0.631 s |
| Preliminary climate | 3.819 s | 12.787 s |
| Preliminary hydrology, including corner river construction | 0.108 s | 0.373 s |
| Erosion | 0.018 s | 0.042 s |
| Refresh water bodies | 0.043 s | 0.126 s |
| Final climate | 3.662 s | 12.641 s |
| Final hydrology, including corner river construction | 0.096 s | 0.375 s |
| Ecology | 0.006 s | 0.011 s |
| Total measured generation | **8.503 s** | **28.454 s** |
| Climate share of timed stages | **88.1%** | **89.4%** |

The actionable conclusion is that climate is the measured optimization priority in these runs. The table does not establish that every planet has the same cost distribution, that the browser behaves identically, or that the C3 port will meet a particular generation-time target.

### Persistent typed-array storage

These totals count unique ArrayBuffer backing storage in the final grid and field groups. They exclude ordinary objects, retained preliminary states, temporary buffers, allocator overhead, render geometry, and GPU copies.

| Group | Level 6 bytes | Level 7 bytes |
|---|---:|---:|
| Grid | 12,656,762 | 50,626,682 |
| Tectonics | 1,802,706 | 7,209,426 |
| Topography | 1,065,012 | 4,259,892 |
| Climate | 8,847,792 | 35,389,872 |
| Hydrology | 1,519,210 | 6,076,378 |
| Ecology | 286,734 | 1,146,894 |
| Total | **24.965 MiB** | **99.858 MiB** |

The final layout uses approximately **639 bytes per surface cell** in both observations. Climate alone uses exactly **216 bytes per cell** with four seasons. Extrapolating that unchanged layout to 655,362 cells gives approximately **399 MiB of persistent numerical buffers**; that is an estimate, not a level-8 generation measurement. The sampled Node process resident size reached approximately 124 MiB and 302 MiB in the two runs.

### Profile interpretation

The level-6 profile assigned substantial self time to vector length/`Math.hypot`, moisture transport, whorl sampling, angular distance, tangent construction, and normalization, with about 0.60 seconds attributed to garbage collection. The vector-length helper alone accounted for approximately 2.68 seconds of sampled self time. Self times are not end-to-end costs of independently removable stages, and should not be added to inclusive call times.

This supports caching invariant geometry/transport coefficients and removing temporary vector arrays in the hot kernels. It does **not** justify an indiscriminate rewrite of every vector helper, replacing all heaps, or moving the complete generator to GPU compute.

## 3. Findings that materially affect the architecture

Source paths below are relative to the extracted archive's project root. Line ranges refer to the attached snapshot, not a future repository revision.

### A. The two river calculations are independent

**Evidence:** `src/core/generation/hydrology.ts:13–115`; `src/core/generation/river-network.ts:93–155`.

`generateHydrology` constructs cell receivers and accumulates cell discharge. It then calls:

```ts
const riverNetwork = buildRiverNetwork(
  grid,
  topography,
  runoff,
  config.riverThreshold,
);
```

The corner routine receives local runoff, not the cell receiver graph or accumulated cell discharge. It builds another Priority-Flood forest on approximately twice as many corner nodes, distributes runoff into those nodes, and accumulates an independent discharge field.

**Conclusion:** The change log's description of a display-only conversion is incomplete. Both calculations may be individually acyclic, but they do not have a shared drainage authority. Erosion uses the cell graph; visible rivers use the corner graph. A disagreement is therefore possible without either graph containing a local programming error.

**Design response:** Keep cell-based rainfall/runoff generation, but choose one channel-routing graph. Because edge-following rivers are an accepted requirement, promote the corner graph to the sole routing authority. Derive river geometry, channel discharge, basin summaries, riparian overlays, and erosion forcing from it. Keep terrain-to-corner sampling explicit; do not invent a second terrain state.

### B. Moisture transport still uses a fixed graph-hop horizon

**Evidence:** `src/core/generation/climate.ts:212–315`.

The code fixes `transportIterations = 9`, normalizes wind to a direction, and transfers the fraction `0.3 * moistureTransportScale` using neighbor alignment. Wind speed, interface length, physical neighbor distance, and a physical time step are absent from the transport fraction.

**Conclusion:** As cells get smaller, the geographic distance reachable in nine neighbor exchanges decreases. This is the same class of scale dependence that the tectonic revision correctly removed. The two measured planets also have different generation geometry, so their different rainfall means should not be presented as an isolated experimental measurement of this transport effect.

**Design response:** Express transport through cached edge fluxes and a physical duration. Cap the number of *climate cells* for high-detail worlds rather than silently shortening simulated transport time.

### C. Moisture conservation is over values, not area-weighted inventory

**Evidence:** `climate.ts:240–301`.

A donor sends fractions of `moisture[cell]` directly into recipient values. That conserves an unweighted sum in the advection substep, but not `sum(area * moisture)` for unequal cells. For example, moving 0.3 units from a cell of area 2 to a cell of area 1 changes the area-weighted inventory by -0.3 despite conserving the sum of the two values. This is an algebraic counterexample, not an additional measured planet run.

**Design response:** Track a column quantity with explicit units and update its extensive inventory using equal-and-opposite edge transfers. Enforce nonnegative inventory through the transport step, not by clamping only the displayed humidity afterward.

### D. Reported evaporation is not the evaporation used by the moisture calculation

**Evidence:** `climate.ts:282–285` versus `climate.ts:311–313`; `hydrology.ts:73–79`.

Moisture injection and returned evaporation are different formulas. The returned evaporation also acts as a water-loss term in runoff. These fields cannot currently support a single water budget without additional interpretation.

**Design response:** Separate actual evaporation/AET from PET, which is atmospheric evaporative demand. PET can remain a simple temperature/wind/season heuristic. Actual land loss must be water-limited; actual ocean evaporation must be the source used in moisture transport. Store unresolved groundwater/export losses under a named term rather than implicitly treating them as rain or evaporation.

### E. Current sea-surface temperature is a local offset, not transported heat

**Evidence:** `climate.ts:411–412`.

```ts
const polewardComponent = current[1] * Math.sign(grid.latitude[cell]);
seaSurfaceTemperature[scalarIndex] = temperature[scalarIndex] - polewardComponent * 3.2;
```

**Conclusion:** This does not follow upstream temperature. Under this formula a positive poleward component lowers the local SST relative to the baseline. Reversing that sign would still not turn it into heat transport.

**Design response:** Retain procedural gyres, but advect SST with their ocean-restricted flow and relax it toward a seasonal thermal baseline. Do not describe the existing offset as an ocean heat-transport simulation.

### F. The high-resolution mesh is measurably not always Delaunay

**Evidence:** `src/core/grid/generate-grid.ts:18–39` and its builder selection; `src/core/grid/dual-grid.ts:299` onward; the focused geometry probe.

| Probe | Level 6 | Level 7 |
|---|---:|---:|
| Edges inspected | 122,880 | 491,520 |
| Local convexity violations above probe tolerance | **125** | **562** |
| Fraction | 0.102% | 0.114% |
| Largest outward opposite-point distance, unit sphere | 0.00004993 | 0.00001254 |

The default jittered fixed-connectivity meshes therefore fail an exact spherical-Delaunay prerequisite at some edges. Their measured area sums are nevertheless close to `4*pi`, and their cell-area coefficients of variation are about 0.119. Neither fact proves all dual cells are valid nearest-site Voronoi regions. The probe does not establish that the entire mesh is unusable or that every violating edge causes a visible fold.

**Design response:** Legalize geometry-driven edges before advertising a circumcentric Voronoi grid. This is a consistency correction, not the current measured speed bottleneck. A deliberately centroid-based dual is a legitimate alternative but must be named and its nonorthogonal geometry handled; it is not an interchangeable exact Voronoi representation.

### G. Plate-class targets and connectivity guarantees need narrower wording

**Evidence:** `src/core/generation/plate-regions.ts:45–177`, `179–269`, `272–377`.

Seed selection does not receive plate classes or target sizes. Nominal target ranges are adjusted to cover the grid. Target sizes use cell counts, not physical area. Fragment cleanup reassigns an unseeded disconnected fragment only in its particular single-neighbor-owner case; a fragment touching several owners is not covered by that rule.

**Conclusion:** “Class-aware seeds,” hard size multipliers relative to the mean, and universal connectivity are stronger claims than the inspected code establishes. Both measured worlds had one connected component for every plate; no contrary result is claimed for those worlds.

**Design response:** Keep the frontier method, describe class ranges as normalized weights/soft targets, use area budgets, and do one seed-component cleanup when necessary. An enclosed microplate is still a connected plate and needs no exception to connectivity.

### H. Physical-distance tectonic spreading is worth keeping, but it is not diffusion

**Evidence:** `src/core/operators/graph.ts:46–93`; `src/core/generation/tectonics.ts`.

`spreadMaximumByDistance` is a useful log-space Dijkstra construction of a dominant-source exponential envelope. It is approximately `max_s source[s] * exp(-distance(s,x)/width)`, subject to the cutoff. It does not sum source effects and does not diffuse a conserved stress field.

The geology code spreads kinematic categories and then evaluates effects using local receiving-cell crust. It does not retain a full source boundary's crust pair and subduction polarity through propagation.

**Design response:** Preserve the inexpensive maximum-envelope strategy where it gives good terrain. Classify feature families and their side/polarity before spreading. Use a bounded number of fields with source provenance, not one distance solve per boundary edge.

### I. Geological age controls are not historical simulation

**Evidence:** `src/core/generation/tectonics.ts`; `src/core/generation/tectonic-history.ts:1–46`.

The epoch count changes influence width rather than running a sequence of advected-crust time steps. The history view rotates present parcels with a display conversion factor. The change log correctly distinguishes the latter from real crust history.

**Design response:** Name these controls tectonic exposure and kinematic drift preview. Preserve the visually useful preview. Actual crust advection, remapping, rifting, and consumption remain a separate future project.

### J. Runoff and sediment currently have resolution-dependent numerical meanings

**Evidence:** `hydrology.ts:73–80`, `134–189`.

Runoff is rainfall-like depth times `areaRatio`, not a physical volume/time. The same uniform input over successively finer grids therefore does not retain a resolution-independent total discharge scale. Erosion transfers a fraction of removed *height* to a receiver without an area ratio; equal height on unequal cells is not equal sediment volume.

The code lowers surface elevation by the full erosion amount but bedrock elevation by 72%. With initially coincident surfaces, an eroded cell can therefore have surface elevation below its stored bedrock elevation. That may be acceptable only if “bedrock” is redefined as a reference field, not a material boundary.

**Design response:** Use m³/s discharge, explicit bedrock plus nonnegative sediment thickness, and volume transfers. Keep the erosion law heuristic and capped; do not add a full sediment mechanics solver.

### K. Lake type is currently classification, not water-storage routing

**Evidence:** `hydrology.ts:55–59`, `95–108`.

Filled height minus original terrain is a depression-to-spill depth. The routine classifies lake kinds from local annual balance but does not use lake storage or an endorheic outlet rule to change routing.

**Design response:** Separate depression geometry from actual lake water. Initially treat each top-level depression as one reservoir with one spill and an annual balance; acknowledge that internal nested basins are aggregated. Implement a full depression hierarchy only when finer lake behavior becomes a real feature requirement.

### L. Worker responsiveness exists; cancellation and real stage progress are not implemented

**Evidence:** `src/workers/planet-generation.worker.ts:21–34`, `src/core/pipeline/generation-messages.ts`, `src/app/usePlanetGeneration.ts`.

The worker returns success/error and transferable buffers. The hook uses elapsed time/status and ignores stale results by request identity. It does not stop an earlier queued computation when a newer request supersedes it. A transfer also detaches the worker's corresponding buffers, so a future retained worker cache cannot be designed as though both sides continue owning the same transferred arrays.

**Design response:** Keep one worker. Add stage messages, and terminate/recreate it on superseded one-shot jobs if cancellation is needed. Decide buffer ownership explicitly before implementing partial regeneration. Do not introduce a worker pool or task-graph framework.

### M. Rendering changes should not change cell semantics

**Evidence:** `src/render/globe-geometry.ts`, `src/render/GlobeView.tsx:160–200, 234–274`.

The renderer switches representation above 50,000 cells. Its indexed primal-triangle path records the first site of a triangle as that triangle's picked cell, and interpolates vertex colors. A Delaunay triangle does not belong entirely to its first site's Voronoi cell. Interpolating categorical palette entries also creates colors that are not categories. Layer/season/history updates rebuild substantial geometry in the inspected effects.

**Design response:** Distinguish a continuous terrain mesh from categorical cell overlays and cell lookup. Reuse static geometry and change field/palette buffers. Resolve the picked site geometrically rather than using an arbitrary triangle vertex. These are source-observed opportunities; no browser interaction latency was measured in this review.

## 4. What is not being claimed

This audit does not claim the prototype is unusable, its output is scientifically inaccurate in a quantified way, all plates are disconnected, every non-Delaunay edge creates an inverted cell, or its renderer has a measured frame-time problem. It also does not promise that two-grid climate, cached kernels, or the native port will achieve a particular speedup before implementation and measurement.

Several prototype decisions are specifically retained: explicit staging, SoA storage, worker isolation, deterministic seeds, varied frontier plates, domain-warped inherited terrain, physical-width tectonic envelopes, whorl-based circulation, bounded erosion, edge-following river presentation, and limited diagnostic geometry.

The revised architecture concentrates work on mismatched authorities, inconsistent quantity/scale meanings, and the observed climate cost rather than expanding validation or replacing every approximate model.
