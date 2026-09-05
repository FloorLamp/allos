import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { ToastProvider } from "@/components/Toast";
import SleepMoodSection from "@/app/(app)/sleep/SleepMoodSection";
import SleepRetimeDialog from "@/app/(app)/sleep/SleepRetimeDialog";
import { retimeSleepSession } from "@/app/(app)/sleep/actions";
import { DEFAULT_FORMAT_PREFS } from "@/lib/format-date";
import type { SleepMoodHistoryRow } from "@/lib/sleep-summary";

// THE THIRD DOOR ON A CONTRADICTED NIGHT (#5021). What is pinned here is who gets the
// door and what the dialog claims when it opens — both of them rulings, not copy:
// the lock stays on every night the detector has NOT contradicted, and the two clocks
// open EMPTY because the settled instant is information and not a bedtime.

vi.mock("@/app/(app)/sleep/actions", () => ({
  retimeSleepSession: vi.fn(),
  deleteSleepMoodRow: vi.fn(),
  saveSleepMoodEntry: vi.fn(),
}));
vi.mock("@/app/(app)/undo-actions", () => ({
  undoDelete: vi.fn(async () => ({ ok: true })),
  undoDeletes: vi.fn(async () => ({ restored: 0 })),
}));

function night(overrides: Partial<SleepMoodHistoryRow>): SleepMoodHistoryRow {
  return {
    date: "2026-08-28",
    sleepHours: 7,
    valence: null,
    moodDetails: null,
    stages: null,
    bedtimeSupplements: null,
    sleepEditable: false,
    sleepEditHours: null,
    sleepSampleId: null,
    moodLogId: null,
    sleepSuspect: false,
    sleepSettledMinutes: null,
    sleepClaimedWindow: null,
    ...overrides,
  };
}

const HEDGED = night({
  sleepSampleId: 41,
  sleepSuspect: true,
  // 23:30 → 06:30, seven hours.
  sleepSettledMinutes: 180,
  sleepClaimedWindow: {
    startMinutes: 23 * 60 + 30,
    endMinutes: 6 * 60 + 30,
    elapsedMin: 420,
  },
});

function section(history: SleepMoodHistoryRow[]) {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <SleepMoodSection
          points={[]}
          history={history}
          naps={[]}
          windowDays={30}
          formatPrefs={DEFAULT_FORMAT_PREFS}
          tz="UTC"
        />
      </ConfirmProvider>
    </ToastProvider>
  );
}

function openRowMenu() {
  fireEvent.click(screen.getAllByTestId("overflow-menu-trigger")[0]);
}

beforeEach(() => {
  // The log table sits in a ScrollFade, which measures itself on mount.
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(cleanup);

describe("the Fix times door", () => {
  it("is offered on a hedged night, beside the delete it replaces", () => {
    render(section([HEDGED]));
    openRowMenu();

    expect(screen.getByTestId("sleep-history-retime").textContent).toBe(
      "Fix times"
    );
    // The delete stays: this is a second door, not a replacement.
    expect(screen.queryByTestId("sleep-history-delete-sleep")).not.toBeNull();
  });

  it("is withheld from a night the detector has not contradicted", () => {
    // A synced night with a session behind it, and no hedge. The #133 edit lock is the
    // default and #5021's out-of-scope line keeps it: only a contradicted night opens.
    render(
      section([
        night({
          sleepSampleId: 41,
          sleepClaimedWindow: {
            startMinutes: 23 * 60 + 30,
            endMinutes: 6 * 60 + 30,
            elapsedMin: 420,
          },
        }),
      ])
    );
    openRowMenu();

    expect(screen.queryByTestId("sleep-history-retime")).toBeNull();
  });
});

describe("the Fix times dialog", () => {
  function open() {
    render(
      <ToastProvider>
        <SleepRetimeDialog
          row={HEDGED}
          dateLabel="August 28, 2026"
          tz="UTC"
          onClose={vi.fn()}
        />
      </ToastProvider>
    );
  }

  it("opens claiming nothing, and states what it is about to move", () => {
    open();

    // THE RULING (2026-09-04 10:38 UTC): both fields empty. A prefilled bed time would
    // turn the settled instant into a claim about when the person went to bed.
    const bed = screen.getByLabelText("Bed time") as HTMLInputElement;
    const wake = screen.getByLabelText("Wake time") as HTMLInputElement;
    expect(bed.value).toBe("");
    expect(wake.value).toBe("");
    // Nothing to save until they say something.
    expect(
      (screen.getByTestId("sleep-retime-save") as HTMLButtonElement).disabled
    ).toBe(true);

    // The stored window and its length, so the times about to move are on screen.
    expect(screen.getByTestId("sleep-retime-stored").textContent).toBe(
      "Stored as 23:30 → 06:30, 7h."
    );
    // And the measurement, worded as one: information, never a bedtime.
    expect(screen.getByTestId("sleep-retime-settled").textContent).toBe(
      "Your heart rate settled around 03:00."
    );
  });

  it("offers the stored length as the other clock, so the move is reachable", () => {
    open();

    fireEvent.change(screen.getByLabelText("Bed time"), {
      target: { value: "23:30" },
    });
    // A move may not change the session's LENGTH — a different length has no single
    // delta — so the wake clock is offered at exactly the stored 7h rather than left
    // to arithmetic. Taking the offer fills it.
    const shortcut = screen.getByTestId("end-time-shortcut");
    expect(shortcut.textContent).toBe("+420m");
    fireEvent.click(shortcut);
    expect((screen.getByLabelText("Wake time") as HTMLInputElement).value).toBe(
      "06:30"
    );
  });

  it("keeps a refusal in the dialog, where the clocks are", async () => {
    vi.mocked(retimeSleepSession).mockResolvedValue({
      undoId: null,
      error: "Keep the same length — this session is 7h.",
    });
    open();

    fireEvent.change(screen.getByLabelText("Bed time"), {
      target: { value: "01:00" },
    });
    fireEvent.change(screen.getByLabelText("Wake time"), {
      target: { value: "06:00" },
    });
    const save = screen.getByTestId("sleep-retime-save") as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    expect((await screen.findByTestId("sleep-retime-error")).textContent).toBe(
      "Keep the same length — this session is 7h."
    );
    // Still open, still holding what was typed — a refusal a person can answer is
    // worth nothing behind a dialog that closed.
    expect((screen.getByLabelText("Bed time") as HTMLInputElement).value).toBe(
      "01:00"
    );
  });
});
