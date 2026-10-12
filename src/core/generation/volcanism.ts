import type { Grid, WorldConfig } from '../model';
import { MinHeap, createSeededRandom, randomSpherePoint } from '../math';

export interface Hotspot {
  position: [number, number, number];
  start: number;
  end: number;
  radius: number;
  rate: number;
}

/** Fixed mantle-frame sources; motion of the crust creates age-progressive tracks.
 * The seed fixes positions and lifetimes independently of the requested end date.
 */
export function createHotspots(config: WorldConfig): Hotspot[] {
  const randomNumber = createSeededRandom(config.seed + '/hotspots');

  return Array.from({ length: config.hotspotCount }, () => {
    const position = randomSpherePoint(randomNumber);
    const start = randomNumber() * 260 - 60;

    return {
      position,
      start,
      end: start + 50 + randomNumber() * 100,
      radius: 110000 + randomNumber() * 90000,
      rate: 220 + randomNumber() * 220, // effective metres of construction per Myr
    };
  });
}

/** Fault sources spread over a physical width on their own overriding plate.
 * Stronger sources dominate overlaps instead of adding a mountain per boundary edge.
 */
export function volcanicRates(
  grid: Grid,
  owners: Uint16Array,
  faults: Float32Array,
  hotspots: Hotspot[],
  elapsed: number,
  config: WorldConfig,
): Float32Array {
  const cost = new Float64Array(grid.count).fill(Infinity);
  const heap = new MinHeap();
  const rate = new Float32Array(grid.count);
  const width = 130000 * config.tectonicWidth;

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    if (faults[cellIndex] > 0) {
      cost[cellIndex] = -Math.log(faults[cellIndex] / 200);
      heap.push(cellIndex, cost[cellIndex]);
    }
  }

  while (heap.size) {
    const [cellIndex, value] = heap.pop();

    if (value > cost[cellIndex]) {
      continue;
    }

    for (
      let neighborOffset = grid.offsets[cellIndex];
      neighborOffset < grid.offsets[cellIndex + 1];
      neighborOffset++
    ) {
      const neighborCell = grid.neighbors[neighborOffset];

      if (owners[cellIndex] !== owners[neighborCell]) {
        continue;
      }

      const next =
        value + (grid.edgeDistance[grid.arcEdges[neighborOffset]] * config.radius) / width;

      if (next < cost[neighborCell] && next < 5) {
        cost[neighborCell] = next;
        heap.push(neighborCell, next);
      }
    }
  }

  const active = hotspots.filter((hotspot) => elapsed >= hotspot.start && elapsed <= hotspot.end);

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    let construction = 200 * Math.exp(-cost[cellIndex]);

    for (const hotspot of active) {
      const cosineDistance =
        grid.positions[cellIndex * 3] * hotspot.position[0] +
        grid.positions[cellIndex * 3 + 1] * hotspot.position[1] +
        grid.positions[cellIndex * 3 + 2] * hotspot.position[2];
      // Chord distance is adequate over a volcanic province; avoids an acos per source.
      const distanceSquared = 2 * Math.max(0, 1 - cosineDistance) * config.radius ** 2;
      construction += hotspot.rate * Math.exp(-distanceSquared / hotspot.radius ** 2);
    }

    rate[cellIndex] = construction * config.volcanicActivity;
  }

  return rate;
}

/** Saturating emplacement approximates load compensation, not unlimited vertical stacking. */
export function emplaceVolcanics(previous: number, rate: number, timeStep: number): number {
  const capacity = 10000;

  return previous + (capacity - previous) * -Math.expm1((-Math.max(0, rate) * timeStep) / capacity);
}
