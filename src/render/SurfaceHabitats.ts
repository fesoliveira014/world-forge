import { Color } from 'three';
import type { World } from '../core/model';
import { clamp } from '../core/math';
import { lakeCoverageAt } from '../core/generation/lake-state';

/** Entirely wet cells have no regional land habitat. Mixed shores retain land;
 * their wet fraction is blended by the surface, never by detached triangle patches. */
export function isLakeCell(world: World, cellIndex: number) {
  return !world.terrain.ocean[cellIndex] && lakeCoverageAt(world.drainage, cellIndex) >= 1 - 1e-6;
}

const deltaCache = new WeakMap<World, Uint8Array>();

/** Two adjoining land cells at each resolved mouth. The second is more water-toned.
 * This is a display classification; it does not create islands or reroute discharge.
 */
export function getDeltaCells(world: World) {
  const cached = deltaCache.get(world);

  if (cached) {
    return cached;
  }

  const cells = new Uint8Array(world.grid.count);
  const { grid, drainage } = world;

  for (const delta of world.rivers.deltas) {
    const cornerIndex = delta.corner;
    const receiverCorner = drainage.receiver[cornerIndex];

    if (receiverCorner < 0) {
      continue;
    }

    const candidates = new Set<number>();

    for (const node of [cornerIndex, receiverCorner]) {
      for (let incidentIndex = 0; incidentIndex < 3; incidentIndex++) {
        candidates.add(grid.triangles[node * 3 + incidentIndex]);
      }
    }

    const land = [...candidates].filter(
      (cellIndex) => !world.terrain.ocean[cellIndex] && !isLakeCell(world, cellIndex),
    );
    land.sort(
      (firstCell, secondCell) =>
        world.terrain.deltaSediment[secondCell] - world.terrain.deltaSediment[firstCell] ||
        firstCell - secondCell,
    );

    if (!land.length) {
      continue;
    }

    const first = land[0];
    cells[first] = 1;
    const second = land.slice(1).find((cellIndex) => {
      for (
        let neighborOffset = grid.offsets[first];
        neighborOffset < grid.offsets[first + 1];
        neighborOffset++
      ) {
        if (grid.neighbors[neighborOffset] === cellIndex) {
          return true;
        }
      }

      return false;
    });

    if (second !== undefined) {
      cells[second] = 2;
    }
  }

  deltaCache.set(world, cells);

  return cells;
}

const deltaMud = new Color('#9a8863');

const deltaGreen = new Color('#5b8066');

const deltaWater = new Color('#31788b');

const ice = new Color('#dcebef');

export function sampleDeltaColor(world: World, cellIndex: number, season: number, target: Color) {
  const temperature =
    season < 0
      ? world.water.temperature[cellIndex]
      : world.water.seasonalTemperature[season][cellIndex];
  const rain =
    season < 0
      ? 1
      : clamp(
          (world.water.seasonalRain[season][cellIndex] * 4) /
            Math.max(1, world.water.rain[cellIndex]),
        );
  const green =
    world.ecology.vegetation[cellIndex] * (0.65 + rain * 0.35) * clamp((temperature + 2) / 15);

  return target
    .copy(deltaMud)
    .lerp(deltaGreen, green)
    .lerp(deltaWater, getDeltaCells(world)[cellIndex] === 2 ? 0.48 : 0.3)
    .lerp(ice, clamp((-temperature + 1) / 12) * 0.85);
}
