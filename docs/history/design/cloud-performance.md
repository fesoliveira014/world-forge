# Reproducible cloud quality and cost

Measurements use the task's Linux x64 cloud executor: AMD EPYC 9V74, Node
24.19.0, a four-CPU quota and a 16 GiB memory limit. Independent climate seasons can use up to four worker threads. Other
generation stages own one thread. Worker count is a runtime choice, outside the
world recipe, and serial and parallel execution reproduce the same physical fields. The web application still generates in a browser worker; these timings
calibrate this executor, not every browser or device.

## Atlas 2.16.2 current display and storage limits

[Manual saving and dense material rendering](../revisions/2.16.2.md) supersede the
32 MiB tile limit described in the historical sections below. The current tile
budget is 192 MiB of accounted CPU/GPU data, with the same 64 active tiles,
128 resident tiles and four concurrent requests. Terrain/inspection and overlays
use separate reader workers; the overlay reader starts only when needed. Each
reader has a 32 MiB raw-page cache and 4 MiB metadata cache, giving combined limits
of 64 MiB and 8 MiB while both are active, plus their bounded helper caches.
Temporary worlds stay outside the saved library until explicit Save; promotion
changes metadata without restoring or copying the physical fields.

The [field-fidelity audit](../../observations/measurements/saved-field-fidelity.json) uses a generated
10,242-cell fixture. The [dense material query profile](../../observations/measurements/dense-material-query.json)
uses a synthetic 163,842-site grid and in-memory pages. These establish field
parity and bounded allocations, not full-world browser latency or GPU throughput.
The earlier generation and browser reports below retain their original versions
and measurement scope.

## Atlas 2.16.1 rendering fixes

[River coverage and globe-motion fixes](../revisions/2.16.1.md) preserve the physical
model and the tile/page limits below. Tile accounting now reserves temporary
transition arrays. New snapshots add optional per-bin river rankings; older
snapshots use a bounded ranking cache in the reader. The 2.16 index-size and
preparation measurements below predate that extra index and have not been rerun.

## Atlas 2.16: saved worlds and paged viewing

The new renderer keeps at most 64 active tiles, 128 resident tiles, four pending
tile loads, and 32 MiB of accounted tile CPU/GPU data. A separate reader keeps a
32 MiB raw-page cache, a 4 MiB metadata cache, and bounded spatial, render-record
and surface-interpolation caches. These are application data budgets, not a bound
on the browser's total RSS, JavaScript runtime, or graphics-driver allocations. Display detail is sampled
from the authoritative cells; zooming does not modify the simulation mesh.

Generated worlds now commit exact physical snapshots to browser-local IndexedDB.
Spatially packed display records add disk space so a cold view can read nearby
data without loading every physical field. The compute worker exits after the
commit; the page retains a small handle. Refinement restores full physical state
in a new compute worker, conservatively remaps it, rebuilds drainage, and commits
a new revision before switching the page. Global physics still runs in memory.

The 2.16 cloud Balanced reference produced 240,980 surface cells and 40,962 process
cells in 60.27 seconds with four climate workers. Preparing its display index took
1.05 seconds; physical typed buffers retained 220.0 MiB, the display sidecar added
89.6 MiB, and the binary graph contained 312.2 MiB of buffer data. Peak process RSS
including view preparation was 936.2 MiB. IndexedDB write time, browser rendering,
and storage-engine overhead are separate from these Node measurements. See the
[complete Balanced report](../../observations/measurements/cloud-balanced-parallel-2.16.json).

Use `--measure-view-index` with the measurement command to include index preparation
and binary graph size. Regional recipe history is replayed by the measurement tool
as well as the browser importer.

## Earlier calibration (Atlas 2.15)

The historical runs below predate 2.16 sediment physics and complete snapshots.
In particular, the largest headless memory/time figures have not been revalidated
with display-index preparation and should not be treated as current browser limits.

[ATLAS-CLOUD-BALANCED.json](../../../examples/ATLAS-CLOUD-BALANCED.json) fixes all physical and quality parameters. It uses
surface/process subdivision 6, 50 km requested minimum spacing at strength 0.8,
twelve recent-landscape batches, and two evolved-terrain remeshes. The actual
nearest-center distances are recorded in its measurement; requested spacing is
not a promise that every center pair has that separation.

| Recipe                                | Climate workers | Surface cells | Process cells | Generation | Peak process RSS | Retained typed buffers |
| ------------------------------------- | --------------: | ------------: | ------------: | ---------: | ---------------: | ---------------------: |
| Adaptive pilot, no evolved remesh     |               1 |        14,570 |           642 |     2.18 s |        140.0 MiB |               12.9 MiB |
| Cloud balanced, two evolved remeshes  |               1 |       240,564 |        40,962 |    82.66 s |        694.8 MiB |              217.7 MiB |
| Cloud balanced, parallel climate      |               4 |       240,564 |        40,962 |    53.55 s |        885.8 MiB |              217.7 MiB |
| High-detail 15 km serial calibration  |               1 |     3,902,376 |       163,842 |  18.55 min |         5.85 GiB |               3.08 GiB |
| 10 km headless saved-plan calibration |               4 |     8,251,214 |       163,842 |  23.85 min |        11.48 GiB |               6.39 GiB |

The [headless configuration](../../../examples/ATLAS-CLOUD-HEADLESS.json) uses surface/process
subdivision 7, 10 km requested spacing at full refinement strength, twelve landscape
batches, and two evolved-terrain remeshes. Its completed calibration stayed below
the requested 30-minute budget without a cutoff or quality reduction. This is a
single fixed world on this executor, not a runtime guarantee for other worlds.
Balanced remains the recommended interactive preset; the headless recipe is not
a browser quality option.

The complete reports in [measurements](../../observations/measurements/) include normalized config,
environment, stage durations, spacing quantiles, conservation diagnostics, and
SHA-256 hashes of geometry, topology, height, and the resolved recipe. The small
pilot's saved recipe was replayed in a fresh process: all four hashes matched.
Recipe hashes use compact JSON without the saved file's final newline.
The reports are individual runs, not benchmark averages. The final matched Balanced
reports are `cloud-balanced-final-serial-2.15.json` and
`cloud-balanced-final-parallel-2.15.json`.

The two large calibrations predate the final refinement-planner correction that
accumulates catchments along the final drainage receiver graph. The 10 km run's
119.36 MB resolved recipe, supplied separately, pins the exact measured spacing
choices; its SHA-256 is recorded in the report. A config-only run resolves a fresh
plan with the corrected planner and may produce different counts and hashes.
The matched final Balanced runs include the correction and retain the earlier
Balanced hashes exactly. The 15 km serial and 10 km parallel runs use different
quality settings, so they do not establish a parallel speedup.

Four climate workers reduced the balanced recipe’s two climate solves from 41.38
to 12.54 seconds, a 3.30× climate speedup and 1.54× overall speedup. Geometry,
topology, height, and resolved-recipe hashes matched the serial run exactly.
Parallel workers increased peak RSS by about 191 MiB in this run. The small
pilot also reproduced all four hashes across worker counts.

Balanced's serialized spacing decisions occupy 12.9 MB; those JavaScript arrays are additional to the
217.7 MiB of typed buffers. Process RSS includes live arrays, heap overhead,
transient allocations, and garbage-collector retention.

## Measuring another recipe

```sh
npm run measure -- examples/ATLAS-CLOUD-BALANCED.json \
  --output /tmp/atlas-report.json \
  --save-recipe /tmp/atlas-resolved-recipe.json \
  --threads 4 --measure-transfer --progress
```

Each measurement starts a fresh child process. The default climate worker count
is the smaller of four and the available CPU parallelism; `--threads 1` reproduces
a serial reference. Threads do not change recipe quality or numerical results. A parent samples Linux RSS every
50 ms while the generator is busy in synchronous stages. The child's OS high-water
RSS captures peaks between samples and includes all worker threads. Heap and
external-memory values are sampled on the orchestrator thread at stage boundaries,
so they do not count separate worker heaps. Stage summaries never claim to measure an allocation that
wasn't observed. The report separates generation time, recipe serialization,
optional disk writing, and optional snapshot ownership transfer. It excludes
browser rendering, GPU buffers, and display texture creation.

Resolved recipes retain the selected spacing values, pilot support radii, indexed
volcanic caps, and exact mesh/config identifiers. They do not retain complete old
meshes or landscape fields. Import rejects stale or malformed plans. Manual
Generate resolves a new deterministic plan after settings change. Recipe import
and the measurement worker use normal structured messages, so large plans do not
have to fit an operating-system command-line argument.

## Planning a larger run

```sh
node --import tsx scripts/estimate-cost.ts \
  docs/observations/measurements/cloud-balanced-final-parallel-2.15.json \
  --surface-cells 2500000 --process-level 7 --batches 12 --remeshes 2
```

The estimator requires an explicit prospective final cell count. A spacing
setting alone cannot establish that count because coastlines, drainage, terrain
curvature, and volcanic provinces select different regions on each world.
Additional complete measurements of the same generator and worker count calibrate scaling by
stage group. With one resolution, the fallback uses linear surface work and
N² diffusion-limited climate and N^1.5 process evolution. It prints the assumptions and half/double-cost sensitivity;
these are engineering projections, not confidence intervals.

Estimates do not change a recipe. Generation always completes the requested
physical interval, landscape batches, and spacing criteria. There is no elapsed-
time cutoff, hidden cell budget, or automatic reduction in refinement strength.

## Historical 2.15 generation memory

The measured 15 km serial run reached 3.90 million surface cells, with a
5.85 GiB generation peak and a 6.02 GiB peak including recipe serialization and
snapshot transfer. Its 71.9 MB resolved recipe serialized in 371 ms; ownership
transfer took 1.01 seconds. Those observations do not include browser/GPU rendering.
The serial run predates the three new preflight cost-estimation stages; those
added diagnostics do not change geometry or physics.

The 10 km headless run reached 8.25 million surface cells after remeshing from
564,209 to 2,165,929 and then 8,251,214 cells. Both sediment-volume remap residuals
were below 6.1×10⁻¹¹ relative error. Its generation and publication peak was
11.48 GiB, with no cgroup memory-limit or OOM events. Recipe serialization took
566 ms, writing took 78 ms, and ownership transfer took 1.52 seconds. The retained
typed buffers alone occupy 6.39 GiB; saved-plan arrays and transient work are extra.

These measured 2.15 headless workloads fit this executor's 16 GiB limit without
generation paging. This result does not establish the cost of the 2.16 physics,
display-index preparation, browser viewer, or larger/freshly planned workloads.
Conservative remapping can temporarily hold old and new grids plus intersection
data. The 2.15 renderer additionally retained a complete in-memory world; the
2.16 viewer instead opens bounded snapshot pages and render packets. Generation
and regional refinement still require the complete physical state in a compute
worker. A low retained-buffer count alone does not prove that a workload fits.

## 2.15 renderer memory ownership (historical)

The following are analytical allocation estimates from the previous full-world
2.15 renderer, not browser measurements. The 2.16 paged viewer replaces these
full-grid render allocations with bounded tiles. Let N be the final surface-cell count; a closed triangular
sphere has approximately 2N corners and 6N directed cell adjacencies. The rounded
8.8-million-cell example is hypothetical and is separate from the measured runs
above. GiB means 2³⁰ bytes.

| Component                                    | Additional CPU ownership |             GPU ownership | At 8.8 million cells, CPU / GPU |
| -------------------------------------------- | -----------------------: | ------------------------: | ------------------------------: |
| Natural globe                                |               109N bytes |                132N bytes |                 0.89 / 1.08 GiB |
| Natural flat map, instead of globe           |               145N bytes |                144N bytes |                 1.19 / 1.18 GiB |
| Categorical globe, alongside natural surface |               380N bytes |                296N bytes |                 3.11 / 2.43 GiB |
| River construction scratch                   |     82N bytes, temporary |   Excludes river geometry |                    0.67 GiB / — |
| Riverbank texture                            |                   32 MiB | About 43 MiB with mipmaps |                     32 / 43 MiB |

The natural globe reuses the core triangle-index buffer on the CPU but uploads it
to the GPU. Its attributes and cached delta mask are additional CPU allocations.
The categorical mesh has about 7N vertices, its own indices, and a separate
position copy for plate drift. Switching layers hides the natural surface rather
than freeing it; both meshes remain allocated. River scratch includes full-corner
lookup arrays and routing summaries, before variable-size ribbon arrays, typed
geometry, and GPU copies. Texture baking also builds a separate 24N-byte river
lookup scratch allocation.

Flat-map conversion copies attributes and indices and temporarily allocates
longitude/latitude arrays. At the hypothetical size, overlapping natural-map
attribute copies can require roughly 2.3 GiB CPU during construction; categorical
map conversion can require roughly 5.8 GiB CPU in addition to the natural mesh.
Full grid lines add at least 1.18 GiB of JavaScript numeric storage, 0.59 GiB of
CPU typed positions, and 0.59 GiB of GPU positions. These estimates exclude array
capacity overhead, browser/driver allocations, render targets, and river/oxbow
geometry. Temporary allocations from different stages need not overlap.

In 2.15, world publication transferred unique typed buffers to the viewer rather
than copying them; refinement-plan JavaScript arrays still underwent structured
cloning. The 2.16 publication path commits a snapshot and sends only its handle.
In both versions, `world.bytes` excludes saved-plan JavaScript arrays, renderer
allocations, and GPU memory. A core-generation RSS peak therefore cannot establish
an end-to-end browser memory ceiling, nor should it simply be added to allocations
that occur after its scratch data is released. GPU memory may be separate or
shared with system RAM. The 2.16 viewer implements bounded rendering and paged
publication, but the historical multi-million-cell runs remain generation-only
evidence until that complete interactive workload is measured.

## Paged reader and habitat display in 2.16

Saved snapshots include an exact nearest-center spatial index and spatially ordered
render records. A cold viewer reads these pages without restoring the full physical
world. Its reader caches at most 32 MiB of raw pages, 4 MiB of metadata, sixteen
483,328-byte render blocks, 128 spatial leaves and 4,096 spatial nodes. Smooth
height interpolation adds sixteen 196,608-byte triangle blocks, sixteen
8,192-byte starting-face blocks and thirty-two 49,152-byte position blocks
(4.625 MiB combined at their limits). Request packets and render/GPU tile caches
are additional bounded ownership. Saving a world
still prepares the complete display index beside the resident physical world;
paged viewing does not make generation or regional remeshing out of core.

Terrain geometry and natural material fields use radial barycentric interpolation
on the saved primal triangles. Shared edges have continuous heights, vegetation,
land/water masks and seasonal shading, even when the display grid is finer than
the physical cells. Categories and inspection retain exact nearest-cell
ownership. The packed topology adds about 52 bytes per physical cell to the saved
display index; positions and height records are reused. Full-world library storage
first ships in 2.16, with view-index format 2. Earlier recipe files still regenerate
compatible snapshots.

All 29 layer palettes and four seasons plus annual values use the same physical
fields and color rules as the previous renderer. Natural surface
attributes preserve temperature, vegetation, snow, wetlands, water coverage,
incision and delta tint. Riverbanks now use the saved cell's riparian coverage and
strength in the tile shader. This is a cell-scale habitat tint: the previous
full-world raster represented narrow, asymmetric bank strips with seasonal flood
color. Actual river, delta and oxbow curves remain separate spatial overlays.
Matching those narrow bank strips in a paged viewer would require bounded tile
rasters of the indexed bank geometry; it is not claimed by the current tint.

Run `node --expose-gc --import tsx scripts/measure-paged-view.ts` for a reproducible
codec and query benchmark. It uses in-memory fake IndexedDB, so its storage latency
and process memory do not measure browser disk I/O or browser rendering.

A Quick recipe run with interpolated natural attributes on 2026-10-12 produced
27,227 cells and a 10.28 MiB display sidecar. Preparation took 0.14 s, saving 1.20 s,
a cold 16,384-point categorical sample 0.34 s, a warm natural-material sample
0.40 s, detailed inspection 12 ms, and bounded overlays 0.15 s. The reader retained 14.74 MiB of raw
pages, 0.19 MiB of metadata, eight render blocks, 65 spatial leaves, six triangle
blocks, eight starting-face blocks and eight position blocks. These measurements
establish query behavior and cache bounds rather than browser I/O speed. See
[the paged-view report](../../observations/measurements/paged-view-quick-2.16.json) for the full report.

## Browser integration checks in 2.16

Chromium 154 with SwiftShader and software compositing completed the real browser
workflows on the default 10,242-cell world: save, rename, cold reload without a
compute worker, export, regional refinement to 10,346 cells, recipe replay, exact
cell restoration, cancellation, and deletion. Failure injection verified that a
failed Open remains visible in the library and a stale failed Delete cannot
cancel newer generation.

Globe/map navigation, five zoom steps on each projection, orbit/pan, June/December,
Natural/relief/Ink styles, actual picking, and regional controls passed without
browser errors. Observed peaks were 64 active tiles, 128 resident tiles, four
pending requests, 10.63 MiB of tile data and 33.08 MiB of accounted display data
including overlays and the Ink texture atlas. The Natural view submitted no new
GPU frames during a 1.5-second settled idle check. These small-world interaction
checks establish behavior and cache limits, not total browser RSS or a frame-rate
guarantee for multi-million-cell worlds.

Reports: [workflows](../../observations/measurements/browser-workflows-2.16.json),
[library failures](../../observations/measurements/browser-library-failures-2.16.json), and
[rendering](../../observations/measurements/browser-render-2.16.json).
