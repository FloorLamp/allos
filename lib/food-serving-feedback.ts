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

export interface FoodServingAddTruth {
  servings: number;
  mealServings: number;
}

// Add responses may resolve out of order. Within one day/group/meal burst both
// authoritative counters are monotonic, so a later-arriving lower response is an
// older truth: keep the maxima and do not let it replace the receipt/inverse.
export function reconcileFoodServingAdd(
  previous: FoodServingAddTruth | undefined,
  incoming: FoodServingAddTruth
): FoodServingAddTruth & { publishReceipt: boolean } {
  if (!previous) return { ...incoming, publishReceipt: true };
  return {
    servings: Math.max(previous.servings, incoming.servings),
    mealServings: Math.max(previous.mealServings, incoming.mealServings),
    publishReceipt: incoming.servings >= previous.servings,
  };
}

export function finishesFoodServingBurst(pendingAdds: number): boolean {
  return pendingAdds <= 1;
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
