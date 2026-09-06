import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QuickPracticeList from "@/components/quick-entry/QuickPracticeList";
import type { TrackedPractice } from "@/lib/queries/wellness";

// ── THE SHEET'S PRACTICE ROW, AND THE STATE IT USED TO LIE ABOUT (#5431) ─────
//
// The named defect: `Start now` set a session the CONTROL kept a copy of, and nothing
// else moved — so the row printed "No sessions yet" beside a brand-filled "End
// session"; and once a practice with a usual duration completed itself server-side
// (#5091) that End outlived the session and answered "that session is no longer
// running" when tapped.
//
// Driven at the COMPONENT tier, because that is the cheapest one that can see both
// halves: the contradiction is between two strings in one row, and the second half is a
// TIMER firing against a re-read. jsdom gives fake timers and a stubbed read; a browser
// would have to spend a real fifteen minutes or seed a doctored clock to see the same
// thing. What no tier below this could see is that the row's two columns agree, since
// the facts and the control are rendered by different components.

const { loadQuickEntry, startPracticeLive, endPracticeLive } = vi.hoisted(
  () => ({
    loadQuickEntry: vi.fn(),
    startPracticeLive: vi.fn(),
    endPracticeLive: vi.fn(),
  })
);

vi.mock("@/app/(app)/quick-entry-actions", () => ({ loadQuickEntry }));
vi.mock("@/app/(app)/wellness/actions", () => ({
  logPractice: vi.fn(),
  startPracticeLive,
  endPracticeLive,
}));
vi.mock("@/components/Toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({ enqueue: vi.fn() }),
}));
vi.mock("@/components/TimezoneProvider", () => ({ useTimezone: () => "UTC" }));
vi.mock("@/components/LoggedViaSurface", () => ({
  useLoggedViaStamp: () => (formData: FormData) => formData,
}));
vi.mock("@/components/useOptimisticLedger", () => ({
  useOptimisticLedger: (affordance: string) => ({
    affordance,
    pending: () => false,
    blocked: () => false,
    tap: async ({
      write,
      settle,
    }: {
      write: () => Promise<unknown>;
      settle: (outcome: unknown) => unknown;
    }) => settle(await write()),
  }),
}));

const TODAY = "2026-09-06";
const RED_LIGHT: TrackedPractice = {
  targetId: 1,
  identity: "red light therapy",
  name: "Red light therapy",
  perWeek: 3,
  perWeekMax: 5,
  countThisWeek: 0,
  atCeiling: false,
  pace: "quiet",
  todayCount: 0,
  previousDurationMin: 15,
  liveSession: null,
};

const facts = () => screen.getByTestId("practice-row-facts").textContent;
const list = (practices: TrackedPractice[]) => (
  <QuickPracticeList practices={practices} today={TODAY} />
);

beforeEach(() => {
  loadQuickEntry.mockReset();
  startPracticeLive.mockReset();
  endPracticeLive.mockReset();
});
afterEach(cleanup);

describe("the sheet's practice row states one thing at a time", () => {
  // The three ruled states, read off the row as it renders them. `atCeiling` rides the
  // finished case because the week fact is the only place left that can carry it since
  // the boxed weekly line was deleted.
  it.each([
    {
      state: "idle",
      row: RED_LIGHT,
      expected: "0 of 3–5 this week",
      running: false,
    },
    {
      state: "finished today",
      row: { ...RED_LIGHT, todayCount: 1, countThisWeek: 1 },
      expected: "1 today · 1 of 3–5 this week",
      running: false,
    },
    {
      state: "at the weekly ceiling",
      row: {
        ...RED_LIGHT,
        todayCount: 1,
        countThisWeek: 5,
        atCeiling: true,
      },
      expected: "1 today · 5 of 3–5 this week · Weekly maximum reached",
      running: false,
    },
    {
      state: "running with a derived end",
      row: {
        ...RED_LIGHT,
        liveSession: {
          id: 9,
          date: TODAY,
          startTime: "06:22",
          expectedEnd: { at: Date.now() + 900_000, hhmm: "06:37" },
        },
      },
      expected: "Running since 06:22 · ends ~06:37",
      running: true,
    },
    {
      state: "running with no derived end",
      row: {
        ...RED_LIGHT,
        previousDurationMin: null,
        liveSession: {
          id: 9,
          date: TODAY,
          startTime: "06:22",
          expectedEnd: null,
        },
      },
      expected: "Running since 06:22",
      running: true,
    },
  ])("$state reads $expected", ({ row, expected, running }) => {
    render(list([row]));
    expect(facts()).toBe(expected);
    // THE TWO COLUMNS AGREE, which is the defect stated as a property: a row that
    // says a session is running offers only the exit, and a row that does not offers
    // only the two ways in.
    expect(screen.queryByTestId("practice-end-button") != null).toBe(running);
    expect(screen.queryByTestId("practice-start-button") != null).toBe(!running);
    expect(screen.queryByTestId("practice-log-button") != null).toBe(!running);
    // The deleted chrome, asserted absent on the surface it was deleted from.
    expect(screen.queryByText("No sessions yet")).toBeNull();
    expect(screen.queryByText("Today")).toBeNull();
  });

  it("carries the duration on the chip label and opens the editor from it", async () => {
    render(list([RED_LIGHT]));
    const label = screen.getByTestId("practice-duration-toggle");
    expect(label.textContent).toBe("15 min");
    expect(label.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("practice-inline-duration")).toBeNull();

    fireEvent.click(label);
    expect(label.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("practice-inline-duration")).toBeTruthy();
    fireEvent.click(screen.getByTestId("practice-duration-up"));
    expect(screen.getByTestId("practice-duration-toggle").textContent).toBe(
      "20 min"
    );
  });

  // A practice with no history has no duration to show, and the app does not invent
  // one (#2204 constraint 3). The label still names its unit, so the editor stays
  // reachable — the value it opens holding is blank and a tap posts none.
  it("shows the bare unit and posts no duration when there is no usual", () => {
    render(list([{ ...RED_LIGHT, previousDurationMin: null }]));
    expect(screen.getByTestId("practice-duration-toggle").textContent).toBe(
      "min"
    );
  });
});

describe("the row follows the server's session rather than a copy of it", () => {
  // THE NAMED DEFECT, END TO END. A practice with a fifteen-minute usual completes
  // itself server-side at start plus that duration; the sheet, gathered once on open,
  // went on offering End. The row times to the end the row itself stamped, asks for
  // the gather again, and re-renders from the answer — no tap, no reopen.
  it("re-reads when the derived end passes and the row comes back finished", async () => {
    vi.useFakeTimers();
    try {
      const endsAt = Date.now() + 900_000;
      const running: TrackedPractice = {
        ...RED_LIGHT,
        liveSession: {
          id: 9,
          date: TODAY,
          startTime: "06:22",
          expectedEnd: { at: endsAt, hhmm: "06:37" },
        },
      };
      const finished: TrackedPractice = {
        ...RED_LIGHT,
        todayCount: 1,
        countThisWeek: 1,
        liveSession: null,
      };
      loadQuickEntry.mockResolvedValue({
        form: "practice",
        practices: [finished],
        today: TODAY,
      });

      render(list([running]));
      expect(facts()).toBe("Running since 06:22 · ends ~06:37");
      expect(loadQuickEntry).not.toHaveBeenCalled();

      // One minute short of the end nothing has been asked — the re-read is keyed on
      // the row's own end, not on a poll.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(840_000);
      });
      expect(loadQuickEntry).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(61_000);
      });
      expect(loadQuickEntry).toHaveBeenCalledWith("practice", undefined);
      expect(facts()).toBe("1 today · 1 of 3–5 this week");
      expect(screen.queryByTestId("practice-end-button")).toBeNull();
      expect(screen.getByTestId("practice-start-button")).toBeTruthy();
      expect(screen.getByTestId("practice-log-button")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks for the row again as soon as a session starts", async () => {
    startPracticeLive.mockResolvedValue({
      kind: "started",
      session: {
        id: 9,
        date: TODAY,
        startTime: "06:22",
        expectedEnd: { at: Date.now() + 900_000, hhmm: "06:37" },
      },
      count: 1,
      date: TODAY,
    });
    loadQuickEntry.mockResolvedValue({
      form: "practice",
      practices: [
        {
          ...RED_LIGHT,
          liveSession: {
            id: 9,
            date: TODAY,
            startTime: "06:22",
            expectedEnd: { at: Date.now() + 900_000, hhmm: "06:37" },
          },
        },
      ],
      today: TODAY,
    });

    render(list([RED_LIGHT]));
    fireEvent.click(screen.getByTestId("practice-start-button"));

    await waitFor(() =>
      expect(loadQuickEntry).toHaveBeenCalledWith("practice", undefined)
    );
    await waitFor(() =>
      expect(facts()).toBe("Running since 06:22 · ends ~06:37")
    );
    // Never the pair the screenshot caught: the row cannot say a session is running
    // and count no sessions in the same breath, because one read produces both.
    expect(screen.queryByTestId("practice-today-count")).toBeNull();
  });
});
