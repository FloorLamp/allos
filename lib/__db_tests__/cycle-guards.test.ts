// DB INTEGRATION TIER — the cycle write cores' typed outcomes and the read-side
// plausibility withdrawal (issues #1681, #1682), plus the #448 end-to-end fixture for the
// prolonged-bleeding coaching builder.
//
// Each start/reopen outcome is asserted DISTINCTLY (the #1681 bug was exactly that two of
// them were indistinguishable from success), and every refusal is checked to have written
// NOTHING — a report, never a repair.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  cyclePhaseOnDate,
  periodOnDate,
  MAX_PLAUSIBLE_PERIOD_DAYS,
} from "@/lib/cycle";
import { listCyclePeriods, getOpenPeriod } from "@/lib/cycle-store";
import {
  startPeriodCore,
  endPeriodCore,
  reopenPeriodCore,
} from "@/lib/cycle-write";
import { REOPEN_PERIOD_MAX_AGE_DAYS } from "@/lib/cycle-plausibility";
import {
  buildCycleBleedingFindings,
  collectCoachingFindings,
} from "@/lib/rule-findings";
import {
  dedupeKeyHasKnownPrefix,
  tierForDedupeKey,
} from "@/lib/rule-finding-prefixes";
import { CYCLE_BLEEDING_PREFIX } from "@/lib/cycle-observation";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// A recorded period `startAgo`..`endAgo` days before the profile's today (endAgo null =
// still open).
function seedPeriod(
  profileId: number,
  startAgo: number,
  endAgo: number | null
): number {
  const anchor = today(profileId);
  return Number(
    db
      .prepare(
        `INSERT INTO cycles (profile_id, period_start, period_end) VALUES (?, ?, ?)`
      )
      .run(
        profileId,
        shiftDateStr(anchor, -startAgo),
        endAgo == null ? null : shiftDateStr(anchor, -endAgo)
      ).lastInsertRowid
  );
}

describe("startPeriodCore outcomes (#1681 bug 1 + bug 2)", () => {
  it("started: opens a period when nothing is recorded", () => {
    const p = newProfile("cycle-start-fresh");
    const out = startPeriodCore(p, today(p));
    expect(out.kind).toBe("started");
    expect(getOpenPeriod(p)?.period_start).toBe(today(p));
  });

  it("already-open: reports and writes nothing", () => {
    const p = newProfile("cycle-start-open");
    seedPeriod(p, 2, null);
    const before = listCyclePeriods(p).length;
    const out = startPeriodCore(p, today(p));
    expect(out.kind).toBe("already-open");
    expect(listCyclePeriods(p).length).toBe(before);
  });

  it("duplicate: a second tap on the same day reports and writes nothing", () => {
    const p = newProfile("cycle-start-dup");
    // A period that STARTED today and was already closed today — the owner-reported
    // reproduction: the control flipped back to "started" and the tap did nothing.
    seedPeriod(p, 0, 0);
    const out = startPeriodCore(p, today(p));
    expect(out.kind).toBe("duplicate");
    expect(listCyclePeriods(p).length).toBe(1);
  });

  it("too-soon: refuses a back-to-back period after a recent end", () => {
    const p = newProfile("cycle-start-soon");
    seedPeriod(p, 8, 3); // ended 3 days ago
    const out = startPeriodCore(p, today(p));
    expect(out.kind).toBe("too-soon");
    if (out.kind === "too-soon")
      expect(out.lastEnd).toBe(shiftDateStr(today(p), -3));
    expect(listCyclePeriods(p).length).toBe(1);
  });

  it("started again once a plausible gap has elapsed", () => {
    const p = newProfile("cycle-start-gap");
    seedPeriod(p, 25, 20);
    expect(startPeriodCore(p, today(p)).kind).toBe("started");
    expect(listCyclePeriods(p).length).toBe(2);
  });
});

describe("reopenPeriodCore outcomes (#1681 bug 3)", () => {
  it("reopened: clears the end date and restores the open-period state", () => {
    const p = newProfile("cycle-reopen");
    const start = shiftDateStr(today(p), -4);
    seedPeriod(p, 4, 0); // started 4 days ago, ended today
    const out = reopenPeriodCore(p, today(p));
    expect(out.kind).toBe("reopened");

    const open = getOpenPeriod(p);
    expect(open?.period_start).toBe(start);
    expect(open?.period_end).toBeNull();
    // The phase re-derives as menstrual — the reopen restores the claim, and the start
    // day the user recorded is untouched.
    expect(cyclePhaseOnDate(listCyclePeriods(p), today(p))).toBe("menstrual");
  });

  it("not-found: nothing has ever been closed", () => {
    const p = newProfile("cycle-reopen-none");
    expect(reopenPeriodCore(p, today(p)).kind).toBe("not-found");
  });

  it("too-old: refuses to resurrect a period beyond the recency window", () => {
    const p = newProfile("cycle-reopen-old");
    const endAgo = REOPEN_PERIOD_MAX_AGE_DAYS + 1;
    seedPeriod(p, endAgo + 4, endAgo);
    const out = reopenPeriodCore(p, today(p));
    expect(out.kind).toBe("too-old");
    // The row is untouched — still closed.
    expect(getOpenPeriod(p)).toBeNull();
    expect(listCyclePeriods(p)[0].period_end).toBe(
      shiftDateStr(today(p), -endAgo)
    );
  });

  it("already-open: refuses rather than minting a second open period", () => {
    const p = newProfile("cycle-reopen-open");
    seedPeriod(p, 30, 26);
    seedPeriod(p, 1, null);
    expect(reopenPeriodCore(p, today(p)).kind).toBe("already-open");
    expect(listCyclePeriods(p).filter((r) => r.period_end == null).length).toBe(
      1
    );
  });

  it("end → reopen → end is a clean round trip", () => {
    const p = newProfile("cycle-round-trip");
    seedPeriod(p, 3, null);
    expect(endPeriodCore(p, today(p)).kind).toBe("ended");
    expect(reopenPeriodCore(p, today(p)).kind).toBe("reopened");
    expect(endPeriodCore(p, today(p)).kind).toBe("ended");
    expect(listCyclePeriods(p).length).toBe(1);
    expect(listCyclePeriods(p)[0].period_end).toBe(today(p));
  });
});

describe("a stale open period stops claiming menstrual (#1682 fix a)", () => {
  it("stays stored exactly as recorded while yielding no menstrual phase today", () => {
    const p = newProfile("cycle-stale");
    const startAgo = MAX_PLAUSIBLE_PERIOD_DAYS + 5;
    const id = seedPeriod(p, startAgo, null);

    const rows = listCyclePeriods(p);
    expect(cyclePhaseOnDate(rows, today(p))).toBe("follicular");
    expect(periodOnDate(rows, today(p))).toBeNull();

    // The record is untouched: still open, still owned by the user to close.
    const row = db
      .prepare("SELECT period_start, period_end FROM cycles WHERE id = ?")
      .get(id) as { period_start: string; period_end: string | null };
    expect(row.period_end).toBeNull();
    expect(row.period_start).toBe(shiftDateStr(today(p), -startAgo));
    expect(getOpenPeriod(p)?.id).toBe(id);

    // Its own early days still read as menstrual — only the lapsed tail is withdrawn.
    expect(
      cyclePhaseOnDate(rows, shiftDateStr(today(p), -(startAgo - 1)))
    ).toBe("menstrual");
  });
});

describe("buildCycleBleedingFindings (#1682 fix b)", () => {
  it("observes a prolonged recorded period, coaching tier, registered prefix", () => {
    const p = newProfile("cycle-long");
    seedPeriod(p, 14, 4); // 11 inclusive bleeding days
    const anchor = today(p);

    const findings = buildCycleBleedingFindings(p, anchor);
    expect(findings.length).toBe(1);
    const f = findings[0];
    expect(f.title).toBe(
      "11 days of bleeding — worth discussing with a clinician"
    );
    expect(f.dedupeKey).toBe(
      `${CYCLE_BLEEDING_PREFIX}${shiftDateStr(anchor, -14)}`
    );
    expect(dedupeKeyHasKnownPrefix(f.dedupeKey)).toBe(true);
    expect(tierForDedupeKey(f.dedupeKey)).toBe("coaching");
    expect(f.tone).toBe("info");

    // It joins the ONE coaching rollup, so a dismissal rides the shared bus.
    const rolled = collectCoachingFindings(p, anchor, "kg").map(
      (x) => x.dedupeKey
    );
    expect(rolled).toContain(f.dedupeKey);
  });

  it("says nothing about a typical period or a still-open one", () => {
    const p = newProfile("cycle-typical");
    seedPeriod(p, 20, 16); // 5 days
    seedPeriod(p, 1, null); // open, no length yet
    expect(buildCycleBleedingFindings(p, today(p))).toEqual([]);
  });
});
