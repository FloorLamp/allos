import { useEffect } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function normalMotionMediaQuery(query: string): MediaQueryList {
  return { ...mediaQuery(query), matches: false };
}

function ActivateProfileToast({ profileId }: { profileId: number }) {
  const activate = useActivateToastProfile();
  useEffect(() => activate(profileId), [activate, profileId]);
  return null;
}

function barTree({
  profileId = 7,
  day = DAY,
  slot = "Midday" as FoodSlot,
} = {}) {
  return (
    <TimezoneProvider tz="UTC">
      <ActiveProfileProvider profileId={profileId}>
        <ToastProvider>
          <ActivateProfileToast profileId={profileId} />
          <FoodSelectedDateProvider today={DATE} days={[day]}>
            <FoodLogBar
              today={DATE}
              days={[day]}
              groupsBySlot={GROUPS}
              excludedGroups={[]}
              slot={slot}
              slotBoundaries={{ midday: 660, evening: 900 }}
            />
          </FoodSelectedDateProvider>
        </ToastProvider>
      </ActiveProfileProvider>
    </TimezoneProvider>
  );
}

function mountBar(options: Parameters<typeof barTree>[0] = {}) {
  return render(barTree(options));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("FoodLogBar projection publication", () => {
  beforeEach(() => {
    window.matchMedia = mediaQuery;
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    actions.logFoodServing.mockReset();
    actions.undoFoodServing.mockReset();
    actions.readFoodServingTruth.mockReset();
    actions.updateFoodLogEvent.mockReset();
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

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("publishes correction truth after its Server Action RSC rerender", async () => {
    window.matchMedia = normalMotionMediaQuery;
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      })
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const day: FoodLogDay = {
      ...DAY,
      counts: { cruciferous: 1 },
      slotCounts: {
        Morning: { cruciferous: 1 },
        Midday: {},
        Evening: {},
      },
      events: [
        {
          id: 51,
          groupKey: "cruciferous",
          name: GROUP.name,
          date: DATE,
          mealSlot: "Morning",
          eatenAt: null,
          loggedTime: "08:00",
        },
      ],
    };
    const outcome = {
      ok: true,
      from: {
        date: DATE,
        groupKey: "cruciferous",
        mealSlot: "Morning",
        servings: 1,
        mealServings: 0,
      },
      to: {
        date: DATE,
        groupKey: "cruciferous",
        mealSlot: "Evening",
        servings: 1,
        mealServings: 1,
      },
    } as const;
    const correction = deferred<typeof outcome>();
    actions.updateFoodLogEvent.mockReturnValue(correction.promise);
    const view = mountBar({ day, slot: "Morning" });

    fireEvent.click(
      screen.getByRole("button", {
        name: /^Actions for the Cruciferous vegetables serving/,
      })
    );
    fireEvent.click(screen.getByTestId("food-logged-correct-51"));
    fireEvent.change(screen.getByTestId("food-correct-slot"), {
      target: { value: "Evening" },
    });
    act(() => {
      fireEvent.click(screen.getByTestId("food-correct-save"));
    });
    expect(actions.updateFoodLogEvent).toHaveBeenCalledTimes(1);

    // A Server Action applies its revalidated RSC tree before the awaiting client
    // continuation publishes the typed result. The provider stays mounted for the
    // same profile, while the bar receives the server's corrected row/day props.
    const correctedDay: FoodLogDay = {
      ...day,
      slotCounts: {
        Morning: { cruciferous: 0 },
        Midday: {},
        Evening: { cruciferous: 1 },
      },
      events: [{ ...day.events[0], mealSlot: "Evening" }],
    };
    view.rerender(barTree({ day: correctedDay, slot: "Morning" }));

    await act(async () => correction.resolve(outcome));

    // Both consumers read the same provider projection. The raw meal totals and
    // the row's title prove it is already Morning=0/Evening=1 even though the
    // visual receipt's queued frame has deliberately not run.
    expect(screen.getByTestId("food-slot-total-morning").textContent).toBe("0");
    expect(screen.getByTestId("food-slot-total-evening").textContent).toBe("1");
    expect(screen.getByTestId("count-cruciferous").getAttribute("title")).toBe(
      "0 servings in Morning today"
    );
    expect(screen.getByTestId("count-cruciferous").textContent).toBe("0");
    expect(frames).toHaveLength(1);
  });
});
