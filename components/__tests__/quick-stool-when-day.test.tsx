import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import QuickStoolForm from "@/components/quick-entry/QuickStoolForm";

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

vi.mock("@/components/Toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({ enqueue: vi.fn() }),
}));
vi.mock("@/components/TimezoneProvider", () => ({ useTimezone: () => "UTC" }));
vi.mock("@/app/(app)/stool-actions", () => ({ logStoolForm: vi.fn() }));
// The ledger stands in for the real one and RUNS the write, so a tap is not a no-op
// that would pass any assertion about what tapping does.
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
      <QuickStoolForm todayCount={0} today="2026-07-08" />
    );

    fireEvent.click(screen.getByTestId("stool-when-toggle"));
    fireEvent.change(timeField(), { target: { value: "23:50" } });
    expect(timeField().value).toBe("23:50");
    expect(screen.getByTestId("stool-when-date").textContent).toBe(
      "2026-07-08"
    );

    // Local midnight passes and the server's day moves under the open sheet.
    rerender(<QuickStoolForm todayCount={0} today="2026-07-09" />);

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
      <QuickStoolForm todayCount={0} today="2026-07-08" />
    );

    fireEvent.click(screen.getByTestId("stool-when-toggle"));
    fireEvent.change(timeField(), { target: { value: "07:05" } });
    rerender(<QuickStoolForm todayCount={1} today="2026-07-08" />);

    expect(timeField().value).toBe("07:05");
  });
});
