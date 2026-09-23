// THE DAY LEDGER'S DUE ROWS (#5097 items 1-2).
//
// 1. A due row's expanded members reserve the same gutter as every other row in the
//    bucket, so one bucket's icons share one x.
// 2. Only the next due row — the first one still drawing — carries the accent; a later
//    bucket's due row reads as ground.
//
// Every value is synthetic.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDayLedger, type LedgerDose } from "@/lib/day-ledger";
import type { PendingDayDose } from "@/lib/queries/usual-routine";
import type { TimeBucket } from "@/lib/intake-schedule";

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

function owed(doseId: number, bucket: TimeBucket): PendingDayDose {
  return {
    bucket,
    timeOfDay: null,
    doseId,
    itemId: doseId,
    name: `Item ${doseId}`,
    detail: null,
    stack: null,
    amountAssumed: false,
  };
}

const taken: LedgerDose = {
  kind: "dose",
  id: "dose:1",
  logId: 1,
  doseId: 1,
  itemId: 1,
  name: "Item 1",
  detail: "1 capsule",
  stack: null,
  status: "taken",
  skipReason: null,
  bucket: "Morning",
  hhmm: "07:30",
  clockKind: "stated",
  filedDay: null,
  bundleId: null,
};

function renderLedger(pending: PendingDayDose[]) {
  render(
    <DayLedger
      date={DAY}
      profileToday={DAY}
      groups={buildDayLedger({ servings: [], doses: [taken], pending })}
      doseWritable
      prefs={{ timeFormat: "12h", dateFormat: "iso" }}
      keepApart={[]}
      dayContext={null}
      moveDays={[]}
      onCorrectServing={vi.fn()}
      onRemoveServing={vi.fn()}
      removingServingId={null}
    />
  );
}

describe("the ledger's due rows", () => {
  it("indents a due member exactly as far as a logged row", () => {
    renderLedger([owed(2, "Morning")]);
    fireEvent.click(screen.getByTestId("ledger-due-group-Morning"));
    // The logged row after the labelled due row carries the blank gutter; the member
    // must lead with the same element, not start at the frame's edge.
    const logged = screen.getByTestId("ledger-dose-1").firstElementChild;
    const member = screen.getByTestId("ledger-due-dose-2").firstElementChild;
    expect(logged?.getAttribute("aria-hidden")).toBe("true");
    expect(member?.outerHTML).toBe(logged?.outerHTML);
  });

  it("accents only the next bucket's due row", () => {
    renderLedger([owed(2, "Morning"), owed(3, "Midday"), owed(4, "Evening")]);
    const accented = ["Morning", "Midday", "Evening"].filter((bucket) =>
      screen
        .getByTestId(`ledger-due-row-${bucket}`)
        .className.includes("--accent-soft")
    );
    expect(accented).toEqual(["Morning"]);
  });
});
