import type { Grid, Oxbow, Terrain, WorldConfig } from '../model';
import { nearestCell } from '../grid/build';
import { classifyWater } from '../generation/terrain';
import { createScalarStencilSampler, sampleScalarStencil } from './scalar-sampling';
import { buildOverlapTransfer, transferDensity, transferInventory } from './transfer';

/** Preserve abandoned-channel geography independently of the cell index space.
 * A newly inserted cell can receive several old anchors. Their combined footprint
 * stays within its available area; the water solver retains separate pond stores.
 */
function remapOxbows(source: Grid, target: Grid, ponds: Oxbow[], radius: number): Oxbow[] {
  const occupiedArea = new Float64Array(target.count);
  let previousCell = 0;
  const result = ponds.map((pond): Oxbow => {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let offset = 0; offset < pond.points.length; offset += 3) {
      x += pond.points[offset];
      y += pond.points[offset + 1];
      z += pond.points[offset + 2];
    }
    if (Math.hypot(x, y, z) === 0) {
      x = source.positions[3 * pond.cell];
      y = source.positions[3 * pond.cell + 1];
      z = source.positions[3 * pond.cell + 2];
    }
    previousCell = nearestCell(target, x, y, z, previousCell);
    occupiedArea[previousCell] += pond.area;
    return { ...pond, cell: previousCell, points: new Float32Array(pond.points) };
  });
  for (const pond of result) {
    const scale = Math.min(1, (target.areas[pond.cell] * radius ** 2) / occupiedArea[pond.cell]);
    pond.area *= scale;
    pond.width *= scale;
  }
  return result;
}

/** Transfer the existing material state onto a new surface mesh. Geological
 * forcing and erosion are not replayed here. Total height and signed net change
 * are bounded continuous samples; sediment and accumulated incision/deposition
 * are cell-average depths whose area integrals survive changed Voronoi cells.
 * Reconcile the bedrock interface with that conserved sediment beneath the
 * existing surface. Sampling bedrock independently would turn a flat floor into
 * bumps and pits wherever the two different reconstruction operators disagree.
 */
export function remapTerrain(
  sourceGrid: Grid,
  targetGrid: Grid,
  terrain: Terrain,
  config: Pick<WorldConfig, 'radius'>,
): Terrain {
  const overlap = buildOverlapTransfer(sourceGrid, targetGrid);
  const locate = createScalarStencilSampler(sourceGrid);
  const bedrock = new Float32Array(targetGrid.count);
  const surfaceChange = new Float32Array(targetGrid.count);
  const sediment = Float32Array.from(transferDensity(overlap, terrain.sediment));
  const fluvialIncision = Float32Array.from(transferDensity(overlap, terrain.fluvialIncision));
  const deltaSediment = Float32Array.from(transferDensity(overlap, terrain.deltaSediment));
  const height = new Float32Array(targetGrid.count);
  for (let cell = 0; cell < targetGrid.count; cell++) {
    const stencil = locate(
      targetGrid.positions[3 * cell],
      targetGrid.positions[3 * cell + 1],
      targetGrid.positions[3 * cell + 2],
    );
    height[cell] = sampleScalarStencil(stencil, terrain.height);
    bedrock[cell] = height[cell] - sediment[cell];
    // Retained sites keep their recorded material interface when its cell-average
    // sediment is unchanged. Subtracting a rounded total height can otherwise
    // discard low bits of an existing bedrock sample underneath deep deposits.
    const retained = stencil.weights.findIndex((weight) => weight === 1);
    if (retained >= 0 && sediment[cell] === terrain.sediment[stencil.cells[retained]]) {
      bedrock[cell] = terrain.bedrock[stencil.cells[retained]];
    }
    surfaceChange[cell] = sampleScalarStencil(stencil, terrain.surfaceChange);
    // Height is authoritative: summing two rounded Float32 material fields again
    // could introduce submillimetre noise on an exactly level lake floor.
  }
  return {
    bedrock,
    sediment,
    height,
    surfaceChange,
    fluvialIncision,
    deltaSediment,
    // Cell totals are an extensive inventory, never copied into every child.
    // Immutable parcels retain subcell ownership across lake splits and merges;
    // the salinity solve rebuilds this cell cache from their fixed geography.
    ...(terrain.saltMass
      ? {
          saltMass: transferInventory(overlap, terrain.saltMass),
        }
      : {}),
    ...(terrain.saltParcels ? { saltParcels: terrain.saltParcels } : {}),
    ...(terrain.saltMass || terrain.saltParcels ? { saltAgeYears: terrain.saltAgeYears } : {}),
    seaThreshold: terrain.seaThreshold,
    migration: terrain.migration?.map((record) => ({
      ...record,
      start: [...record.start],
      end: [...record.end],
    })),
    oxbows: remapOxbows(sourceGrid, targetGrid, terrain.oxbows, config.radius),
    ...classifyWater(targetGrid, height, config.radius),
  };
}
