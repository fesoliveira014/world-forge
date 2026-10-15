# Atlas 2.19: bounded visual zoom refinement

## Behavior

The generated physical mesh remains the permanent minimum detail. The default-on
**Zoom detail** display toggle adds temporary interior vertices near the camera's
view centre when original faces become large on screen. It applies to Natural
globe and Shaded relief globe/map views. Natural flat maps and Ink atlas keep
their existing presentation; diagnostic layers and physical-cell picking do not
change. Manual regional refinement remains a separate simulation operation.

The implementation interpolates saved one-ring slope normals to reconstruct a
limited interior height curve. It adds no noise, geology, erosion, runoff, lakes,
or drainage decisions. It does not sharpen the climate/vegetation inputs or the
riverbank atlas. This is additional terrain shape from existing samples, not new
measured or simulated geographic information.

## Boundaries and water

Each selected physical triangle keeps its three original corners and unsplit
edges. A triangular interior lattice joins those edges through a triangulated
collar. Different subdivision levels meet without skirts, T-junctions, or changes
to neighbouring faces. Height correction and its first derivative are zero on
every original edge. This preserves the original face boundary; it does not claim
globally smooth derivatives across the old triangulation.

Quadratic Hermite controls derived from saved slopes are constrained by endpoint
heights. An interior blending function limits correction to at most 20% of the
parent face's height range and prevents overshooting that range. Faces touching
any ocean/lake coverage, sea level, or a flat surface receive no reconstruction.
The original displayed triangle, including its sphere chord or projected map
positions, remains the base; even a protected face cannot acquire a radial bulge.

A conservative 3D index references the existing compact river asset. The whole
parent face is protected if it intersects a river or oxbow corridor, including
the maximum river width setting. This avoids missing a narrow channel between
fine samples. River paths, flow phases, widths, bank atlas and original data are
unchanged. Map seam/pole faces retain their existing projection-specific geometry.

## Camera work and resources

- Up to 384 nearby candidate faces; up to 32 affected physical batches.
- At most 32,760 temporary vertices per patch, including copied original corners.
  At most one installed patch and one replacement generation coexist.
- A single merged patch draw, with shared terrain material. Affected base batches
  use temporary indices sharing all original vertex attributes. They replace
  their original draw, rather than drawing twice.
- Visibility tests use retained batch bounds and actual projected face sizes.
  A cached maximum edge and a conservative projection bound reject entire batches
  when every edge is below the refinement threshold, including wide globe views.
  No world-sized candidate array or per-frame complete topology scan is allocated.
  Selection/build work is cooperative, normally sliced to 3 ms per animation tick;
  individual generator operations can exceed that target.
- 36-pixel activation / 26-pixel retention thresholds and level hysteresis reduce
  threshold chatter. New selection starts after a short quiet interval or during
  sustained movement. The completed old surface stays visible while work runs.
- An installed patch morphs back to its original parent surface over 180 ms before
  replacement; the completed replacement morphs in over 240 ms. Nothing replaces
  generated physical detail with a coarser world mesh.
- Zooming out or disabling the feature frees extra geometry and constraints.
  Layer, style, relief, season, snapshot and projection changes cancel old work.
  Failure restores the original complete physical surface.

Material fields use floating-point interpolation for temporary vertices,
decoding paired 16-bit values before interpolation. Original direction and normal
varyings are preserved at zero displacement, so adding a vertex does not quantize
colors or resample geography. No additional terrain/river reader request, storage
cache, or saved-world modification is part of zoom refinement.

The cap bounds added detail, not the full world's existing CPU/GPU memory. The
river constraint index scales with the retained network and is measured separately.
Canvas diagnostics report patch vertices, faces, triangles, build time, accounted
buffer bytes, constraint bytes, morph progress and state. Buffer estimates exclude
JavaScript object overhead, construction scratch and graphics-driver allocations.

## Verification

Focused tests cover reconstruction bounds, preserved edge derivatives and water,
topology manifoldness, winding and coverage, bounded selection, camera snapshot
and hysteresis, river seams/poles and corridor widths, cancellation, shared buffer
ownership, exact material/normal interpolation, projected seam/pole preservation,
and all supported material shaders. Browser results and release verification are
recorded in the release notes.

Application version is 2.19.0. Generator identity remains 2.17.1; existing saved
worlds need no migration or regeneration, and saving remains manual.
