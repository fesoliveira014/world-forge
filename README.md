# World Forge

A TypeScript planet-generation prototype for worldbuilding. Explore a generated
world as a globe or flat map, inspect its physical fields, and choose natural,
relief, fantasy-cartography or grayscale heightmap styles.

Application and generator **2.28.0**. This is the standalone React/Vite edition
of the browser prototype; [the changelog](CHANGELOG.md) records source provenance.

![Shaded-relief map](docs/observations/art-styles/relief-map.png)

## Run locally

Use Node.js **22.13 or newer** and npm.

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite. Generation runs in browser workers, with up
to four independent seasonal climate workers. No account, environment variables
or server API is required. The world library uses browser-local IndexedDB.

```sh
npm run build
npm run preview
```

The build produces a static application in `dist/`. Serve it over HTTP; opening
`index.html` directly from disk does not provide the module-worker environment
the app needs. Relative asset paths support hosting beneath a URL prefix.

## Explore

- Change the seed and generation settings, then choose **Generate world**.
- Inspect tectonics, climate, rivers, lakes, wetlands, vegetation, minerals and fertility.
- Switch between Globe and Flat map, choose a season, or change the map style.
  Classic parchment, Engraved explorer and Painted fantasy atlas illustrate
  mountain ranges and woodland; Heightmap maps low elevations to black and high
  elevations to white.
- Click a cell or deposit for its values and explanatory details. Salinity-aware
  worlds include lake/river concentration and local soil effects.
- Use adaptive detail during generation, bounded automatic final feature passes,
  or **Refine region** on an existing world. Lake districts can receive more cells;
  optional quiet-land simplification removes detail from suitable interiors.
- Use **Save world** to retain the complete physical state in this browser's
  library. Saving is manual; generating or refining does not add a library entry.
- Use **Export recipe** and **Import recipe** to exchange JSON reconstruction
  settings, including resolved refinement history. Examples are in
  [`examples/`](examples/).

The local library belongs to the browser and origin; it is not a cross-device
backup. Recipes contain reconstruction instructions rather than complete worlds.
Exact reproduction requires a compatible generator version. Older recipes receive
explicit compatibility defaults; old snapshots keep unknown salinity until a new
world is generated.

Physical detail stays fixed while navigating. Optional **Zoom detail** adds a
bounded display-only reconstruction from existing samples. Finer physical meshes
and higher weather detail still cost generation memory and time; the fixed mesh
renderer also scales with world size. Quality presets provide starting points,
not performance guarantees.

## Develop

| Command                                            | Purpose                                            |
| -------------------------------------------------- | -------------------------------------------------- |
| `npm run dev`                                      | Development server                                 |
| `npm run build`                                    | Type-check and build the static application        |
| `npm run preview`                                  | Serve the production build locally                 |
| `npm run typecheck`                                | Check TypeScript without building                  |
| `npm test`                                         | Run numerical, storage, worker and rendering tests |
| `npm run lint`                                     | Check source conventions and unused code           |
| `npm run format`                                   | Format maintained source and documentation         |
| `npm run format:check`                             | Check formatting                                   |
| `npm run measure -- examples/AETHER-0004.json 5 4` | Measure a world at explicit detail levels          |

Start with [`src/core/pipeline.ts`](src/core/pipeline.ts) for generation,
[`src/core/model.ts`](src/core/model.ts) for fields and units, and
[`src/render/PagedWorldView.tsx`](src/render/PagedWorldView.tsx) for the active viewer.

| Directory            | Responsibility                                                           |
| -------------------- | ------------------------------------------------------------------------ |
| `src/core/`          | Spherical grids, deterministic generation, snapshots and bounded readers |
| `src/app/`           | Editor, inspection, saved-world library and worker lifecycle             |
| `src/render/`        | Three.js meshes, materials, projections and overlays                     |
| `src/components/ui/` | Shared UI primitives used by the editor                                  |
| `tests/`             | Numerical, data-contract, storage, worker and geometry checks            |
| `scripts/`           | Optional generation, refinement, rendering and salinity measurements     |
| `docs/`              | Architecture, algorithms, development notes and historical evidence      |

## Documentation

The [documentation index](docs/README.md) is the entry point.

- [Architecture](docs/architecture.md): current boundaries, data flow and ownership.
- [Illustrated algorithms](docs/algorithms.md): formulas, diagrams and worked examples.
- [Development guide](docs/development.md): naming, array conventions and checks.
- [History](docs/history/README.md): revision notes, proposals and comparisons.
- [Changelog](CHANGELOG.md): repository preparation and source provenance.

This is an approximate worldbuilding model: plate motion is prescribed, climate
uses representative seasons, and river, resource and salinity processes use
simplified physical or procedural models. Salt accumulation has its own explicit
interval; oceanic crust alone does not establish a salt source. The documentation
identifies the models' limits. Civilizations, mining and irrigation are future work.

Third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
