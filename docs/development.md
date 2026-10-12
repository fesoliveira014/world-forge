# Development guide

## Local workflow

Use Node.js 22.13 or newer. Run `npm ci`, then `npm run dev`. The standalone Vite
application needs no hosting credentials or Bash wrapper. `npm run build`
type-checks and creates `dist/`; `npm run preview` serves that output.

Start with `src/core/pipeline.ts`. `generateWorld` lists the stages in execution order; each stage lives in `src/core/generation/`. The core has no React or three.js dependency. `src/core/model.ts` defines the snapshot, field units, and array layouts.

## Names and layout

- Use names that describe the value's role: `receiverCorner`, `processCell`, `seasonIndex`, `accumulatedRain`, and `riverThreshold`.
- Distinguish cell IDs, corner IDs, adjacency offsets, and vertex-buffer offsets. They are different index spaces even when all are numbers.
- Keep conventional `x`, `y`, and `z` in coordinate formulas. Expand ambiguous abbreviations elsewhere. Prefer verbs for operations, such as `computeDistances`, `sampleCellColor`, and `collectWorldBuffers`.
- Declare one variable per statement. Use braces for every conditional and loop, including early returns.
- Separate setup, traversal, updates, and result assembly with blank lines. Explain the purpose of a pass and its assumptions rather than narrating individual assignments.
- Keep numerical operations and iteration order explicit. Seeded generation, floating-point accumulation, and reservoir routing can depend on that order.

## Finding the relevant code

| Task                                     | Start here                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| Change mineral placement / amount        | `generation/resources.ts` and `resource-presets.ts`                                    |
| Change fertility / its explanation       | `generation/fertility.ts` and `src/app/ResourceInspector.tsx`                          |
| Change a generation parameter            | `src/core/config.ts` and `src/core/model.ts`                                           |
| Follow generation and feedback           | `src/core/pipeline.ts`                                                                 |
| Understand spherical topology            | `src/core/grid/build.ts` and the `Grid` interface                                      |
| Follow moisture and soil water           | `generation/climate.ts` and `generation/land-water.ts`                                 |
| Follow a river and its destination       | `generation/drainage.ts`, `lake-surfaces.ts`, and `rivers.ts`                          |
| Change camera or pointer behavior        | `src/render/WorldView.tsx`                                                             |
| Change cell or overlay mesh construction | `src/render/WorldMeshes.ts`                                                            |
| Change river geometry                    | `src/render/RiverGeometry.ts`, `RiverCurve.ts`, `RiverRibbon.ts`, and `RiverStrips.ts` |
| Change artistic styles or symbols        | `src/render/MapStyle.ts` and `CartographicSymbols.ts`                                  |
| Change flat-map relief                   | `src/render/projection.ts` and `WaterSurface.ts`                                       |
| Change surface colors or banks           | `src/render/NaturalSurface.ts`, `palette.ts`, and `RiverbankTexture.ts`                |
| Change controls or inspection            | `src/app/WorldStudio.tsx`, `controls.tsx`, and `Inspector.tsx`                         |
| Change worker messages                   | `src/app/generation-messages.ts`                                                       |

Generation paths in the table are relative to `src/core/`.

## Data and rendering conventions

The surface grid resolves terrain and water. The process grid carries plate evolution and climate. `world.transfer[cellIndex]` maps a surface cell to its process cell. Packed vectors use three consecutive numbers; cell adjacency uses `offsets`, while every corner has three incident cells and three neighboring corners.

Keep snapshot and project-file field names stable. `pet`, `aet`, and `sst` are documented conventional fields; local calculations use `potentialEvapotranspiration`, `actualEvapotranspiration`, and `seaSurfaceTemperature`. Renaming a local value must not silently rename its serialized key.

Keep shaders in readable `/* glsl */` template strings, with one declaration per line and named intermediate values. Reuse buffers and scratch vectors in rendering loops. A readability change should not add per-frame allocations or change the shader formulas.

## Formatting and verification

Run `npm run format` to format all authored TypeScript, application styles, tests, measurement scripts, and relevant configuration files. `npm run format:check` checks the same files without rewriting them. The project uses two spaces, semicolons, single quotes, and a 100-column target. `.editorconfig` supplies matching editor defaults; ESLint requires braces and separate declarations in `src/`.

Use `npm run typecheck` and the existing `npm test` suite for substantive code changes. For a numerical refactor, compare a small deterministic world before and after the change. Preserve arithmetic order, field shapes, seeded streams, and the generator version when behavior is unchanged. Large-world benchmarks and browser tests are separate tasks, not routine cleanup requirements.

The eight retained primitives live in `src/components/ui/`. Preserve their Radix
behavior and third-party notices when editing them. Add helpers for clear
responsibilities; avoid a generic framework around generation stages.

## Optional measurements

```sh
npm run measure -- examples/AETHER-0004.json 5 4
npm run measure:tectonics -- AETHER-0004 4 5
```

The first command reports full-generation stage times and water diagnostics with
explicit surface/process levels. The second compares initial and evolved terrain
without climate. Measurements depend on the machine and are not CI thresholds.

CI runs formatting, lint, the existing tests and the production build on Node 22.
Historical notes, observations, SVGs and third-party styles retain their original
formatting. Update the current architecture when boundaries change and link to
historical evidence instead of duplicating it in the README.
