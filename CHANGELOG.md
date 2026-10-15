# Changelog

## Standalone feature sync — 2026-10-15

Application and generator **2.28.0**, imported from source commit
`c493d030f956b02ba8c40255642769126450a5e8`.

- Added adaptive physical terrain, evolved-landscape remeshing and conservative
  river, hillslope, wind and coastal sediment transport.
- Added parallel seasonal climate workers, complete browser-local snapshots,
  manual saved-world library and existing-world regional refinement.
- Restored fixed physical detail with shared terrain/river assets, hidden-batch
  culling, batched terrain submission and bounded optional visual zoom detail.
- Added persistent cell grids, faster categorical geometry, moving wind/current
  trails, three fantasy map styles and a black-to-white elevation heightmap.
- Added automatic final feature refinement, lake-district detection and optional
  protected quiet-land coarsening with replayable mesh decisions.
- Added lake salt budgets, downstream salt transport and local salinity effects
  on vegetation and fertility, preserving salt mass across later refinements.
- Retained the standalone static React/Vite entry, portable commands, cleaned
  dependency/layout conventions and historical documentation archive.

The [2.14–2.28 revision archive](docs/history/README.md) includes implementation
limits and measured evidence. New physical behavior uses the current generator;
older recipes retain compatibility defaults and older snapshots keep unknown
salinity until regeneration. Saving remains manual.

## Standalone repository preparation — 2026-10-11

Based on application **2.13.2**, generator **2.13.0**, original source commit
`5a936635510eb553a20fc151c4f9df7a747d13b6`.

- Replaced the hosting-specific server shell with a static React/Vite entry point.
- Removed unused database examples, server handlers, hosting scripts and UI primitives.
- Kept dependencies used by the application and development commands.
- Declared the test runner explicitly and made commands portable across shells.
- Grouped runtime code under `src/` and applied consistent formatting and lint rules.
- Consolidated architecture copies and organized history, diagrams and measurements.
- Added GitHub Actions checks for formatting, lint, tests and build.

The generation algorithm and project-recipe version remain unchanged.

## Imported prototype milestones

| Application | Change                                         | Details                                      |
| ----------- | ---------------------------------------------- | -------------------------------------------- |
| 2.13.2      | Connected ink mountain ranges                  | [Revision](docs/history/revisions/2.13.2.md) |
| 2.13.1      | Elevation-scaled symbols and clearer shores    | [Revision](docs/history/revisions/2.13.1.md) |
| 2.13.0      | Faster climate and higher optional resolutions | [Revision](docs/history/revisions/2.13.0.md) |
| 2.12.0      | Seasonal lakes and smoother rainfall           | [Revision](docs/history/revisions/2.12.0.md) |
| 2.11.1      | River curves retained across display widths    | [Revision](docs/history/revisions/2.11.1.md) |
| 2.11.0      | Shaded relief and ink-atlas styles             | [Revision](docs/history/revisions/2.11.0.md) |
| 2.10.0      | Minerals, gemstones and fertility              | [Revision](docs/history/revisions/2.10.0.md) |

Earlier terrain, climate, rivers and rendering work is in the
[historical revision notes](docs/history/README.md).
