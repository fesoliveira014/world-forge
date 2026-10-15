# Atlas 2.17: stable physical detail and connected rivers

## Objective

Render the generated world without camera-dependent resampling. Restore the river
appearance and network continuity that were lost in the paged renderer, while
retaining worker execution, paged snapshots, inspection and explicit manual saving.

## Milestones

1. **Define render-only packets.** Prepare immutable spatial batches from the saved
   physical triangulation and exact per-cell display records. Read saved arrays
   sequentially in a worker. Define complete river packets independent of viewport
   and unrelated overlay budgets. Existing saved worlds must remain readable.
2. **Restore surface and river fidelity.** Make fixed physical geometry the default.
   Camera movement may cull draw batches but must not alter their vertices,
   topology or material resolution. Retain styles, seasons and diagnostic layers.
   Restore connected river curves, joins, discharge widths/taper, water endpoints,
   seasonal/source/animated styling and bank corridors.
3. **Verify visual and performance behavior.** Use the same saved 2,621,442-cell world
   for globe, flat map, poles, close river views and all map styles. Exercise zoom,
   rotation, overlays, season/layer changes, world replacement and manual saving.
   Record actual buffers, load time, navigation frame time and screenshots. Treat
   visual failures as failures even when unit tests pass.
4. **Release.** Run relevant geometry/worker/regression tests, typecheck and a
   production build; publish the reviewed source to the existing private Atlas
   site and document measured limits.

## Acceptance criteria

- Every physical surface triangle is represented without zoom-dependent replacement.
- Rotating or zooming a loaded world does not request replacement terrain samples.
- Fixed batches share consistent boundary positions, material values and normals.
- Map seams and poles have no stretched cross-world triangles, holes or texture jumps.
- Diagnostic categories keep physical cell ownership and selection agrees with inspection.
- Complete selected river networks retain bends and connected junctions. Grid,
  coast and other overlay toggles do not consume the river detail budget.
- River widths, smooth joins, endpoint anchoring, seasonal activity, source colors,
  flow animation and bank coverage are verified against the previous visual design.
- Old snapshot readers remain bounded; render buffers are measured separately.
  Closing/replacing a view releases its workers and GPU resources.
- Generation creates an unsaved working world. Only the explicit Save action adds
  it to the saved library; rendering must not change these semantics.

## Design constraints

The renderer receives compact display data, not a complete simulation `World`.
Spatial batching is an implementation detail with fixed quality. No silent return
to sampled terrain or additional simulation/refinement is allowed. GPU buffer
estimates are planning figures until measured on the high-resolution fixture.

Large-world loading and memory are explicit costs of preserving the generated
mesh. If an actual resource limit is reached, report it clearly instead of
quietly removing terrain detail.

## Execution record

### Packets and renderer

- Implemented fixed 4,096-face terrain batches from the saved primal mesh, exact
  dual polygons for categorical fields, packed material attributes and continuous
  physical normals. Projection retains category ownership and packed precision
  at seams and poles.
- Replaced camera-dependent tile refinement with retained physical packets.
  Frustum culling changes visibility only. Styles and projection reuse packets;
  a new layer or season reads the corresponding saved fields.
- Restored complete connected river courses, shared flow phase, endpoint anchors,
  seasonal/source styling and independent bank corridors. River preparation has
  its own worker, with cancellation when the selected season or threshold changes.
- Replaced overlapping inner joins with shared offset intersections and one
  outer bevel. Tight bends bound the visual width before batching; a 0.03
  width-per-distance envelope prevents repeated flares between meanders. The
  saved centerline, discharge, physical channel widths and banks are unchanged.
- Limited graphics submission to one outstanding frame using nonblocking WebGL2
  fences. Progressive loading is paced without simplifying the mesh. Bank atlas
  uploads are combined after river installation.

### Verification

The full automated suite passes **275 tests**, and typecheck and formatting
checks pass. The tests cover exact saved terrain, category ownership, packed
projection fields, connected river curves and phase, complete packet transfer,
worker cancellation, bank eligibility, and manual saving. An actual failing
high-resolution river fixture now has zero multiply covered triangle interiors;
splitting that path into packets preserves every position and flow attribute.
Dense resampling preserves the bend bound, and straight channels retain their
original width. A distant straight reach recovers its wider original stroke.

The existing 2,621,442-cell snapshot loads without regeneration. Its measured
production renderer (Chromium using SwiftShader software graphics, 2,048 × 1,140
viewport, Natural flat map, annual season, river threshold 20) contains:

| Measurement | Final production result |
| --- | ---: |
| Physical terrain triangles | 5,242,880 |
| Terrain triangles after flat-map seam/pole expansion | 5,249,568 |
| Total drawn terrain and river triangles | 9,403,321 |
| Fixed terrain batches | 1,280 |
| River packet batches, including bank-only paths | 181 |
| Terrain requests, including manifest | 1,281 |
| Accounted retained display bytes | 1,098,175,047 (1.02 GiB) |
| Fresh opening through completed full-detail frame | 184.3 seconds |
| Full-map graphics frame completion | 7.84 seconds |
| Close river view graphics frame completion | 581.9 ms |

These are software-GPU measurements, not hardware-GPU frame-rate claims.
Accounted display bytes include retained CPU arrays and estimated GPU copies;
they exclude workers, browser/driver overhead and temporary allocations. The
large world preserves its generated detail but is expensive to load and slow to
navigate on this machine. Lower-resolution worlds remain available as an
explicit generation choice; camera motion never silently lowers detail.

Additional browser checks:

- Ten fresh captures on the same saved 10,242-cell world cover all three map
  styles, river visibility, June/December activity, source colors and a north
  polar globe at the default 26× relief. No browser or shader errors occurred.
  More than 99.97% of final river pixels match the pre-paging courses within
  two pixels. Reverse coverage is 94.0–94.4% because the bend safety correction
  deliberately narrows previously over-wide strokes; exact old stroke geometry
  is not claimed. A separate three-camera globe orbit/zoom check at 26× relief
  retained identical packet requests and made zero `sample()` calls.
- A fresh production opening used the new packet fields and renderer without
  diagnostic overrides. It produced no application or shader errors. The final
  close-up removes the repeated triangular overlaps and meander-width flares.
  Its 1,398,027 visible triangles are culled from the complete resident world.
  Terrain and river requests remained at 1,281 and 181 after navigation;
  `sample()` was never called. Short lake connectors still follow their coarser
  saved courses and can look broader than curvature-limited neighboring rivers.
- The complete north and south polar views are closed, with no radial texture
  warp or meridian hole. Moving between them left terrain and river request
  counts unchanged at 1,281 and 181.
- The south-pole coastline toggle changed 14,116 image pixels above a 12-level
  RGB threshold in a matched camera pair. The global physical grid reports
  `zoom-in`; a close globe view resolves 752 physical edge segments without
  truncation. That close view draws 684,032 triangles in 168 calls, with a
  measured 410 ms graphics-frame completion on SwiftShader. All physical mesh
  packets remain resident during culling.
- Ten actual-app manual-save checks passed with no page or console errors:
  unsaved generation and an empty library; closing the save dialog; failure
  preserving the readable draft; explicit named publication of the same pages;
  another generation; generation cancellation; unsaved refinement; transaction
  cancellation; replacing a draft with a saved world; and reload restoring only
  explicitly saved worlds. This separate storage/UI run disabled WebGL and
  injected the regional anchor callback; rendering and picking were not its
  subject.
