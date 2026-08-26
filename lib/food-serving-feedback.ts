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
  latestSuccessfulTap: FoodServingAddTap | null;
  latestSuccessfulEventId: number | null;
  // Corrections, removals, and inverses do not occupy the add-pending map, but
  // an authoritative read must still wait until their server action settles.
  nonAddPending: ReadonlySet<number>;
  truthDeferred: boolean;
  truthRevision: number;
  successes: number;
  failures: number;
}

export interface FoodServingBurstReceipt {
  coordinate: string;
  mealSlot: string;
  eventId: number;
}

export interface FoodServingBurstSettlement {
  state: FoodServingBurstState;
  accepted: boolean;
  completed: boolean;
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
    latestSuccessfulTap: null,
    latestSuccessfulEventId: null,
    nonAddPending: new Set(),
    truthDeferred: false,
    truthRevision: 0,
    successes: 0,
    failures: 0,
  };
}

// Tap order and response order are different facts. The burst remembers the
// former for the inverse coordinate. It deliberately does NOT combine returned
// totals: a number cannot prove server order once another client may add,
// remove, or correct the same coordinate. The caller performs one fresh read
// after the final pending response instead.
export function beginFoodServingAdd(
  state: FoodServingBurstState,
  coordinate: string,
  mealSlot: string
): { state: FoodServingBurstState; tap: FoodServingAddTap } {
  const starting = state.pending.size === 0;
  // A completed burst followed by a later add is a new coordinate mutation.
  // Rapid taps that are pending together intentionally share one epoch.
  const epoch = starting ? state.epoch + 1 : state.epoch;
  const tap: FoodServingAddTap = {
    id: state.nextTapId + 1,
    epoch,
    coordinate,
    mealSlot,
  };
  const pending = new Map(state.pending).set(tap.id, tap);
  return {
    tap,
    state: {
      ...state,
      epoch,
      nextTapId: tap.id,
      pending,
      latestSuccessfulTap: starting ? null : state.latestSuccessfulTap,
      latestSuccessfulEventId: starting ? null : state.latestSuccessfulEventId,
      successes: starting ? 0 : state.successes,
      failures: starting ? 0 : state.failures,
    },
  };
}

export function settleFoodServingAdd(
  state: FoodServingBurstState,
  tap: FoodServingAddTap,
  outcome: { ok: true; eventId: number } | { ok: false }
): FoodServingBurstSettlement {
  if (tap.epoch !== state.epoch || !state.pending.has(tap.id)) {
    return {
      state,
      accepted: false,
      completed: false,
      reportFailure: false,
    };
  }
  const pending = new Map(state.pending);
  pending.delete(tap.id);
  let latestSuccessfulTap = state.latestSuccessfulTap;
  let latestSuccessfulEventId = state.latestSuccessfulEventId;
  let successes = state.successes;
  let failures = state.failures;
  if (outcome.ok) {
    successes += 1;
    if (!latestSuccessfulTap || tap.id > latestSuccessfulTap.id) {
      latestSuccessfulTap = tap;
      latestSuccessfulEventId = outcome.eventId;
    }
  } else {
    failures += 1;
  }
  const completed = pending.size === 0;
  const receipt =
    completed &&
    successes > 0 &&
    latestSuccessfulTap &&
    latestSuccessfulEventId != null
      ? {
          coordinate: latestSuccessfulTap.coordinate,
          mealSlot: latestSuccessfulTap.mealSlot,
          eventId: latestSuccessfulEventId,
        }
      : undefined;
  const reportFailure = completed && failures > 0;
  const next = completed
    ? {
        ...emptyFoodServingBurst(state.epoch, state.nextTapId),
        nonAddPending: state.nonAddPending,
        truthDeferred: state.truthDeferred,
        truthRevision: state.truthRevision,
      }
    : {
        ...state,
        pending,
        latestSuccessfulTap,
        latestSuccessfulEventId,
        successes,
        failures,
      };
  return {
    state: next,
    accepted: true,
    completed,
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
    ? {
        ...emptyFoodServingBurst(state.epoch, state.nextTapId),
        nonAddPending: state.nonAddPending,
        truthDeferred: state.truthDeferred,
        truthRevision: state.truthRevision,
      }
    : { ...state, pending };
}

// A decrement/removal starts a new mutation epoch. Responses from adds that were
// already in flight remain server facts, but may not resurrect their obsolete UI
// count or Undo offer over the newer authoritative mutation.
export function invalidateFoodServingBurst(
  state: FoodServingBurstState
): FoodServingBurstState {
  return {
    ...emptyFoodServingBurst(state.epoch + 1, state.nextTapId),
    nonAddPending: state.nonAddPending,
    truthDeferred: state.truthDeferred,
    truthRevision: state.truthRevision,
  };
}

export function beginFoodServingNonAddMutation(
  state: FoodServingBurstState
): FoodServingBurstState {
  const invalidated = invalidateFoodServingBurst(state);
  return {
    ...invalidated,
    nonAddPending: new Set(state.nonAddPending).add(invalidated.epoch),
    truthRevision: state.truthRevision + 1,
  };
}

export function requestFoodServingTruth(state: FoodServingBurstState): {
  state: FoodServingBurstState;
  readNow: boolean;
} {
  return state.nonAddPending.size > 0
    ? { state: { ...state, truthDeferred: true }, readNow: false }
    : { state, readNow: true };
}

export function finishFoodServingNonAddMutation(
  state: FoodServingBurstState,
  epoch: number
): { state: FoodServingBurstState; refreshDeferredTruth: boolean } {
  if (!state.nonAddPending.has(epoch))
    return { state, refreshDeferredTruth: false };
  const nonAddPending = new Set(state.nonAddPending);
  nonAddPending.delete(epoch);
  const complete = nonAddPending.size === 0;
  return {
    state: {
      ...state,
      nonAddPending,
      truthDeferred: complete ? false : state.truthDeferred,
      truthRevision: state.truthRevision + 1,
    },
    refreshDeferredTruth: complete && state.truthDeferred,
  };
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
