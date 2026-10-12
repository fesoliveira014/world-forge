import type { Grid, Lake } from '../model';
import { balanceLake } from './reservoir';
import type { ReservoirForcing } from './seasonal-reservoir';

type Saddle = { a: number; b: number; height: number };

type Basin = {
  members: number[];
  inflow: number;
  seasonalInflow: number[];
  first: number;
  end: number;
  leaf?: number;
  left?: Basin;
  right?: Basin;
  saddle?: Saddle;
};

type LakeState = {
  basin: Basin;
  inflow: number;
  seasonalInflow: number[];
  limit: number;
  from: number;
  to: number;
  outflow: number;
  lake?: Lake;
  left?: LakeState;
  right?: LakeState;
};

interface Inputs {
  grid: Grid;
  members: number[];
  height: Float32Array;
  rank: Uint32Array;
  input: Float64Array;
  discharge: Float64Array;
  seasonalDischarge?: Float64Array[];
  seasonalFlux?: ReservoirForcing['at'];
  rain: Float64Array;
  evap: Float64Array;
  area: Float64Array;
  candidate: Lake;
  escapeFrom: number;
  receiver: Int32Array;
  lakeId: Int32Array;
  allocateId: () => number;
}

/** Refine only a closed reservoir whose dry interior contains another local minimum.
 * A small saddle merge tree lets those ponds fill/spill independently. There is no time
 * simulation: each node uses the same annual reservoir balance as the outer drainage pass.
 */
export function resolveNestedLakes(data: Inputs) {
  const { grid, members, height, rank, discharge, candidate } = data;
  const seasonalDischarge =
    data.seasonalDischarge ?? Array.from({ length: 4 }, () => new Float64Array(discharge));
  const included = new Set(members);
  const next = new Map<number, number>();
  const ascending = members
    .slice()
    .sort(
      (firstCorner, secondCorner) =>
        height[firstCorner] - height[secondCorner] || rank[firstCorner] - rank[secondCorner],
    );
  let needsRefinement = false;

  for (const cornerIndex of ascending) {
    let best = -1;
    let bestSlope = 0;

    for (let neighborSlot = 0; neighborSlot < 3; neighborSlot++) {
      const neighborCorner = grid.cornerNeighbors[cornerIndex * 3 + neighborSlot];

      if (!included.has(neighborCorner)) {
        continue;
      }

      const drop = height[cornerIndex] - height[neighborCorner];

      if (drop > 0) {
        const slope = drop / grid.edgeLength[grid.cornerEdges[cornerIndex * 3 + neighborSlot]];

        if (slope > bestSlope) {
          best = neighborCorner;
          bestSlope = slope;
        }
      } else if (
        drop === 0 &&
        bestSlope === 0 &&
        rank[neighborCorner] < rank[cornerIndex] &&
        (best < 0 || rank[neighborCorner] < rank[best])
      ) {
        best = neighborCorner;
      }
    }

    next.set(cornerIndex, best);

    if (best < 0 && height[cornerIndex] > candidate.level) {
      needsRefinement = true;
    }
  }

  if (!needsRefinement) {
    return null;
  }

  // Each corner belongs to its downhill minimum. At this point discharge contains only
  // local runoff and external river injections, before any internal channels are accumulated.
  const leafAt = new Map<number, number>();
  const basins: Basin[] = [];

  for (const cornerIndex of ascending) {
    const neighborCorner = next.get(cornerIndex)!;
    let leaf: number;

    if (neighborCorner < 0) {
      leaf = basins.length;
      basins.push({ members: [], inflow: 0, seasonalInflow: [0, 0, 0, 0], first: 0, end: 0, leaf });
    } else {
      leaf = leafAt.get(neighborCorner)!;
    }

    leafAt.set(cornerIndex, leaf);
    basins[leaf].members.push(cornerIndex);
    basins[leaf].inflow += discharge[cornerIndex];
    for (let season = 0; season < 4; season++) {
      basins[leaf].seasonalInflow[season] += seasonalDischarge[season][cornerIndex];
    }
  }

  // Kruskal records the lowest saddle at which neighboring drainage catchments join.
  const edges: Saddle[] = [];

  for (const cornerIndex of members) {
    for (let neighborSlot = 0; neighborSlot < 3; neighborSlot++) {
      const neighborCorner = grid.cornerNeighbors[cornerIndex * 3 + neighborSlot];

      if (
        cornerIndex < neighborCorner &&
        included.has(neighborCorner) &&
        leafAt.get(cornerIndex) !== leafAt.get(neighborCorner)
      ) {
        edges.push({
          a: cornerIndex,
          b: neighborCorner,
          height: Math.max(height[cornerIndex], height[neighborCorner]),
        });
      }
    }
  }

  edges.sort((firstSaddle, secondSaddle) => firstSaddle.height - secondSaddle.height);
  const parent = basins.map((_, basinIndex) => basinIndex);
  const trees = basins.slice();

  const findRoot = (basinIndex: number): number => {
    while (parent[basinIndex] !== basinIndex) {
      parent[basinIndex] = parent[parent[basinIndex]];
      basinIndex = parent[basinIndex];
    }

    return basinIndex;
  };

  for (const edge of edges) {
    const firstRoot = findRoot(leafAt.get(edge.a)!);
    const secondRoot = findRoot(leafAt.get(edge.b)!);

    if (firstRoot === secondRoot) {
      continue;
    }

    const left = trees[firstRoot];
    const right = trees[secondRoot];
    parent[secondRoot] = firstRoot;
    trees[firstRoot] = {
      members: [...left.members, ...right.members],
      inflow: left.inflow + right.inflow,
      seasonalInflow: left.seasonalInflow.map(
        (flow, season) => flow + right.seasonalInflow[season],
      ),
      first: 0,
      end: 0,
      left,
      right,
      saddle: edge,
    };
  }

  const root = trees[findRoot(0)];

  // DFS leaf intervals make an incoming spill's branch a constant-time lookup.
  const leafOrder = new Uint32Array(basins.length);
  let leafCount = 0;

  function indexLeaves(basin: Basin) {
    basin.first = leafCount;

    if (basin.leaf !== undefined) {
      leafOrder[basin.leaf] = leafCount++;
    } else {
      indexLeaves(basin.left!);
      indexLeaves(basin.right!);
    }

    basin.end = leafCount;
  }

  indexLeaves(root);

  function balance(state: LakeState) {
    state.lake = balanceLake(
      -1,
      state.to,
      state.limit,
      state.basin.members.filter((memberCorner) => height[memberCorner] <= state.limit),
      height,
      data.area,
      data.input,
      data.rain,
      data.evap,
      state.inflow,
      data.seasonalFlux ? { inflow: state.seasonalInflow, at: data.seasonalFlux } : undefined,
    );
    state.outflow = state.lake.outflow;
  }

  function connectReservoirs(state: LakeState, changed: LakeState, previousOutflow: number) {
    const leftState = state.left!;
    const rightState = state.right!;
    const saddle = state.basin.saddle!;
    const other = changed === leftState ? rightState : leftState;
    const extra = changed.outflow - previousOutflow;

    // Only new spill crosses the saddle. Internal transfers increase the recipient's
    // inflow, never the parent's: the parent already contains that source water.
    if (extra > 0 && other.outflow === 0) {
      const outletCorner = changed === leftState ? saddle.b : saddle.a;
      const pattern = changed.lake?.seasonal?.outflow ?? changed.seasonalInflow;
      const mean = pattern.reduce((sum, flow) => sum + flow, 0) / 4;
      addFlow(
        other,
        leafOrder[leafAt.get(outletCorner)!],
        extra,
        pattern.map((flow) => (mean > 0 ? (extra * flow) / mean : extra)),
      );
    }

    if (leftState.outflow > 0 && rightState.outflow > 0) {
      balance(state);
    }
  }

  function addFlow(state: LakeState, leaf: number, amount: number, seasonalAmount: number[]) {
    state.inflow += amount;
    for (let season = 0; season < 4; season++) {
      state.seasonalInflow[season] += seasonalAmount[season];
    }

    // More supply cannot un-fill a merged lake. Keep its settled structure and
    // rebalance it directly instead of restarting all its descendant ponds.
    if (state.lake) {
      balance(state);

      return;
    }

    const left = state.left!;
    const child = leaf >= left.basin.first && leaf < left.basin.end ? left : state.right!;
    const previousOutflow = child.outflow;
    addFlow(child, leaf, amount, seasonalAmount);
    connectReservoirs(state, child, previousOutflow);
  }

  function settleBasin(basin: Basin, limit: number, from: number, outletCorner: number): LakeState {
    const state: LakeState = {
      basin,
      inflow: basin.inflow,
      seasonalInflow: basin.seasonalInflow.slice(),
      limit,
      from,
      to: outletCorner,
      outflow: 0,
    };

    if (!basin.saddle) {
      balance(state);
    } else {
      const { saddle } = basin;
      state.left = settleBasin(basin.left!, saddle.height, saddle.a, saddle.b);
      state.right = settleBasin(basin.right!, saddle.height, saddle.b, saddle.a);
      connectReservoirs(state, state.left.outflow > 0 ? state.left : state.right, 0);
    }

    return state;
  }

  const solution = settleBasin(root, candidate.spill, data.escapeFrom, candidate.outlet);
  const plans: (LakeState & { lake: Lake })[] = [];

  function collect(state: LakeState) {
    if (state.lake) {
      plans.push(state as LakeState & { lake: Lake });
    } else {
      collect(state.left!);
      collect(state.right!);
    }
  }

  collect(solution);
  const byCorner = new Map<number, Lake>();

  for (const plan of plans) {
    plan.lake.id = data.allocateId();

    for (const cornerIndex of plan.basin.members) {
      byCorner.set(cornerIndex, plan.lake);
      data.lakeId[cornerIndex] = plan.lake.id;
    }
  }

  // Final display graph: dry channels descend naturally; water stops at each wet pond;
  // only a real spilling pond injects water into the next catchment.
  for (const plan of plans) {
    if (plan.lake.outflow > 0 && included.has(plan.to)) {
      discharge[plan.to] += plan.lake.outflow;
      for (let season = 0; season < 4; season++) {
        seasonalDischarge[season][plan.to] +=
          plan.lake.seasonal?.outflow[season] ?? plan.lake.outflow;
      }
    }
  }

  for (let orderIndex = ascending.length - 1; orderIndex >= 0; orderIndex--) {
    const cornerIndex = ascending[orderIndex];
    const lake = byCorner.get(cornerIndex)!;
    data.receiver[cornerIndex] = height[cornerIndex] <= lake.level ? -1 : next.get(cornerIndex)!;

    if (data.receiver[cornerIndex] >= 0) {
      discharge[data.receiver[cornerIndex]] += discharge[cornerIndex];
      for (let season = 0; season < 4; season++) {
        seasonalDischarge[season][data.receiver[cornerIndex]] +=
          seasonalDischarge[season][cornerIndex];
      }
    }
  }

  for (const plan of plans) {
    if (plan.lake.outflow > 0) {
      data.receiver[plan.from] = plan.to;
      discharge[plan.from] = plan.lake.outflow;
      for (let season = 0; season < 4; season++) {
        seasonalDischarge[season][plan.from] =
          plan.lake.seasonal?.outflow[season] ?? plan.lake.outflow;
      }
    }
  }

  return {
    lakes: plans.map((plan) => plan.lake),
    byCorner,
    outflow: solution.outflow,
    seasonalOutflow: solution.lake?.seasonal?.outflow ?? [0, 0, 0, 0],
  };
}
