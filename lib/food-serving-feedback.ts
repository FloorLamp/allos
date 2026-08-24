// Pure feedback copy + keyed-slot identity for one food-serving tap (#3611).
//
// The toast names the authoritative day total returned by the write, not a local
// tap count. Posting the same (profile, day, group) key upgrades that one slot in place, so
// quick repeats read as one cumulative answer instead of a stack of confirmations.

export interface FoodServingFeedback {
  key: string;
  message: string;
}

export function foodServingCoordinate(
  profileId: number,
  date: string,
  mealSlot: string,
  groupKey: string
): string {
  return `${profileId}:${date}:${mealSlot}:${groupKey}`;
}

export function foodServingToastKey(
  profileId: number,
  date: string,
  groupKey: string
): string {
  return `food-serving:${profileId}:${date}:${groupKey}`;
}

export function foodServingInverseKey(
  coordinate: string,
  offerRevision: number
): string {
  return `${coordinate}:receipt-undo:${offerRevision}`;
}

export interface FoodServingAddTap {
  id: number;
  epoch: number;
  coordinate: string;
  mealSlot: string;
}

export interface FoodServingBurstState {
  epoch: number;
  nextTapId: number;
  pending: ReadonlyMap<number, FoodServingAddTap>;
  baseServings: number | null;
  baseMealServings: ReadonlyMap<string, number>;
  servings: number | null;
  mealServings: ReadonlyMap<string, number>;
  latestSuccessfulTap: FoodServingAddTap | null;
  failures: number;
}

export interface FoodServingBurstCounts {
  servings: number;
  mealServings: number;
}

export interface FoodServingBurstReceipt {
  servings: number;
  coordinate: string;
  mealSlot: string;
}

export interface FoodServingBurstSettlement {
  state: FoodServingBurstState;
  accepted: boolean;
  counts?: FoodServingBurstCounts;
  receipt?: FoodServingBurstReceipt;
  reportFailure: boolean;
}

export function emptyFoodServingBurst(
  epoch = 0,
  nextTapId = 0
): FoodServingBurstState {
  return {
    epoch,
    nextTapId,
    pending: new Map(),
    baseServings: null,
    baseMealServings: new Map(),
    servings: null,
    mealServings: new Map(),
    latestSuccessfulTap: null,
    failures: 0,
  };
}

// Tap order and response order are different facts. The burst remembers the
// former for the inverse coordinate, while authoritative maxima absorb the
// latter without ever moving a rendered count backwards.
export function beginFoodServingAdd(
  state: FoodServingBurstState,
  coordinate: string,
  mealSlot: string,
  before: FoodServingBurstCounts
): { state: FoodServingBurstState; tap: FoodServingAddTap } {
  const starting = state.pending.size === 0;
  const tap: FoodServingAddTap = {
    id: state.nextTapId + 1,
    epoch: state.epoch,
    coordinate,
    mealSlot,
  };
  const pending = new Map(state.pending).set(tap.id, tap);
  const baseMealServings = starting
    ? new Map([[coordinate, before.mealServings]])
    : new Map(state.baseMealServings);
  if (!baseMealServings.has(coordinate))
    baseMealServings.set(coordinate, before.mealServings);
  return {
    tap,
    state: {
      ...state,
      nextTapId: tap.id,
      pending,
      baseServings: starting ? before.servings : state.baseServings,
      baseMealServings,
      servings: starting ? null : state.servings,
      mealServings: starting ? new Map() : state.mealServings,
      latestSuccessfulTap: starting ? null : state.latestSuccessfulTap,
      failures: starting ? 0 : state.failures,
    },
  };
}

export function settleFoodServingAdd(
  state: FoodServingBurstState,
  tap: FoodServingAddTap,
  outcome: ({ ok: true } & FoodServingBurstCounts) | { ok: false }
): FoodServingBurstSettlement {
  if (tap.epoch !== state.epoch || !state.pending.has(tap.id)) {
    return { state, accepted: false, reportFailure: false };
  }
  const pending = new Map(state.pending);
  pending.delete(tap.id);
  let servings = state.servings;
  let mealServings = new Map(state.mealServings);
  let latestSuccessfulTap = state.latestSuccessfulTap;
  let failures = state.failures;
  if (outcome.ok) {
    servings = Math.max(servings ?? outcome.servings, outcome.servings);
    mealServings.set(
      tap.coordinate,
      Math.max(
        mealServings.get(tap.coordinate) ?? outcome.mealServings,
        outcome.mealServings
      )
    );
    if (!latestSuccessfulTap || tap.id > latestSuccessfulTap.id)
      latestSuccessfulTap = tap;
  } else {
    failures += 1;
  }
  const visibleServings = servings ?? state.baseServings ?? 0;
  const visibleMeal =
    mealServings.get(tap.coordinate) ??
    state.baseMealServings.get(tap.coordinate) ??
    0;
  const completed = pending.size === 0;
  const receipt =
    completed && servings != null && latestSuccessfulTap
      ? {
          servings,
          coordinate: latestSuccessfulTap.coordinate,
          mealSlot: latestSuccessfulTap.mealSlot,
        }
      : undefined;
  const reportFailure = completed && failures > 0;
  const next = completed
    ? emptyFoodServingBurst(state.epoch, state.nextTapId)
    : {
        ...state,
        pending,
        servings,
        mealServings,
        latestSuccessfulTap,
        failures,
      };
  return {
    state: next,
    accepted: true,
    counts: { servings: visibleServings, mealServings: visibleMeal },
    receipt,
    reportFailure,
  };
}

// Offline capture retains the optimistic count but has no online authoritative
// receipt. It still leaves the burst so later online taps are not held forever.
export function dropFoodServingAdd(
  state: FoodServingBurstState,
  tap: FoodServingAddTap
): FoodServingBurstState {
  if (tap.epoch !== state.epoch || !state.pending.has(tap.id)) return state;
  const pending = new Map(state.pending);
  pending.delete(tap.id);
  return pending.size === 0
    ? emptyFoodServingBurst(state.epoch, state.nextTapId)
    : { ...state, pending };
}

// A decrement/removal starts a new mutation epoch. Responses from adds that were
// already in flight remain server facts, but may not resurrect their obsolete UI
// count or Undo offer over the newer authoritative mutation.
export function invalidateFoodServingBurst(
  state: FoodServingBurstState
): FoodServingBurstState {
  return emptyFoodServingBurst(state.epoch + 1, state.nextTapId);
}

export function foodServingFeedback(
  profileId: number,
  date: string,
  groupKey: string,
  groupName: string,
  servings: number,
  dayLabel: string
): FoodServingFeedback {
  return {
    key: foodServingToastKey(profileId, date, groupKey),
    message: `${servings} ${servings === 1 ? "serving" : "servings"} of ${groupName} ${dayLabel.toLowerCase()}`,
  };
}
