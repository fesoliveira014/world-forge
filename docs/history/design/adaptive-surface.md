# Adaptive landscapes — 2.15.0

Terrain now evolves in time steps, with refreshed drainage and optional refinement
of the landscape that has already formed. Hillslope and wind transport move material
between cells, and finer volcanic detail uses the existing geological history.
Tectonics and climate retain their process grid.

Load [AETHER-EVOLVED.json](../../../examples/AETHER-EVOLVED.json) for a 2,562-cell base
surface, 642-cell simulation grid, 100 km target spacing, 60% adaptive detail,
four landscape steps and one refinement during a 1 Myr recent interval. The final
cell count depends on the terrain. Its detail settings also appear as **Quick
preview** in **World parameters → Quality preset**.

Quality presets change only the base/simulation detail, adaptive spacing and
strength, refinement count and time steps. They preserve the seed and other world
parameters. Choose **Generate world** after selecting one. **Quick preview** took
about six seconds in the reference browser run; **Balanced cloud** took 54 seconds
and 0.9 GiB peak memory with four workers on the cloud runner. These are measured
examples rather than time or memory guarantees; seed, world settings and hardware
affect cost.

## Controls and timing

- **Adaptive detail** selects coasts, river corridors, lake outlets, complex relief
  and volcanic regions for smaller cells. It defaults to off.
- **Minimum target spacing** sets the requested local detail. Actual neighboring
  center distances vary; the help dialog reports their distribution and the
  generated cell count.
- **Refine evolving terrain** allows up to two additional refinement passes during
  recent evolution. It defaults to off and requires adaptive detail, erosion and
  a positive landscape evolution duration.
- **Landscape time steps** divides the recent interval into 1–12 requested steps,
  defaulting to four. More steps refresh drainage more often; they do not multiply
  the duration. Enough steps are used to separate the requested refinement passes.
- **Hillslope transport** scales downslope material movement. **Wind erosion**
  controls wind-driven transport. Both operate over the modeled interval.

Geological duration still controls the earlier prescribed crust history and broad
landscape aging. Landscape evolution duration is the separate recent interval.
Setting it, or erosion, to zero skips recent evolution. Diagnostics report the actual
completed steps and duration rather than only the requested settings.

## Preserving the evolved landscape

The initial adaptive pass samples the fixed geological history. Later passes use
the current terrain, rivers and outlets to decide where more cells are useful.
They transfer the existing bedrock, sediment and erosion histories to the new mesh,
including cutoff-channel records. They do not generate fresh terrain in place of
the evolved state.

Sparse spherical polygon overlaps provide the geometric transfer areas. Extensive
material is conserved across the changed cell boundaries, and subsequent drainage
uses the new mesh. Terrain, incision and rendered cell corners share the same
reconstruction. The process grid and primary deposit history remain fixed.

Saved projects include the resolved refinement plans. Import validates their
compatibility and passes them to the generation worker. Changing settings and
choosing Generate creates new plans. Recipes from 2.13.0 and 2.14.0 remain readable;
missing controls receive current defaults. Generator identity is now 2.15.0, so
older recipes regenerate using the current numerical model.

## Material movement and volcanic detail

Recent evolution combines river incision and sediment routing with hillslope and
wind transport. Drainage is refreshed as the surface changes, so later steps can
respond to earlier erosion and deposition. These are procedural landscape models
with prototype physical coefficients, not calibrated erosion forecasts.

On adaptive surfaces, finer volcanic construction follows the retained sources and
geological history. Its construction budget is normalized to that history; refining
the mesh does not reroll hotspots or add an independent volcanic endowment.

The cell inspector shows bedrock elevation and sediment thickness. Generation
diagnostics include each refinement's cell counts and sediment volume before and
after transfer, along with hillslope and wind transport volumes in km³. Transport
volumes describe cumulative movement, not newly created material. Downloaded
diagnostics retain their underlying volumes in m³.

## Cost and remaining limits

Smaller spacing and additional refinement can add many cells and increase both
generation time and memory. The controls do not imply that a requested spacing is
affordable everywhere. Diagnostic timings, actual spacing and cell counts make the
chosen recipe measurable. Globe, Flat map, Shaded relief and Ink atlas display the
same evolved surface.

Starting another generation releases the previous snapshot and unmounts its
renderer, including geometry, textures and event listeners. This avoids retaining
the previous large world while its replacement is built. Cancel or generation
failure therefore leaves an empty preview; the current parameters remain available
for another run. Save the current project before starting a replacement if needed.
Cloud generation measurements exclude browser renderer memory, and browser garbage
collection may delay reclamation of released arrays.

At simulation detail five or above, browser generation can solve the four independent
climate seasons concurrently, using up to four available workers. Smaller process
grids run serially to avoid worker overhead. Seasonal results are assembled in a fixed
order; runtime concurrency does not change the saved quality settings or recipe.
If seasonal workers cannot start, generation uses one worker. Cancel, replacement,
completion and failure terminate the owned worker pool. Diagnostics report the actual
climate worker count.

The snapshot remains in memory. A fixed 10 km headless calibration completed
8.25 million surface cells in 23.85 minutes with four climate workers and an
11.48 GiB process-memory peak on the 16 GiB cloud runner. This includes all twelve
landscape batches and two conservative remeshes; generation has no time cutoff or
hidden reduction in detail. The saved spacing plan preserves that measured mesh;
the config-only example resolves a fresh plan with the final planner correction.
See [cloud measurements and reproduction](cloud-performance.md) for the exact
scope, hashes, and renderer memory analysis. Balanced remains the recommended
interactive preset. Out-of-core paging and unbounded interactive refinement remain
future work: the large headless result does not establish that a browser viewer
fits. Atlas retains its Vinext/Cloudflare shell and browser generation worker;
this release requires no backend data migration or sharing change.
