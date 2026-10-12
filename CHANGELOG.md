# Changelog

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
