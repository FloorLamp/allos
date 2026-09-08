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
import { ProfileDaysBoundary } from "@/components/DayContext";

// COMPONENT TIER — #3416/#4454, the sheet's offline OPEN path: last-good render
// with a revalidate behind it, a failed revalidate keeping what is already shown, a
// stalled gather timing out to the error state, Retry re-running the SAME gather,
// and the acting-profile change dropping the cache (the same device-local wipe
// boundary ProfileSwitchWatcher enforces for the offline read snapshots).

const loadQuickEntry = vi.hoisted(() => vi.fn());
vi.mock("@/app/(app)/quick-entry-actions", () => ({ loadQuickEntry }));

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
      <ProfileDaysBoundary days={new Map([[id, day]])}>
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
