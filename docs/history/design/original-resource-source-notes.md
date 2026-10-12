# Source integration notes — resource architecture proposal

**Inspected input:** `worldbuilding_architecture_illustrated.zip` supplied in this conversation.  
**Source identity reported by the bundle:** World Forge / Atlas v2.4.1, revision `daead72ec2fd3c2c80b59dff2f693497d7b36044`.  
**Method:** Static inspection of the extracted architecture and the relevant TypeScript source. No source files were modified. No build, generator run, benchmark, or test suite was executed for this proposal.

The archive has no readable indexed text through the file reader, so it was inspected directly after extraction. Paths and line numbers below refer to the uploaded archive, not to a repository fetched later. The ZIP hash identifies the exact input bytes independently of the revision written in its documentation.

## 1. Input identity

`SHA-256: 90c6c104a9be36303d17c8e3dd33d0a3c68d54105284537ec9df9ee7501a9cef`

The supplied main document describes the current browser application and calls a native port optional. The user's latest request makes C3 the intended destination. The integrated proposal marks this as a new project-direction decision; it does not claim that C3 is already implemented.

## 2. Evidence map and interpretation

| Observation | Evidence in supplied archive | Consequence for the proposal |
| --- | --- | --- |
| The implemented runtime is generator v2.4.1. | Root architecture header; `source/src/core/model.ts:1–4`. | Use this snapshot, not the older prototype audit, as the baseline. |
| Broad geology and detailed environmental state are separate. | `model.ts:61–79,88–104,177–194`; `pipeline.ts:30–46`. | Process-grid provinces plus surface material/wood fields fit existing ownership. |
| Geology exports plate, continentalness, age-like noise, uplift, volcanism, boundary. | `generation/geology.ts:23–35,115–128,202–217`. | Add a modest material substrate; do not mistake existing fields for ore concentrations or rock types. |
| The age-like field is noise-derived and scaled by 220. | `generation/geology.ts:34`. | Do not infer ancient shields or precise ore-forming chronology from this alone. |
| Bedrock is elevation; loose sediment begins at zero. | `generation/terrain.ts:30–50`; `generation/erosion.ts` updates elevations/thicknesses. | Geological lithology and inherited sedimentary rocks require new explicit meaning. |
| Soil storage is water, not a fertility/texture profile. | `model.ts:117–129`; `generation/land-water.ts` soil-bucket updates. | Land-resource suitability needs additional small soil/land classes or clearly labelled proxies. |
| Vegetation is a potential index and already includes a bank adjustment. | `generation/ecology.ts:119–129`. | Do not equate it to timber or add the same bank contribution again. |
| Drainage and selected river systems already include real lake terminations/spills. | `model.ts:146–175`; `generation/rivers.ts:28–36,49–85`. | Reuse the same lake-aware routes for secondary mineral transport. No new Priority-Flood. |
| Channel supply is not a guarantee of perennial flow. | `generation/rivers.ts:53–58`. | Keep freshwater reliability and navigability as explicit future limitations. |
| Lake state has no salinity. | Complete `Lake` definition, `model.ts:131–145`. | Closed lake does not imply salt availability. |
| No resource/history data exists in the World type. | Complete `World` definition, `model.ts:177–194`. | `World.resources` is a proposed addition, not an implemented capability. |
| The pipeline already has bounded feedback and ends with channel selection/ecology. | `pipeline.ts:47–98`. | Add substrate before terrain and endowment after ecology, without another climate pass. |
| Buffer collection recursively visits typed arrays and deduplicates backing buffers. | `pipeline.ts:100–110`. | New endowment arrays can use the existing transfer/count mechanism. |
| Current project export saves version and config. | `app/WorldStudio.tsx:359–372`. | History requires an explicit baseline/version contract before attaching persistent mines and settlements. |
| The worker sends transferred buffers; the app terminates one-shot tasks. | `app/generator.worker.ts:1–18`; `app/useWorldGeneration.ts:10–45`. | Resource-only rebuild is a future ownership decision, not existing partial regeneration. |

These observations do not establish scientific calibration or runtime costs of the proposed layer. Missing history-specific fields are not defects in a generator that has not implemented history yet.

## 3. Selected exact excerpts

The line numbers inside each block are original source-file line numbers. Only surrounding explanation is new.

### World fields and ownership

`source/src/core/model.ts:88–104`

```text
  88  export interface Geology {
  89    plate: Uint16Array;
  90    plates: Plate[];
  91    continental: Float32Array;
  92    age: Float32Array;
  93    uplift: Float32Array;
  94    volcanism: Float32Array;
  95    boundary: Uint8Array;
  96  }
  97  export interface Terrain {
  98    bedrock: Float32Array;
  99    sediment: Float32Array;
 100    height: Float32Array;
 101    ocean: Uint8Array;
 102    coastDistance: Float32Array;
 103    seaThreshold: number;
 104  }
```

### Water, lake, ecology, and river field contracts

`source/src/core/model.ts:117–175`

```text
 117  export interface LandWater {
 118    rain: Float32Array;
 119    temperature: Float32Array;
 120    pet: Float32Array;
 121    aet: Float32Array;
 122    runoff: Float64Array;
 123    channelRunoff: Float64Array; // subset of runoff: soil drainage and overflow, excluding quickflow
 124    soil: Float32Array;
 125    snow: Float32Array;
 126    aridity: Float32Array;
 127    seasonalRain: Float32Array[];
 128    seasonalTemperature: Float32Array[];
 129    residual: number;
 130  }
 131  export interface Lake {
 132    id: number;
 133    outlet: number;
 134    spill: number;
 135    capacity: number;
 136    storage: number;
 137    level: number;
 138    area: number;
 139    inflow: number;
 140    outflow: number;
 141    evaporation: number;
 142    directRain: number;
 143    displacedRunoff: number;
 144    kind: 'closed' | 'spilling';
 145  }
 146  export interface Drainage {
 147    height: Float32Array;
 148    filled: Float32Array;
 149    receiver: Int32Array;
 150    order: Uint32Array;
 151    discharge: Float64Array;
 152    basin: Uint32Array;
 153    lakeId: Int32Array;
 154    lakeDepth: Float32Array;
 155    lakes: Lake[];
 156    runoffTotal: number;
 157    oceanDischarge: number;
 158    lakeExchange: number;
 159  }
 160  export interface Ecology {
 161    biome: Uint8Array;
 162    vegetation: Float32Array;
 163    riparian: Float32Array; // potential vegetation on accessible riverbanks
 164    riparianFraction: Float32Array; // fraction of cell area within those banks
 165    riverbankVegetation: Float32Array; // potential on each selected corner-to-receiver edge
 166    ice: Float32Array;
 167  }
 168  /** Channel selection on Drainage.receiver; the full runoff graph remains authoritative. */
 169  export interface Rivers {
 170    channel: Uint8Array;
 171    headwater: Uint8Array;
 172    catchmentArea: Float64Array; // m², includes land draining through upstream reservoirs
 173    supportFlow: Float64Array; // m³/s of non-storm supply, bounded by actual discharge
 174    system: Uint32Array; // shared terminal corner or closed-lake node, across spilling lakes
 175    streamOrder: Uint8Array; // Strahler order of selected channels; zero off-channel
```

### Current World contains environmental state only

`source/src/core/model.ts:177–194`

```text
 177  export interface World {
 178    version: string;
 179    config: WorldConfig;
 180    grid: Grid;
 181    process: Grid;
 182    transfer: Uint32Array;
 183    geology: Geology;
 184    terrain: Terrain;
 185    climate: Climate;
 186    water: LandWater;
 187    drainage: Drainage;
 188    rivers: Rivers;
 189    ecology: Ecology;
 190    timings: { name: string; ms: number }[];
 191    elapsed: number;
 192    bytes: number;
 193    sedimentExport: number;
 194  }
```

### Procedural age-like field

`source/src/core/generation/geology.ts:23–35`

```text
  23      return {
  24        continental: clamp(0.5 + continent * 1.6),
  25        base: continent * 12500 + inherited,
  26        // Low relief at a fixed physical scale gives plains shared valleys and divides.
  27        // It is applied after the continental height compression, which otherwise reduces
  28        // the inherited detail to a few metres and leaves long, almost parallel slopes.
  29        lowlandRelief:
  30          0.75 * valleys(wx * valleyScale, wy * valleyScale, wz * valleyScale) +
  31          0.25 * valleys(wx * valleyScale * 2, wy * valleyScale * 2, wz * valleyScale * 2),
  32        mountainTexture:
  33          1 + 0.16 * n(wx * 22, wy * 22, wz * 22) + 0.08 * n(wx * 53, wy * 53, wz * 53),
  34        age: clamp(0.5 + n(x * 3 + 20, y * 3, z * 3) * 0.5) * 220,
  35      };
```

### Tectonic feature results currently retained

`source/src/core/generation/geology.ts:202–217`

```text
 202            family === 0
 203              ? 4700 * v
 204              : family === 1
 205                ? -1700 * v
 206                : family === 2
 207                  ? 3300 * v * (0.4 + 1.4 * Math.exp(-Math.pow((distance - 110000) / 100000, 2)))
 208                  : family === 3
 209                    ? -650 * v
 210                    : 850 * v;
 211          delta *= config.exposure;
 212          uplift[i] += delta;
 213          if (family === 2 || family === 4)
 214            volcanism[i] = Math.max(volcanism[i], v * config.exposure);
 215        }
 216    }
 217    return { plate: owner, plates, continental, age, uplift, volcanism, boundary };
```

### Initial terrain and loose sediment

`source/src/core/generation/terrain.ts:30–50`

```text
  30    const bedrock = new Float32Array(grid.count),
  31      sediment = new Float32Array(grid.count),
  32      height = new Float32Array(grid.count);
  33    for (let i = 0; i < grid.count; i++) {
  34      const [x, y, z] = at(grid.positions, i);
  35      const noise = sample(x, y, z),
  36        uplift = sampleUplift(process, geology.uplift, x, y, z, map[i]),
  37        raw = noise.base + uplift - seaThreshold;
  38      // The continent field chooses land and broad drainage gradients, not mountain altitude.
  39      // A monotone lowland profile retains those gradients; concentrated uplift supplies ranges.
  40      const plains = 950 * -Math.expm1(-Math.max(0, raw) / 5500),
  41        valleys = Math.min(140, plains * 0.65) * noise.lowlandRelief,
  42        coastFade = clamp(raw / 500),
  43        mountains = Math.max(0, uplift) * noise.mountainTexture * coastFade;
  44      height[i] = bedrock[i] =
  45        raw > 0 ? (plains + valleys + mountains) * config.reliefScale : raw * 0.55;
  46    }
  47    const { ocean, coastDistance } = classifyWater(grid, height, config.radius);
  48    shapeContinentalBasins(grid, height, ocean);
  49    bedrock.set(height);
  50    return { bedrock, sediment, height, ocean, coastDistance, seaThreshold };
```

### Background and bank vegetation are already combined

`source/src/core/generation/ecology.ts:119–129`

```text
 119      // The soil budget already accounts for rain, demand, storage, and snowmelt.
 120      // Use its fulfilled demand once, instead of multiplying two drought penalties.
 121      // Annual potential describes growing-season cover, including short cool summers.
 122      const waterAvailability = clamp(water.aet[i] / Math.max(1, water.pet[i])),
 123        growingSeason = clamp((warm - 1) / 14);
 124      vegetation[i] =
 125        b === 0 || b === 1 || b === 12 ? 0 : (1 - Math.exp(-3 * waterAvailability)) * growingSeason;
 126      if (b !== 0 && b !== 1 && b !== 12)
 127        vegetation[i] += Math.max(0, riparian[i] - vegetation[i]) * riparianFraction[i];
 128    }
 129    return { biome, vegetation, riparian, riparianFraction, riverbankVegetation, ice };
```

### Existing lake-aware transport topology

`source/src/core/generation/rivers.ts:28–36`

```text
  28    for (let c = 0; c < n; c++) {
  29      const id = d.lakeId[c],
  30        lake = id >= 0 ? d.lakes[id] : undefined;
  31      if (lake && d.height[c] <= lake.level) {
  32        next[c] = n + id;
  33        if (lake.outflow > 0 && d.receiver[c] === lake.outlet) spillFrom[id] = c;
  34      } else next[c] = d.receiver[c];
  35    }
  36    for (const lake of d.lakes) if (lake.outflow > 0) next[n + lake.id] = lake.outlet;
```

### Channel-supply qualification and terminal identities

`source/src/core/generation/rivers.ts:49–85`

```text
  49    for (let c = 0; c < size; c++) if (!incoming[c]) queue[tail++] = c;
  50    while (head < tail) {
  51      const c = queue[head++],
  52        to = next[c];
  53      if (c >= n) {
  54        // Reservoir outflow has already passed through storage and evaporation. It is a
  55        // valid supply, not proof of perennial flow (our climate has four seasonal samples).
  56        const lake = d.lakes[c - n];
  57        supply[c] = lake.outflow;
  58      } else supply[c] = Math.min(supply[c], d.discharge[c]);
  59      const supported =
  60        area[c] >= config.riverSourceArea * 1e6 && supply[c] >= config.riverSourceFlow;
  61      if (supported) active[c] = 1;
  62      if (active[c]) streamOrder[c] = Math.max(1, streamOrder[c] + equalOrder[c]);
  63      if (c < n && to === d.receiver[c] && to >= 0 && d.discharge[c] > 0) channel[c] = active[c];
  64      if (to >= 0) {
  65        area[to] += area[c];
  66        supply[to] += supply[c];
  67        // A closed lake ends the network; a spill continues it through the existing outlet.
  68        if (active[c] && supply[c] > 0) {
  69          active[to] = 1;
  70          if (streamOrder[c] > streamOrder[to]) {
  71            streamOrder[to] = streamOrder[c];
  72            equalOrder[to] = 0;
  73          } else if (streamOrder[c] === streamOrder[to]) equalOrder[to] = 1;
  74        }
  75        if (--incoming[to] === 0) queue[tail++] = to;
  76      }
  77    }
  78    if (tail !== size) throw Error('River catchments contain a drainage cycle.');
  79    // The same temporary lake-aware graph identifies whole river systems. Separate
  80    // ocean mouths remain separate systems; a real spill connects its upstream lake.
  81    const system = new Uint32Array(size);
  82    for (let k = tail - 1; k >= 0; k--) {
  83      const c = queue[k];
  84      system[c] = next[c] < 0 ? c : system[next[c]];
  85    }
```

### Final stages and buffer handling

`source/src/core/pipeline.ts:70–110`

```text
  70    const rivers = stage('Headwaters & channels', () =>
  71      selectRivers(grid, terrain, water, drainage, config),
  72    );
  73    const ecology = stage('Biomes & ecology', () =>
  74      classifyEcology(grid, terrain, water, drainage, rivers, config),
  75    );
  76    const world: World = {
  77      version: VERSION,
  78      config: { ...config },
  79      grid,
  80      process,
  81      transfer,
  82      geology,
  83      terrain,
  84      climate,
  85      water,
  86      drainage,
  87      rivers,
  88      ecology,
  89      timings,
  90      elapsed: 0,
  91      bytes: 0,
  92      sedimentExport,
  93    };
  94    stage('Publish world', () => {
  95      world.bytes = buffers(world).reduce((n, b) => n + b.byteLength, 0);
  96    });
  97    world.elapsed = performance.now() - started;
  98    return world;
  99  }
 100  /** Deduplicate shared geometry before transferring ownership or reporting retained bytes. */
 101  export function buffers(value: unknown): ArrayBuffer[] {
 102    const seen = new Set<ArrayBuffer>();
 103    function visit(v: unknown) {
 104      if (ArrayBuffer.isView(v)) {
 105        if (v.buffer instanceof ArrayBuffer) seen.add(v.buffer);
 106      } else if (v && typeof v === 'object') for (const child of Object.values(v)) visit(child);
 107    }
 108    visit(value);
 109    return [...seen];
 110  }
```

### Current project export

`source/src/app/WorldStudio.tsx:359–373`

```text
 359              <ToolButton
 360                label="Save project"
 361                disabled={!world}
 362                onClick={() =>
 363                  world &&
 364                  download(
 365                    { version: world.version, config: world.config },
 366                    `${world.config.seed.replace(/[^a-z0-9_-]/gi, '_')}.json`,
 367                  )
 368                }
 369              >
 370                <ArrowDownToLine size={17} />
 371              </ToolButton>
 372              <HelpDialog world={world} />
 373            </div>
```

### Worker transfer

`source/src/app/generator.worker.ts:1–18`

```text
   1  /// <reference lib="webworker" />
   2  import { generateWorld, buffers } from '../core/pipeline';
   3  import type { WorldConfig } from '../core/model';
   4  self.onmessage = (event: MessageEvent<{ config: WorldConfig; id: number }>) => {
   5    const { config, id } = event.data;
   6    try {
   7      const world = generateWorld(config, (stage, completed, total) =>
   8        self.postMessage({ type: 'progress', id, stage, completed, total }),
   9      );
  10      self.postMessage({ type: 'complete', id, world }, buffers(world));
  11    } catch (error) {
  12      self.postMessage({
  13        type: 'error',
  14        id,
  15        message: error instanceof Error ? error.message : String(error),
  16      });
  17    }
  18  };
```

## 4. Proposed changes, not source observations

The geological heritage provinces, host materials, finite deposit zones, biomass stock/capacity, cultivation suitability, extraction capability interface, stable resource IDs, and knowledge/depletion state are new designs in `RESOURCE_ARCHITECTURE.md`. Geological associations in its catalogue are external research, not claims that the supplied source already models those processes.

The source's existing climate, legalized mesh, unified drainage, reservoir behavior, and biome classification are not replaced by this proposal. Early resource outputs do not alter environmental generation. Resource-dependent erosion, land-use feedback, irrigation withdrawals, and mine-water effects require later explicit owning-subsystem changes rather than silent feedback through presentation fields.

## 5. Arithmetic used for the memory illustration

No performance measurements were made. These are byte-count calculations for the proposed arrays, using `N=655,362`, `M=40,962`, and an illustrative `D=20,000` sparse records:

| Allocation | Calculation | MiB (1,048,576 bytes) |
| --- | ---: | ---: |
| Dense resource fields | `24 × 655,362 = 15,728,688` bytes | 15.000 |
| Process context allowance | `12 × 40,962 = 491,544` bytes | 0.469 |
| Illustrative occurrence-record allowance | `128 × 20,000 = 2,560,000` bytes | 2.441 |
| One reusable Float32 surface overlay | `4 × 655,362 = 2,621,448` bytes | 2.500 |
| One Float64 corner scratch array | `8 × (2 × 655,362 − 4) = 10,485,760` bytes | 10.000 |

Catalogue storage, indices, managed-history state, temporary object overhead, GPU copies, and allocator overhead are additional. The 128-byte record allowance is not a measured C3 `sizeof`, and 20,000 is not a recommended default deposit count.

## 6. File hashes for the principal integration points

These hashes support source identification, not a new verification framework for the project.

| Relative path in supplied ZIP | SHA-256 |
| --- | --- |
| `source/src/core/model.ts` | `2ced341b9e8fad7091081ced631cb34a112a4891dd6cb862bd9a28c455c51260` |
| `source/src/core/pipeline.ts` | `ee734d11f61655c7be178513d74cd4b4501db8531331bc9fb3a603e2821b63cd` |
| `source/src/core/generation/geology.ts` | `d05f278514ca9bef032f23e120df9c55bcfbb117ade17cdb722c34e46347807c` |
| `source/src/core/generation/terrain.ts` | `471924e3c0523bda908de1ca71f0c8386561b12eab8505e4328831702b612fb8` |
| `source/src/core/generation/ecology.ts` | `ef3c24eaee84670b9100682d85869c784806494d7671a4e82f48eec0bd022dcf` |
| `source/src/core/generation/rivers.ts` | `b12633d31d9dc31e19bde54f04d1dff56b6f903c0ee6daad5fdf3a7bc974c0b7` |
| `source/src/app/WorldStudio.tsx` | `39c0d53a59d11911d05bb8423eecb054d57d3d8a5bfdc49a5fe26e9c22eb8f08` |
