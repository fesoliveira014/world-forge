# Development guide

## Local workflow

Use Node.js 22.13 or newer. Run `npm ci`, then `npm run dev`. The standalone Vite
application needs no hosting credentials or Bash wrapper. `npm run build`
type-checks and creates `dist/`; `npm run preview` serves that static output.

Start with `src/core/pipeline.ts`. Its bounded generation stages live in
`src/core/generation/`. The core has no React or Three.js dependency.
`src/core/model.ts` defines fields, units and array layouts. The active browser
viewer is `src/render/PagedWorldView.tsx`; its data source is a small snapshot
handle and `src/app/WorldDataClient.ts`, not a complete world in React state.

## Names and layout

- Use names that describe a value's role: `receiverCorner`, `processCell`,
  `seasonIndex`, `accumulatedRain` and `riverThreshold`.
- Distinguish cell IDs, corner IDs, adjacency offsets and vertex-buffer offsets.
  They are different index spaces even when all are numbers.
- Keep conventional `x`, `y` and `z` in coordinate formulas. Expand ambiguous
  abbreviations elsewhere. Prefer verbs for operations.
- Declare one variable per statement. Use braces for conditionals and loops,
  including early returns.
- Separate setup, traversal, updates and assembly with blank lines. Explain a
  pass's purpose and assumptions rather than narrating individual assignments.
- Keep numerical operations and iteration order explicit. Seeded generation,
  floating-point accumulation and reservoir routing can depend on that order.

## Finding the relevant code

| Task                                           | Start here                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| Generation parameters and compatibility        | `src/core/config.ts`, `model.ts`, `project.ts`                                         |
| Generation order and feedback                  | `src/core/pipeline.ts`                                                                 |
| Initial/evolved adaptive meshes                | `src/core/grid/refine.ts`, `refinement-plan.ts`                                        |
| Final feature selection and quiet-land removal | `src/core/grid/feature-refinement.ts`, `feature-districts.ts`, `feature-coarsening.ts` |
| Existing-world physical refinement             | `src/core/regional-refinement.ts`, `operators/remap.ts`                                |
| Moisture and soil water                        | `src/core/generation/climate.ts`, `land-water.ts`                                      |
| Rivers and receiving lakes                     | `src/core/generation/drainage.ts`, `lake-surfaces.ts`, `rivers.ts`                     |
| Salt budget and ecological salt stress         | `src/core/generation/salinity.ts`, `lake-state.ts`, `ecology.ts`, `fertility.ts`       |
| Mineral placement and amounts                  | `src/core/generation/resources.ts`, `resource-presets.ts`                              |
| Snapshot persistence and reader caches         | `src/core/storage/`, `src/core/view/`                                                  |
| Reader-worker ownership                        | `src/app/WorldDataClient.ts`, `reader.worker.ts`                                       |
| Camera and renderer lifetime                   | `src/render/PagedWorldView.tsx`                                                        |
| Fixed terrain and batching                     | `src/render/FixedSurface.ts`, `TerrainBatchRenderer.ts`                                |
| Physical cell grid                             | `src/render/FixedGrid.ts`, `FixedGridCache.ts`                                         |
| River geometry and retained assets             | `src/render/FixedRivers.ts`, `RiverGeometry.ts`, `RiverCurve.ts`                       |
| Wind and current trails                        | `src/render/PagedFlowTrails.ts`, `src/core/view/flow-paths.ts`                         |
| Visual zoom refinement                         | `src/render/ZoomDetail.ts`, `ZoomSurface.ts`, `ZoomSelection.ts`                       |
| Fantasy styles and geographic symbols          | `src/render/FantasyStyle.ts`, `FantasyRidges.ts`, `FantasyLandCover.ts`                |
| Controls and inspection                        | `src/app/WorldStudio.tsx`, `Inspector.tsx`, `ResourceInspector.tsx`                    |
| Compute messages and seasonal concurrency      | `src/app/generation-messages.ts`, `climate-pool.ts`                                    |

Paths without a repeated prefix in a row are relative to the first path's directory.

## Data and lifetime conventions

The adaptive surface resolves terrain and water; the process grid owns broad
geology and climate. `world.transfer[cellIndex]` maps surface cells to process
cells. Packed vectors use three consecutive numbers; cell adjacency uses offsets,
while each corner has three incident cells and neighboring corners.

Keep snapshot and recipe field names stable. A local variable rename must not
silently rename its serialized key. Add compatibility defaults deliberately and
test old recipes/snapshots. Unknown legacy salinity is different from zero salt.
Resolved refinement/coarsening plans must validate against their mesh and config.

Distinguish intensive fields from inventories. Remapping concentration alone can
create or lose salt; transfer the geographic mass inventory and derive
concentration under the new water ownership. Numerical iterations and physical
refinement do not advance erosion or salinity clocks.

Saving is manual. New computation publishes a draft handle; explicit saving
promotes its metadata to the local library. Ensure cancellation, failed reads and
stale worker messages cannot replace a newer world or delete a promoted draft.
Terminate owned compute/reader lanes when their work is obsolete.

Rendering packets are immutable shared data where possible. A scene may borrow a
material, river asset or terrain buffer owned at a longer lifetime; disposing one
representation must not invalidate another. Keep culling independent of physical
mesh detail and retain CPU positions needed for picking and zoom reconstruction.

Keep shaders in readable `/* glsl */` template strings with named intermediate
values. Reuse buffers and scratch vectors in frame loops. A readability change
should not add per-frame allocation or alter shader formulas.

## Formatting and verification

`npm run format` formats maintained TypeScript, styles, tests, scripts and current
documentation. `npm run format:check` checks the same files. Historical notes,
measurements, SVGs and third-party styles retain their original formatting. The
project uses two spaces, semicolons, single quotes and a 100-column target.

Run `npm run typecheck`, `npm run lint`, the relevant existing tests and the
production build for substantive changes. The full suite includes numerical
conservation, adaptive topology, storage roundtrips, stale-message lifecycles and
rendering geometry. Large-world measurements and browser checks are separate
from ordinary numerical tests. Verify visual changes in both globe and flat map,
including relevant seams, poles, seasons and camera movement.

Preserve arithmetic order, field shapes and seeded streams when a refactor claims
unchanged results. Changing physical behavior requires an appropriate generator
identity and compatibility decision. Record actual benchmark environment and
scope; software graphics do not establish hardware-GPU frame rates.

UI primitives live in `src/components/ui/`. Preserve their Radix behavior and
third-party notices. Prefer helpers with clear ownership over generic orchestration
frameworks around generation stages.

## Optional measurements

```sh
npm run measure -- examples/AETHER-0004.json 5 4
npm run measure -- examples/ATLAS-CLOUD-BALANCED.json --threads 4 --measure-view-index
npm run measure:tectonics -- AETHER-0004 4 5
node --import tsx scripts/measure-salinity.ts
```

The salinity script generates AETHER-2408 with 40,962 base terrain and weather
cells; its optional positional directory exports a browser fixture. It writes a
versioned report under `docs/observations/measurements/`.

The optional automatic-region benchmark consumes a baseline fixture produced by
the feature-refinement benchmark. Run them in this order from the repository root
when reproducing that comparison:

```sh
node --import tsx scripts/measure-feature-refinement.ts /tmp/feature-report.json
node --import tsx scripts/measure-auto-regions.ts /tmp/region-report.json
```

The first command creates `/tmp/atlas-final-feature-refinement-2.25.0/baseline`,
which the second script currently requires. These scripts reconstruct a recorded
recipe using current source; historical numeric results are not guaranteed after
physical model changes. They can take substantial time and memory.

Measurements report observed timing, memory, topology and physical budgets;
read each script's options before launching an expensive recipe. Reports under
`docs/observations/measurements/` retain their original generator version and
machine context. They are not CI performance thresholds.

CI checks formatting, lint, tests and production build on Node 22. Update the
current architecture when ownership or pipeline boundaries change, then link to
historical evidence rather than duplicating it in the README.
