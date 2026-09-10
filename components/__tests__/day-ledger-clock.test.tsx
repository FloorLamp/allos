// THE DAY LEDGER'S CLOCK CELL (#5618 rule 6, owner ruling 2026-09-10 22:36Z:
// "ruling 6 belongs to the clock grammar, both surfaces").
//
// #5789 landed the rule on the record and made `historyClock`'s filing argument
// OPTIONAL, leaving the ledger byte-identical — one formatter with two behaviours
// depending on whether its caller passed the argument. The owner resolved that the rule
// is the grammar's, so the ledger passes it too, and an untimed row filed on another day
// reads "logged Sep 8" here as well.
//
// EVERY CASE READS THE RENDERED CELL, never the formatter's return value. The formatter
// is already pinned by its own unit cases; what is unpinned — and what the ledger got
// wrong until now — is whether the ROW hands it the day it sits under. A test that
// called `historyClock` directly would pass against a `DayLedger` that still passes
// nothing, which is exactly the defect.
//
// Both directions are covered, because only one of them is a change: a row filed on its
// own day must still print its minute, and a row filed elsewhere must print a date and
// no minute at all. The second assertion is written as "matches no clock pattern"
// rather than as a string, so a cell that kept the minute *and* added the date fails.
//
// Every value is synthetic.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LedgerGroup, LedgerServing, LedgerDose } from "@/lib/day-ledger";

// THE PROVIDERS THE LEDGER'S ROW CONTROLS REACH FOR, and nothing else. The clock cell
// depends on none of them; they are here so the component can mount at all. The
// formatter is deliberately NOT stubbed — it is half of what is under test.
vi.mock("@/components/Toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/LoggedViaSurface", () => ({
  useLoggedViaStamp: () => (formData: FormData) => formData,
}));
vi.mock("@/components/TimezoneProvider", () => ({ useTimezone: () => "UTC" }));
vi.mock("@/components/ConfirmDialog", () => ({
  useConfirm: () => vi.fn(async () => false),
  useConfirmOpen: () => false,
}));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({ enqueue: vi.fn() }),
  useQueuedDayContextCapture: () => () => ({
    dayContext: null,
    capturedAt: new Date(),
    writeToken: Promise.resolve(0),
  }),
}));
vi.mock("@/components/useOptimisticLedger", () => ({
  useOptimisticLedger: () => ({
    pending: () => false,
    blocked: () => false,
    tap: vi.fn(),
  }),
}));

const { default: DayLedger } = await import("@/app/(app)/nutrition/DayLedger");

afterEach(cleanup);

const DAY = "2026-09-10";
const FILED_ELSEWHERE = "2026-09-08";

/** A serving nobody timed: its clock is the filing's, which is rule 6's whole subject. */
function serving(id: number, filedDay: string | null): LedgerServing {
  return {
    kind: "serving",
    id: `serving:${id}`,
    eventId: id,
    slug: "berries",
    name: "Berries",
    bucket: "Morning",
    hhmm: "07:41",
    clockKind: "logged",
    filedDay,
  };
}

/** The dose half of the same question — the ledger states both on one list. */
function dose(id: number, filedDay: string | null): LedgerDose {
  return {
    kind: "dose",
    id: `dose:${id}`,
    logId: id,
    doseId: id,
    itemId: id,
    name: "Magnesium",
    detail: "400 mg",
    stack: null,
    status: "taken",
    skipReason: null,
    bucket: "Morning",
    hhmm: "07:41",
    clockKind: "logged",
    filedDay,
    // One ordinary tap composed nothing, so it carries no bundle and never collapses
    // into a stack — this case is about one row's cell.
    bundleId: null,
  };
}

function groups(rows: (LedgerServing | LedgerDose)[]): LedgerGroup[] {
  return [
    {
      bucket: "Morning",
      servings: rows.filter((r) => r.kind === "serving").length,
      doses: rows.filter((r) => r.kind === "dose").length,
      rows,
    },
  ];
}

/**
 * The ledger on `DAY`, in 12-hour so a surviving minute reads "7:41am" — a shape no
 * date could be mistaken for, in either direction.
 */
function renderLedger(
  rows: (LedgerServing | LedgerDose)[],
  dateFormat: "iso" | "mdy" | "dmy" = "iso"
) {
  render(
    <DayLedger
      date={DAY}
      profileToday={DAY}
      groups={groups(rows)}
      doseWritable
      prefs={{ timeFormat: "12h", dateFormat }}
      keepApart={[]}
      dayContext={null}
      moveDays={[]}
      onCorrectServing={vi.fn()}
      onRemoveServing={vi.fn()}
      removingServingId={null}
    />
  );
}

/** What the row's cell actually says — the rendered text, not a computed string. */
function cellText(testId: string): string {
  return screen.getByTestId(testId).textContent ?? "";
}

/** Any clock this page could print, in either time format. */
const A_CLOCK = /\d{1,2}:\d{2}\s*(am|pm)?/i;

describe("a ledger row filed on the day it sits on keeps its minute", () => {
  it("renders 'logged 7:41am' on a serving", () => {
    renderLedger([serving(11, DAY)]);
    expect(cellText("ledger-serving-11")).toContain("logged 7:41am");
  });

  it("renders 'logged 7:41am' on a dose", () => {
    renderLedger([dose(21, DAY)]);
    expect(cellText("ledger-dose-21")).toContain("logged 7:41am");
  });

  // THE CASE THE OPTIONAL ARGUMENT USED TO PRODUCE, kept as a distinct answer: a row
  // nothing filed at a knowable instant has no filing day to compare, and must not be
  // swept into the date branch by a falsy check that treats "unknown" as "elsewhere".
  it("keeps the minute when nothing filed the row at a knowable instant", () => {
    renderLedger([serving(12, null)]);
    expect(cellText("ledger-serving-12")).toContain("logged 7:41am");
  });
});

describe("a ledger row filed on another day says which day, not a clock", () => {
  it("renders the filing DATE on a serving, and no minute", () => {
    renderLedger([serving(13, FILED_ELSEWHERE)]);
    const text = cellText("ledger-serving-13");
    expect(text).toContain(`logged ${FILED_ELSEWHERE}`);
    // NO MINUTE SURVIVES. Asserted as an absence rather than as an exact string: a cell
    // that printed "logged 2026-09-08 7:41am" would satisfy the line above.
    expect(text).not.toMatch(A_CLOCK);
  });

  it("renders the filing DATE on a dose, and no minute", () => {
    const text =
      (renderLedger([dose(23, FILED_ELSEWHERE)]), cellText("ledger-dose-23"));
    expect(text).toContain(`logged ${FILED_ELSEWHERE}`);
    expect(text).not.toMatch(A_CLOCK);
  });

  // THE RULING'S OWN WORDS, in the format it quoted them in: "an untimed row filed on
  // another day reads 'logged Sep 8'". The date goes through the shared vocabulary
  // (#1448), so the shape follows the PROFILE's date format rather than being spelled
  // here — which is why the same row reads "logged 2026-09-08" above. Both are pinned,
  // so a change to either is a decision somebody makes on purpose.
  it("spells the ruling's own 'logged Sep 8' on a month-day profile", () => {
    renderLedger([serving(16, FILED_ELSEWHERE)], "mdy");
    const text = cellText("ledger-serving-16");
    expect(text).toContain("logged Sep 8");
    expect(text).not.toMatch(A_CLOCK);
  });

  it("spells it '8 Sep' on a day-month profile", () => {
    renderLedger([serving(17, FILED_ELSEWHERE)], "dmy");
    expect(cellText("ledger-serving-17")).toContain("logged 8 Sep");
  });

  // THE REAL BACKFILL DIRECTION — the row sits BEHIND the day it was filed from, which
  // is what a person doing yesterday's log this morning produces. The rule is about two
  // days differing, not about which came first.
  it("renders the filing date when the filing came AFTER the row's day", () => {
    renderLedger([serving(14, "2026-09-12")]);
    const text = cellText("ledger-serving-14");
    expect(text).toContain("logged 2026-09-12");
    expect(text).not.toMatch(A_CLOCK);
  });
});

describe("a stated time is never a filing time", () => {
  // The ledger's other clockKind, asserted so the date branch cannot leak into it: a
  // stated eating time renders BARE, with no "logged" and no date, however far from the
  // row's day the tap happened to be.
  it("renders a stated clock bare even with a filing day present", () => {
    renderLedger([{ ...serving(15, FILED_ELSEWHERE), clockKind: "stated" }]);
    const text = cellText("ledger-serving-15");
    expect(text).toContain("7:41am");
    expect(text).not.toContain("logged");
    expect(text).not.toContain(FILED_ELSEWHERE);
  });
});
