import { useEffect, useLayoutEffect } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveProfileProvider } from "@/components/ActiveProfileProvider";
import {
  ToastProvider,
  useToast,
  useToastProfileScopeGetter,
} from "@/components/Toast";
import ProfileSwitchWatcher from "@/components/ProfileSwitchWatcher";
import { TimezoneProvider } from "@/components/TimezoneProvider";
import FoodLogBar, { type FoodLogDay } from "@/app/(app)/nutrition/FoodLogBar";
import { FoodSelectedDateProvider } from "@/app/(app)/nutrition/FoodSuggestionsLayout";
import type { FoodGroup } from "@/lib/food-groups";
import type { FoodSlot } from "@/lib/food-slot";
import type { ProfileToastScope } from "@/lib/toast-upsert";

const actions = vi.hoisted(() => ({
  logFoodServing: vi.fn(),
  undoFoodServing: vi.fn(),
  readFoodServingTruth: vi.fn(),
  deleteFoodLogEvent: vi.fn(),
  updateFoodLogEvent: vi.fn(),
  logUsualFood: vi.fn(),
}));
const fastActions = vi.hoisted(() => ({
  endFastAction: vi.fn(),
  undoEndFastAction: vi.fn(),
}));

vi.mock("@/app/(app)/nutrition/actions", () => actions);
// This suite owns receipt lifecycle, not the unopened preferences modal. Loading
// the real form also loads its settings Server Action and the full DB graph.
vi.mock("@/app/(app)/settings/profile/DietaryPreferencesForm", () => ({
  default: () => null,
}));
vi.mock("@/components/emergency-offline", () => ({
  clearEmergencyPayload: vi.fn(),
}));
vi.mock("@/lib/offline/snapshot-db", () => ({ clearSnapshots: vi.fn() }));
vi.mock("@/app/(app)/nutrition/fast-actions", () => fastActions);
vi.mock("@/app/(app)/undo-actions", () => ({ undoDelete: vi.fn() }));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({
    pending: 0,
    enqueue: vi.fn(async () => "kept" as const),
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

function TapBeforePassiveEffect() {
  useLayoutEffect(() => {
    document
      .querySelector<HTMLElement>("[data-testid='log-cruciferous']")
      ?.click();
  }, []);
  return null;
}

function RunOnLayoutCommit({ run }: { run: () => void }) {
  useLayoutEffect(run, [run]);
  return null;
}

function CaptureProfileScopeAfterCommit({
  capture,
}: {
  capture: (scope: ProfileToastScope | null) => void;
}) {
  const getScope = useToastProfileScopeGetter();
  useEffect(() => capture(getScope()), [capture, getScope]);
  return null;
}

function PostProfileNoteOnLayout({
  oldScope,
  observeCurrent,
}: {
  oldScope: ProfileToastScope;
  observeCurrent: (scope: ProfileToastScope | null) => void;
}) {
  const toast = useToast();
  const getScope = useToastProfileScopeGetter();
  useLayoutEffect(() => {
    observeCurrent(getScope());
    toast("Old-profile layout note.", {
      profileId: oldScope.profileId,
      profileToken: oldScope.token,
    });
  }, [getScope, observeCurrent, oldScope, toast]);
  return null;
}

function barTree({
  profileId = 7,
  day = DAY,
  slot = "Midday" as FoodSlot,
  barKey = "food-bar",
  providerKey = "food-provider",
  tapBeforePassiveEffect = false,
  onLayoutCommit = undefined as (() => void) | undefined,
  captureProfileScope = undefined as
    ((scope: ProfileToastScope | null) => void) | undefined,
  layoutProfileNote = undefined as
    | {
        oldScope: ProfileToastScope;
        observeCurrent: (scope: ProfileToastScope | null) => void;
      }
    | undefined,
} = {}) {
  return (
    <TimezoneProvider tz="UTC">
      <ActiveProfileProvider profileId={profileId}>
        <ToastProvider>
          <ProfileSwitchWatcher activeProfileId={profileId} />
          {captureProfileScope && (
            <CaptureProfileScopeAfterCommit capture={captureProfileScope} />
          )}
          {layoutProfileNote && (
            <PostProfileNoteOnLayout {...layoutProfileNote} />
          )}
          <FoodSelectedDateProvider key={providerKey} today={DATE} days={[day]}>
            <FoodLogBar
              key={barKey}
              today={DATE}
              days={[day]}
              groupsBySlot={GROUPS}
              excludedGroups={[]}
              slot={slot}
              slotBoundaries={{ midday: 660, evening: 900 }}
            />
            {tapBeforePassiveEffect && <TapBeforePassiveEffect />}
            {onLayoutCommit && <RunOnLayoutCommit run={onLayoutCommit} />}
          </FoodSelectedDateProvider>
        </ToastProvider>
      </ActiveProfileProvider>
    </TimezoneProvider>
  );
}

function mountBar(options: Parameters<typeof barTree>[0] = {}) {
  return render(barTree(options));
}

function twoBarTree({ showFirst = true, day = DAY } = {}) {
  const bar = (key: string) => (
    <FoodSelectedDateProvider key={`provider-${key}`} today={DATE} days={[day]}>
      <FoodLogBar
        key={`bar-${key}`}
        today={DATE}
        days={[day]}
        groupsBySlot={GROUPS}
        excludedGroups={[]}
        slot="Midday"
        slotBoundaries={{ midday: 660, evening: 900 }}
      />
    </FoodSelectedDateProvider>
  );
  return (
    <TimezoneProvider tz="UTC">
      <ActiveProfileProvider profileId={7}>
        <ToastProvider>
          <ProfileSwitchWatcher activeProfileId={7} />
          <div data-testid="first-food-bar">{showFirst && bar("first")}</div>
          <div data-testid="second-food-bar">{bar("second")}</div>
        </ToastProvider>
      </ActiveProfileProvider>
    </TimezoneProvider>
  );
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
    actions.deleteFoodLogEvent.mockReset();
    actions.updateFoodLogEvent.mockReset();
    actions.logUsualFood.mockReset();
    fastActions.endFastAction.mockReset();
    fastActions.undoEndFastAction.mockReset();
    fastActions.endFastAction.mockResolvedValue({
      ok: false,
      error: "No fast is running.",
    });
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

  it("publishes the authoritative receipt for a tap committed before passive effects", async () => {
    const outcome = {
      ok: true,
      eventId: 40,
      servings: 1,
      mealSlot: "Midday",
      mealServings: 1,
      endFastOffer: true,
      limitNote: {
        kind: "interaction",
        groupKey: "cruciferous",
        title: "Early interaction note.",
        body: "Keep the authoritative receipt.",
        hold: true,
      },
    } as const;
    const add = deferred<typeof outcome>();
    actions.logFoodServing.mockReturnValue(add.promise);
    actions.readFoodServingTruth.mockReset().mockResolvedValue({
      ok: true,
      servings: 1,
      mealServings: { Morning: 0, Midday: 1, Evening: 0 },
    });

    mountBar({ tapBeforePassiveEffect: true });

    expect(actions.logFoodServing).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("count-cruciferous").textContent).toBe("1");
    await act(async () => add.resolve(outcome));

    expect(actions.readFoodServingTruth).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("count-cruciferous").textContent).toBe("1");
    expect(await screen.findByRole("button", { name: "Undo" })).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: "End fast" })
    ).toBeTruthy();
    expect(screen.getByText(/Early interaction note\./).textContent).toContain(
      "Keep the authoritative receipt."
    );
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

  it("resets provider projection when the mounted subject changes", () => {
    const profileSeven: FoodLogDay = {
      ...DAY,
      counts: { cruciferous: 1 },
      slotCounts: {
        Morning: {},
        Midday: { cruciferous: 1 },
        Evening: {},
      },
    };
    const profileEight: FoodLogDay = {
      ...DAY,
      counts: { cruciferous: 9 },
      slotCounts: {
        Morning: {},
        Midday: { cruciferous: 9 },
        Evening: {},
      },
    };
    const view = mountBar({ profileId: 7, day: profileSeven });
    expect(screen.getByTestId("food-slot-total-midday").textContent).toBe("1");
    expect(screen.getByTestId("count-cruciferous").textContent).toBe("1");

    view.rerender(barTree({ profileId: 8, day: profileEight }));

    // Plain totals derive directly from the provider projection, so this
    // proves subject reset independently of RollingNumber's visual lifecycle.
    expect(screen.getByTestId("food-slot-total-midday").textContent).toBe("9");
    expect(screen.getByTestId("count-cruciferous").textContent).toBe("9");
  });

  it("drops a deferred correction receipt after its profile bar unmounts", async () => {
    const profileSeven: FoodLogDay = {
      ...DAY,
      counts: { cruciferous: 1 },
      slotCounts: {
        Morning: { cruciferous: 1 },
        Midday: {},
        Evening: {},
      },
      events: [
        {
          id: 71,
          groupKey: "cruciferous",
          name: GROUP.name,
          date: DATE,
          mealSlot: "Morning",
          eatenAt: null,
          loggedTime: "08:00",
        },
      ],
    };
    const profileEight: FoodLogDay = {
      ...DAY,
      counts: { cruciferous: 9 },
      slotCounts: {
        Morning: {},
        Midday: { cruciferous: 9 },
        Evening: {},
      },
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
    const view = mountBar({
      profileId: 7,
      day: profileSeven,
      slot: "Morning",
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: /^Actions for the Cruciferous vegetables serving/,
      })
    );
    fireEvent.click(screen.getByTestId("food-logged-correct-71"));
    fireEvent.change(screen.getByTestId("food-correct-slot"), {
      target: { value: "Evening" },
    });
    fireEvent.click(screen.getByTestId("food-correct-save"));
    expect(actions.updateFoodLogEvent).toHaveBeenCalledTimes(1);

    view.rerender(
      barTree({
        profileId: 8,
        day: profileEight,
        onLayoutCommit: () => correction.resolve(outcome),
      })
    );
    await act(async () => {});

    expect(screen.getByTestId("food-slot-total-midday").textContent).toBe("9");
    expect(screen.getByTestId("count-cruciferous").textContent).toBe("9");
    expect(screen.queryByText("Serving corrected.")).toBeNull();
    expect(screen.queryByTestId("toast")).toBeNull();
    expect(screen.queryByTestId("food-correct-save")).toBeNull();
  });

  it("rotates the profile token before a pure old-profile note resolves in the new layout", async () => {
    const profileEight: FoodLogDay = {
      ...DAY,
      counts: { cruciferous: 9 },
      slotCounts: {
        Morning: {},
        Midday: { cruciferous: 9 },
        Evening: {},
      },
    };
    let oldScope: ProfileToastScope | null = null;
    let scopeDuringNewLayout: ProfileToastScope | null = null;
    const view = mountBar({
      profileId: 7,
      captureProfileScope: (scope) => {
        oldScope = scope;
      },
    });
    expect(oldScope).not.toBeNull();

    view.rerender(
      barTree({
        profileId: 8,
        day: profileEight,
        layoutProfileNote: {
          oldScope: oldScope!,
          observeCurrent: (scope) => {
            scopeDuringNewLayout = scope;
          },
        },
      })
    );
    await act(async () => {});

    expect(scopeDuringNewLayout).toMatchObject({ profileId: 8 });
    expect(screen.queryByText(/Old-profile layout note\./)).toBeNull();
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("does not claim a correction after a same-profile provider remount", async () => {
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
          id: 74,
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
    const view = mountBar({ profileId: 7, day, slot: "Morning" });

    fireEvent.click(
      screen.getByRole("button", {
        name: /^Actions for the Cruciferous vegetables serving/,
      })
    );
    fireEvent.click(screen.getByTestId("food-logged-correct-74"));
    fireEvent.change(screen.getByTestId("food-correct-slot"), {
      target: { value: "Evening" },
    });
    fireEvent.click(screen.getByTestId("food-correct-save"));

    view.rerender(
      barTree({
        profileId: 7,
        day,
        slot: "Morning",
        barKey: "replacement-correction-bar",
        providerKey: "replacement-correction-provider",
      })
    );
    await act(async () => correction.resolve(outcome));

    expect(screen.getByTestId("food-slot-total-morning").textContent).toBe("1");
    expect(screen.getByTestId("food-slot-total-evening").textContent).toBe("0");
    expect(screen.queryByText("Serving corrected.")).toBeNull();
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("rejects an old interaction note after an A to B to A profile cycle", async () => {
    const profileSeven: FoodLogDay = {
      ...DAY,
      counts: { cruciferous: 1 },
      slotCounts: {
        Morning: {},
        Midday: { cruciferous: 1 },
        Evening: {},
      },
    };
    const profileEight: FoodLogDay = {
      ...DAY,
      counts: { cruciferous: 9 },
      slotCounts: {
        Morning: {},
        Midday: { cruciferous: 9 },
        Evening: {},
      },
    };
    const returnedProfileSeven: FoodLogDay = {
      ...DAY,
      counts: { cruciferous: 5 },
      slotCounts: {
        Morning: {},
        Midday: { cruciferous: 5 },
        Evening: {},
      },
    };
    const outcome = {
      ok: true,
      eventId: 72,
      servings: 2,
      mealSlot: "Midday",
      mealServings: 2,
      limitNote: {
        kind: "interaction",
        groupKey: "cruciferous",
        title: "Food interaction note.",
        body: "Check the timing guidance for this food.",
        hold: true,
      },
    } as const;
    const add = deferred<typeof outcome>();
    actions.logFoodServing.mockReturnValue(add.promise);
    const view = mountBar({ profileId: 7, day: profileSeven });

    fireEvent.click(screen.getByTestId("log-cruciferous"));
    expect(actions.logFoodServing).toHaveBeenCalledTimes(1);
    const submitted = actions.logFoodServing.mock.calls[0][0] as FormData;
    expect(submitted.get("profileId")).toBe("7");

    view.rerender(barTree({ profileId: 8, day: profileEight }));
    view.rerender(barTree({ profileId: 7, day: returnedProfileSeven }));
    await act(async () => add.resolve(outcome));

    expect(screen.getByTestId("food-slot-total-midday").textContent).toBe("5");
    expect(screen.getByTestId("count-cruciferous").textContent).toBe("5");
    expect(screen.queryByText("Food interaction note.")).toBeNull();
    expect(screen.queryByTestId("toast")).toBeNull();
    expect(actions.readFoodServingTruth).not.toHaveBeenCalled();
  });

  it("keeps only a pure late note across a same-generation remount", async () => {
    const before: FoodLogDay = {
      ...DAY,
      counts: { cruciferous: 1 },
      slotCounts: {
        Morning: {},
        Midday: { cruciferous: 1 },
        Evening: {},
      },
    };
    const remounted: FoodLogDay = {
      ...DAY,
      counts: { cruciferous: 2 },
      slotCounts: {
        Morning: {},
        Midday: { cruciferous: 2 },
        Evening: {},
      },
    };
    const outcome = {
      ok: true,
      eventId: 73,
      servings: 2,
      mealSlot: "Midday",
      mealServings: 2,
      endFastOffer: true,
      limitNote: {
        kind: "interaction",
        groupKey: "cruciferous",
        title: "Same-profile interaction note.",
        body: "Keep this receipt after an ordinary remount.",
        hold: true,
      },
    } as const;
    const add = deferred<typeof outcome>();
    actions.logFoodServing.mockReturnValue(add.promise);
    const view = mountBar({ profileId: 7, day: before });

    fireEvent.click(screen.getByTestId("log-cruciferous"));
    view.rerender(
      barTree({
        profileId: 7,
        day: remounted,
        barKey: "replacement-bar",
        providerKey: "replacement-provider",
      })
    );
    await act(async () => add.resolve(outcome));

    expect(screen.getByTestId("food-slot-total-midday").textContent).toBe("2");
    expect(screen.getByTestId("count-cruciferous").textContent).toBe("2");
    expect(
      screen.getByText(/Same-profile interaction note\./).textContent
    ).toContain("Keep this receipt after an ordinary remount.");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.queryByRole("button", { name: "End fast" })).toBeNull();
    expect(screen.queryByText("Serving logged. End your fast?")).toBeNull();
    expect(actions.undoFoodServing).not.toHaveBeenCalled();
    expect(fastActions.endFastAction).not.toHaveBeenCalled();
    expect(actions.readFoodServingTruth).not.toHaveBeenCalled();
  });

  it("removes action-bearing receipts when their origin unmounts", async () => {
    actions.logFoodServing.mockResolvedValue({
      ok: true,
      eventId: 75,
      servings: 1,
      mealSlot: "Midday",
      mealServings: 1,
      endFastOffer: true,
    });
    actions.readFoodServingTruth.mockReset().mockResolvedValue({
      ok: true,
      servings: 1,
      mealServings: { Morning: 0, Midday: 1, Evening: 0 },
    });
    const view = mountBar();

    fireEvent.click(screen.getByTestId("log-cruciferous"));
    expect(await screen.findByRole("button", { name: "Undo" })).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: "End fast" })
    ).toBeTruthy();

    view.rerender(
      barTree({
        profileId: 7,
        day: {
          ...DAY,
          counts: { cruciferous: 1 },
          slotCounts: {
            Morning: {},
            Midday: { cruciferous: 1 },
            Evening: {},
          },
        },
        barKey: "post-receipt-bar",
        providerKey: "post-receipt-provider",
      })
    );

    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.queryByRole("button", { name: "End fast" })).toBeNull();
  });

  it("does not let an older bar cleanup dismiss a newer bar's actions", async () => {
    actions.logFoodServing
      .mockResolvedValueOnce({
        ok: true,
        eventId: 83,
        servings: 1,
        mealSlot: "Midday",
        mealServings: 1,
        endFastOffer: true,
      })
      .mockResolvedValueOnce({
        ok: true,
        eventId: 84,
        servings: 2,
        mealSlot: "Midday",
        mealServings: 2,
        endFastOffer: true,
      });
    actions.readFoodServingTruth
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        servings: 1,
        mealServings: { Morning: 0, Midday: 1, Evening: 0 },
      })
      .mockResolvedValueOnce({
        ok: true,
        servings: 2,
        mealServings: { Morning: 0, Midday: 2, Evening: 0 },
      });
    const view = render(twoBarTree());

    fireEvent.click(
      within(screen.getByTestId("first-food-bar")).getByTestId(
        "log-cruciferous"
      )
    );
    expect(
      await screen.findByRole("button", { name: "End fast" })
    ).toBeTruthy();
    fireEvent.click(
      within(screen.getByTestId("second-food-bar")).getByTestId(
        "log-cruciferous"
      )
    );
    await waitFor(() =>
      expect(actions.readFoodServingTruth).toHaveBeenCalledTimes(2)
    );
    expect(
      await screen.findByText("2 servings of Cruciferous vegetables today")
    ).toBeTruthy();
    view.rerender(twoBarTree({ showFirst: false }));

    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    const offer = screen.getByRole("button", { name: "End fast" });
    fireEvent.click(offer);
    expect(fastActions.endFastAction).toHaveBeenCalledTimes(1);
  });

  it("does not let an older deferred end-fast result replace a newer offer", async () => {
    const endOutcome = {
      ok: true,
      message: "Older fast ended.",
      undoFastId: 17,
    } as const;
    const ending = deferred<typeof endOutcome>();
    fastActions.endFastAction.mockReturnValue(ending.promise);
    actions.logFoodServing
      .mockResolvedValueOnce({
        ok: true,
        eventId: 92,
        servings: 1,
        mealSlot: "Midday",
        mealServings: 1,
        endFastOffer: true,
      })
      .mockResolvedValueOnce({
        ok: true,
        eventId: 93,
        servings: 2,
        mealSlot: "Midday",
        mealServings: 2,
        endFastOffer: true,
      });
    actions.readFoodServingTruth
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        servings: 1,
        mealServings: { Morning: 0, Midday: 1, Evening: 0 },
      })
      .mockResolvedValueOnce({
        ok: true,
        servings: 2,
        mealServings: { Morning: 0, Midday: 2, Evening: 0 },
      });
    render(twoBarTree());

    fireEvent.click(
      within(screen.getByTestId("first-food-bar")).getByTestId(
        "log-cruciferous"
      )
    );
    fireEvent.click(await screen.findByRole("button", { name: "End fast" }));
    fireEvent.click(
      within(screen.getByTestId("second-food-bar")).getByTestId(
        "log-cruciferous"
      )
    );
    expect(
      await screen.findByText("2 servings of Cruciferous vegetables today")
    ).toBeTruthy();
    expect(screen.getByText("Serving logged. End your fast?")).toBeTruthy();

    await act(async () => ending.resolve(endOutcome));

    expect(screen.getByText("Serving logged. End your fast?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "End fast" })).toBeTruthy();
    expect(screen.queryByText("Older fast ended.")).toBeNull();
  });

  it("keeps the later bar's receipt when an earlier add response finishes last", async () => {
    const slowOutcome = {
      ok: true,
      eventId: 85,
      servings: 1,
      mealSlot: "Midday",
      mealServings: 1,
    } as const;
    const slow = deferred<typeof slowOutcome>();
    actions.logFoodServing
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce({
        ok: true,
        eventId: 86,
        servings: 2,
        mealSlot: "Midday",
        mealServings: 2,
      });
    actions.readFoodServingTruth
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        servings: 2,
        mealServings: { Morning: 0, Midday: 2, Evening: 0 },
      })
      .mockResolvedValueOnce({
        ok: true,
        servings: 1,
        mealServings: { Morning: 0, Midday: 1, Evening: 0 },
      });
    render(twoBarTree());

    fireEvent.click(
      within(screen.getByTestId("first-food-bar")).getByTestId(
        "log-cruciferous"
      )
    );
    fireEvent.click(
      within(screen.getByTestId("second-food-bar")).getByTestId(
        "log-cruciferous"
      )
    );
    expect(
      await screen.findByText("2 servings of Cruciferous vegetables today")
    ).toBeTruthy();

    await act(async () => slow.resolve(slowOutcome));

    expect(actions.readFoodServingTruth).toHaveBeenCalledTimes(2);
    expect(
      screen.getByText("2 servings of Cruciferous vegetables today")
    ).toBeTruthy();
    expect(
      screen.queryByText("1 serving of Cruciferous vegetables today")
    ).toBeNull();
  });

  it("publishes an inverted same-bar burst under its latest lifecycle", async () => {
    const firstOutcome = {
      ok: true,
      eventId: 94,
      servings: 1,
      mealSlot: "Midday",
      mealServings: 1,
    } as const;
    const secondOutcome = {
      ok: true,
      eventId: 95,
      servings: 2,
      mealSlot: "Midday",
      mealServings: 2,
    } as const;
    const first = deferred<typeof firstOutcome>();
    const second = deferred<typeof secondOutcome>();
    actions.logFoodServing
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    actions.readFoodServingTruth.mockReset().mockResolvedValue({
      ok: true,
      servings: 2,
      mealServings: { Morning: 0, Midday: 2, Evening: 0 },
    });
    mountBar();

    fireEvent.click(screen.getByTestId("log-cruciferous"));
    fireEvent.click(screen.getByTestId("log-cruciferous"));
    await act(async () => second.resolve(secondOutcome));
    expect(actions.readFoodServingTruth).not.toHaveBeenCalled();

    await act(async () => first.resolve(firstOutcome));

    expect(actions.readFoodServingTruth).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText("2 servings of Cruciferous vegetables today")
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("keeps the newer keyed limit note when an older tap resolves last", async () => {
    const firstOutcome = {
      ok: true,
      eventId: 96,
      servings: 1,
      mealSlot: "Midday",
      mealServings: 1,
      limitNote: {
        kind: "interaction",
        groupKey: "cruciferous",
        title: "Older interaction note.",
        body: "This older response must not replace the later note.",
        hold: true,
      },
    } as const;
    const secondOutcome = {
      ok: true,
      eventId: 97,
      servings: 2,
      mealSlot: "Midday",
      mealServings: 2,
      limitNote: {
        kind: "interaction",
        groupKey: "cruciferous",
        title: "Newer interaction note.",
        body: "Keep the interaction-start winner.",
        hold: true,
      },
    } as const;
    const first = deferred<typeof firstOutcome>();
    const second = deferred<typeof secondOutcome>();
    actions.logFoodServing
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    actions.readFoodServingTruth.mockReset().mockResolvedValue({
      ok: true,
      servings: 2,
      mealServings: { Morning: 0, Midday: 2, Evening: 0 },
    });
    mountBar();

    fireEvent.click(screen.getByTestId("log-cruciferous"));
    fireEvent.click(screen.getByTestId("log-cruciferous"));
    await act(async () => second.resolve(secondOutcome));
    expect(screen.getByText(/Newer interaction note\./).textContent).toContain(
      "Keep the interaction-start winner."
    );

    await act(async () => first.resolve(firstOutcome));

    expect(screen.getByText(/Newer interaction note\./).textContent).toContain(
      "Keep the interaction-start winner."
    );
    expect(screen.queryByText(/Older interaction note\./)).toBeNull();
  });

  it("keeps the later bar's receipt when an earlier removal response finishes last", async () => {
    const day: FoodLogDay = {
      ...DAY,
      counts: { cruciferous: 1 },
      slotCounts: {
        Morning: {},
        Midday: { cruciferous: 1 },
        Evening: {},
      },
      events: [
        {
          id: 90,
          groupKey: "cruciferous",
          name: GROUP.name,
          date: DATE,
          mealSlot: "Midday",
          eatenAt: null,
          loggedTime: "12:00",
        },
      ],
    };
    const removalOutcome = {
      ok: true,
      undoId: 90,
      vacated: {
        date: DATE,
        groupKey: "cruciferous",
        mealSlot: "Midday",
        servings: 0,
        mealServings: 0,
      },
    } as const;
    const removal = deferred<typeof removalOutcome>();
    actions.deleteFoodLogEvent.mockReturnValue(removal.promise);
    actions.logFoodServing.mockResolvedValue({
      ok: true,
      eventId: 91,
      servings: 2,
      mealSlot: "Midday",
      mealServings: 2,
    });
    actions.readFoodServingTruth.mockReset().mockResolvedValue({
      ok: true,
      servings: 2,
      mealServings: { Morning: 0, Midday: 2, Evening: 0 },
    });
    render(twoBarTree({ day }));

    fireEvent.click(
      within(screen.getByTestId("first-food-bar")).getByRole("button", {
        name: /^Actions for the Cruciferous vegetables serving/,
      })
    );
    fireEvent.click(screen.getByTestId("food-logged-remove-90"));
    fireEvent.click(
      within(screen.getByTestId("second-food-bar")).getByTestId(
        "log-cruciferous"
      )
    );
    expect(
      await screen.findByText("2 servings of Cruciferous vegetables today")
    ).toBeTruthy();

    await act(async () => removal.resolve(removalOutcome));

    expect(
      screen.getByText("2 servings of Cruciferous vegetables today")
    ).toBeTruthy();
    expect(screen.queryByText("Serving removed.")).toBeNull();
  });

  it("does not let an older deferred Undo replace a newer bar's receipt", async () => {
    const inverseOutcome = {
      ok: true,
      servings: 0,
      mealSlot: "Midday",
      mealServings: 0,
    } as const;
    const inverse = deferred<typeof inverseOutcome>();
    actions.logFoodServing
      .mockResolvedValueOnce({
        ok: true,
        eventId: 87,
        servings: 1,
        mealSlot: "Midday",
        mealServings: 1,
      })
      .mockResolvedValueOnce({
        ok: true,
        eventId: 88,
        servings: 2,
        mealSlot: "Midday",
        mealServings: 2,
      });
    actions.undoFoodServing.mockReturnValue(inverse.promise);
    actions.readFoodServingTruth
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        servings: 1,
        mealServings: { Morning: 0, Midday: 1, Evening: 0 },
      })
      .mockResolvedValueOnce({
        ok: true,
        servings: 2,
        mealServings: { Morning: 0, Midday: 2, Evening: 0 },
      });
    render(twoBarTree());

    fireEvent.click(
      within(screen.getByTestId("first-food-bar")).getByTestId(
        "log-cruciferous"
      )
    );
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    fireEvent.click(
      within(screen.getByTestId("second-food-bar")).getByTestId(
        "log-cruciferous"
      )
    );
    expect(
      await screen.findByText("2 servings of Cruciferous vegetables today")
    ).toBeTruthy();

    await act(async () => inverse.resolve(inverseOutcome));

    expect(
      screen.getByText("2 servings of Cruciferous vegetables today")
    ).toBeTruthy();
    expect(screen.queryByText("Serving undone.")).toBeNull();
  });

  it("does not let an older decrement response dismiss a newer bar's receipt", async () => {
    const day: FoodLogDay = {
      ...DAY,
      counts: { cruciferous: 1 },
      slotCounts: {
        Morning: {},
        Midday: { cruciferous: 1 },
        Evening: {},
      },
    };
    const decrementOutcome = {
      ok: true,
      servings: 0,
      mealSlot: "Midday",
      mealServings: 0,
    } as const;
    const decrement = deferred<typeof decrementOutcome>();
    actions.undoFoodServing.mockReturnValue(decrement.promise);
    actions.logFoodServing.mockResolvedValue({
      ok: true,
      eventId: 89,
      servings: 2,
      mealSlot: "Midday",
      mealServings: 2,
    });
    actions.readFoodServingTruth.mockReset().mockResolvedValue({
      ok: true,
      servings: 2,
      mealServings: { Morning: 0, Midday: 2, Evening: 0 },
    });
    render(twoBarTree({ day }));

    fireEvent.click(
      within(screen.getByTestId("first-food-bar")).getByTestId(
        "undo-cruciferous"
      )
    );
    fireEvent.click(
      within(screen.getByTestId("second-food-bar")).getByTestId(
        "log-cruciferous"
      )
    );
    expect(
      await screen.findByText("2 servings of Cruciferous vegetables today")
    ).toBeTruthy();

    await act(async () => decrement.resolve(decrementOutcome));

    expect(
      screen.getByText("2 servings of Cruciferous vegetables today")
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
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
    // row count prove it is already Morning=0/Evening=1 even though the
    // visual receipt's queued frame has deliberately not run.
    expect(screen.getByTestId("food-slot-total-morning").textContent).toBe("0");
    expect(screen.getByTestId("food-slot-total-evening").textContent).toBe("1");
    expect(screen.getByTestId("count-cruciferous").textContent).toBe("0");
    expect(frames).toHaveLength(1);
  });
});
