import { describe, expect, it } from "vitest";
import {
  foodServingCoordinate,
  foodServingFeedback,
  foodServingInverseKey,
  beginFoodServingAdd,
  emptyFoodServingBurst,
  invalidateFoodServingBurst,
  settleFoodServingAdd,
} from "@/lib/food-serving-feedback";
import {
  dismissOtherProfileToasts,
  upsertToast,
  type KeyedToast,
} from "@/lib/toast-upsert";

interface TestToast extends KeyedToast {
  message: string;
}

describe("foodServingFeedback", () => {
  it("replaces two taps with one keyed cumulative toast", () => {
    let toasts: TestToast[] = [];
    for (const servings of [1, 2]) {
      const feedback = foodServingFeedback(
        7,
        "2026-08-24",
        "vegetables",
        "Vegetables",
        servings,
        "Today"
      );
      toasts = upsertToast(toasts, {
        id: servings,
        revision: 0,
        ...feedback,
      });
    }

    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      key: "food-serving:7:2026-08-24:vegetables",
      message: "2 servings of Vegetables today",
      revision: 1,
    });
  });

  it("keeps every partial settlement away from three optimistic taps and binds Undo to tap order", () => {
    let state = emptyFoodServingBurst();
    const morning = beginFoodServingAdd(state, "morning", "Morning");
    state = morning.state;
    const evening = beginFoodServingAdd(state, "evening", "Evening");
    state = evening.state;
    const midday = beginFoodServingAdd(state, "midday", "Midday");
    state = midday.state;

    // Natural response order: after three optimistic taps are already visible,
    // the first response knows only its own total. It must not publish a count
    // that would roll the UI 3→1 while the other taps are still pending.
    const first = settleFoodServingAdd(state, morning.tap, { ok: true });
    expect(first.completed).toBe(false);
    expect(first.receipt).toBeUndefined();

    const second = settleFoodServingAdd(first.state, evening.tap, { ok: true });
    expect(second.completed).toBe(false);
    expect(second.receipt).toBeUndefined();

    // A concurrent removal can make the final action's own result numerically
    // lower. The coordinator accepts only success/tap identity; response totals
    // never enter this protocol, and the caller performs one fresh read now.
    const final = settleFoodServingAdd(second.state, midday.tap, { ok: true });

    expect(final.completed).toBe(true);
    expect(final.receipt).toEqual({
      coordinate: "midday",
      mealSlot: "Midday",
    });
  });

  it("ignores a delayed add settlement after a decrement starts a new epoch", () => {
    const begun = beginFoodServingAdd(
      emptyFoodServingBurst(),
      "morning",
      "Morning"
    );
    const afterRemoval = invalidateFoodServingBurst(begun.state);
    const stale = settleFoodServingAdd(afterRemoval, begun.tap, { ok: true });
    expect(stale.accepted).toBe(false);
    expect(stale.completed).toBe(false);
    expect(stale.receipt).toBeUndefined();
  });

  it("keeps successful receipt and failure channel when the final tap fails", () => {
    let state = emptyFoodServingBurst();
    const first = beginFoodServingAdd(state, "morning", "Morning");
    state = first.state;
    const second = beginFoodServingAdd(state, "evening", "Evening");
    const success = settleFoodServingAdd(second.state, first.tap, { ok: true });
    const failure = settleFoodServingAdd(success.state, second.tap, {
      ok: false,
    });
    expect(failure.receipt).toEqual({
      coordinate: "morning",
      mealSlot: "Morning",
    });
    expect(failure.completed).toBe(true);
    expect(failure.reportFailure).toBe(true);
  });

  it("keys settle state by profile, day, meal, and group", () => {
    expect(
      foodServingCoordinate(7, "2026-08-24", "Morning", "berries")
    ).not.toBe(foodServingCoordinate(7, "2026-08-24", "Evening", "berries"));
    expect(
      foodServingCoordinate(7, "2026-08-24", "Morning", "berries")
    ).not.toBe(foodServingCoordinate(7, "2026-08-23", "Morning", "berries"));
  });

  it("keeps one toast slot but gives every upgraded Undo a fresh write identity", () => {
    const coordinate = foodServingCoordinate(
      7,
      "2026-08-24",
      "Morning",
      "berries"
    );
    expect(foodServingInverseKey(coordinate, 1)).not.toBe(
      foodServingInverseKey(coordinate, 2)
    );
    expect(
      foodServingFeedback(7, "2026-08-24", "berries", "Berries", 1, "Today").key
    ).toBe(
      foodServingFeedback(7, "2026-08-24", "berries", "Berries", 2, "Today").key
    );
  });

  it("drops shown and queued receipts from the previous profile only", () => {
    const toasts: TestToast[] = [
      {
        id: 1,
        revision: 0,
        key: "food-serving:7:2026-08-24:berries",
        profileId: 7,
        message: "A receipt",
      },
      {
        id: 2,
        revision: 0,
        key: "food-serving:8:2026-08-24:berries",
        profileId: 8,
        message: "B receipt",
      },
      { id: 3, revision: 0, message: "Unscoped notice" },
    ];

    expect(
      dismissOtherProfileToasts(toasts, 8).map((toast) => toast.id)
    ).toEqual([2, 3]);
  });

  it("lets precise removal replace the older add receipt in the same slot", () => {
    const key = foodServingFeedback(
      7,
      "2026-08-24",
      "berries",
      "Berries",
      1,
      "Today"
    ).key;
    const add = testToast({
      id: 1,
      key,
      message: "1 serving of Berries today",
    });
    const removal = testToast({ id: 2, key, message: "Serving removed." });

    const toasts = upsertToast([add], removal);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      id: 1,
      key,
      message: "Serving removed.",
      revision: 1,
    });
  });
});

function testToast(overrides: Partial<TestToast> & { id: number }): TestToast {
  return { revision: 0, message: "", ...overrides };
}
