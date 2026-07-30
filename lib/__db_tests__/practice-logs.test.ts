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
  getPracticeSessions,
  getFrequencyTargetProgress,
  getWellnessPractices,
  getTrackedPractices,
  collectUpcoming,
  dismissFinding,
} from "@/lib/queries";
import { getTimelinePage } from "@/lib/timeline";
import {
  behindPractices,
  buildPracticeReminder,
} from "@/lib/notifications/practices";
import { getNavRelevance } from "@/lib/queries/nav-relevance";
import { OWNED_TABLES } from "@/lib/owned-tables";
import {
  createWellnessPractice,
  untrackWellnessPractice,
  updateWellnessPractice,
} from "@/lib/practice-store";
import { practiceIdentity } from "@/lib/practice";

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
        `INSERT INTO frequency_targets
           (profile_id, scope_kind, scope_value, scope_identity, per_week, per_week_max)
         VALUES (?, 'practice', ?, ?, ?, ?)`
      )
      .run(profileId, name, practiceIdentity(name), floor, ceiling)
      .lastInsertRowid
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

  it("makes Wellness relevant for either target-backed or logs-only practices (#1620)", () => {
    const empty = makeProfile("wellness-nav-empty");
    expect(getNavRelevance(empty).wellness).toBe(false);

    const logsOnly = makeProfile("wellness-nav-logs");
    logPracticeSession(logsOnly, "Meditation", "2026-06-17");
    expect(getNavRelevance(logsOnly).wellness).toBe(true);

    const targetOnly = makeProfile("wellness-nav-target");
    practiceTarget(targetOnly, "Breathwork", 3, null);
    expect(getNavRelevance(targetOnly).wellness).toBe(true);
  });

  it("retiring a practice keeps its logs-only card and removes Upcoming, nudge, and dismissal state (#1621)", () => {
    const pid = makeProfile("wellness-retire");
    setWeekMode(pid, "rolling");
    const t = today(pid);
    const tid = practiceTarget(pid, "Meditation", 3, null);
    logPracticeSession(pid, "Meditation", t);

    expect(collectUpcoming(pid, t).map((item) => item.key)).toContain(
      `practice:${tid}`
    );
    expect(behindPractices(pid).map((item) => item.targetId)).toContain(tid);
    dismissFinding(pid, `practice:${tid}`);

    expect(untrackWellnessPractice(pid, tid)).toEqual({
      kind: "untracked",
      targetId: tid,
    });
    expect(getPracticeSessions(pid, "Meditation")).toHaveLength(1);
    expect(getWellnessPractices(pid)).toMatchObject([
      {
        name: "Meditation",
        targetId: null,
        perWeek: null,
        sessionCount: 1,
      },
    ]);
    expect(collectUpcoming(pid, t).map((item) => item.key)).not.toContain(
      `practice:${tid}`
    );
    expect(behindPractices(pid)).toEqual([]);
    expect(buildPracticeReminder(pid)).toBeNull();
    expect(
      db
        .prepare(
          `SELECT 1 FROM upcoming_dismissals
            WHERE profile_id = ? AND signal_key = ?`
        )
        .get(pid, `practice:${tid}`)
    ).toBeUndefined();
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

  it("case/whitespace variants share one target identity and one history", () => {
    const pid = makeProfile("identity");
    setWeekMode(pid, "rolling");
    const t = today(pid);
    const tid = practiceTarget(pid, "Sauna", 3, 5);
    logPracticeSession(pid, " sauna ", t);
    logPracticeSession(pid, "SAUNA", shiftDateStr(t, -1));

    const progress = getFrequencyTargetProgress(pid).find(
      (p) => p.target.id === tid
    );
    expect(progress?.count).toBe(2);
    expect(getPracticeDayCount(pid, "Sauna", t)).toBe(1);
    expect(getPracticeSessions(pid, "sAuNa")).toHaveLength(2);
  });

  it("database uniqueness follows practice identity within one profile (#1623)", () => {
    const owner = makeProfile("practice-identity-owner");
    const other = makeProfile("practice-identity-other");
    practiceTarget(owner, "Sauna ritual", 3, null);

    expect(() =>
      db
        .prepare(
          `INSERT INTO frequency_targets
             (profile_id, scope_kind, scope_value, scope_identity, per_week)
           VALUES (?, 'practice', ' SAUNA\tRITUAL ', ?, 4)`
        )
        .run(owner, practiceIdentity(" SAUNA\tRITUAL "))
    ).toThrow(/UNIQUE/i);

    expect(() => practiceTarget(other, "SAUNA RITUAL", 4, null)).not.toThrow();
  });

  it("refuses to rename a target onto a logs-only practice history (#1618)", () => {
    const pid = makeProfile("rename-collision");
    const created = createWellnessPractice(pid, "Sauna", 3, null);
    expect(created.kind).toBe("saved");
    if (created.kind !== "saved") throw new Error("practice was not created");

    logPracticeSession(pid, "Sauna", "2026-06-15");
    logPracticeSession(pid, "Meditation", "2026-06-14");
    logPracticeSession(pid, "Meditation", "2026-06-16");

    expect(
      updateWellnessPractice(pid, created.targetId, "Meditation", 3, null)
    ).toEqual({ kind: "duplicate" });
    expect(getPracticeSessions(pid, "Sauna")).toHaveLength(1);
    expect(getPracticeSessions(pid, "Meditation")).toHaveLength(2);
    expect(
      getWellnessPractices(pid).map((practice) => ({
        name: practice.name,
        targetId: practice.targetId,
        sessionCount: practice.sessionCount,
      }))
    ).toEqual([
      { name: "Meditation", targetId: null, sessionCount: 2 },
      { name: "Sauna", targetId: created.targetId, sessionCount: 1 },
    ]);
  });

  it("allows a case-only rename within one practice identity (#1618)", () => {
    const pid = makeProfile("rename-same-identity");
    const created = createWellnessPractice(pid, "sauna", 3, null);
    expect(created.kind).toBe("saved");
    if (created.kind !== "saved") throw new Error("practice was not created");
    logPracticeSession(pid, " SAUNA ", "2026-06-16");

    expect(
      updateWellnessPractice(pid, created.targetId, "Sauna", 3, null)
    ).toEqual({ kind: "saved", targetId: created.targetId });
    expect(getWellnessPractices(pid)).toMatchObject([
      {
        identity: "sauna",
        name: "Sauna",
        targetId: created.targetId,
        sessionCount: 1,
      },
    ]);
    expect(getPracticeSessions(pid, "sauna")).toHaveLength(1);
  });

  it("supports protocol-windowed and unbounded session history", () => {
    const pid = makeProfile("windowed-history");
    logPracticeSession(pid, "Meditation", "2026-06-01");
    logPracticeSession(pid, "Meditation", "2026-06-10");
    logPracticeSession(pid, "Meditation", "2026-07-01");
    expect(
      getPracticeSessions(pid, "Meditation", 50, {
        start: "2026-06-05",
        end: "2026-06-30",
      }).map((session) => session.date)
    ).toEqual(["2026-06-10"]);
    expect(getPracticeSessions(pid, "Meditation")).toHaveLength(3);
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
    expect(item.href).toBe("/wellness");
    expect(item.practiceTargetId).toBe(tid);
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

// The quick surfaces' practice list (#1633): the shared read behind BOTH the
// quick-entry overlay's row and the command palette's finite preimage. It is
// deliberately narrower than getWellnessPractices — tracked only, no heatmap — so its
// boundaries need pinning where the page aggregate's don't overlap them.
describe("getTrackedPractices — the quick surfaces' list (#1633)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-17T12:00:00Z")); // a Wednesday
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("offers TRACKED practices only — history alone never re-lists an untracked one", () => {
    const pid = makeProfile("tracked-only");
    setWeekMode(pid, "rolling");
    const t = today(pid);
    practiceTarget(pid, "Sauna", 3, null);
    // Logged for months, then untracked: the card and the history stay (the page
    // aggregate still folds it in), but a quick surface offering it again would
    // quietly undo the untrack.
    logPracticeSession(pid, "Journaling", t);

    expect(getTrackedPractices(pid).map((p) => p.name)).toEqual(["Sauna"]);
    expect(getWellnessPractices(pid).map((p) => p.name)).toEqual([
      "Journaling",
      "Sauna",
    ]);
  });

  it("counts the week and TODAY across every spelling of one identity", () => {
    const pid = makeProfile("tracked-counts");
    setWeekMode(pid, "rolling");
    const t = today(pid);
    practiceTarget(pid, "Cold plunge", 3, null);
    logPracticeSession(pid, "COLD PLUNGE", t);
    logPracticeSession(pid, "cold  plunge", t); // same day, second session
    logPracticeSession(pid, "Cold plunge", shiftDateStr(t, -2));

    const [row] = getTrackedPractices(pid);
    expect(row).toMatchObject({
      identity: practiceIdentity("Cold plunge"),
      name: "Cold plunge", // the target's spelling wins
      perWeek: 3,
      // Adherence counts DAYS (two sessions today are one adherence day)…
      countThisWeek: 2,
      // …while today's tally counts SESSIONS, which is what the tap needs to show.
      todayCount: 2,
      atCeiling: false,
    });
  });

  it("reports the calm at-ceiling state rather than hiding the row", () => {
    const pid = makeProfile("tracked-ceiling");
    setWeekMode(pid, "rolling");
    const t = today(pid);
    practiceTarget(pid, "Sauna", 2, 3);
    for (const d of [0, -1, -2])
      logPracticeSession(pid, "Sauna", shiftDateStr(t, d));

    const [row] = getTrackedPractices(pid);
    expect(row).toMatchObject({ countThisWeek: 3, atCeiling: true });
    // Still offered: a dose-limited practice is never PUSHED toward more, but the user
    // asking to log one is user-initiated access, and removing the row would be the
    // system rewriting their intent.
    expect(getTrackedPractices(pid)).toHaveLength(1);
  });

  it("is profile-scoped", () => {
    const mine = makeProfile("tracked-mine");
    const theirs = makeProfile("tracked-theirs");
    practiceTarget(theirs, "Sauna", 3, null);
    expect(getTrackedPractices(mine)).toEqual([]);
  });
});
