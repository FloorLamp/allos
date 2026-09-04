import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/Toast";
import SleepOverlapKeep from "@/components/SleepOverlapKeep";
import { keepSleepSession } from "@/app/(app)/data/review-actions";
import type { OverlappingSleepPair } from "@/lib/queries/sleep";

// #5021's pair half. The one thing a test can get wrong here is the one thing that
// matters: each row's button must keep ITS OWN session and drop the other. Swapped, it
// silently deletes the copy the person chose.

vi.mock("@/app/(app)/data/review-actions", () => ({
  keepSleepSession: vi.fn(async () => ({ undoId: 7 })),
}));

const PAIR: OverlappingSleepPair = {
  origin: "com.fitbit.FitbitMobile",
  sessions: [
    {
      id: 11,
      date: "2026-08-28",
      started_at: "2026-08-27T23:00:00Z",
      minutes: 420,
    },
    {
      id: 12,
      date: "2026-08-28",
      started_at: "2026-08-28T02:00:00Z",
      minutes: 420,
    },
  ],
};

afterEach(cleanup);

describe("Keep this one", () => {
  it("offers the choice on both rows and drops the other one", () => {
    render(
      <ToastProvider>
        <SleepOverlapKeep pair={PAIR} />
      </ToastProvider>
    );

    // Both copies get the offer: the app does not know which is real, so it does not
    // pick a side.
    expect(
      screen.getAllByRole("button", { name: "Keep this one" })
    ).toHaveLength(2);

    fireEvent.click(screen.getByTestId("sleep-overlap-keep-11"));

    const posted = vi.mocked(keepSleepSession).mock.calls[0][0];
    expect(posted.get("keep_id")).toBe("11");
    expect(posted.get("drop_id")).toBe("12");
  });

  it("drops the first row when the second is the one kept", () => {
    render(
      <ToastProvider>
        <SleepOverlapKeep pair={PAIR} />
      </ToastProvider>
    );

    fireEvent.click(screen.getByTestId("sleep-overlap-keep-12"));

    const posted = vi.mocked(keepSleepSession).mock.calls.at(-1)![0];
    expect(posted.get("keep_id")).toBe("12");
    expect(posted.get("drop_id")).toBe("11");
  });
});
