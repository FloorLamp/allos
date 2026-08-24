import { useEffect } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveProfileProvider } from "@/components/ActiveProfileProvider";
import { ToastProvider, useActivateToastProfile } from "@/components/Toast";
import { TimezoneProvider } from "@/components/TimezoneProvider";
import FoodLogBar, { type FoodLogDay } from "@/app/(app)/nutrition/FoodLogBar";
import { FoodSelectedDateProvider } from "@/app/(app)/nutrition/FoodSuggestionsLayout";
import type { FoodGroup } from "@/lib/food-groups";
import type { FoodSlot } from "@/lib/food-slot";

const actions = vi.hoisted(() => ({
  logFoodServing: vi.fn(),
  undoFoodServing: vi.fn(),
  readFoodServingTruth: vi.fn(),
  deleteFoodLogEvent: vi.fn(),
  updateFoodLogEvent: vi.fn(),
  logUsualFood: vi.fn(),
}));

vi.mock("@/app/(app)/nutrition/actions", () => actions);
vi.mock("@/app/(app)/nutrition/fast-actions", () => ({
  endFastAction: vi.fn(),
  undoEndFastAction: vi.fn(),
}));
vi.mock("@/app/(app)/undo-actions", () => ({ undoDelete: vi.fn() }));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({
    pending: 0,
    enqueue: vi.fn(async () => true),
    flush: vi.fn(async () => {}),
  }),
}));

const DATE = "2026-08-24";
const GROUP: FoodGroup = {
  slug: "cruciferous",
  name: "Cruciferous vegetables",
  serving: "1 cup",
  tier: "encourage",
  nutrients: [],
};
const GROUPS = Object.fromEntries(
  ["Morning", "Midday", "Evening"].map((slot) => [slot, [GROUP]])
) as Record<FoodSlot, FoodGroup[]>;
const DAY: FoodLogDay = {
  date: DATE,
  label: "Today",
  counts: { cruciferous: 0 },
  slotCounts: { Morning: {}, Midday: { cruciferous: 0 }, Evening: {} },
  events: [],
};

function mediaQuery(query: string): MediaQueryList {
  return {
    // This test owns the provider projection and guarded inverse, not animation
    // scheduling. Make the accessibility end state deterministic under the full
    // unit suite's loaded event loop; motion behavior has its own focused tests.
    matches: query.includes("prefers-reduced-motion: reduce"),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  };
}

function ActivateProfileToast({ profileId }: { profileId: number }) {
  const activate = useActivateToastProfile();
  useEffect(() => activate(profileId), [activate, profileId]);
  return null;
}

function mountBar() {
  render(
    <TimezoneProvider tz="UTC">
      <ActiveProfileProvider profileId={7}>
        <ToastProvider>
          <ActivateProfileToast profileId={7} />
          <FoodSelectedDateProvider today={DATE} days={[DAY]}>
            <FoodLogBar
              today={DATE}
              days={[DAY]}
              groupsBySlot={GROUPS}
              excludedGroups={[]}
              slot="Midday"
              slotBoundaries={{ midday: 660, evening: 900 }}
            />
          </FoodSelectedDateProvider>
        </ToastProvider>
      </ActiveProfileProvider>
    </TimezoneProvider>
  );
}

describe("FoodLogBar guarded Undo projection", () => {
  beforeEach(() => {
    window.matchMedia = mediaQuery;
    actions.logFoodServing.mockReset();
    actions.undoFoodServing.mockReset();
    actions.readFoodServingTruth.mockReset();
    actions.logFoodServing.mockResolvedValue({
      ok: true,
      eventId: 41,
      servings: 3,
      mealSlot: "Midday",
      mealServings: 3,
    });
    actions.undoFoodServing.mockResolvedValue({
      ok: false,
      error: "That serving count has changed.",
      servings: 4,
      mealSlot: "Midday",
      mealServings: 4,
    });
    actions.readFoodServingTruth
      .mockResolvedValueOnce({
        ok: true,
        servings: 3,
        mealServings: { Morning: 0, Midday: 3, Evening: 0 },
      })
      .mockResolvedValueOnce({
        ok: true,
        servings: 4,
        mealServings: { Morning: 0, Midday: 4, Evening: 0 },
      });
  });

  it("publishes fresh day and meal truth when a newer serving invalidates the receipt", async () => {
    mountBar();

    fireEvent.click(screen.getByTestId("log-cruciferous"));
    await waitFor(() =>
      expect(screen.getByTestId("count-cruciferous").textContent).toBe("3")
    );
    const undo = await screen.findByRole("button", { name: "Undo" });

    await act(async () => {
      fireEvent.click(undo);
    });

    await waitFor(() =>
      expect(screen.getByTestId("count-cruciferous").textContent).toBe("4")
    );
    expect(actions.undoFoodServing).toHaveBeenCalledTimes(1);
    const inverse = actions.undoFoodServing.mock.calls[0][0] as FormData;
    expect(inverse.get("expected_servings")).toBe("3");
    expect(inverse.get("event_id")).toBe("41");
    expect(actions.readFoodServingTruth).toHaveBeenCalledTimes(2);
    expect(
      await screen.findByText("Couldn’t undo — this has changed since.")
    ).toBeTruthy();
  });
});
