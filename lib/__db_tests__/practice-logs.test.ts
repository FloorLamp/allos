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
  logPracticeByTargetId,
  inferPracticeSchedule,
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
import { modalHour } from "@/lib/weekly-rhythm";

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

    // #1718: the nudge carries a deep link and a real, routable kind, so it is honest
    // on Web Push and Home Assistant (which strip the "✅ Done" buttons) instead of
    // telling those users to "tap when you've done a session".
    const linked = buildPracticeReminder(pid, "e2e0", "https://allos.example")!;
    expect(linked.actions?.at(-1)?.url).toBe("https://allos.example/wellness");
    expect(linked.kind).toBe("practice");
    expect(String(linked.body)).not.toMatch(/\btap\b/i);

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

// ---------------------------------------------------------------------------
// #2204 — the quick path stops discarding duration and time.
//
// Two omissions with two different histories. DURATION was reachable only through the
// Wellness card's modal, and the sheet deliberately refused to stack one — an objection
// about MODALS that the inline stepper answers without reversing. TIME was declared
// `day-only` because nothing read it, and #2202's `modalHour` is now that reader, which
// turned the omission into an active regression: the faster the path, the more it
// starved the very inference that reschedules its own nudge.
describe("quick-path practice logs carry duration and time (#2204)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-17T07:05:00Z")); // a Wednesday, 07:05 UTC
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function rows(profileId: number) {
    return db
      .prepare(
        `SELECT practice, date, time, duration_min FROM practice_logs
          WHERE profile_id = ? ORDER BY id`
      )
      .all(profileId) as {
      practice: string;
      date: string;
      time: string | null;
      duration_min: number | null;
    }[];
  }

  it("stamps the profile-local tap instant when the caller states no time", () => {
    const pid = makeProfile("quick-time-stamp");
    const t = today(pid);
    // The one-tap shape: no `time` key at all.
    expect(logPracticeSession(pid, "Sauna", t)).toMatchObject({
      kind: "logged",
    });
    expect(rows(pid)).toEqual([
      { practice: "Sauna", date: t, time: "07:05", duration_min: null },
    ]);
  });

  it("keeps an explicitly empty time null — the modal's blank is a statement", () => {
    const pid = makeProfile("quick-time-explicit-null");
    const t = today(pid);
    // The expanded form ALWAYS posts its time field; empty means "no instant", and
    // silently stamping one there would be the app inventing data the user declined.
    logPracticeSession(pid, "Sauna", t, { time: null });
    // ...and a stated time still wins outright.
    logPracticeSession(pid, "Sauna", t, { time: "06:30" });
    expect(rows(pid).map((r) => r.time)).toEqual([null, "06:30"]);
  });

  it("does not stamp a backdated correction — 'now' is not that day's instant", () => {
    const pid = makeProfile("quick-time-backdated");
    const t = today(pid);
    logPracticeSession(pid, "Sauna", shiftDateStr(t, -3));
    expect(rows(pid).map((r) => r.time)).toEqual([null]);
  });

  it("feeds modalHour identically from a quick tap and a Wellness-modal log", () => {
    const tapped = makeProfile("rhythm-from-tap");
    const typed = makeProfile("rhythm-from-modal");
    const t = today(tapped);
    for (const back of [0, -7, -14]) {
      // The quick path states nothing; the modal states the same instant by hand.
      logPracticeSession(tapped, "Breathwork", shiftDateStr(t, back));
      logPracticeSession(typed, "Breathwork", shiftDateStr(t, back), {
        time: "07:05",
      });
    }
    const hourOf = (pid: number) => modalHour(rows(pid).map((r) => r.time));
    expect(hourOf(tapped)).toBe(7);
    expect(hourOf(tapped)).toBe(hourOf(typed));
    // And the rhythm reader agrees, rather than falling to the 18:00 evening default.
    expect(inferPracticeSchedule(tapped, "Breathwork").hour).toBe(7);
  });

  it("stamps the Telegram Done ✅ tap too — it was starving the nudge it feeds", () => {
    const pid = makeProfile("quick-time-telegram");
    const tid = practiceTarget(pid, "Red light therapy", 3, null);
    expect(logPracticeByTargetId(pid, tid)).toMatchObject({ kind: "logged" });
    expect(rows(pid).map((r) => r.time)).toEqual(["07:05"]);
  });

  it("writes the duration the quick path supplies, and prefills the NEXT tap from it", () => {
    const pid = makeProfile("quick-duration");
    const t = today(pid);
    practiceTarget(pid, "Sauna", 3, null);

    // Nothing logged yet: no history and no declared default, so the sheet offers a
    // BLANK stepper. The app does not invent a duration (#2204 constraint 2).
    expect(getTrackedPractices(pid)[0].previousDurationMin).toBeNull();

    // Tap one: the user types 20 into the stepper and accepts it.
    logPracticeSession(pid, "Sauna", t, { durationMin: 20 });
    expect(getTrackedPractices(pid)[0].previousDurationMin).toBe(20);

    // Tap two: the prefill arrives at 20, the user steps it to 25 and logs. The NEXT
    // prefill must be 25 — the value WRITTEN, not the one that was merely shown.
    logPracticeSession(pid, "Sauna", t, { durationMin: 25 });
    expect(rows(pid).map((r) => r.duration_min)).toEqual([20, 25]);
    expect(getTrackedPractices(pid)[0].previousDurationMin).toBe(25);

    // Tap three: the user steps the stepper off the bottom and logs without one.
    // Blank stays blank — clearing is a decision the next prefill honours, not a
    // gap the last non-null value quietly fills back in.
    logPracticeSession(pid, "Sauna", t, { durationMin: null });
    expect(getTrackedPractices(pid)[0].previousDurationMin).toBeNull();
  });

  it("folds the prefill across an identity's spellings and stays profile-scoped", () => {
    const mine = makeProfile("quick-duration-mine");
    const theirs = makeProfile("quick-duration-theirs");
    const t = today(mine);
    practiceTarget(mine, "Sauna", 3, null);
    practiceTarget(theirs, "Sauna", 3, null);

    // Another profile's longer session may not leak into mine.
    logPracticeSession(theirs, "Sauna", t, { durationMin: 45 });
    expect(getTrackedPractices(mine)[0].previousDurationMin).toBeNull();

    // Two stored spellings of ONE identity: the newest row wins, whichever it is
    // spelled as — the same fold the today-count uses.
    logPracticeSession(mine, "sauna", shiftDateStr(t, -1), { durationMin: 12 });
    expect(getTrackedPractices(mine)[0].previousDurationMin).toBe(12);
    logPracticeSession(mine, "Sauna", t, { durationMin: 18 });
    expect(getTrackedPractices(mine)[0].previousDurationMin).toBe(18);
  });

  it("leaves the Wellness card's own prefill reading the same value", () => {
    const pid = makeProfile("quick-duration-card");
    const t = today(pid);
    practiceTarget(pid, "Sauna", 3, null);
    logPracticeSession(pid, "Sauna", t, { durationMin: 30 });
    // One question, one computation: the sheet and the card format the SAME pure
    // resolution, so the two surfaces cannot offer different defaults.
    expect(getWellnessPractices(pid)[0].previousDurationMin).toBe(
      getTrackedPractices(pid)[0].previousDurationMin
    );
    expect(getWellnessPractices(pid)[0].previousDurationMin).toBe(30);
  });
});
