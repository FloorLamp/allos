import { describe, expect, it } from "vitest";
import { foodServingFeedback } from "@/lib/food-serving-feedback";
import { upsertToast, type KeyedToast } from "@/lib/toast-upsert";

interface TestToast extends KeyedToast {
  message: string;
}

describe("foodServingFeedback", () => {
  it("replaces two taps with one keyed cumulative toast", () => {
    let toasts: TestToast[] = [];
    for (const servings of [1, 2]) {
      const feedback = foodServingFeedback(
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
      key: "food-serving:2026-08-24:vegetables",
      message: "2 servings of Vegetables today",
      revision: 1,
    });
  });
});
