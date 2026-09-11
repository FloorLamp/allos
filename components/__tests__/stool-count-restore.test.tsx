import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import StoolTypeControl from "@/components/stool/StoolTypeControl";

// THE STOOL ROW'S SIDE OF THE OPTIMISTIC CHANNEL (#3728). Seven buttons write ONE day
// count, which is the shape that makes "restore the pre-tap value" the wrong rule: the
// value a refused tap fired from can already have been superseded by a sibling type's
// reading. The generic matrix lives in `write-pipeline.test.tsx`; what is asserted here
// is that this control's own count comes back to the right number through the REAL
// ledger and pipeline. Since #5663 the count reads `N today`, beneath the day's rows.
const { toast, logStoolForm, loadStoolDay } = vi.hoisted(() => ({
  toast: vi.fn(),
  logStoolForm: vi.fn(),
  // The sheet's own gather answers with a count, so the control asks for the day's
  // ROWS itself (#5663). Empty here: what this file is about is the count.
  loadStoolDay: vi.fn(async () => ({ readings: [], dayCount: 0 })),
}));
vi.mock("@/components/Toast", () => ({ useToast: () => toast }));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({ enqueue: vi.fn() }),
  useQueuedDayContextCapture: () => () => null,
}));
vi.mock("@/app/(app)/stool-actions", () => ({ logStoolForm, loadStoolDay }));
// The pipeline's provider-bound collaborators, which this tier does not mount. The
// LEDGER is deliberately real: it is the thing carrying the value now.
vi.mock("@/components/LoggedViaSurface", () => ({
  useLoggedViaStamp: () => (fd: FormData) => fd,
}));
vi.mock("@/components/useUndoableAction", () => ({
  useUndoableAction: () => vi.fn(),
}));

const count = () =>
  screen.getByTestId("quick-entry-stool-count").textContent ?? "";

function held<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (settle = resolve));
  return { promise, settle };
}

describe("a refused reading leaves the day count telling the truth (#3728)", () => {
  it("puts the count back when the write is refused, and says why", async () => {
    vi.clearAllMocks();
    const answer = held<{ ok: false; error: string }>();
    logStoolForm.mockReturnValue(answer.promise);
    render(<StoolTypeControl todayCount={2} today="2026-07-08" />);
    expect(count()).toBe("2 today");

    await act(async () => {
      screen.getByTestId("stool-type-4").click();
    });
    expect(count()).toBe("3 today");

    await act(async () => {
      answer.settle({ ok: false, error: "That reading was refused." });
    });
    await waitFor(() => expect(count()).toBe("2 today"));
    expect(toast).toHaveBeenCalledWith("That reading was refused.", {
      tone: "error",
    });
  });

  // The case only this surface can pose: two of the seven buttons out at once. Type 5
  // lands and the server says the day now holds THREE readings; type 4 is then refused.
  // Its own pre-tap number was 2, and putting that back would delete type 5's reading
  // from a count that is the only receipt this control gives.
  it("keeps a sibling type's landed reading when another type is refused", async () => {
    vi.clearAllMocks();
    const refused = held<{ ok: false; error: string }>();
    const landed = held<{
      ok: true;
      type: number;
      dayCount: number;
      readings: { id: number; type: number; hhmm: string }[];
    }>();
    logStoolForm
      .mockReturnValueOnce(refused.promise)
      .mockReturnValueOnce(landed.promise);
    render(<StoolTypeControl todayCount={2} today="2026-07-08" />);

    await act(async () => {
      screen.getByTestId("stool-type-4").click();
    });
    expect(count()).toBe("3 today");
    await act(async () => {
      screen.getByTestId("stool-type-5").click();
    });
    expect(count()).toBe("4 today");

    await act(async () => {
      landed.settle({
        ok: true,
        type: 5,
        dayCount: 3,
        readings: [{ id: 3, type: 5, hhmm: "08:12" }],
      });
    });
    await waitFor(() => expect(count()).toBe("3 today"));

    await act(async () => {
      refused.settle({ ok: false, error: "That reading was refused." });
    });
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("That reading was refused.", {
        tone: "error",
      })
    );
    expect(count()).toBe("3 today");
  });
});
