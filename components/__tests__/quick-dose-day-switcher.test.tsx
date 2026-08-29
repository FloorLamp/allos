import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import QuickDoseList from "@/components/quick-entry/QuickDoseList";

// #3936. The switcher's job is to say what the accepted window IS, so the guards below
// are about the SHAPE of the offer — three days, today first, every past day listed
// even when it is already settled — and about the bulk row's promise naming exactly
// the doses it will write. The days themselves are resolved server-side from
// DOSE_LOG_DATE_WINDOW_DAYS and pinned there (lib/__action_tests__/past-dose-day).

vi.mock("@/components/LoggedViaSurface", () => ({
  useLoggedViaStamp: () => (formData: FormData) => formData,
}));
vi.mock("@/components/Toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({ enqueue: vi.fn() }),
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
vi.mock("@/app/(app)/upcoming/actions", () => ({ markTaken: vi.fn() }));
vi.mock("@/app/(app)/nutrition/intake-actions", () => ({
  resolveDayDoses: vi.fn(),
}));

import { resolveDayDoses } from "@/app/(app)/nutrition/intake-actions";
const resolveDayDosesMock = vi.mocked(resolveDayDoses);

const TODAY = "2026-08-28";

function dose(doseId: number, name: string, stack: string | null = null) {
  return { doseId, name, detail: "1 scoop", stack };
}

const PAST_DAYS = [
  {
    date: "2026-08-27",
    label: "Yesterday",
    slots: [
      {
        bucket: "Morning" as const,
        doses: [
          dose(11, "Creatine", "Morning stack"),
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
        { doseId: 1, title: "Vitamin D", detail: null, dueText: "8:00am" },
      ]}
      pastDays={PAST_DAYS}
      onDone={vi.fn()}
    />
  );
}

describe("the quick-log dose sheet's day switcher (#3936)", () => {
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
    resolveDayDosesMock.mockImplementation(async (fd: FormData) => {
      const ids = String(fd.get("dose_ids"))
        .split(",")
        .map(Number)
        .filter(Boolean);
      return {
        ok: true as const,
        date: "2026-08-27",
        doses: ids.map((doseId) => ({
          doseId,
          name: `dose ${doseId}`,
          outcome: "logged" as const,
        })),
      };
    });

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
