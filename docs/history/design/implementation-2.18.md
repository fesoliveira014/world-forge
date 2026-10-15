# Atlas 2.18: shared display resources

## Scope

Implement the three selected memory improvements while preserving the complete
physical terrain, connected river geometry and existing rendering order:

1. Share unchanged terrain attributes and indices with their immutable packets
   when map projection needs no seam or pole expansion.
2. Retain one compact river asset and bank atlas across scene recreation, and
   release bank-painting inputs once consumed.
3. Share one terrain material for the active appearance, with explicit ownership
   and disposal separate from individual terrain meshes.

This release does not introduce horizon culling, merged draw batches, multi-draw,
quantized geometry, camera-dependent resolution changes or additional disk caches.
Application version is 2.18.0; generator identity remains 2.17.0.

## Acceptance criteria

- Physical vertices, triangle order, category ownership and river attributes agree
  with 2.17.0, including seam and pole interpolation.
- Projection, relief and style changes preserve picking and riverbank coverage.
- Camera movement and projection changes reuse retained packets without requesting
  replacement surface or river data.
- Shared materials and textures remain live while needed and are released when
  their owner is replaced or unmounted. Stale asynchronous replies cannot revive
  a released asset.
- Compare unique retained CPU buffers and estimated GPU buffers on the same saved
  2,621,442-cell world. Distinguish steady memory from temporary allocations,
  worker memory, browser overhead and graphics-driver allocations.
- Run focused ownership/projection tests, the full regression suite, typecheck,
  formatting and production build, plus browser comparisons at matching cameras.

## Verification record

Measurements and release verification are recorded in [the release notes](../revisions/2.18.0.md).
