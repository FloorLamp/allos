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
      servings: [
        serving(1, "Morning", "07:30"),
        serving(2, "Evening", "19:00"),
      ],
      doses: [dose(10, "Morning", "08:00", { clockKind: "stated" })],
      pending: [],
    });
    expect(groups.map((g) => g.bucket)).toEqual(["Morning", "Evening"]);
    expect(groups[0].rows.map((r) => r.id)).toEqual(["serving:1", "dose:10"]);
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
        dose(
          1,
          "Morning",
          "07:07",
          morningStack({ writeMinute: "2026-08-30T07:07", hhmm: "07:07" })
        ),
        dose(
          2,
          "Morning",
          "07:07",
          morningStack({ writeMinute: "2026-08-30T07:07", hhmm: "07:07" })
        ),
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

  // THE OTHER HALF OF THE KEY, guarded alone (#4323 review). `hhmm` and `clockKind` are
  // two components and the amend case above only moves `hhmm`; without this one, deleting
  // `clockKind` from the key left the whole file green.
  //
  // REACHABLE, not contrived: one composed tap at 08:07 where one member carries a stated
  // `occurred_at` that happens to land on the same minute the tap was filed, and the other
  // carries none and falls back to the filing time. Same routine, same bucket, same write
  // minute, same wall clock — and two DIFFERENT claims about what that clock means. #3958
  // renders one as "08:07" and the other as "logged 8:07am"; a single collapsed row states
  // one grammar for every member, so joining them would put an administration time over a
  // dose nothing timed.
  it("does not collapse a stated dose with a filed one that shares its minute", () => {
    const doses = [
      dose(
        1,
        "Morning",
        "08:07",
        morningStack({
          writeMinute: "2026-08-30T08:07",
          hhmm: "08:07",
          clockKind: "stated",
        })
      ),
      dose(
        2,
        "Morning",
        "08:07",
        morningStack({
          writeMinute: "2026-08-30T08:07",
          hhmm: "08:07",
          clockKind: "logged",
        })
      ),
    ];
    // THE FIXTURE'S OWN REACH, asserted rather than assumed (the brief's rule): these two
    // agree on every key component but one, so this case can only be answered by
    // `clockKind`. If a later edit makes them differ elsewhere too, this fails here rather
    // than silently going green for the wrong reason.
    expect(doses[0].bucket).toBe(doses[1].bucket);
    expect(doses[0].stack).toBe(doses[1].stack);
    expect(doses[0].writeMinute).toBe(doses[1].writeMinute);
    expect(doses[0].hhmm).toBe(doses[1].hhmm);
    expect(doses[0].clockKind).not.toBe(doses[1].clockKind);

    const groups = buildDayLedger({ servings: [], doses, pending: [] });
    const rows = groups[0].rows;
    // Two loose rows, no stack: a "2 doses" row here would claim both were named.
    expect(rows.map((r) => r.kind)).toEqual(["dose", "dose"]);
    expect(
      rows.filter((r): r is LedgerStack => r.kind === "stack")
    ).toHaveLength(0);
    // And the stated one still sorts above the filed one (#3958).
    expect(rows.map((r) => r.kind === "dose" && r.clockKind)).toEqual([
      "stated",
      "logged",
    ]);
  });

  // R1 (adversarial, #4323): the key that keeps WRITTEN doses apart was
  // (bucket, stack, minute) while the key that assigned OPEN doses was (bucket, stack).
  // Two taps of one routine in one bucket therefore made two rows that each claimed the
  // same pending doses: one dose on two rows, its Take control rendered twice, and the
  // labels summing past the routine's size. Reproduced at the DB tier too, from four
  // ordinary `markDoseTaken` calls and nothing else.
  it("never puts one open dose on two stack rows of the same routine", () => {
    const groups = buildDayLedger({
      servings: [],
      doses: [
        dose(
          1,
          "Morning",
          "07:07",
          morningStack({ writeMinute: "2026-08-30T07:07", hhmm: "07:07" })
        ),
        dose(
          2,
          "Morning",
          "07:07",
          morningStack({ writeMinute: "2026-08-30T07:07", hhmm: "07:07" })
        ),
        dose(3, "Morning", "10:07", morningStack()),
        dose(4, "Morning", "10:07", morningStack()),
      ],
      pending: [
        pending(90, "Morning", "Morning stack"),
        pending(91, "Morning", "Morning stack"),
      ],
    });
    const rows = groups[0].rows;
    const stacks = rows.filter((r): r is LedgerStack => r.kind === "stack");
    expect(stacks).toHaveLength(2);
    const seen = new Map<number, number>();
    for (const st of stacks)
      for (const o of st.open)
        seen.set(o.doseId, (seen.get(o.doseId) ?? 0) + 1);
    expect([...seen.values()]).toEqual([]);
    // Neither row can own them, so they state themselves once, on the due row.
    const due = rows.find((r) => r.kind === "due");
    expect(due?.kind === "due" && due.doses.map((d) => d.doseId)).toEqual([
      90, 91,
    ]);
    // And both written rows read honestly as whole taps rather than "2 of 4" twice.
    expect(stacks.map(stackLabel)).toEqual(["2 doses", "2 doses"]);
  });

  // R2 (adversarial, #4323): the collapse key was the WRITE minute and the rendered
  // clock is the ADMINISTRATION instant. `updateHistoricalDose` moves `occurred_at` and
  // deliberately never touches `recorded_at` (#2228/#2876), so a member corrected to
  // three hours earlier kept its tap-mates' write minute and the row went on stating one
  // timestamp for two doses the record says were hours apart — the ruling's exact
  // prohibition, reached from the other side.
  it("drops a member whose stated clock no longer matches its tap-mates", () => {
    const groups = buildDayLedger({
      servings: [],
      doses: [
        // All three STATED, so `clockKind` is held and `hhmm` is the only field that
        // moves. The fixture used to vary both at once, which meant either half of the
        // key could be deleted and this case stayed green — the exact defect class the
        // brief now names: the fixture confirmed a belief instead of testing a rule.
        dose(
          1,
          "Morning",
          "08:07",
          morningStack({
            writeMinute: "2026-08-30T08:07",
            hhmm: "08:07",
            clockKind: "stated",
          })
        ),
        dose(
          2,
          "Morning",
          "08:07",
          morningStack({
            writeMinute: "2026-08-30T08:07",
            hhmm: "08:07",
            clockKind: "stated",
          })
        ),
        // Same tap, amended to 05:15 — still a stated time, just an earlier one.
        dose(
          3,
          "Morning",
          "05:15",
          morningStack({
            writeMinute: "2026-08-30T08:07",
            hhmm: "05:15",
            clockKind: "stated",
          })
        ),
      ],
      pending: [],
    });
    const rows = groups[0].rows;
    const stacks = rows.filter((r): r is LedgerStack => r.kind === "stack");
    expect(stacks).toHaveLength(1);
    expect(stacks[0].hhmm).toBe("08:07");
    expect(stacks[0].written.map((d) => d.logId)).toEqual([1, 2]);
    // The amended dose states its own time, on its own row, above the 08:07 stack.
    const amended = rows.find((r) => r.kind === "dose");
    expect(amended?.kind === "dose" && amended.hhmm).toBe("05:15");
    expect(rows.map((r) => r.kind)).toEqual(["dose", "stack"]);
    // Every member of a stack row shares that row's clock — which is what lets the
    // expanded members render without one.
    for (const st of stacks)
      expect(new Set(st.written.map((d) => d.hhmm)).size).toBe(1);
  });

  // THE COUNT IS TAKEN AFTER THE DISSOLUTION LOOP, and these two cases are why that
  // ordering is a decision rather than an accident. Lifting the `rowsPerRoutine` count
  // above the loop leaves every conservation property intact — each dose still on exactly
  // one row — and leaves the whole of the rest of this file green. What it breaks is
  // subtler: a stack that is ABOUT TO DISSOLVE into a loose row still counts toward its
  // routine's total, so the surviving row sees a count of 2, refuses to claim, and a
  // legitimately claimable open dose is quietly demoted to the due row. "4 of 6" becomes
  // "4 doses" plus a due row, which is a different and worse statement of the same day.
  it("lets the survivor claim when a singleton member dissolves", () => {
    const groups = buildDayLedger({
      servings: [],
      doses: [
        dose(
          1,
          "Morning",
          "07:07",
          morningStack({ writeMinute: "2026-08-30T07:07", hhmm: "07:07" })
        ),
        dose(
          2,
          "Morning",
          "07:07",
          morningStack({ writeMinute: "2026-08-30T07:07", hhmm: "07:07" })
        ),
        // A lone member of the SAME routine, written later: it dissolves to a loose row.
        dose(
          3,
          "Morning",
          "11:11",
          morningStack({ writeMinute: "2026-08-30T11:11", hhmm: "11:11" })
        ),
      ],
      pending: [pending(90, "Morning", "Morning stack")],
    });
    const rows = groups[0].rows;

    // THE FIXTURE'S REACH, asserted before the claim (the brief's rule): this case is only
    // about the ordering if the routine's row count actually CHANGES across dissolution.
    // One surviving stack row plus a loose row of the same routine and bucket is that
    // change made observable — the loose row is the entry that existed in `stacks` before
    // the loop and would still have been counted had the count been taken earlier. If an
    // edit stops producing a dissolving singleton, this fails here rather than going
    // quietly green.
    const stacks = rows.filter((r): r is LedgerStack => r.kind === "stack");
    const dissolved = rows.filter(
      (r) =>
        r.kind === "dose" &&
        r.stack === "Morning stack" &&
        r.bucket === "Morning"
    );
    expect(stacks).toHaveLength(1);
    expect(dissolved).toHaveLength(1);

    // And the claim itself: the survivor owns the open dose.
    expect(stackLabel(stacks[0])).toBe("2 of 3");
    expect(stacks[0].open.map((d) => d.doseId)).toEqual([90]);
    expect(rows.find((r) => r.kind === "due")).toBeUndefined();
  });

  it("lets the survivor claim when two singleton members dissolve", () => {
    const groups = buildDayLedger({
      servings: [],
      doses: [
        dose(
          1,
          "Morning",
          "07:07",
          morningStack({ writeMinute: "2026-08-30T07:07", hhmm: "07:07" })
        ),
        dose(
          2,
          "Morning",
          "07:07",
          morningStack({ writeMinute: "2026-08-30T07:07", hhmm: "07:07" })
        ),
        dose(
          3,
          "Morning",
          "07:07",
          morningStack({ writeMinute: "2026-08-30T07:07", hhmm: "07:07" })
        ),
        dose(
          4,
          "Morning",
          "11:11",
          morningStack({ writeMinute: "2026-08-30T11:11", hhmm: "11:11" })
        ),
        dose(
          5,
          "Morning",
          "12:12",
          morningStack({ writeMinute: "2026-08-30T12:12", hhmm: "12:12" })
        ),
      ],
      pending: [pending(90, "Morning", "Morning stack")],
    });
    const rows = groups[0].rows;
    const stacks = rows.filter((r): r is LedgerStack => r.kind === "stack");
    // Reach: TWO entries leave `stacks` in the loop, so a count taken early would read 3.
    const dissolved = rows.filter(
      (r) =>
        r.kind === "dose" &&
        r.stack === "Morning stack" &&
        r.bucket === "Morning"
    );
    expect(stacks).toHaveLength(1);
    expect(dissolved).toHaveLength(2);

    expect(stackLabel(stacks[0])).toBe("3 of 4");
    expect(stacks[0].open.map((d) => d.doseId)).toEqual([90]);
    expect(rows.find((r) => r.kind === "due")).toBeUndefined();
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
