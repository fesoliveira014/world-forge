import type { Lake } from '../model';
import { balanceSeasonalLake, type ReservoirForcing } from './seasonal-reservoir';

/** Annual equilibrium estimate using a sorted piecewise-constant height/area curve.
 * At each wet sample, replace its provisional land runoff with rain minus lake evaporation.
 * A dry/closed lake has zero outflow. This does not simulate its filling chronology.
 */
export function balanceLake(
  id: number,
  outlet: number,
  spill: number,
  members: number[],
  height: Float32Array,
  area: Float64Array,
  runoff: Float64Array,
  rain: Float64Array,
  evap: Float64Array,
  inflow: number,
  seasonal?: ReservoirForcing,
): Lake {
  const sorted = members
    .slice()
    .sort((firstCorner, secondCorner) => height[firstCorner] - height[secondCorner]);
  let wetArea = 0;
  let weightedHeight = 0;
  let netInflow = inflow;
  let evaporation = 0;
  let directRain = 0;
  let displacedRunoff = 0;
  let level = height[sorted[0]];
  let closed = false;

  for (let memberIndex = 0; memberIndex < sorted.length; memberIndex++) {
    const cornerIndex = sorted[memberIndex];
    const previousNetInflow = netInflow;
    wetArea += area[cornerIndex];
    weightedHeight += area[cornerIndex] * height[cornerIndex];
    netInflow += rain[cornerIndex] - evap[cornerIndex] - runoff[cornerIndex];
    evaporation += evap[cornerIndex];
    directRain += rain[cornerIndex];
    displacedRunoff += runoff[cornerIndex];

    if (netInflow <= 0) {
      // Partially wet terminal sample keeps the equilibrium ledger continuous.
      const wettedFraction = previousNetInflow / Math.max(1e-20, previousNetInflow - netInflow);
      wetArea -= area[cornerIndex] * (1 - wettedFraction);
      weightedHeight -= area[cornerIndex] * height[cornerIndex] * (1 - wettedFraction);
      evaporation -= evap[cornerIndex] * (1 - wettedFraction);
      directRain -= rain[cornerIndex] * (1 - wettedFraction);
      displacedRunoff -= runoff[cornerIndex] * (1 - wettedFraction);
      level = height[cornerIndex];
      netInflow = 0;
      closed = true;
      break;
    }
  }

  if (!closed) {
    level = spill;
  }

  let capacity = 0;

  for (const cornerIndex of sorted) {
    capacity += area[cornerIndex] * Math.max(0, spill - height[cornerIndex]);
  }

  const storage = Math.max(0, wetArea * level - weightedHeight);
  const outflow = closed ? 0 : Math.max(0, netInflow);

  const lake: Lake = {
    id,
    outlet,
    spill,
    capacity,
    storage,
    level,
    area: wetArea,
    inflow,
    outflow,
    evaporation,
    directRain,
    displacedRunoff,
    kind: outflow > 0 ? 'spilling' : 'closed',
  };
  return seasonal ? balanceSeasonalLake(lake, sorted, height, area, seasonal) : lake;
}
