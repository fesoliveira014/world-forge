# Atlas 2.16 implementation plan

## Goal

Make large generated worlds practical to explore and keep, allow local increases in resolution without restarting their history, and make sediment visibly reshape rivers and coasts. Preserve the current volcanic model.

## 1. Complete snapshots and paged access

- Introduce an independently versioned binary snapshot format. Preserve exact typed-array bits, shared buffers, object aliases, and resolved refinement histories.
- Persist immutable revisions in browser-local IndexedDB using bounded pages. Commit the manifest only after all pages and spatial indexes are stored. Failed or interrupted writes must leave the previous revision usable.
- Separate compute workers from a persistent snapshot reader. A full world exists only during generation or an explicit physical/edit operation. The page owns a small handle, visible render packets, and current inspection results.
- Store a spatial lookup with each snapshot. Cold viewing and picking must read bounded pages rather than reconstruct the entire world.
- Keep recipe import/export distinct from complete saved worlds. Add a local library with names, loading, and deletion. As of 2.16.2, generation writes temporary unlisted pages; only explicit **Save world** promotes them to the saved catalog.

Acceptance: exact graph roundtrip, real IndexedDB transactions, missing-page rejection, interrupted-save recovery, bounded cache residency, cold reload without generation, and no full `World` in React state. Solver edits still require the complete physical state in a compute worker; viewing is paged, not the global physics solver.

Complete snapshots belong to the current site's browser storage and remain subject to its quota and retention. The library is not a cross-device backup. Recipe export saves reconstruction instructions, including resolved refinement history; it does not export the complete physical snapshot. Exact retained state comes from opening the saved snapshot, while recipe import regenerates through the compatible generator.

## 2. Rendering with zoom-dependent detail

- Replace global surface and categorical meshes with a canonical spherical tile hierarchy independent of the adaptive simulation mesh.
- Sample authoritative fields into bounded packets. Preserve seasonal layers, categorical classifications, natural and art styles, and spatially filtered overlays.
- Bound CPU/GPU tile residency, discard stale responses, dispose evicted resources, and retain parents until replacement detail arrives.
- Support globe and map projections, including seams and poles. Pick a geographic direction and resolve the actual simulation cell through the reader.

Acceptance: globe/map inspection, layer/season changes, zoom refinement, continuous tile edges, pole/dateline coverage, stale-request rejection, and repeated navigation with cache memory staying within its budget.

Geometry heights and natural material attributes interpolate on the saved simulation triangles; categorical diagnostic colors and inspection retain exact nearest-cell ownership. Display zoom adds render samples without inserting simulation cells. Overlay packets have separate feature budgets and can omit additional features in a dense or broad viewport. Riverbank pigment currently uses cell-scale riparian coverage, rather than reproducing the earlier narrow, asymmetric, seasonal bank raster. Natural terrain, climate, water, wetland and delta attributes retain their original field rules.

## 3. Regional refinement

- Add radius and target-spacing controls anchored to a selected geographic point, plus watershed refinement where a drainage outlet is available.
- Refine the existing mesh and conservatively remap terrain. Rebuild global drainage, rivers, ecology, and fertility under the existing climate forcing.
- Preserve elapsed geological/erosional time, process geology, deposit identities, and sediment exports. Record regional operations separately from generation's fixed refinement passes.
- Prepare a new immutable draft before publishing the edit to the UI. Cancellation keeps the previous world visible. Only explicit **Save world** retains the edited revision in the library. Replay regional operations from recipe files.

Acceptance: a local mesh-density increase, sediment-volume conservation and bounded bedrock reconstruction, global downstream connectivity, deterministic replay, no repeated erosion or geological history, and cancellation/failed-save rollback.

Regional refinement resamples the existing evolved state. Loose sediment volume and area-integrated incision/deposition history use area-overlap transfer; bedrock and signed surface change use bounded interpolation, so total bedrock volume is not promised to remain identical. The atmospheric and ocean climate fields and their reference height remain fixed while land water, lakes and drainage are recalculated. Shorelines and flow paths can therefore move without any additional geological or erosion time. This operation does not synthesize new fine geological features or rerun volcanic construction.

The watershed option selects the complete river system sharing the selected channel's terminal outlet, including connected lakes; it is not just the catchment upstream of the selected point. A physical spacing transition extends beyond the chosen region or watershed. Global topology and water routing are rebuilt, and finer requests can still require substantial generation memory even though viewing is paged.

## 4. River and coastal sediment evolution

- Make river settling depend on physical reach distance instead of graph-hop count.
- Deposit transported material on accessible floodplains and point bars; account for eroded banks in the same sediment budget.
- Grow deltas through connected receiving-water accommodation rather than a fixed adjacent-cell deposit ring.
- Transport loose coastal sediment along the shoreline with stable substeps and donor limits. Preserve bedrock and avoid double-counting wave erosion.
- Track migration geographically where persistent state is needed, so remeshing does not restart it.

Acceptance: material-volume accounting, no negative sediment, zero-duration no-op, timestep/resolution checks, connected delta land growth, and bounded or inactive migration in confined channels.

The implemented operators advance the existing recent-landscape clock and leave volcanic construction unchanged. River settling uses a physical 120 km reference settling length, lengthened on steep reaches. Routed seasonal peak flow above an estimated bankfull threshold expands the accessible floodplain footprint and trapping; it supplies no additional sediment or water. Mouth fans search connected receiving water within a discharge-dependent 40–160 km reach and fill accommodation up to 3 m above the receiving datum. Unretained material remains explicit sediment export. Coastal drift moves only the available loose nearshore sediment with donor limits and physical CFL substeps; the existing geological wave-abrasion stage remains the source of wave-cut bedrock.

Migration retains sparse original spherical reach endpoints and bounded growth parameters. Outer-bank swept area funds actual point-bar deposition and downstream load; geographically matched inserted reaches sample the inherited bend and retain its clock. A changed receiver graph can introduce unmatched reaches with a new bounded migration sketch. These are effective landscape proxies: seasonal peaks are quarter-mean flows rather than individual floods; wind/current-driven coastal drift does not solve wave breaking, tides, or grain-size sorting; bends do not solve detailed bank hydraulics or reconstruct an avulsion chronology. Coastal transport operates on cells incident to an ocean shoreline, so the participating band's resolved width changes with mesh density. Narrow features remain cell-average material changes until the simulation mesh resolves them. Material budgets account for detachment, deposition and named export to terrain-storage precision, while individual shoreline positions and drainage paths can change with resolution.

## Integration and release

Implement the four tracks in parallel behind shared snapshot and view contracts. Run the existing regression suite plus meaningful new tests, typecheck, formatting, production build, and browser generation/save/reload/refine/cancel tests. Share screenshots during integration. Record measured limitations and storage costs with the tested source revision.

## Implementation result

All four tracks are implemented. Complete snapshots and paged readers now back
the UI; bounded tiles retain all projections, seasons and map styles; regional
operations prepare new revisions and replay from recipes; and the new river/coast
operators participate in the existing sediment budget and landscape clock.

The regression suite covers storage identity, bounded paging, conservative
transport, deterministic regional replay, continuous material sampling and tile
selection. Real browser checks cover generation/save/reload/refine/cancel and
library failure recovery, plus zoom/orbit/pan, seasons, styles and regional
selection. See [performance and validation evidence](cloud-performance.md) for
measured costs, browser reports and the remaining memory/display limitations.
The [2.16.2 update](../revisions/2.16.2.md) changes saving to explicit promotion,
raises the accounted tile budget to 192 MiB for dense materials, and restores
connected coast and complete local-grid overlays.
