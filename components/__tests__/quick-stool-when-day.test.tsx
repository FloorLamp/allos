import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import StoolTypeControl from "@/components/stool/StoolTypeControl";
import { DayContextProvider } from "@/components/DayContext";

// #3273 — the sheet's "Happened earlier?" statement follows the SERVER's day.
//
// The sheet's props are gathered when it opens, and the quick-log overlay is a
// surface people leave open. Before this issue the picker had no time affordance at
// all, so a stale `today` could not make a stated time wrong; mounting the control is
// what created the surface. Left across local midnight without the follower, the
// control goes on offering yesterday as its fixed day while `logStoolForm` files the
// tap under the server's today — so a statement of 23:50 lands at TODAY's 23:50,
// which is in the future.
//
// The e2e tier cannot ask this: crossing local midnight is not a thing a spec can do
// to a running app, and the prop change is exactly what this tier can drive.

// Hoisted, because `vi.mock`'s factory is lifted above every module-scope binding.
const { toast, outcome, announce, loadStoolDay } = vi.hoisted(() => ({
  toast: vi.fn(),
  outcome: vi.fn(),
  announce: vi.fn(),
  // The day's receipt rows (#5663) are read by the control itself; empty here, because
  // what this file is about is the statement, not the rows.
  loadStoolDay: vi.fn(async () => ({ readings: [], dayCount: 0 })),
}));
vi.mock("@/components/Toast", () => ({ useToast: () => toast }));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({ enqueue: vi.fn() }),
  useQueuedDayContextCapture: () => () => null,
}));
vi.mock("@/components/TimezoneProvider", () => ({ useTimezone: () => "UTC" }));
outcome.mockResolvedValue({ ok: true, type: 4, dayCount: 1, readings: [] });
vi.mock("@/app/(app)/stool-actions", () => ({
  logStoolForm: outcome,
  loadStoolDay,
}));
// The pipeline's other collaborators (#3276). Left real, the hook would need the
// undo-offer and logged-via providers this tier does not mount.
vi.mock("@/components/LoggedViaSurface", () => ({
  useLoggedViaStamp: () => (fd: FormData) => fd,
}));
// The undoable channel is a mock but a SHARED one: since #5663 a landed stool reading
// carries an Undo, so `useWritePipeline`'s `say` routes its sentence here rather than
// to the bare toast. The two are different channels and the assertions below name
// which one a sentence went down.
vi.mock("@/components/useUndoableAction", () => ({
  useUndoableAction: () => announce,
}));
// The ledger stands in for the real one and RUNS the write, so a tap is not a no-op
// that would pass any assertion about what tapping does. `useWritePipeline` itself is
// REAL here — it is the thing under the control now, and mocking it would leave the
// statement-spend this file exists for running against nothing.
vi.mock("@/components/useOptimisticLedger", () => ({
  useOptimisticLedger: () => ({
    pending: () => false,
    blocked: () => false,
    tap: async <T,>(op: {
      write: () => Promise<T>;
      settle: (outcome: T) => unknown;
    }) => op.settle(await op.write()),
  }),
}));

const timeField = () =>
  screen.getByTestId("stool-when-time") as HTMLInputElement;

describe("the stool sheet's stated time follows the server's day (#3273)", () => {
  it("drops a statement the day moved out from under, and re-anchors", () => {
    const { rerender } = render(
      <StoolTypeControl todayCount={0} today="2026-07-08" />
    );

    fireEvent.click(screen.getByTestId("stool-when-toggle"));
    fireEvent.change(timeField(), { target: { value: "23:50" } });
    expect(timeField().value).toBe("23:50");
    // THE DAY IS WORDS, NEVER THE STORAGE SPELLING (#5489 fix 3). This arm used to
    // print `value.date` whenever the fixed day was not today; it now names the day
    // through the login's own date shape, and only the day the sheet is standing on.
    expect(screen.getByTestId("stool-when-date").textContent).not.toMatch(
      /^\d{4}-\d{2}-\d{2}$/
    );
    expect(screen.getByTestId("stool-when-date").textContent).toContain(
      "Jul 8"
    );

    // Local midnight passes and the server's day moves under the open sheet.
    rerender(<StoolTypeControl todayCount={0} today="2026-07-09" />);

    // The statement is DROPPED, not re-anchored: 23:50 said about yesterday is not a
    // claim about today, and re-anchoring it would invent one — in the future, on the
    // day the action actually files under.
    expect(timeField().value).toBe("");
    expect(screen.getByTestId("stool-when-date").textContent).toContain(
      "Jul 9"
    );
  });

  // The converse, so the follower cannot be satisfied by clearing on every render.
  it("leaves a statement alone while the day holds", () => {
    const { rerender } = render(
      <StoolTypeControl todayCount={0} today="2026-07-08" />
    );

    fireEvent.click(screen.getByTestId("stool-when-toggle"));
    fireEvent.change(timeField(), { target: { value: "07:05" } });
    rerender(<StoolTypeControl todayCount={1} today="2026-07-08" />);

    expect(timeField().value).toBe("07:05");
  });
});

// THE REFUSAL REACHES THE PERSON (#4425/#4433). The stated time is judged at the write
// boundary and a refusal costs the STATEMENT rather than the observation — so the only
// place that fact can become visible is this surface's sentence. It says the reading was
// filed at the moment of the tap and names the minute that was not taken, in this
// surface's own words: the user TYPED the time here, so `STATED_TIME_REFUSAL_NOTE`'s
// "your device's clock is ahead" would diagnose the wrong machine (lib/stated-time.ts).
//
// The sentence moved from a bare `toast()` to `useWritePipeline`'s announcement when
// this control converged (#3276), which is a route it could have been dropped on.
describe("the refused stated time is reported, not swallowed", () => {
  it.each([
    ["future", "Logged type 4 now — 23:50 hasn't happened yet."],
    ["malformed", "Logged type 4 now — 23:50 isn't a time on this day."],
    // #5663 retires the two success forks — "at 23:50" when a time was stated, bare
    // when it was not — for ruling 1's one toast grammar, over the minute the STORED
    // reading carries rather than the one that was typed. The refusal sentences are
    // untouched: they are about the statement that did NOT land, which is a different
    // sentence and #4425's, not this ruling's.
    [undefined, "Type 4 logged · 23:50"],
  ])("statedTimeRefused=%s → %s", async (refused, sentence) => {
    announce.mockClear();
    outcome.mockResolvedValueOnce({
      ok: true,
      type: 4,
      dayCount: 1,
      reading: { id: 31 },
      readings: [{ id: 31, type: 4, hhmm: "23:50" }],
      ...(refused ? { statedTimeRefused: refused } : {}),
    });
    render(<StoolTypeControl todayCount={0} today="2026-07-08" />);

    fireEvent.click(screen.getByTestId("stool-when-toggle"));
    fireEvent.change(timeField(), { target: { value: "23:50" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("stool-type-4"));
    });

    expect(announce).toHaveBeenCalledWith(
      expect.objectContaining({ message: sentence })
    );
  });
});

describe("a historical quick-entry stool observation", () => {
  it("requires its visible time and posts the mounted day", async () => {
    render(
      <DayContextProvider
        profileId={7}
        today="2026-07-09"
        reach={{ kind: "dated" }}
        backing={{ kind: "state", initialDay: "2026-07-08" }}
      >
        <StoolTypeControl todayCount={0} today="2026-07-08" />
      </DayContextProvider>
    );
    const type = screen.getByTestId("stool-type-4");
    expect(screen.queryByTestId("stool-when-toggle")).toBeNull();
    expect(type.hasAttribute("disabled")).toBe(true);
    fireEvent.change(timeField(), { target: { value: "08:10" } });
    expect(type.hasAttribute("disabled")).toBe(false);
    await act(async () => fireEvent.click(type));
    const sent = outcome.mock.calls.at(-1)?.[0] as FormData;
    expect(sent.get("date")).toBe("2026-07-08");
    expect(sent.get("at")).toBe("08:10");
  });
});
