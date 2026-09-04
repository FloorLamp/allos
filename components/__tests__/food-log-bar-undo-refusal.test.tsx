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
// The ledger's batch Delete asks ONE confirmation (#4118), through the app-wide
// dialog `app/(app)/layout.tsx` mounts around every page. The bar renders the ledger,
// so a tree without the provider is a tree the app never renders.
import { ConfirmProvider } from "@/components/ConfirmDialog";
import FoodLogBar, { type FoodLogDay } from "@/app/(app)/nutrition/FoodLogBar";
import { buildDayLedger } from "@/lib/day-ledger";
import type { DisplayFormatPrefs } from "@/lib/settings";
import {
  FoodSelectedDateProvider,
  useFoodSelectedDate,
} from "@/app/(app)/nutrition/FoodSuggestionsLayout";
import type { FoodGroup } from "@/lib/food-groups";
import type { FoodSlot } from "@/lib/food-slot";
import type { ProfileToastScope } from "@/lib/toast-upsert";

const actions = vi.hoisted(() => ({
  addProteinGrams: vi.fn(),
  logFoodServing: vi.fn(),
  undoFoodServing: vi.fn(),
  readFoodServingTruth: vi.fn(),
  deleteFoodLogEvent: vi.fn(),
  updateFoodLogEvent: vi.fn(),
}));
// The composed bundle's action lives on the app-root module (#4438), not on the
// nutrition one — the bar posts the SAME action the dashboard control does.
const appActions = vi.hoisted(() => ({
  logUsualRoutine: vi.fn(),
  usualRoutineOffersOn: vi.fn(async (_date: string) => [] as unknown[]),
}));
const fastActions = vi.hoisted(() => ({
  endFastAction: vi.fn(),
  undoEndFastAction: vi.fn(),
}));

vi.mock("@/app/(app)/nutrition/actions", () => actions);
vi.mock("@/app/(app)/actions", () => appActions);
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

// THE SLOT DIMENSION OF THE PROJECTION, made observable on purpose.
//
// A correction is a MOVE: it decrements one meal coordinate and increments another, and
// `applyPlacements([outcome.from, outcome.to])` publishes both halves in one state.
// Until #3987 the Meals cards rendered `food-slot-total-<meal>` and this suite read the
// destination half through them incidentally; the ledger replaced those cards with rows
// derived from SERVER props, which the optimistic projection does not touch. That left
// the day total ("1 serving") and the mounted meal's own count as the only reads — and
// a move changes neither the number of servings the day holds nor, at the remount site,
// anything the assertions looked at. Dropping `outcome.to` from the publish therefore
// went green across the whole pure tier.
//
// So the probe reads the projection directly, both halves, on every mount in this suite.
// It is not a surface: it exists because the dimension the defect lives in stopped being
// rendered anywhere, and an invariant nothing observes is not protected.
function SlotProjectionProbe() {
  const { activeDate, slotCountsByDate } = useFoodSelectedDate();
  const counts = slotCountsByDate[activeDate];
  return (
    <>
      {(["Morning", "Midday", "Evening"] as const).map((slot) => (
        <span key={slot} data-testid={`projection-slot-${slot.toLowerCase()}`}>
          {counts?.[slot]?.cruciferous ?? 0}
        </span>
      ))}
    </>
  );
}

function barTree({
  profileId = 7,
  day = DAY,
  days = undefined as FoodLogDay[] | undefined,
  proteinQuickAdd = undefined as React.ComponentProps<
    typeof FoodLogBar
  >["proteinQuickAdd"],
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
  const offered = days ?? [day];
  return (
    <TimezoneProvider tz="UTC">
      <ActiveProfileProvider profileId={profileId}>
        <ConfirmProvider>
          <ToastProvider>
            <ProfileSwitchWatcher activeProfileId={profileId} />
            {captureProfileScope && (
              <CaptureProfileScopeAfterCommit capture={captureProfileScope} />
            )}
            {layoutProfileNote && (
              <PostProfileNoteOnLayout {...layoutProfileNote} />
            )}
            <FoodSelectedDateProvider
              key={providerKey}
              today={DATE}
              days={offered}
            >
              <FoodLogBar
                key={barKey}
                today={DATE}
                days={offered}
                groupsBySlot={GROUPS}
                slot={slot}
                slotBoundaries={{ midday: 660, evening: 900 }}
                dayLedger={ledgerFor(day)}
                proteinQuickAdd={proteinQuickAdd}
              />
              {tapBeforePassiveEffect && <TapBeforePassiveEffect />}
              {onLayoutCommit && <RunOnLayoutCommit run={onLayoutCommit} />}
              <SlotProjectionProbe />
            </FoodSelectedDateProvider>
          </ToastProvider>
        </ConfirmProvider>
      </ActiveProfileProvider>
    </TimezoneProvider>
  );
}

// The Day ledger the page mount hands down (#3987), derived from the SAME day fixture
// the bar gets — exactly as `FoodTab` derives it — so a test that seeds an event gets a
// ledger row for it without maintaining a second fixture that could disagree.
function ledgerFor(day: FoodLogDay) {
  return {
    groupsByDate: {
      [day.date]: buildDayLedger({
        servings: day.events.map((event) => ({
          kind: "serving" as const,
          id: `serving:${event.id}`,
          eventId: event.id,
          slug: event.groupKey,
          name: event.name,
          bucket: event.mealSlot,
          hhmm: event.eatenAt ?? event.loggedTime,
          clockKind: event.eatenAt ? ("stated" as const) : ("logged" as const),
        })),
        doses: [],
        pending: [],
      }),
    },
    doseWritableDates: [day.date],
    prefs: { timeFormat: "24h", dateFormat: "iso" } as DisplayFormatPrefs,
    keepApart: [],
    dayContext: null,
  };
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
        slot="Midday"
        slotBoundaries={{ midday: 660, evening: 900 }}
        dayLedger={ledgerFor(day)}
      />
    </FoodSelectedDateProvider>
  );
  return (
    <TimezoneProvider tz="UTC">
      <ActiveProfileProvider profileId={7}>
        <ConfirmProvider>
          <ToastProvider>
            <ProfileSwitchWatcher activeProfileId={7} />
            <div data-testid="first-food-bar">{showFirst && bar("first")}</div>
            <div data-testid="second-food-bar">{bar("second")}</div>
          </ToastProvider>
        </ConfirmProvider>
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
    actions.addProteinGrams.mockReset();
    actions.undoFoodServing.mockReset();
    actions.readFoodServingTruth.mockReset();
    actions.deleteFoodLogEvent.mockReset();
    actions.updateFoodLogEvent.mockReset();
    appActions.logUsualRoutine.mockReset();
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
    actions.addProteinGrams.mockResolvedValue({ ok: true, grams: 30 });
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

  it("keeps protein quick-add on a past selected day and submits that day", async () => {
    const yesterday = "2026-08-23";
    mountBar({
      days: [DAY, { ...DAY, date: yesterday, label: "Yesterday" }],
      proteinQuickAdd: {
        initialGramsByDate: { [DATE]: 5, [yesterday]: 0 },
        lastPreset: 30,
      },
    });

    expect(screen.getByTestId("protein-quickadd")).toBeTruthy();
    expect(screen.getByTestId("protein-quickadd-grams").textContent).toBe("5");
    fireEvent.click(screen.getByTestId("food-day-yesterday"));
    expect(screen.getByTestId("protein-quickadd")).toBeTruthy();
    expect(screen.getByTestId("protein-quickadd-grams").textContent).toBe("0");
    fireEvent.click(screen.getByTestId("protein-quickadd-add"));

    await waitFor(() => expect(actions.addProteinGrams).toHaveBeenCalledOnce());
    const submitted = actions.addProteinGrams.mock.calls[0][0] as FormData;
    expect(submitted.get("date")).toBe(yesterday);
  });

  // THE TYPED AMOUNT IS THE TYPIST'S; THE TOTAL IS THE DAY'S (#4934, owner ruling
  // 2026-09-03). Driven through the real provider and day picker: whatever is in the
  // box survives a day move and posts against the day now shown, while the readout
  // re-seeds to the day moved to. The cleared row is the other half of "only a submit
  // or an explicit clear discards them" — an emptied box must stay empty across the
  // move rather than being re-seeded from `lastPreset` or from the day's total.
  it.each([
    { typed: "17", posts: "17" },
    { typed: "", posts: null },
  ])(
    "carries a $typed-gram box across a day move and logs it on the day now shown",
    async ({ typed, posts }) => {
      const yesterday = "2026-08-23";
      mountBar({
        days: [DAY, { ...DAY, date: yesterday, label: "Yesterday" }],
        proteinQuickAdd: {
          initialGramsByDate: { [DATE]: 5, [yesterday]: 0 },
          lastPreset: 30,
        },
      });

      const input = screen.getByTestId(
        "protein-quickadd-input"
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: typed } });
      expect(screen.getByTestId("protein-quickadd-grams").textContent).toBe(
        "5"
      );

      fireEvent.click(screen.getByTestId("food-day-yesterday"));

      // The SAME node, not a fresh one: a remount is what discarded the value, and
      // a value-only check would pass against a remount that happened to re-seed
      // the same string.
      expect(screen.getByTestId("protein-quickadd-input")).toBe(input);
      expect(input.value).toBe(typed);
      // The day's own datum still follows the day.
      expect(screen.getByTestId("protein-quickadd-grams").textContent).toBe(
        "0"
      );

      const add = screen.getByTestId(
        "protein-quickadd-add"
      ) as HTMLButtonElement;
      fireEvent.click(add);

      if (posts === null) {
        // An emptied box offers nothing to log, so the add door stays shut.
        expect(add.disabled).toBe(true);
        await waitFor(() =>
          expect(actions.addProteinGrams).not.toHaveBeenCalled()
        );
        return;
      }
      await waitFor(() =>
        expect(actions.addProteinGrams).toHaveBeenCalledOnce()
      );
      const submitted = actions.addProteinGrams.mock.calls[0][0] as FormData;
      expect(submitted.get("grams")).toBe(posts);
      expect(submitted.get("date")).toBe(yesterday);
      // And the readout then holds the server's authoritative total for the day
      // moved to. A seed that re-applied on any render rather than on a day change
      // would drag this back to the day's starting 0.
      await waitFor(() =>
        expect(screen.getByTestId("protein-quickadd-grams").textContent).toBe(
          "30"
        )
      );
    }
  );

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
    expect(screen.getByTestId("food-day-total").textContent).toBe("1 serving");
    expect(screen.getByTestId("count-cruciferous").textContent).toBe("1");

    view.rerender(barTree({ profileId: 8, day: profileEight }));

    // Plain totals derive directly from the provider projection, so this
    // proves subject reset independently of RollingNumber's visual lifecycle.
    expect(screen.getByTestId("food-day-total").textContent).toBe("9 servings");
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
    fireEvent.click(screen.getByTestId("ledger-serving-correct-71"));
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

    expect(screen.getByTestId("food-day-total").textContent).toBe("9 servings");
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
    fireEvent.click(screen.getByTestId("ledger-serving-correct-74"));
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

    // THE MEAL COUNT IS THE DISCRIMINATOR, and the day total is not. The defect this
    // test exists to catch is a correction from the UNMOUNTED bar leaking into the
    // remounted provider's projection — a Morning→Evening MOVE. A move does not change
    // how many servings the day holds, so `food-day-total` reads "1 serving" whether
    // the leak happened or not: it is invariant under the exact bug. The bar is mounted
    // on Morning, so `count-cruciferous` is Morning's count for this group — 1 if the
    // correction was correctly ignored, 0 if it leaked through.
    expect(screen.getByTestId("count-cruciferous").textContent).toBe("1");
    expect(screen.getByTestId("food-day-total").textContent).toBe("1 serving");
    // Both halves off the projection, for completeness — though here they are belt to the
    // toast's braces rather than the discriminator. The PROVIDER was replaced too, so the
    // unmounted bar's `applyPlacements` closure addresses a dead setState.
    //
    // AND THE PROJECTION HERE IS DEFENDED TWICE, which matters to anyone reading one of
    // the guards and wondering whether it still does anything. Establishing that took
    // four mutations, not one: the epoch guard (`areServingMutationsCurrent`) removed
    // alone leaks the TOAST at both stale sites and moves no projection;
    // `commitProjection`'s mount guard (`barMountedRef`, via `isMountedProfile`) removed
    // alone changes nothing at all, because the epoch guard has already returned; and
    // with BOTH removed this case still passes its two projection lines while the case
    // below reds. So neither guard alone is falsifiable HERE, and a reader who deletes
    // one and sees nothing change must not conclude it is dead.
    //
    // THEY ARE NOT REDUNDANT — they cover different cases, and no single test shows both:
    //   • the MOUNT guard covers the replaced-bar case (the case below: provider alive,
    //     bar swapped, the stale continuation still holding a live setState);
    //   • the EPOCH guard covers the SUPERSEDED-correction case, where nothing unmounts
    //     at all — "refuses a superseded correction that resolves after a newer one",
    //     above. Forcing the epoch guard open reds it with `expected '1' to be '0'`;
    //     removing the mount guard alone leaves it green at 20/20, because the bar
    //     never went away and there is no mount check left to do the work.
    // Delete either one and some real defect stops being refused.
    //
    // The case below replaces only the bar, leaving the provider live, and is where these
    // two lines bite.
    expect(screen.getByTestId("projection-slot-morning").textContent).toBe("1");
    expect(screen.getByTestId("projection-slot-evening").textContent).toBe("0");
    expect(screen.queryByText("Serving corrected.")).toBeNull();
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  // THE EPOCH GUARD'S OWN CASE, where NOTHING UNMOUNTS (#4323 review). The two stale
  // -write guards cover different defects and the suite only demonstrated one of them:
  // every other stale case here replaces the bar, the provider, or both, so
  // `commitProjection`'s mount check answers first and `areServingMutationsCurrent` is
  // never the line doing the work. Its justification lived in prose, and a prose guard
  // is not a guard.
  //
  // Here one bar stays mounted throughout and two corrections overlap on it: A moves the
  // serving Morning->Evening and is left in flight; B moves it Morning->Midday and
  // resolves fully. A then lands last. A is superseded — B is the correction the person
  // actually completed — so A must be refused, and no mount check can refuse it because
  // nothing ever unmounted.
  it("refuses a superseded correction that resolves after a newer one", async () => {
    const day: FoodLogDay = {
      ...DAY,
      counts: { cruciferous: 1 },
      slotCounts: { Morning: { cruciferous: 1 }, Midday: {}, Evening: {} },
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
    const toEvening = {
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
    const toMidday = {
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
        mealSlot: "Midday",
        servings: 1,
        mealServings: 1,
      },
    } as const;

    // A superseded correction also asks the server for current truth. Pin that answer
    // to the state B left behind, so a reconcile is a no-op and the ONLY thing this
    // case can be measuring is whether A's own placement leaked.
    actions.readFoodServingTruth.mockReset();
    actions.readFoodServingTruth.mockResolvedValue({
      ok: true,
      servings: 1,
      mealServings: { Morning: 0, Midday: 1, Evening: 0 },
    });
    const slow = deferred<typeof toEvening>();
    actions.updateFoodLogEvent.mockReturnValueOnce(slow.promise);
    mountBar({ profileId: 7, day, slot: "Morning" });

    const openCorrection = () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: /^Actions for the Cruciferous vegetables serving/,
        })
      );
      fireEvent.click(screen.getByTestId("ledger-serving-correct-74"));
    };

    // Correction A — Morning to Evening, left in flight.
    openCorrection();
    fireEvent.change(screen.getByTestId("food-correct-slot"), {
      target: { value: "Evening" },
    });
    fireEvent.click(screen.getByTestId("food-correct-save"));

    // Correction B — Morning to Midday, resolves completely. Same bar, same provider.
    actions.updateFoodLogEvent.mockResolvedValueOnce(toMidday);
    openCorrection();
    fireEvent.change(screen.getByTestId("food-correct-slot"), {
      target: { value: "Midday" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("food-correct-save"));
    });
    expect(screen.getByTestId("projection-slot-midday").textContent).toBe("1");

    // THE FIXTURE'S REACH: B really did land, so A really is superseded rather than
    // merely late. Without this the case could pass with both corrections refused.
    expect(screen.getByTestId("projection-slot-morning").textContent).toBe("0");

    // A lands last. The epoch guard is the only thing that can refuse it.
    await act(async () => slow.resolve(toEvening));

    expect(screen.getByTestId("projection-slot-midday").textContent).toBe("1");
    expect(screen.getByTestId("projection-slot-evening").textContent).toBe("0");
    expect(screen.getByTestId("food-day-total").textContent).toBe("1 serving");
  });

  // THE REACHABLE HALF of the same defect. In the remount case above the provider itself
  // is replaced, so the unmounted bar's `applyPlacements` closure addresses a dead
  // setState and the projection is out of the leak's reach whatever the guard does. Here
  // the PROVIDER SURVIVES and only the bar is replaced — the stale continuation's
  // publish would land on live state, moving a serving the person is looking at from
  // Morning to Evening on the strength of an interaction that is no longer current.
  it("does not move a serving when a replaced bar's correction resolves late", async () => {
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
    fireEvent.click(screen.getByTestId("ledger-serving-correct-74"));
    fireEvent.change(screen.getByTestId("food-correct-slot"), {
      target: { value: "Evening" },
    });
    fireEvent.click(screen.getByTestId("food-correct-save"));

    // Same `providerKey`: the projection this bar was editing is still mounted and
    // still reachable. Only the bar is new.
    view.rerender(
      barTree({
        profileId: 7,
        day,
        slot: "Morning",
        barKey: "replacement-live-provider-bar",
      })
    );
    await act(async () => correction.resolve(outcome));

    expect(screen.getByTestId("projection-slot-morning").textContent).toBe("1");
    expect(screen.getByTestId("projection-slot-evening").textContent).toBe("0");
    expect(screen.getByTestId("count-cruciferous").textContent).toBe("1");
    expect(screen.queryByText("Serving corrected.")).toBeNull();
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
    expect(submitted.get("profile_id")).toBe("7");

    view.rerender(barTree({ profileId: 8, day: profileEight }));
    view.rerender(barTree({ profileId: 7, day: returnedProfileSeven }));
    await act(async () => add.resolve(outcome));

    expect(screen.getByTestId("food-day-total").textContent).toBe("5 servings");
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

    expect(screen.getByTestId("food-day-total").textContent).toBe("2 servings");
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
    fireEvent.click(screen.getByTestId("ledger-serving-remove-90"));
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
    fireEvent.click(screen.getByTestId("ledger-serving-correct-51"));
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
    expect(screen.getByTestId("food-day-total").textContent).toBe("1 serving");
    expect(screen.getByTestId("count-cruciferous").textContent).toBe("0");
    // The DESTINATION half, which nothing else here observes: `count-cruciferous` is
    // Morning's count and the day total is invariant under a move, so publishing only
    // `outcome.from` would satisfy both of the lines above while the serving vanished
    // from the projection entirely.
    expect(screen.getByTestId("projection-slot-morning").textContent).toBe("0");
    expect(screen.getByTestId("projection-slot-evening").textContent).toBe("1");
    expect(frames).toHaveLength(1);
  });
});

// ── THE COMPOSED BUNDLE ON THE PAGE FOOD IS ACTUALLY LOGGED ON (#4438) ───────
//
// The dashboard, the quick-log menu and the record door have offered both halves of
// the "usual" since #2458; `/nutrition` offered the food half alone. These cases pin
// the three things that changed, plus the sequenced re-read the record door used to
// own — it moved here with the day PICKER, which is the only surface that still has
// one (#4424 ruling 2 retired the door's shared date field).
describe("FoodLogBar composed usual bundle", () => {
  const OTHER = "2026-08-23";
  const SECOND_GROUP: FoodGroup = {
    slug: "berries",
    name: "Berries",
    serving: "1 cup",
    tier: "encourage",
    nutrients: [],
  };
  const BOTH = Object.fromEntries(
    ["Morning", "Midday", "Evening"].map((slot) => [
      slot,
      [GROUP, SECOND_GROUP],
    ])
  ) as Record<FoodSlot, FoodGroup[]>;
  const HABIT = {
    Morning: [],
    Midday: ["cruciferous", "berries"],
    Evening: [],
  } as Record<FoodSlot, string[]>;
  const DOSE = { id: 9, name: "Creatine", stack: null };
  const otherDay: FoodLogDay = { ...DAY, date: OTHER, label: "Yesterday" };
  const offer = (
    window: FoodSlot,
    doses = [DOSE],
    proteinGrams: number | null = null
  ) => ({
    window,
    food: [
      { slug: "cruciferous", name: "Cruciferous vegetables" },
      { slug: "berries", name: "Berries" },
      ...(proteinGrams === null
        ? []
        : [{ slug: "__protein__", name: `+${proteinGrams}g protein` }]),
    ],
    proteinGrams,
    doses,
  });

  function mount(
    seeded: ReturnType<typeof offer>[],
    habit: Record<FoodSlot, string[]> = HABIT
  ) {
    return render(
      <TimezoneProvider tz="UTC">
        <ActiveProfileProvider profileId={7}>
          <ConfirmProvider>
            <ToastProvider>
              <ProfileSwitchWatcher activeProfileId={7} />
              <FoodSelectedDateProvider today={DATE} days={[DAY, otherDay]}>
                <FoodLogBar
                  today={DATE}
                  days={[DAY, otherDay]}
                  groupsBySlot={BOTH}
                  usualBySlot={habit}
                  usualRoutine={{ date: DATE, offers: seeded }}
                  slot="Midday"
                  slotBoundaries={{ midday: 660, evening: 900 }}
                  dayLedger={ledgerFor(DAY)}
                />
              </FoodSelectedDateProvider>
            </ToastProvider>
          </ConfirmProvider>
        </ActiveProfileProvider>
      </TimezoneProvider>
    );
  }

  const pickDay = async (label: string) => {
    await act(async () => {
      fireEvent.click(screen.getByTestId("food-day-menu-trigger"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: label }));
    });
  };

  beforeEach(() => {
    window.matchMedia = mediaQuery;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    appActions.logUsualRoutine.mockReset();
    appActions.logUsualRoutine.mockResolvedValue({
      ok: true,
      window: "Midday",
      date: DATE,
      groups: [
        { groupKey: "cruciferous", servings: 1, mealServings: 1 },
        { groupKey: "berries", servings: 1, mealServings: 1 },
      ],
      doses: [{ doseId: 9, name: "Creatine", outcome: "logged" }],
    });
    appActions.usualRoutineOffersOn.mockReset();
    appActions.usualRoutineOffersOn.mockResolvedValue([]);
    // The single-serving add shares this mount's sticky statement and is the CONVERSE
    // half of the case below, so it needs an answer to settle against. Evening because
    // that is where a 20:00 statement files against these boundaries — the same
    // derivation the bar makes client-side, so the adopt path is exercised honestly.
    actions.logFoodServing.mockReset();
    actions.logFoodServing.mockResolvedValue({
      ok: true,
      eventId: 41,
      servings: 1,
      mealSlot: "Evening",
      mealServings: 1,
    });
  });

  it("names and posts the dose half beside the food half", async () => {
    mount([offer("Midday")]);
    const button = screen.getByTestId("food-usual-offer");
    // THE LABEL IS THE PROMISE, through the one phrase every host renders (#2458), so
    // the page cannot name this write differently from the dashboard.
    expect(button.getAttribute("data-doses")).toBe("9");
    expect(screen.getByTestId("food-usual-names").textContent).toContain(
      "Creatine"
    );
    await act(async () => fireEvent.click(button));
    const sent = appActions.logUsualRoutine.mock.calls[0][0] as FormData;
    expect(sent.get("dose_ids")).toBe("9");
    expect(sent.get("groups")).toBe("cruciferous,berries");
    // The ANSWER is the shared sentence, not the food-only "Logged …".
    expect(
      screen
        .getAllByTestId("toast")
        .map((t) => t.textContent)
        .join(" ")
    ).toContain("1 dose taken");
  });

  // THE SCOOP IS A MEMBER OF THE FOOD HALF HERE TOO (#4379, owner ruling 2026-09-02:
  // "protein behaves exactly like a food group"). This page is the one host that
  // derives the food half CLIENT-side, off the habitual set rather than off the offer
  // the other hosts read, so the ruling has to be true in a second computation — and
  // nothing pinned it here. The member stands only while BOTH halves say it does, so
  // the second case below is the converse and not a second scenario: same habitual set,
  // server offer silent about grams, member gone. Slugs are asserted too because the
  // reserved key is a member of the NAME and never of the posted group list.
  it.each([
    [30, "Cruciferous vegetables, Berries and +30g protein + Creatine"],
    [null, "Cruciferous vegetables and Berries + Creatine"],
  ])(
    "names the scoop as a food member when the offer promises %s",
    (grams, phrase) => {
      mount([offer("Midday", [DOSE], grams)], {
        ...HABIT,
        Midday: ["__protein__", "cruciferous", "berries"],
      });
      expect(screen.getByTestId("food-usual-names").textContent).toBe(phrase);
      expect(
        screen.getByTestId("food-usual-offer").getAttribute("data-groups")
      ).toBe("cruciferous,berries");
    }
  );

  // ── A BUNDLE WHOSE WHOLE FOOD HALF IS THE SCOOP (#4765) ────────────────────
  //
  // The gate here asked for a catalog GROUP while `usualRoutineOffer` asks for a food
  // MEMBER, and the scoop is a member (#4379). These two cases pin the rule at this
  // component's own boundary: its PROPS. Whether the app can hand it a habitual set with
  // no resolvable group in it is a question two modules upstream, and the answer today
  // is no — `getFoodRegularity` drops unresolvable slugs before the measure, so every
  // non-scoop member of `usualBySlot` is a real group, and `usualFoodOffer`'s
  // FOOD_USUAL_MIN_GROUPS floor counts the scoop, so a standing half of two-or-more
  // members always leaves one. The fixture below therefore reaches a state no seeded
  // profile currently produces, and that is stated rather than hidden: what it pins is
  // that the component answers the props it is GIVEN by the rule the offer functions
  // use, not by a second rule of its own. It fails against the old gate.
  // A habitual set whose only members are the scoop and a slug this mount's catalog does
  // not name — the shape of a half with no group left in it.
  const RETIRED_HABIT = {
    ...HABIT,
    Midday: ["__protein__", "retired-grains"],
  } as Record<FoodSlot, string[]>;
  const retiredOffer = (proteinGrams: number | null) => ({
    ...offer("Midday", [DOSE], proteinGrams),
    food: [
      { slug: "retired-grains", name: "retired-grains" },
      ...(proteinGrams === null
        ? []
        : [{ slug: "__protein__", name: `+${proteinGrams}g protein` }]),
    ],
  });

  it("offers and posts a bundle whose only food member is the scoop", async () => {
    appActions.logUsualRoutine.mockResolvedValue({
      ok: true,
      window: "Midday",
      date: DATE,
      groups: [],
      doses: [{ doseId: 9, name: "Creatine", outcome: "logged" }],
      protein: 30,
    });
    mount([retiredOffer(30)], RETIRED_HABIT);
    const button = screen.getByTestId("food-usual-offer");
    expect(screen.getByTestId("food-usual-names").textContent).toBe(
      "+30g protein + Creatine"
    );
    // No slugs to post, and that is not the same as nothing to write: the grams are the
    // write, and the action's shape gate counts them (app/(app)/actions.ts).
    expect(button.getAttribute("data-groups")).toBe("");
    await act(async () => fireEvent.click(button));
    const sent = appActions.logUsualRoutine.mock.calls[0][0] as FormData;
    expect(sent.get("groups")).toBe("");
    expect(sent.get("protein_grams")).toBe("30");
    expect(sent.get("dose_ids")).toBe("9");
    expect(
      screen
        .getAllByTestId("toast")
        .map((t) => t.textContent)
        .join(" ")
    ).toContain("+30g protein");
  });

  // THE CONVERSE, so the gate cannot have become "always". Same habitual set, same
  // unresolvable slug, and a server offer that promises no grams: the food half has no
  // member at all and the whole control goes, exactly as a dose-only "usual" always has.
  it("still renders no bundle when the unresolvable half promises no scoop", () => {
    mount([retiredOffer(null)], RETIRED_HABIT);
    expect(screen.queryByTestId("food-usual-offer")).toBeNull();
  });

  // THE STICKY STATEMENT DOES NOT RIDE THE BUNDLE, and this is the converse of the
  // single-serving assertion above it rather than a gap. The statement is per-DAY and
  // this button names a WINDOW, so carrying it would file the servings outside the
  // window the offer was derived for — after which the offer never reduces and the tap
  // double-logs without bound (proved at the action tier, `food-usual.actions.test.ts`).
  it("does not carry the bar's day-wide stated time onto the bundle", async () => {
    mount([offer("Midday")]);
    await act(async () => {
      fireEvent.change(screen.getByTestId("food-when-time"), {
        target: { value: new Date(`${DATE}T20:00:00.000Z`).toISOString() },
      });
    });
    // THE FIXTURE REACHES THE STATE THE ASSERTION FORBIDS: the statement really is set,
    // so this is "the bundle declines to carry it" and not "nothing was there to carry".
    expect(screen.getByTestId("food-when-set").textContent).toBe("20:00");
    await act(async () =>
      fireEvent.click(screen.getByTestId("food-usual-offer"))
    );
    const sent = appActions.logUsualRoutine.mock.calls[0][0] as FormData;
    expect(sent.get("occurred_at")).toBeNull();

    // AND THE SINGLE-SERVING ADD BESIDE IT STILL STATES THE HOUR — the converse, and
    // the half that makes the assertion above mean "the bundle declines it" rather than
    // "this mount states nothing at all". Read off `logFoodServing`'s OWN FormData: an
    // earlier spelling asserted `sent.get("meal_slot")` here, which is the BUNDLE's
    // post, so it could not fail however the single-serving path behaved.
    await act(async () => {
      fireEvent.click(screen.getByTestId("log-cruciferous"));
    });
    const single = actions.logFoodServing.mock.calls[0][0] as FormData;
    expect(single.get("occurred_at")).toBe("20:00");
  });

  it("re-reads the dose half when the day picker moves, and drops a late answer for a day already left", async () => {
    // Two day changes are two in-flight reads and the network may answer in either
    // order; the label names every dose the tap will confirm, so a late reply for an
    // abandoned day would repaint a promise about a day nobody is looking at.
    let releaseOther: (offers: ReturnType<typeof offer>[]) => void = () => {};
    appActions.usualRoutineOffersOn.mockImplementation(async (date: string) =>
      date === OTHER
        ? new Promise((resolve) => {
            releaseOther = resolve;
          })
        : []
    );
    mount([offer("Midday")]);
    expect(
      screen.getByTestId("food-usual-offer").getAttribute("data-doses")
    ).toBe("9");

    await pickDay("Yesterday");
    expect(appActions.usualRoutineOffersOn).toHaveBeenCalledWith(OTHER);
    await pickDay("Today");
    // Back on the seeded day, the seed answers and no read is needed for it.
    expect(
      screen.getByTestId("food-usual-offer").getAttribute("data-doses")
    ).toBe("9");

    // The abandoned day answers LAST, with a rider that must not land.
    await act(async () =>
      releaseOther([offer("Midday", [{ id: 77, name: "Zinc", stack: null }])])
    );
    expect(
      screen.getByTestId("food-usual-offer").getAttribute("data-doses")
    ).toBe("9");
  });

  it("degrades to the food half when the read fails, and never promises a dose it could not ask about", async () => {
    appActions.usualRoutineOffersOn.mockRejectedValue(new Error("offline"));
    mount([offer("Midday")]);
    await pickDay("Yesterday");
    const button = screen.getByTestId("food-usual-offer");
    expect(button.getAttribute("data-doses")).toBe("");
    expect(button.getAttribute("data-groups")).toBe("cruciferous,berries");
  });
});
