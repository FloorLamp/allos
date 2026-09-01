import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QuickDoseList from "@/components/quick-entry/QuickDoseList";
import { localDate } from "@/lib/offline/queue";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  enqueue: vi.fn(),
  setDoseStatus: vi.fn(),
}));

// #3936. The switcher's job is to say what the accepted window IS, so the guards below
// are about the SHAPE of the offer — three days, today first, every past day listed
// even when it is already settled — and about the bulk row's promise naming exactly
// the doses it will write. The days themselves are resolved server-side from
// DOSE_LOG_DATE_WINDOW_DAYS and pinned there (lib/__action_tests__/past-dose-day).

vi.mock("@/components/LoggedViaSurface", () => ({
  useLoggedViaStamp: () => (formData: FormData) => formData,
}));
vi.mock("@/components/Toast", () => ({ useToast: () => mocks.toast }));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({ enqueue: mocks.enqueue }),
}));
// The ledger stands in for the real one, but its `tap` RUNS the write and settles it —
// a `tap: vi.fn()` stub would make every click a no-op and quietly pass any assertion
// about what a click does.
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
vi.mock("@/app/(app)/nutrition/intake-actions", () => ({
  resolveDayDoses: vi.fn(),
  setDoseStatus: mocks.setDoseStatus,
}));

afterEach(() => vi.restoreAllMocks());

const TODAY = "2026-08-28";

function dose(doseId: number, name: string, stack: string | null = null) {
  return { doseId, name, detail: "1 scoop", stack };
}

// A DAILY dose is the SAME `intake_item_doses` row on every day it is unlogged, so
// dose 11 appears on today AND on yesterday. The earlier fixture gave today `1` and the
// past days `11,12,13` — disjoint ids that real data can never be, which made the
// (day, dose) collision unreachable by construction and let the defect ship green.
const DAILY_DOSE = 11;

const PAST_DAYS = [
  {
    date: "2026-08-27",
    label: "Yesterday",
    slots: [
      {
        bucket: "Morning" as const,
        doses: [
          dose(DAILY_DOSE, "Creatine", "Morning stack"),
          dose(12, "Collagen", "Morning stack"),
        ],
      },
      { bucket: "Before sleep" as const, doses: [dose(13, "Melatonin")] },
    ],
  },
  // Already settled — still LISTED. A day that vanished would read as "there is
  // nothing back there" when the truth is "that day is done".
  { date: "2026-08-26", label: "Wed, Aug 26", slots: [] },
];

function renderSheet() {
  return render(
    <QuickDoseList
      today={TODAY}
      doses={[
        {
          doseId: DAILY_DOSE,
          title: "Creatine",
          detail: null,
          dueText: "8:00am",
        },
      ]}
      pastDays={PAST_DAYS}
      onDone={vi.fn()}
    />
  );
}

// EVERY ROW IN THIS SHEET IS A `DoseStatusControl` (#4424 ruling 3), on today and on
// the switched-to days alike. Before that this file's today row posted `markTaken`
// through a "Mark taken" button and its past rows posted `resolveDayDoses` through an
// icon pair — one list, two write paths, two spellings of the row. The single tap is
// `setDoseStatus` now; the whole-stack row below is still `resolveDayDoses`, which is
// the bulk offer and not a row control.
describe("today's quick dose uses the shared offline contract (#3272)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("queues the tap instant and confirms the offline capture", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    mocks.enqueue.mockResolvedValue("kept");
    const before = Date.now();
    renderSheet();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Mark taken" }));
    });
    const after = Date.now();

    expect(mocks.setDoseStatus).not.toHaveBeenCalled();
    const [kind, date, payload] = mocks.enqueue.mock.calls[0]!;
    expect({ kind, doseId: payload.doseId }).toEqual({
      kind: "dose",
      doseId: DAILY_DOSE,
    });
    expect(Date.parse(payload.clientTakenAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(payload.clientTakenAt)).toBeLessThanOrEqual(after);
    expect(date).toBe(localDate(new Date(payload.clientTakenAt)));
    expect(mocks.toast).toHaveBeenCalledWith(
      "Dose saved offline — will sync when you reconnect."
    );
  });

  it("keeps the typed online refusal and does not queue it", async () => {
    // The action's own answer for a day that already stands SKIPPED, which the
    // resolve-only rule is what produces: the control was showing CLEAR, so the write
    // may resolve and may not overwrite (#280).
    mocks.setDoseStatus.mockResolvedValue({
      ok: false,
      error: "Not logged — this dose is marked skipped",
    });
    renderSheet();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Mark taken" }));
    });

    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      "Not logged — this dose is marked skipped",
      { tone: "error" }
    );
    expect(screen.getByTestId(`quick-entry-dose-${DAILY_DOSE}`)).toBeTruthy();
  });
});

describe("the quick-log dose sheet's day switcher (#3936)", () => {
  it("queues a past-day take without inventing an administration instant", async () => {
    vi.clearAllMocks();
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    mocks.enqueue.mockResolvedValue("kept");
    renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "Yesterday" }));
    const day = screen.getByTestId("quick-entry-dose-day");
    const creatine = within(day)
      .getAllByRole("listitem")
      .find((row) => within(row).queryByText("Creatine"));
    expect(creatine).toBeTruthy();

    await act(async () => {
      fireEvent.click(within(creatine!).getByTestId("dose-take"));
    });

    expect(mocks.setDoseStatus).not.toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledWith("dose", "2026-08-27", {
      doseId: DAILY_DOSE,
    });
  });

  it("offers exactly the days the server sent, today first", () => {
    renderSheet();
    const labels = within(screen.getByTestId("quick-entry-dose-day-toggle"))
      .getAllByRole("button")
      .map((b) => b.textContent);
    // Exact list, not a count and not a lower bound: a fourth day and a missing
    // third both fail here.
    expect(labels).toEqual(["Today", "Yesterday", "Wed, Aug 26"]);
  });

  it("opens on today's due-now list and leaves the past days unrendered", () => {
    renderSheet();
    expect(screen.getByTestId("quick-entry-dose-list")).toBeTruthy();
    expect(screen.queryByTestId("quick-entry-dose-day")).toBeNull();
  });

  it.each([
    {
      day: "Yesterday",
      heading: "Morning stack (2)",
      // Every rider shares one stack, so the promise compresses to the profile's own
      // name for exactly those two (#3098) instead of enumerating them.
      names: "Morning stack (2)",
      rows: ["Creatine", "Collagen", "Melatonin"],
    },
  ])(
    "switching to $day renders that day's unresolved doses with both verbs",
    ({ heading, names, rows }) => {
      renderSheet();
      fireEvent.click(screen.getByRole("button", { name: "Yesterday" }));

      const day = screen.getByTestId("quick-entry-dose-day");
      expect(day.getAttribute("data-date")).toBe("2026-08-27");
      for (const name of rows) {
        expect(within(day).getByText(name)).toBeTruthy();
      }
      // Tri-state: every row offers take AND skip, because on a closed day "I skipped
      // it" is as ordinary an answer as "I took it".
      expect(within(day).getAllByTestId("dose-take")).toHaveLength(rows.length);
      expect(within(day).getAllByTestId("dose-skip")).toHaveLength(rows.length);

      // The bulk row: one per bucket of TWO OR MORE. The single bedtime dose gets no
      // stack row — a one-dose stack would name a group while writing one member.
      const stack = within(day).getByTestId("quick-entry-dose-stack-Morning");
      expect(stack.textContent).toContain(heading);
      expect(
        within(day).getByTestId("quick-entry-dose-stack-names-Morning")
          .textContent
      ).toBe(names);
      // The ids the tap will name are the two the label counted, and no other.
      expect(stack.getAttribute("data-doses")).toBe("11,12");
      expect(
        within(day).queryByTestId("quick-entry-dose-stack-Before sleep")
      ).toBeNull();
    }
  );

  it("says a settled past day is settled rather than hiding it", () => {
    renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "Wed, Aug 26" }));
    expect(screen.getByTestId("quick-entry-dose-day-empty")).toBeTruthy();
  });
});

// #3936 F6. Two rows resolved in quick succession must BOTH stay resolved. The
// past-day view is the first surface here built for clearing several doses in a row,
// and the bulk row hands `markResolved` many ids at once — so a `new Set(resolved)`
// built from a stale closure loses the earlier tap, the row reappears, and tapping it
// again earns an error-toned "Nothing left to log for that day." about a dose that is
// correctly logged.
describe("resolving several doses in quick succession (#3936)", () => {
  it("keeps every resolved row gone, not just the last one", async () => {
    mocks.setDoseStatus.mockResolvedValue({ ok: true, outcome: "logged" });

    renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "Yesterday" }));
    const day = () => screen.getByTestId("quick-entry-dose-day");
    expect(within(day()).getAllByTestId("dose-take")).toHaveLength(3);

    // Both taps fired before React commits either state update — the real two-quick-
    // taps case, and the one a sequential await would hide.
    const takes = within(day()).getAllByTestId("dose-take");
    await act(async () => {
      fireEvent.click(takes[0]!);
      fireEvent.click(takes[1]!);
    });

    // BOTH gone. A stale-closure write leaves the first row on screen.
    expect(screen.queryByTestId("quick-entry-dose-11")).toBeNull();
    expect(screen.queryByTestId("quick-entry-dose-12")).toBeNull();
    expect(screen.getByTestId("quick-entry-dose-13")).toBeTruthy();
  });
});

// #3936 BLOCKING 1. `doseId` is an `intake_item_doses` row id — a SCHEDULE row that
// recurs — so a daily supplement unlogged for three days is one id on three tabs.
// Resolving it on one day must not resolve it on the others.
describe("one schedule row on several days is several occurrences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setDoseStatus.mockResolvedValue({ ok: true, outcome: "logged" });
  });

  it("logging yesterday's dose leaves TODAY's identical dose still due", async () => {
    const onDone = vi.fn();
    render(
      <QuickDoseList
        today={TODAY}
        doses={[
          {
            doseId: DAILY_DOSE,
            title: "Creatine",
            detail: null,
            dueText: "8:00am",
          },
        ]}
        pastDays={PAST_DAYS}
        onDone={onDone}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Yesterday" }));
    const day = screen.getByTestId("quick-entry-dose-day");
    await act(async () => {
      fireEvent.click(within(day).getAllByTestId("dose-take")[0]!);
    });

    // Yesterday's occurrence is gone…
    expect(
      within(screen.getByTestId("quick-entry-dose-day")).queryByTestId(
        `quick-entry-dose-${DAILY_DOSE}`
      )
    ).toBeNull();

    // …and TODAY's is not. The defect rendered "Nothing left to confirm." here and
    // fired onDone(), closing the sheet over an unwritten medication — a false
    // confirmation of exactly the #280 class.
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.queryByTestId("quick-entry-dose-empty")).toBeNull();
    expect(
      within(screen.getByTestId("quick-entry-dose-list")).getByTestId(
        `quick-entry-dose-${DAILY_DOSE}`
      )
    ).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("a refusal earned on one day does not render under another day's row", async () => {
    mocks.setDoseStatus.mockResolvedValue({
      ok: false,
      error: "Not logged — this dose is marked skipped",
    });
    renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "Yesterday" }));
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId("quick-entry-dose-day")).getAllByTestId(
          "dose-take"
        )[0]!
      );
    });
    // The note belongs to yesterday's occurrence…
    expect(
      screen.getByTestId(`quick-entry-dose-note-${DAILY_DOSE}`)
    ).toBeTruthy();
    // …and must not follow the id onto today.
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(
      screen.queryByTestId(`quick-entry-dose-note-${DAILY_DOSE}`)
    ).toBeNull();
  });
});
