import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ToastProvider } from "@/components/Toast";
import QuickEntryProvider, {
  useQuickEntry,
} from "@/components/QuickEntryProvider";
import type { SessionProfile } from "@/lib/auth";
import {
  DayContextProvider,
  ProfileDaysBoundary,
} from "@/components/DayContext";
import type { AppRoute } from "@/lib/hrefs";

// COMPONENT TIER — #3416/#4454, the sheet's offline OPEN path: last-good render
// with a revalidate behind it, a failed revalidate keeping what is already shown, a
// stalled gather timing out to the error state, Retry re-running the SAME gather,
// and the acting-profile change dropping the cache (the same device-local wipe
// boundary ProfileSwitchWatcher enforces for the offline read snapshots).

const loadQuickEntry = vi.hoisted(() => vi.fn());
vi.mock("@/app/(app)/quick-entry-actions", () => ({ loadQuickEntry }));
vi.mock("@/app/(app)/nutrition/FoodLogBar", async () => {
  const { useDayContext } = await vi.importActual<
    typeof import("@/components/DayContext")
  >("@/components/DayContext");
  return {
    default: function FoodHostProbe({
      days,
      proteinQuickAdd,
    }: {
      days: { date: string; label: string }[];
      proteinQuickAdd?: { initialGramsByDate: Record<string, number> };
    }) {
      const selected = useDayContext().parts.day;
      const label = days.find((day) => day.date === selected)?.label ?? "";
      const grams = proteinQuickAdd?.initialGramsByDate[selected] ?? -1;
      return (
        <output data-testid="food-host-probe">
          {selected}:{grams}:{label}
        </output>
      );
    },
  };
});
vi.mock("@/components/DoseStatusControl", () => ({
  default: ({ date }: { date?: string }) => (
    <span data-testid="dose-control-probe" data-date={date ?? ""} />
  ),
}));
vi.mock("@/components/medications/dose-day-settlement", () => ({
  useDoseDayResolution: () => ({
    resolveAll: vi.fn(),
    bulkBlocked: () => false,
  }),
}));

const ACTING: SessionProfile = {
  id: 1,
  name: "Dad",
  photo_path: null,
  photo_version: 0,
};

const MEASUREMENTS = {
  form: "measurements" as const,
  defaultDate: "2026-09-03",
  defaultStatedAt: null,
  maxDate: "2026-09-03",
  profileId: ACTING.id,
  weightUnit: "lb" as const,
  temperatureUnit: "F" as const,
  showCompositionEntry: true,
  showGrowth: false,
  showHeadCirc: false,
};

function Sheet({ actingProfileId = ACTING.id }: { actingProfileId?: number }) {
  const { open, close } = useQuickEntry();
  return (
    <>
      <button onClick={() => open("stool")}>open</button>
      <button onClick={() => open("dose")}>open dose</button>
      <button onClick={() => open("food")}>open food</button>
      <button onClick={() => open("cycle")}>open cycle</button>
      <button onClick={close}>close</button>
    </>
  );
}

function renderSheet(
  actingProfileId = ACTING.id,
  liveToday = MEASUREMENTS.defaultDate,
  authKey = "login:session"
) {
  const surface = (id: number, day: string, identity: string) => (
    <ToastProvider>
      <ProfileDaysBoundary
        clocks={new Map([[id, { today: day, timeZone: "UTC" }]])}
      >
        <QuickEntryProvider
          key={`${identity}:${id}`}
          measurements={MEASUREMENTS}
          writableProfiles={[ACTING]}
          actingProfileId={id}
        >
          <Sheet actingProfileId={id} />
        </QuickEntryProvider>
      </ProfileDaysBoundary>
    </ToastProvider>
  );
  const utils = render(surface(actingProfileId, liveToday, authKey));
  return {
    ...utils,
    rerenderWithActing: (id: number) =>
      utils.rerender(surface(id, liveToday, authKey)),
    rerenderWithDay: (day: string) =>
      utils.rerender(surface(actingProfileId, day, authKey)),
    rerenderWithAuth: (identity: string) =>
      utils.rerender(surface(actingProfileId, liveToday, identity)),
  };
}

function unavailable(message: string, today = MEASUREMENTS.defaultDate) {
  return {
    form: "unavailable" as const,
    today,
    message,
  };
}

function dueDose(today: string) {
  return {
    form: "dose" as const,
    today,
    doses: [
      {
        doseId: 77,
        title: "Held midnight dose",
        detail: null,
        dueText: "8:00am",
      },
    ],
    prn: {
      meds: [],
      tz: "UTC",
      timeFormat: "24h" as const,
      nowIso: `${today}T12:00:00.000Z`,
      pediatric: {
        ageMonths: null,
        weightKg: null,
        weightDate: null,
        weightUnit: "kg" as const,
        today,
      },
    },
    pastDays: [
      { date: "2026-09-02", label: "Yesterday", slots: [] },
      { date: "2026-09-01", label: "Mon, Sep 1", slots: [] },
    ],
  };
}

function food(day: string, proteinGrams: number, today = "2026-09-03") {
  return {
    form: "food" as const,
    today,
    days: [
      {
        date: day,
        label: "server-relative label",
        counts: {},
        slotCounts: { Morning: {}, Midday: {}, Evening: {} },
        events: [],
      },
    ],
    groupsBySlot: { Morning: [], Midday: [], Evening: [] },
    proteinRankBySlot: { Morning: 0, Midday: 0, Evening: 0 },
    proteinGrams,
    proteinPreset: 30,
    excludedGroups: [],
    slot: "Midday" as const,
    slotBoundaries: { midday: 660, evening: 900 },
  };
}

beforeEach(() => {
  loadQuickEntry.mockReset();
});

describe("last-good render, revalidate behind it (#3416 proposal 1)", () => {
  it("a reopen after a successful open renders instantly from last-good, then updates", async () => {
    let resolveSecond: (v: ReturnType<typeof unavailable>) => void;
    loadQuickEntry
      .mockResolvedValueOnce(unavailable("v1"))
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveSecond = resolve))
      );

    renderSheet();
    fireEvent.click(screen.getByText("open"));
    expect(
      (await screen.findByTestId("quick-entry-unavailable")).textContent
    ).toContain("v1");

    fireEvent.click(screen.getByText("close"));
    fireEvent.click(screen.getByText("open"));

    // INSTANT: no loading state, v1 is already on screen from the cache — before
    // the second (background) gather has even resolved.
    expect(screen.queryByTestId("quick-entry-loading")).toBeNull();
    expect(screen.getByTestId("quick-entry-unavailable").textContent).toContain(
      "v1"
    );

    resolveSecond!(unavailable("v2"));
    await waitFor(() =>
      expect(
        screen.getByTestId("quick-entry-unavailable").textContent
      ).toContain("v2")
    );
  });

  it("a failed revalidate behind a last-good render keeps the rendered form (no error state)", async () => {
    loadQuickEntry
      .mockResolvedValueOnce(unavailable("v1"))
      .mockRejectedValueOnce(new Error("offline"));

    renderSheet();
    fireEvent.click(screen.getByText("open"));
    await screen.findByTestId("quick-entry-unavailable");

    fireEvent.click(screen.getByText("close"));
    fireEvent.click(screen.getByText("open"));

    await waitFor(() => expect(loadQuickEntry).toHaveBeenCalledTimes(2));
    // The failed background revalidate must not blank the sheet into the error
    // state — the last-good copy is still a correct, if slightly stale, answer.
    expect(screen.queryByTestId("quick-entry-error")).toBeNull();
    expect(screen.getByTestId("quick-entry-unavailable").textContent).toContain(
      "v1"
    );
  });

  it("a COLD failure (nothing cached) reaches the error state", async () => {
    loadQuickEntry.mockRejectedValueOnce(new Error("offline"));
    renderSheet();
    fireEvent.click(screen.getByText("open"));
    expect(await screen.findByTestId("quick-entry-error")).not.toBeNull();
  });

  it("the acting profile changing drops the cache — a same-form reopen loads again rather than flashing the last-good copy", async () => {
    loadQuickEntry.mockResolvedValue(unavailable("v1"));
    const { rerenderWithActing } = renderSheet();
    fireEvent.click(screen.getByText("open"));
    await screen.findByTestId("quick-entry-unavailable");
    fireEvent.click(screen.getByText("close"));

    rerenderWithActing(99);
    loadQuickEntry.mockClear();
    let resolveNext: (v: ReturnType<typeof unavailable>) => void;
    loadQuickEntry.mockImplementationOnce(
      () => new Promise((resolve) => (resolveNext = resolve))
    );
    fireEvent.click(screen.getByText("open"));

    // No stale last-good survives the identity change — the sheet goes back to a
    // genuine loading state rather than instantly repainting the OLD profile's
    // cached answer under the new one.
    expect(screen.getByTestId("quick-entry-loading")).not.toBeNull();
    resolveNext!(unavailable("v2"));
    await waitFor(() =>
      expect(
        screen.getByTestId("quick-entry-unavailable").textContent
      ).toContain("v2")
    );
  });

  it("a new authenticated session cannot reuse the prior session's cache", async () => {
    loadQuickEntry.mockResolvedValueOnce(unavailable("old session"));
    const { rerenderWithAuth } = renderSheet();
    fireEvent.click(screen.getByText("open"));
    await screen.findByTestId("quick-entry-unavailable");
    fireEvent.click(screen.getByText("close"));

    rerenderWithAuth("next-login:next-session");
    loadQuickEntry.mockImplementationOnce(() => new Promise(() => {}));
    fireEvent.click(screen.getByText("open"));

    expect(screen.getByTestId("quick-entry-loading")).not.toBeNull();
  });
});

describe("the stall bound and Retry (#3416 proposal 3)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a gather stalled past the timeout reaches the error state, not perpetual Loading", async () => {
    loadQuickEntry.mockImplementationOnce(() => new Promise(() => {}));
    renderSheet();
    fireEvent.click(screen.getByText("open"));
    expect(screen.getByTestId("quick-entry-loading")).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(screen.getByTestId("quick-entry-error")).not.toBeNull();
  });

  it("Retry re-runs the SAME gather and a success replaces the error state", async () => {
    loadQuickEntry.mockRejectedValueOnce(new Error("offline"));
    renderSheet();
    fireEvent.click(screen.getByText("open"));
    await vi.waitFor(() =>
      expect(screen.getByTestId("quick-entry-error")).not.toBeNull()
    );

    loadQuickEntry.mockResolvedValueOnce(unavailable("recovered"));
    fireEvent.click(screen.getByTestId("quick-entry-retry"));

    await vi.waitFor(() =>
      expect(
        screen.getByTestId("quick-entry-unavailable").textContent
      ).toContain("recovered")
    );
    expect(loadQuickEntry).toHaveBeenCalledTimes(2);
  });
});

describe("day request identity", () => {
  it("returns from Yesterday to the cached Today Food total while refreshing that key", async () => {
    let resolveTodayRefresh!: (value: ReturnType<typeof food>) => void;
    loadQuickEntry
      .mockResolvedValueOnce(food("2026-09-03", 5))
      .mockResolvedValueOnce(food("2026-09-02", 0))
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveTodayRefresh = resolve))
      );
    renderSheet();
    fireEvent.click(screen.getByText("open food"));
    expect((await screen.findByTestId("food-host-probe")).textContent).toBe(
      "2026-09-03:5:Today"
    );

    fireEvent.click(screen.getByTestId("day-context-1"));
    await waitFor(() =>
      expect(screen.getByTestId("food-host-probe").textContent).toBe(
        "2026-09-02:0:Yesterday"
      )
    );

    fireEvent.click(screen.getByTestId("day-context-0"));
    expect(screen.getByTestId("food-host-probe").textContent).toBe(
      "2026-09-03:5:Today"
    );
    resolveTodayRefresh(food("2026-09-03", 7));
    await waitFor(() =>
      expect(screen.getByTestId("food-host-probe").textContent).toBe(
        "2026-09-03:7:Today"
      )
    );
  });

  it("renders the inherited dated Food total without a sheet switcher", async () => {
    const inheritedDay = "2026-08-20";
    loadQuickEntry.mockResolvedValueOnce(food(inheritedDay, 33));
    render(
      <ToastProvider>
        <ProfileDaysBoundary
          clocks={
            new Map([[ACTING.id, { today: "2026-09-03", timeZone: "UTC" }]])
          }
        >
          <DayContextProvider
            profileId={ACTING.id}
            today="2026-09-03"
            reach={{ kind: "dated" }}
            backing={{
              kind: "url",
              day: inheritedDay,
              hrefForDay: (day) => `/history?day=${day}` as AppRoute,
            }}
          >
            <QuickEntryProvider
              measurements={MEASUREMENTS}
              writableProfiles={[ACTING]}
              actingProfileId={ACTING.id}
            >
              <Sheet />
            </QuickEntryProvider>
          </DayContextProvider>
        </ProfileDaysBoundary>
      </ToastProvider>
    );

    fireEvent.click(screen.getByText("open food"));
    await waitFor(() =>
      expect(screen.getByTestId("food-host-probe").textContent).toContain(
        `${inheritedDay}:33:`
      )
    );
    expect(loadQuickEntry).toHaveBeenLastCalledWith(
      "food",
      ACTING.id,
      inheritedDay,
      "dated"
    );
    expect(screen.queryByTestId("bounded-day-switcher")).toBeNull();
  });

  it("reopens an undated form daylessly, not on the prior selection", async () => {
    loadQuickEntry
      .mockResolvedValueOnce(unavailable("today"))
      .mockResolvedValueOnce(unavailable("past"))
      .mockResolvedValueOnce(unavailable("today refreshed"));
    renderSheet();
    fireEvent.click(screen.getByText("open"));
    await screen.findByTestId("bounded-day-switcher");
    fireEvent.click(screen.getByTestId("day-context-1"));
    await waitFor(() =>
      expect(
        screen.getByTestId("quick-entry-unavailable").textContent
      ).toContain("past")
    );

    fireEvent.click(screen.getByText("close"));
    fireEvent.click(screen.getByText("open"));

    expect(loadQuickEntry).toHaveBeenLastCalledWith(
      "stool",
      ACTING.id,
      undefined,
      "sheet"
    );
    expect(
      screen.getByTestId("day-context-0").getAttribute("aria-pressed")
    ).toBe("true");
  });

  it("does not expose a past-day context for a today-bound lifecycle", async () => {
    loadQuickEntry.mockResolvedValueOnce(unavailable("cycle unavailable"));
    renderSheet();
    fireEvent.click(screen.getByText("open cycle"));
    await screen.findByTestId("quick-entry-unavailable");
    expect(screen.queryByTestId("bounded-day-switcher")).toBeNull();
    expect(loadQuickEntry).toHaveBeenCalledWith(
      "cycle",
      ACTING.id,
      undefined,
      "sheet"
    );
  });

  it("retries the selected day after its gather rejects", async () => {
    loadQuickEntry
      .mockResolvedValueOnce(unavailable("today"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(unavailable("recovered"));
    renderSheet();
    fireEvent.click(screen.getByText("open"));
    await screen.findByTestId("bounded-day-switcher");

    fireEvent.click(screen.getByTestId("day-context-1"));
    await screen.findByTestId("quick-entry-error");
    expect(loadQuickEntry).toHaveBeenLastCalledWith(
      "stool",
      ACTING.id,
      "2026-09-02",
      "sheet"
    );

    fireEvent.click(screen.getByTestId("quick-entry-retry"));
    await screen.findByTestId("quick-entry-unavailable");
    expect(loadQuickEntry).toHaveBeenLastCalledWith(
      "stool",
      ACTING.id,
      "2026-09-02",
      "sheet"
    );
  });

  it("drops a late response for a day already left", async () => {
    let resolveYesterday!: (value: ReturnType<typeof unavailable>) => void;
    loadQuickEntry
      .mockResolvedValueOnce(unavailable("today"))
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveYesterday = resolve))
      )
      .mockResolvedValueOnce(unavailable("two days ago"));
    renderSheet();
    fireEvent.click(screen.getByText("open"));
    await screen.findByTestId("bounded-day-switcher");

    fireEvent.click(screen.getByTestId("day-context-1"));
    fireEvent.click(screen.getByTestId("day-context-2"));
    await waitFor(() =>
      expect(
        screen.getByTestId("quick-entry-unavailable").textContent
      ).toContain("two days ago")
    );
    resolveYesterday(unavailable("late yesterday"));
    await act(async () => {});
    expect(screen.getByTestId("quick-entry-unavailable").textContent).toContain(
      "two days ago"
    );
  });

  it("gathers the reconciled day when midnight expires the cached selection", async () => {
    let resolveOld!: (value: ReturnType<typeof unavailable>) => void;
    loadQuickEntry
      .mockResolvedValueOnce(unavailable("initial"))
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveOld = resolve))
      )
      .mockResolvedValueOnce(unavailable("reconciled", "2026-09-05"));
    const { rerenderWithDay } = renderSheet();
    fireEvent.click(screen.getByText("open"));
    await screen.findByTestId("bounded-day-switcher");
    fireEvent.click(screen.getByTestId("day-context-2"));
    rerenderWithDay("2026-09-05");

    await waitFor(() =>
      expect(loadQuickEntry).toHaveBeenLastCalledWith(
        "stool",
        ACTING.id,
        "2026-09-05",
        "sheet"
      )
    );
    resolveOld(unavailable("old day after midnight", "2026-09-05"));
    expect(
      (await screen.findByTestId("quick-entry-unavailable")).textContent
    ).toContain("reconciled");
  });

  it("keeps an in-reach cached prior day while a new dayless bootstrap runs", async () => {
    let resolveRefresh!: (value: ReturnType<typeof unavailable>) => void;
    loadQuickEntry
      .mockResolvedValueOnce(unavailable("September 3"))
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveRefresh = resolve))
      );
    const { rerenderWithDay } = renderSheet();
    fireEvent.click(screen.getByText("open"));
    await screen.findByTestId("quick-entry-unavailable");
    fireEvent.click(screen.getByText("close"));

    rerenderWithDay("2026-09-04");
    fireEvent.click(screen.getByText("open"));

    expect(screen.getByTestId("quick-entry-unavailable").textContent).toContain(
      "September 3"
    );
    expect(loadQuickEntry).toHaveBeenLastCalledWith(
      "stool",
      ACTING.id,
      undefined,
      "sheet"
    );
    expect(
      screen.getByTestId("day-context-1").getAttribute("aria-pressed")
    ).toBe("true");
    expect(screen.getByTestId("day-context-1").textContent).toBe("Yesterday");
    resolveRefresh(unavailable("September 4", "2026-09-04"));
    await waitFor(() =>
      expect(
        screen.getByTestId("day-context-0").getAttribute("aria-pressed")
      ).toBe("true")
    );
  });

  it("restarts a dayless bootstrap whose response crossed local midnight", async () => {
    let resolveOld!: (value: ReturnType<typeof unavailable>) => void;
    loadQuickEntry
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveOld = resolve))
      )
      .mockResolvedValueOnce(unavailable("new day", "2026-09-04"));
    const { rerenderWithDay } = renderSheet();
    fireEvent.click(screen.getByText("open"));
    rerenderWithDay("2026-09-04");

    resolveOld(unavailable("old day", "2026-09-03"));

    await waitFor(() => expect(loadQuickEntry).toHaveBeenCalledTimes(2));
    expect(loadQuickEntry).toHaveBeenLastCalledWith(
      "stool",
      ACTING.id,
      undefined,
      "sheet"
    );
    expect(
      (await screen.findByTestId("quick-entry-unavailable")).textContent
    ).toContain("new day");
  });
});

describe("midnight fallback integration", () => {
  it("keeps a reachable prior-day dose row and gives its control the explicit day", async () => {
    loadQuickEntry
      .mockResolvedValueOnce(dueDose("2026-09-03"))
      .mockRejectedValueOnce(new Error("offline"));
    const { rerenderWithDay } = renderSheet(ACTING.id, "2026-09-03");

    fireEvent.click(screen.getByText("open dose"));
    expect(await screen.findByText("Held midnight dose")).toBeTruthy();
    fireEvent.click(screen.getByText("close"));
    rerenderWithDay("2026-09-04");
    fireEvent.click(screen.getByText("open dose"));

    await waitFor(() => expect(loadQuickEntry).toHaveBeenCalledTimes(2));
    expect(loadQuickEntry).toHaveBeenLastCalledWith(
      "dose",
      ACTING.id,
      undefined,
      "sheet"
    );
    expect(
      screen.getByTestId("day-context-1").getAttribute("aria-pressed")
    ).toBe("true");
    expect(screen.getByText("Held midnight dose")).toBeTruthy();
    expect(screen.getByTestId("dose-control-probe").dataset.date).toBe(
      "2026-09-03"
    );
  });

  it("settles persistent in-reach disagreement with one historical response", async () => {
    let calls = 0;
    loadQuickEntry.mockImplementation(() => {
      calls += 1;
      return Promise.resolve(
        unavailable(`stale response ${calls}`, "2026-09-03")
      );
    });
    renderSheet(ACTING.id, "2026-09-04");
    fireEvent.click(screen.getByText("open"));

    expect(
      (await screen.findByTestId("quick-entry-unavailable")).textContent
    ).toContain("stale response 1");
    expect(loadQuickEntry).toHaveBeenCalledTimes(1);
    expect(
      screen.getByTestId("day-context-1").getAttribute("aria-pressed")
    ).toBe("true");
  });

  it("settles a consistent dayless response without an extra request", async () => {
    loadQuickEntry.mockResolvedValueOnce(
      unavailable("current response", "2026-09-04")
    );
    renderSheet(ACTING.id, "2026-09-04");
    fireEvent.click(screen.getByText("open"));

    expect(
      (await screen.findByTestId("quick-entry-unavailable")).textContent
    ).toContain("current response");
    expect(loadQuickEntry).toHaveBeenCalledTimes(1);
  });
});
