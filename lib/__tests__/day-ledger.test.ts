import { describe, expect, it } from "vitest";
import {
  buildDayLedger,
  dayCountsLabel,
  stackLabel,
  type LedgerDose,
  type LedgerServing,
  type LedgerStack,
} from "../day-ledger";
import type { PendingDayDose } from "../queries/usual-routine";
import type { TimeBucket } from "../intake-schedule";

// #3987 phase 1: the Day ledger's grouping, composed collapse and ordering, asserted
// over hand-written rows. Every fixture is minimal — what the rule reads and nothing
// else — so a rule change shows up as a failing assertion rather than as a fixture edit.

function serving(
  id: number,
  bucket: TimeBucket,
  hhmm: string,
  clockKind: "stated" | "logged" = "stated"
): LedgerServing {
  return {
    kind: "serving",
    id: `serving:${id}`,
    eventId: id,
    slug: "leafy-greens",
    name: "Leafy greens",
    bucket,
    hhmm,
    clockKind,
  };
}

function dose(
  id: number,
  bucket: TimeBucket,
  hhmm: string,
  over: Partial<LedgerDose> = {}
): LedgerDose {
  return {
    kind: "dose",
    id: `dose:${id}`,
    logId: id,
    doseId: id,
    itemId: id,
    name: `Item ${id}`,
    detail: "1 capsule",
    stack: null,
    status: "taken",
    skipReason: null,
    bucket,
    hhmm,
    clockKind: "logged",
    writeMinute: "2026-08-30T10:07",
    ...over,
  };
}

function pending(
  doseId: number,
  bucket: TimeBucket,
  stack: string | null = null
): PendingDayDose {
  return {
    bucket,
    doseId,
    itemId: doseId,
    name: `Item ${doseId}`,
    detail: "1 capsule",
    stack,
  };
}

describe("buildDayLedger — one group system (#3987)", () => {
  it("interleaves servings and doses in the same bucket group", () => {
    const groups = buildDayLedger({
      servings: [serving(1, "Morning", "07:30"), serving(2, "Evening", "19:00")],
      doses: [dose(10, "Morning", "08:00", { clockKind: "stated" })],
      pending: [],
    });
    expect(groups.map((g) => g.bucket)).toEqual(["Morning", "Evening"]);
    expect(groups[0].rows.map((r) => r.id)).toEqual([
      "serving:1",
      "dose:10",
    ]);
    expect([groups[0].servings, groups[0].doses]).toEqual([1, 1]);
  });

  it("renders no group for a bucket with nothing in it", () => {
    const groups = buildDayLedger({
      servings: [serving(1, "Midday", "12:00")],
      doses: [],
      pending: [],
    });
    expect(groups.map((g) => g.bucket)).toEqual(["Midday"]);
  });

  // The bucket order is the schedule engine's own (TIME_BUCKETS), not the order the
  // rows happened to arrive in: two days with the same contents must read the same.
  it("orders groups by the schedule engine's bucket order", () => {
    const groups = buildDayLedger({
      servings: [],
      doses: [
        dose(1, "Anytime", "23:00"),
        dose(2, "Morning", "08:00"),
        dose(3, "Before sleep", "22:00"),
        dose(4, "Midday", "12:00"),
      ],
      pending: [],
    });
    expect(groups.map((g) => g.bucket)).toEqual([
      "Morning",
      "Midday",
      "Before sleep",
      "Anytime",
    ]);
  });
});

describe("buildDayLedger — untimed rows sink (#3958 clock grammar)", () => {
  // A filing-time row carries a clock too, so ordering on the clock alone would
  // interleave them with stated ones. The statedness is the first sort field.
  it("puts every stated row above every filing-time row", () => {
    const groups = buildDayLedger({
      servings: [
        serving(1, "Morning", "09:00", "logged"),
        serving(2, "Morning", "10:00", "stated"),
        serving(3, "Morning", "06:00", "logged"),
        serving(4, "Morning", "07:00", "stated"),
      ],
      doses: [],
      pending: [],
    });
    expect(groups[0].rows.map((r) => r.id)).toEqual([
      "serving:4",
      "serving:2",
      "serving:3",
      "serving:1",
    ]);
  });

  it("closes the group with the due row, below even the untimed", () => {
    const groups = buildDayLedger({
      servings: [serving(1, "Evening", "23:59", "logged")],
      doses: [],
      pending: [pending(9, "Evening")],
    });
    expect(groups[0].rows.map((r) => r.kind)).toEqual(["serving", "due"]);
  });
});

describe("buildDayLedger — the composed collapse (#2458 read back)", () => {
  const morningStack = (extra: Partial<LedgerDose> = {}) => ({
    stack: "Morning stack",
    writeMinute: "2026-08-30T10:07",
    hhmm: "10:07",
    ...extra,
  });

  it("collapses doses sharing a routine and a minute into one row", () => {
    const groups = buildDayLedger({
      servings: [],
      doses: [
        dose(1, "Morning", "10:07", morningStack()),
        dose(2, "Morning", "10:07", morningStack()),
        dose(3, "Morning", "10:07", morningStack()),
      ],
      pending: [],
    });
    const row = groups[0].rows[0] as LedgerStack;
    expect(row.kind).toBe("stack");
    expect(row.written.map((d) => d.logId)).toEqual([1, 2, 3]);
    expect(stackLabel(row)).toBe("3 doses");
    expect(groups[0].doses).toBe(3);
  });

  // "Collapse groups by the composed write, never by bucket: two doses hours apart in
  // one bucket do not share a timestamp."
  it("does not collapse two doses of one routine written hours apart", () => {
    const groups = buildDayLedger({
      servings: [],
      doses: [
        dose(1, "Morning", "07:07", morningStack({ writeMinute: "2026-08-30T07:07", hhmm: "07:07" })),
        dose(2, "Morning", "07:07", morningStack({ writeMinute: "2026-08-30T07:07", hhmm: "07:07" })),
        dose(3, "Morning", "10:07", morningStack()),
        dose(4, "Morning", "10:07", morningStack()),
      ],
      pending: [],
    });
    const stacks = groups[0].rows.filter(
      (r): r is LedgerStack => r.kind === "stack"
    );
    expect(stacks).toHaveLength(2);
    expect(stacks.map((s) => s.hhmm)).toEqual(["07:07", "10:07"]);
  });

  it("leaves an unstacked dose and a lone stack member as their own rows", () => {
    const groups = buildDayLedger({
      servings: [],
      doses: [
        dose(1, "Morning", "10:07", morningStack()),
        dose(2, "Morning", "08:00"),
      ],
      pending: [],
    });
    expect(groups[0].rows.map((r) => r.kind)).toEqual(["dose", "dose"]);
  });

  // A skip is its own statement, carrying its own reason, so it never joins the
  // collapse — EVEN when it shares the routine, the bucket and the write minute with
  // taken doses, which is the only arrangement where the rule can be observed at all.
  it("keeps a skip out of the collapse it otherwise shares a tap with", () => {
    const groups = buildDayLedger({
      servings: [],
      doses: [
        dose(1, "Morning", "10:07", morningStack()),
        dose(2, "Morning", "10:07", morningStack()),
        dose(3, "Morning", "10:07", {
          ...morningStack(),
          status: "skipped",
          skipReason: "felt queasy",
        }),
      ],
      pending: [],
    });
    const kinds = groups[0].rows.map((r) => r.kind);
    expect(kinds.filter((k) => k === "stack")).toHaveLength(1);
    const skip = groups[0].rows.find(
      (r) => r.kind === "dose" && r.status === "skipped"
    );
    expect(skip?.kind === "dose" && skip.skipReason).toBe("felt queasy");
    expect(groups[0].doses).toBe(3);
  });

  // "A partially resolved stack states it ('4 of 6') — a single check on a partial
  // stack is a lie." The open members ride the stack row, so the day is stated once.
  it("states a partial stack and owns its open members", () => {
    const groups = buildDayLedger({
      servings: [],
      doses: [
        dose(1, "Morning", "10:07", morningStack()),
        dose(2, "Morning", "10:07", morningStack()),
        dose(3, "Morning", "10:07", morningStack()),
        dose(4, "Morning", "10:07", morningStack()),
      ],
      pending: [
        pending(90, "Morning", "Morning stack"),
        pending(91, "Morning", "Morning stack"),
      ],
    });
    const row = groups[0].rows[0] as LedgerStack;
    expect(stackLabel(row)).toBe("4 of 6");
    expect(row.open.map((d) => d.doseId)).toEqual([90, 91]);
    // Not ALSO in a due row: one dose, one row.
    expect(groups[0].rows.map((r) => r.kind)).toEqual(["stack"]);
  });

  it("leaves a due dose of another routine in the bucket's due row", () => {
    const groups = buildDayLedger({
      servings: [],
      doses: [
        dose(1, "Morning", "10:07", morningStack()),
        dose(2, "Morning", "10:07", morningStack()),
      ],
      pending: [pending(90, "Morning", "Travel kit"), pending(91, "Morning")],
    });
    const due = groups[0].rows.find((r) => r.kind === "due");
    expect(due?.kind === "due" && due.doses.map((d) => d.doseId)).toEqual([
      90, 91,
    ]);
  });
});

describe("labels", () => {
  it.each([
    [1, 0, "1 serving"],
    [4, 6, "4 servings · 6 doses"],
    [0, 1, "1 dose"],
    [0, 0, ""],
  ])("dayCountsLabel(%i, %i)", (servings, doses, expected) => {
    expect(dayCountsLabel(servings, doses)).toBe(expected);
  });
});
