import { describe, expect, it } from "vitest";
import {
  foodServingCoordinate,
  foodServingFeedback,
  foodServingInverseKey,
  finishesFoodServingBurst,
  reconcileFoodServingAdd,
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

  it("does not regress count or receipt when deferred adds settle 3 then 2", async () => {
    let resolveTwo!: (truth: {
      servings: number;
      mealServings: number;
    }) => void;
    let resolveThree!: (truth: {
      servings: number;
      mealServings: number;
    }) => void;
    const two = new Promise<{ servings: number; mealServings: number }>(
      (resolve) => (resolveTwo = resolve)
    );
    const three = new Promise<{ servings: number; mealServings: number }>(
      (resolve) => (resolveThree = resolve)
    );
    let visible: ReturnType<typeof reconcileFoodServingAdd> | undefined;
    let receipt: ReturnType<typeof reconcileFoodServingAdd> | undefined;
    let pendingAdds = 2;
    const settle = async (
      pending: Promise<{ servings: number; mealServings: number }>
    ) => {
      const incoming = await pending;
      visible = reconcileFoodServingAdd(visible, incoming);
      if (finishesFoodServingBurst(pendingAdds)) receipt = visible;
      pendingAdds -= 1;
    };
    const older = settle(two);
    const newer = settle(three);
    resolveThree({ servings: 3, mealServings: 3 });
    await newer;
    resolveTwo({ servings: 2, mealServings: 2 });
    await older;

    expect(visible).toEqual({
      servings: 3,
      mealServings: 3,
      publishReceipt: false,
    });
    expect(receipt).toEqual({
      servings: 3,
      mealServings: 3,
      publishReceipt: false,
    });
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
