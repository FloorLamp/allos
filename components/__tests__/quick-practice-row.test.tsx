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
import { DayContextProvider } from "@/components/DayContext";
import { SHEET_REACH } from "@/lib/log-manifest";
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

const {
  loadQuickEntry,
  logPractice,
  startPracticeLive,
  endPracticeLive,
  clearLastGood,
} = vi.hoisted(() => ({
  loadQuickEntry: vi.fn(),
  logPractice: vi.fn(),
  startPracticeLive: vi.fn(),
  endPracticeLive: vi.fn(),
  clearLastGood: vi.fn(),
}));

vi.mock("@/app/(app)/quick-entry-actions", () => ({ loadQuickEntry }));
vi.mock("@/app/(app)/wellness/actions", () => ({
  logPractice,
  startPracticeLive,
  endPracticeLive,
}));
vi.mock("@/lib/offline/quick-entry-read", () => ({ clearLastGood }));
vi.mock("@/components/Toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({ enqueue: vi.fn() }),
  useQueuedDayContextCapture:
    () =>
    (date: string, reach: unknown, capturedAt = new Date()) => ({
      dayContext: {
        parts: { profileId: 1, day: date, reach },
        key: "test-context",
        isPrimaryDay: date === "2026-09-06",
      },
      capturedAt,
      writeToken: Promise.resolve(0),
    }),
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
  logPractice.mockReset();
  startPracticeLive.mockReset();
  endPracticeLive.mockReset();
  clearLastGood.mockReset();
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
    expect(screen.queryByTestId("practice-start-button") != null).toBe(
      !running
    );
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

  it("labels a cached prior-day count from the live profile day", () => {
    render(
      <DayContextProvider
        profileId={1}
        today="2026-09-07"
        reach={SHEET_REACH}
        backing={{ kind: "state", initialDay: TODAY }}
      >
        <QuickPracticeList
          practices={[{ ...RED_LIGHT, todayCount: 1, countThisWeek: 1 }]}
          today={TODAY}
        />
      </DayContextProvider>
    );

    expect(facts()).toBe("1 yesterday · 1 of 3–5 this week");
    expect(
      screen.getByRole("button", {
        name: "Just finished another Red light therapy session — 1 already logged yesterday",
      })
    ).toBeTruthy();
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
        kind: "ready",
        data: {
          form: "practice",
          practices: [finished],
          today: TODAY,
        },
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
      expect(loadQuickEntry).toHaveBeenCalledWith(
        "practice",
        undefined,
        TODAY,
        "sheet"
      );
      expect(facts()).toBe("1 today · 1 of 3–5 this week");
      expect(screen.queryByTestId("practice-end-button")).toBeNull();
      expect(
        screen.getByRole("button", {
          name: "Start a Red light therapy session, 15 min",
        })
      ).toBeTruthy();
      expect(
        screen.getByRole("button", {
          name: "Just finished another Red light therapy session — 1 already logged today",
        })
      ).toBeTruthy();
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
      kind: "ready",
      data: {
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
      },
    });

    render(list([RED_LIGHT]));
    fireEvent.click(screen.getByTestId("practice-start-button"));

    await waitFor(() =>
      expect(loadQuickEntry).toHaveBeenCalledWith(
        "practice",
        undefined,
        TODAY,
        "sheet"
      )
    );
    await waitFor(() =>
      expect(facts()).toBe("Running since 06:22 · ends ~06:37")
    );
    // Never the pair the screenshot caught: the row cannot say a session is running
    // and count no sessions in the same breath, because one read produces both.
    expect(screen.queryByTestId("practice-today-count")).toBeNull();
  });

  it("invalidates the host copy on an authorization refusal", async () => {
    startPracticeLive.mockResolvedValue({
      kind: "started",
      session: {
        id: 9,
        date: TODAY,
        startTime: "06:22",
        expectedEnd: null,
      },
      count: 1,
      date: TODAY,
    });
    loadQuickEntry.mockResolvedValue({ kind: "refused", reason: "subject" });

    render(list([RED_LIGHT]));
    fireEvent.click(screen.getByTestId("practice-start-button"));

    await waitFor(() => expect(clearLastGood).toHaveBeenCalledOnce());
    expect(screen.getByTestId("quick-entry-practice-empty")).toBeTruthy();
  });

  it("keeps the current rows when a re-read loses transport", async () => {
    startPracticeLive.mockResolvedValue({
      kind: "started",
      session: {
        id: 9,
        date: TODAY,
        startTime: "06:22",
        expectedEnd: null,
      },
      count: 1,
      date: TODAY,
    });
    loadQuickEntry.mockRejectedValue(new Error("offline"));

    render(list([RED_LIGHT]));
    fireEvent.click(screen.getByTestId("practice-start-button"));

    await waitFor(() => expect(loadQuickEntry).toHaveBeenCalledOnce());
    expect(clearLastGood).not.toHaveBeenCalled();
    expect(screen.getByText("Red light therapy")).toBeTruthy();
  });
});

describe("a newer prefill does not take back minutes the person set", () => {
  const sauna: TrackedPractice = {
    ...RED_LIGHT,
    identity: "sauna",
    name: "Sauna",
    previousDurationMin: null,
  };
  const answered = { ...sauna, previousDurationMin: 15 };

  const setDuration = (minutes: string) => {
    fireEvent.click(screen.getByTestId("practice-duration-toggle"));
    fireEvent.change(screen.getByTestId("practice-duration-input"), {
      target: { value: minutes },
    });
  };
  const logged = async () => {
    logPractice.mockResolvedValue({ kind: "logged", date: TODAY, count: 1 });
    loadQuickEntry.mockResolvedValue({
      kind: "ready",
      data: { form: "practice", practices: [], today: TODAY },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("practice-log-button"));
    });
    const fd = logPractice.mock.calls[0]?.[0] as FormData;
    return fd?.get("duration_min");
  };

  it("keeps and posts the entered duration when the late answer brings a usual one", async () => {
    const view = render(list([sauna]));
    setDuration("45");
    const button = screen.getByTestId("practice-log-button");

    view.rerender(list([answered]));

    expect(screen.getByTestId("practice-log-button")).toBe(button);
    expect(screen.getByTestId("practice-duration-toggle").textContent).toBe(
      "45 min"
    );
    expect(
      (screen.getByTestId("practice-duration-input") as HTMLInputElement).value
    ).toBe("45");
    expect(await logged()).toBe("45");
  });

  it("still follows the prefill on a field nobody answered", async () => {
    const view = render(list([sauna]));
    expect(screen.getByTestId("practice-duration-toggle").textContent).toBe(
      "min"
    );

    view.rerender(list([answered]));

    expect(screen.getByTestId("practice-duration-toggle").textContent).toBe(
      "15 min"
    );
    expect(await logged()).toBe("15");
  });

  it("keeps a blank the person entered rather than refilling it", () => {
    const view = render(list([{ ...sauna, previousDurationMin: 30 }]));
    setDuration("");

    view.rerender(list([answered]));

    expect(screen.getByTestId("practice-duration-toggle").textContent).toBe(
      "min"
    );
  });
});
