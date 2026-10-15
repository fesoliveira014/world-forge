import type { Grid, HotspotSource, WorldConfig } from '../model';
import { MinHeap, createSeededRandom, randomSpherePoint } from '../math';

export type Hotspot = HotspotSource;

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
  faultOrigins?: Int32Array,
): Float32Array {
  const cost = new Float64Array(grid.count).fill(Infinity);
  const heap = new MinHeap();
  const rate = new Float32Array(grid.count);
  const width = 130000 * config.tectonicWidth;
  faultOrigins?.fill(-1);

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    if (faults[cellIndex] > 0) {
      cost[cellIndex] = -Math.log(faults[cellIndex] / 200);
      if (faultOrigins) {
        faultOrigins[cellIndex] = cellIndex;
      }
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
        if (faultOrigins) {
          faultOrigins[neighborCell] = faultOrigins[cellIndex];
        }
        heap.push(neighborCell, next);
      }
    }
  }

  const active = hotspots.filter((hotspot) => elapsed >= hotspot.start && elapsed <= hotspot.end);

  for (let cellIndex = 0; cellIndex < grid.count; cellIndex++) {
    let construction = 200 * Math.exp(-cost[cellIndex]);

    for (const hotspot of active) {
      construction += hotspotRateAt(
        hotspot,
        grid.positions[cellIndex * 3],
        grid.positions[cellIndex * 3 + 1],
        grid.positions[cellIndex * 3 + 2],
        config.radius,
      );
    }

    rate[cellIndex] = construction * config.volcanicActivity;
  }

  return rate;
}

export function hotspotRateAt(
  hotspot: Hotspot,
  x: number,
  y: number,
  z: number,
  radius: number,
): number {
  const cosineDistance =
    x * hotspot.position[0] + y * hotspot.position[1] + z * hotspot.position[2];
  // The same chord-distance kernel is used for emplacement and its attribution.
  const distanceSquared = 2 * Math.max(0, 1 - cosineDistance) * radius ** 2;

  return hotspot.rate * Math.exp(-distanceSquared / hotspot.radius ** 2);
}

/** Saturating emplacement approximates load compensation, not unlimited vertical stacking. */
export function emplaceVolcanics(previous: number, rate: number, timeStep: number): number {
  const capacity = 10000;

  return previous + (capacity - previous) * -Math.expm1((-Math.max(0, rate) * timeStep) / capacity);
}
