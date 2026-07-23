// DB INTEGRATION TIER (issue #1259): the wellness-practice loop end-to-end against the
// real schema — the dedicated practice_logs store feeds a `practice`-scope frequency
// target's RANGE progress (floor + ceiling), surfaces on the Timeline, drives the calm
// Upcoming twin, and gates the pace-aware Telegram nudge (the #448 builder-over-fixture
// obligation). Also pins the two-same-day-sessions invariant (two rows, ONE adherence
// day) and the deleteProfile sweep's sibling (the OWNED_TABLES membership).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setWeekMode } from "@/lib/settings";
import {
  logPracticeSession,
  getPracticeDayCount,
  getFrequencyTargetProgress,
  collectUpcoming,
  dismissFinding,
} from "@/lib/queries";
import { getTimelinePage } from "@/lib/timeline";
import {
  behindPractices,
  buildPracticeReminder,
} from "@/lib/notifications/practices";
import { OWNED_TABLES } from "@/lib/owned-tables";

function makeProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function practiceTarget(
  profileId: number,
  name: string,
  floor: number,
  ceiling: number | null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week, per_week_max)
         VALUES (?, 'practice', ?, ?, ?)`
      )
      .run(profileId, name, floor, ceiling).lastInsertRowid
  );
}

describe("practice_logs store + range progress (#1259)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-17T12:00:00Z")); // a Wednesday
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("two same-day sessions are TWO rows but ONE adherence day", () => {
    const pid = makeProfile("two-same-day");
    setWeekMode(pid, "rolling");
    const t = today(pid);

    const a = logPracticeSession(pid, "Red light therapy", t);
    expect(a).toEqual({ kind: "logged", count: 1, date: t });
    const b = logPracticeSession(pid, "Red light therapy", t);
    expect(b).toEqual({ kind: "logged", count: 2, date: t });

    // Two real session rows for the day…
    expect(getPracticeDayCount(pid, "Red light therapy", t)).toBe(2);
    // …but adherence is day-distinct (COUNT(DISTINCT date)) — one day counts once.
    const tid = practiceTarget(pid, "Red light therapy", 3, 5);
    const prog = getFrequencyTargetProgress(pid).find(
      (p) => p.target.id === tid
    )!;
    expect(prog.count).toBe(1);
    expect(prog.met).toBe(false);
  });

  it("range semantics: floor drives met, ceiling flips atCeiling (calm 'plenty')", () => {
    const pid = makeProfile("range");
    setWeekMode(pid, "rolling");
    const t = today(pid);
    const tid = practiceTarget(pid, "Sauna", 3, 5);

    // Below the floor → behind, not met, not at ceiling.
    logPracticeSession(pid, "Sauna", t);
    logPracticeSession(pid, "Sauna", shiftDateStr(t, -1));
    let prog = getFrequencyTargetProgress(pid).find(
      (p) => p.target.id === tid
    )!;
    expect(prog).toMatchObject({ count: 2, met: false, atCeiling: false });
    expect(prog.pace).toBe("behind");
    expect(prog.per_week_max).toBe(5);

    // Reach the floor (3 distinct days) → met, still below the ceiling.
    logPracticeSession(pid, "Sauna", shiftDateStr(t, -2));
    prog = getFrequencyTargetProgress(pid).find((p) => p.target.id === tid)!;
    expect(prog).toMatchObject({ count: 3, met: true, atCeiling: false });

    // Reach the ceiling (5 distinct days) → atCeiling (the "that's plenty" state).
    logPracticeSession(pid, "Sauna", shiftDateStr(t, -3));
    logPracticeSession(pid, "Sauna", shiftDateStr(t, -4));
    prog = getFrequencyTargetProgress(pid).find((p) => p.target.id === tid)!;
    expect(prog).toMatchObject({ count: 5, met: true, atCeiling: true });
  });

  it("a logged session surfaces on the Timeline as its own 'practice' entry", () => {
    const pid = makeProfile("timeline");
    const t = today(pid);
    logPracticeSession(pid, "Meditation", t, { durationMin: 15 });

    const events = getTimelinePage(pid).events;
    const ev = events.find((e) => e.category === "practice");
    expect(ev).toBeTruthy();
    expect(ev!.title).toBe("Meditation");
    expect(ev!.date).toBe(t);
  });

  it("practice_logs is an OWNED table (deleteProfile sweep + export completeness)", () => {
    expect((OWNED_TABLES as readonly string[]).includes("practice_logs")).toBe(
      true
    );
  });
});

describe("practice Upcoming twin + pace-aware nudge (#1259)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-17T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a behind practice surfaces on Upcoming under practice:<id>, NOT training:<id>", () => {
    const pid = makeProfile("upcoming-twin");
    setWeekMode(pid, "rolling");
    const t = today(pid);
    const tid = practiceTarget(pid, "Breathwork", 3, 5);
    logPracticeSession(pid, "Breathwork", t); // 1/3 — behind

    const items = collectUpcoming(pid, t);
    const keys = items.map((i) => i.key);
    expect(keys).toContain(`practice:${tid}`);
    // Never mislabeled as a training target.
    expect(keys).not.toContain(`training:${tid}`);
    const item = items.find((i) => i.key === `practice:${tid}`)!;
    expect(item.domain).toBe("practice");
    expect(item.dueText).toBe("1/3–5 this week");
  });

  it("the nudge builder fires only when behind, and honors the suppression bus", () => {
    const pid = makeProfile("nudge");
    setWeekMode(pid, "rolling");
    const t = today(pid);
    const tid = practiceTarget(pid, "Cold plunge", 3, null);
    logPracticeSession(pid, "Cold plunge", t); // 1/3 — behind

    // Behind → the builder gathers it and mints a Done button carrying ids only.
    expect(behindPractices(pid).map((b) => b.targetId)).toEqual([tid]);
    const msg = buildPracticeReminder(pid, "e2e0")!;
    expect(msg).toBeTruthy();
    expect(
      msg.actions?.some((a) => a.data === `pdone:${pid}:${tid}:e2e0`)
    ).toBe(true);

    // Dismiss the Upcoming twin → the push is held (dismiss once, silence everywhere).
    dismissFinding(pid, `practice:${tid}`);
    expect(behindPractices(pid)).toEqual([]);
    expect(buildPracticeReminder(pid)).toBeNull();
  });

  it("the nudge is SILENT once the floor is met (never toward the ceiling)", () => {
    const pid = makeProfile("nudge-quiet");
    setWeekMode(pid, "rolling");
    const t = today(pid);
    practiceTarget(pid, "Journaling", 3, 5);
    // 3 distinct days → floor met → nothing behind → no nudge.
    logPracticeSession(pid, "Journaling", t);
    logPracticeSession(pid, "Journaling", shiftDateStr(t, -1));
    logPracticeSession(pid, "Journaling", shiftDateStr(t, -2));
    expect(behindPractices(pid)).toEqual([]);
    expect(buildPracticeReminder(pid)).toBeNull();
  });
});
