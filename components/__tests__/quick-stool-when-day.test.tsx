import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import StoolTypeControl from "@/components/stool/StoolTypeControl";

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
const { toast, outcome } = vi.hoisted(() => ({
  toast: vi.fn(),
  outcome: vi.fn(),
}));
vi.mock("@/components/Toast", () => ({ useToast: () => toast }));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({ enqueue: vi.fn() }),
}));
vi.mock("@/components/TimezoneProvider", () => ({ useTimezone: () => "UTC" }));
outcome.mockResolvedValue({ ok: true, type: 4, dayCount: 1 });
vi.mock("@/app/(app)/stool-actions", () => ({ logStoolForm: outcome }));
// The pipeline's other collaborators (#3276). Left real, the hook would need the
// undo-offer and logged-via providers this tier does not mount.
vi.mock("@/components/LoggedViaSurface", () => ({
  useLoggedViaStamp: () => (fd: FormData) => fd,
}));
vi.mock("@/components/useUndoableAction", () => ({
  useUndoableAction: () => vi.fn(),
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
    expect(screen.getByTestId("stool-when-date").textContent).toBe(
      "2026-07-08"
    );

    // Local midnight passes and the server's day moves under the open sheet.
    rerender(<StoolTypeControl todayCount={0} today="2026-07-09" />);

    // The statement is DROPPED, not re-anchored: 23:50 said about yesterday is not a
    // claim about today, and re-anchoring it would invent one — in the future, on the
    // day the action actually files under.
    expect(timeField().value).toBe("");
    expect(screen.getByTestId("stool-when-date").textContent).toBe(
      "2026-07-09"
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
    [undefined, "Logged type 4 at 23:50"],
  ])("statedTimeRefused=%s → %s", async (refused, sentence) => {
    toast.mockClear();
    outcome.mockResolvedValueOnce({
      ok: true,
      type: 4,
      dayCount: 1,
      ...(refused ? { statedTimeRefused: refused } : {}),
    });
    render(<StoolTypeControl todayCount={0} today="2026-07-08" />);

    fireEvent.click(screen.getByTestId("stool-when-toggle"));
    fireEvent.change(timeField(), { target: { value: "23:50" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("stool-type-4"));
    });

    expect(toast).toHaveBeenCalledWith(sentence);
  });
});
