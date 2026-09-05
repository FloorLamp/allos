// DB INTEGRATION TIER (issue #1259): the wellness-practice loop end-to-end against the
// real schema — the dedicated practice_logs store feeds a `practice`-scope frequency
// target's RANGE progress (floor + ceiling), surfaces on the Timeline, drives the calm
// Upcoming twin, and gates the pace-aware Telegram nudge (the #448 builder-over-fixture
// obligation). Also pins the two-same-day-sessions invariant (two rows, ONE adherence
// day) and the deleteProfile sweep's sibling (the OWNED_TABLES membership).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone, setWeekMode } from "@/lib/settings";
import {
  logPracticeSession,
  updatePracticeSession,
  logPracticeByTargetId,
  logFinishedPracticeByTargetId,
  logFinishedPracticeSession,
  startLivePracticeSession,
  endLivePracticeSession,
  closeAbandonedPracticeSessions,
  getPracticeUsualDuration,
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
    logPracticeSession(logsOnly, "Meditation", "2026-06-17", "page");
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
    logPracticeSession(pid, "Meditation", t, "page");

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

    const a = logPracticeSession(pid, "Red light therapy", t, "page");
    expect(a).toEqual({ kind: "logged", count: 1, date: t });
    const b = logPracticeSession(pid, "Red light therapy", t, "page");
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
    logPracticeSession(pid, " sauna ", t, "page");
    logPracticeSession(pid, "SAUNA", shiftDateStr(t, -1), "page");

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

    logPracticeSession(pid, "Sauna", "2026-06-15", "page");
    logPracticeSession(pid, "Meditation", "2026-06-14", "page");
    logPracticeSession(pid, "Meditation", "2026-06-16", "page");

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
    logPracticeSession(pid, " SAUNA ", "2026-06-16", "page");

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
    // All three PAST of this block's faked clock (2026-06-17). The third used to be
    // 2026-07-01 — two weeks in the FUTURE — which only landed because the practice
    // window was symmetric ±30; #4425's ruling refuses a future-dated session, so the
    // fixture states a real past day and the range filter below still excludes it.
    logPracticeSession(pid, "Meditation", "2026-05-20", "page");
    logPracticeSession(pid, "Meditation", "2026-06-01", "page");
    logPracticeSession(pid, "Meditation", "2026-06-10", "page");
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
    logPracticeSession(pid, "Sauna", t, "page");
    logPracticeSession(pid, "Sauna", shiftDateStr(t, -1), "page");
    let prog = getFrequencyTargetProgress(pid).find(
      (p) => p.target.id === tid
    )!;
    expect(prog).toMatchObject({ count: 2, met: false, atCeiling: false });
    expect(prog.pace).toBe("behind");
    expect(prog.per_week_max).toBe(5);

    // Reach the floor (3 distinct days) → met, still below the ceiling.
    logPracticeSession(pid, "Sauna", shiftDateStr(t, -2), "page");
    prog = getFrequencyTargetProgress(pid).find((p) => p.target.id === tid)!;
    expect(prog).toMatchObject({ count: 3, met: true, atCeiling: false });

    // Reach the ceiling (5 distinct days) → atCeiling (the "that's plenty" state).
    logPracticeSession(pid, "Sauna", shiftDateStr(t, -3), "page");
    logPracticeSession(pid, "Sauna", shiftDateStr(t, -4), "page");
    prog = getFrequencyTargetProgress(pid).find((p) => p.target.id === tid)!;
    expect(prog).toMatchObject({ count: 5, met: true, atCeiling: true });
  });

  it("a logged session surfaces on the Timeline as its own 'practice' entry", () => {
    const pid = makeProfile("timeline");
    const t = today(pid);
    logPracticeSession(pid, "Meditation", t, "page", { durationMin: 15 });

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
    logPracticeSession(pid, "Breathwork", t, "page"); // 1/3 — behind

    const items = collectUpcoming(pid, t);
    const keys = items.map((i) => i.key);
    expect(keys).toContain(`practice:${tid}`);
    // Never mislabeled as a training target.
    expect(keys).not.toContain(`training:${tid}`);
    const item = items.find((i) => i.key === `practice:${tid}`)!;
    expect(item.domain).toBe("practice");
    expect(item.dueText).toBe("1/3–5 this week");
    expect(item.href).toBe("/wellness");
    // The row carries what the shared control needs to stand on it (#4424 ruling 7):
    // the target's practice NAME, resolved here rather than posted as an id.
    expect(item.practiceLog?.practice).toBe("Breathwork");
    expect(item.practiceLog?.todayCount).toBe(1);
  });

  it("the nudge builder fires only when behind, and honors the suppression bus", () => {
    const pid = makeProfile("nudge");
    setWeekMode(pid, "rolling");
    const t = today(pid);
    const tid = practiceTarget(pid, "Cold plunge", 3, null);
    logPracticeSession(pid, "Cold plunge", t, "page"); // 1/3 — behind

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
    logPracticeSession(pid, "Journaling", t, "page");
    logPracticeSession(pid, "Journaling", shiftDateStr(t, -1), "page");
    logPracticeSession(pid, "Journaling", shiftDateStr(t, -2), "page");
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
    logPracticeSession(pid, "Journaling", t, "page");

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
    logPracticeSession(pid, "COLD PLUNGE", t, "page");
    logPracticeSession(pid, "cold  plunge", t, "page"); // same day, second session
    logPracticeSession(pid, "Cold plunge", shiftDateStr(t, -2), "page");

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
      logPracticeSession(pid, "Sauna", shiftDateStr(t, d), "page");

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
        `SELECT practice, date, start_time, duration_min FROM practice_logs
          WHERE profile_id = ? ORDER BY id`
      )
      .all(profileId) as {
      practice: string;
      date: string;
      start_time: string | null;
      duration_min: number | null;
    }[];
  }

  it("stamps the profile-local tap instant when the caller states no time", () => {
    const pid = makeProfile("quick-time-stamp");
    const t = today(pid);
    // The one-tap shape: no `startTime` key at all.
    expect(logPracticeSession(pid, "Sauna", t, "page")).toMatchObject({
      kind: "logged",
    });
    expect(rows(pid)).toEqual([
      { practice: "Sauna", date: t, start_time: "07:05", duration_min: null },
    ]);
  });

  it("keeps an explicitly empty time null — the modal's blank is a statement", () => {
    const pid = makeProfile("quick-time-explicit-null");
    const t = today(pid);
    // The expanded form ALWAYS posts its time field; empty means "no instant", and
    // silently stamping one there would be the app inventing data the user declined.
    logPracticeSession(pid, "Sauna", t, "page", { startTime: null });
    // ...and a stated time still wins outright.
    logPracticeSession(pid, "Sauna", t, "page", { startTime: "06:30" });
    expect(rows(pid).map((r) => r.start_time)).toEqual([null, "06:30"]);
  });

  it("does not stamp a backdated correction — 'now' is not that day's instant", () => {
    const pid = makeProfile("quick-time-backdated");
    const t = today(pid);
    logPracticeSession(pid, "Sauna", shiftDateStr(t, -3), "page");
    expect(rows(pid).map((r) => r.start_time)).toEqual([null]);
  });

  it("feeds modalHour identically from a quick tap and a Wellness-modal log", () => {
    const tapped = makeProfile("rhythm-from-tap");
    const typed = makeProfile("rhythm-from-modal");
    const t = today(tapped);
    for (const back of [0, -7, -14]) {
      // The quick path states nothing; the modal states the same instant by hand.
      logPracticeSession(tapped, "Breathwork", shiftDateStr(t, back), "page");
      logPracticeSession(typed, "Breathwork", shiftDateStr(t, back), "page", {
        startTime: "07:05",
      });
    }
    const hourOf = (pid: number) =>
      modalHour(rows(pid).map((r) => r.start_time));
    expect(hourOf(tapped)).toBe(7);
    expect(hourOf(tapped)).toBe(hourOf(typed));
    // And the rhythm reader agrees, rather than falling to the 18:00 evening default.
    expect(inferPracticeSchedule(tapped, "Breathwork").hour).toBe(7);
  });

  it("keeps Upcoming start-only and records Telegram Done as end-only", () => {
    const pid = makeProfile("quick-time-telegram");
    const tid = practiceTarget(pid, "Red light therapy", 3, null);
    expect(logPracticeByTargetId(pid, tid, "page")).toMatchObject({
      kind: "logged",
    });
    // A stored usual duration exists, but Telegram never displayed it. Its callback
    // therefore cannot use that hidden value to invent a start.
    logPracticeSession(
      pid,
      "Red light therapy",
      shiftDateStr(today(pid), -1),
      "page",
      {
        durationMin: 25,
      }
    );
    expect(
      logFinishedPracticeByTargetId(pid, tid, "telegram-command")
    ).toMatchObject({ kind: "logged" });
    expect(
      (
        db
          .prepare(
            `SELECT start_time, end_time, logged_via FROM practice_logs
              WHERE profile_id = ? ORDER BY id`
          )
          .all(pid) as {
          start_time: string | null;
          end_time: string | null;
          logged_via: string | null;
        }[]
      ).map((r) => ({
        start: r.start_time,
        end: r.end_time,
        via: r.logged_via,
      }))
    ).toEqual([
      { start: "07:05", end: null, via: "page" },
      { start: null, end: null, via: "page" },
      { start: null, end: "07:05", via: "telegram-command" },
    ]);
  });

  it("writes the duration the quick path supplies, and prefills the NEXT tap from it", () => {
    const pid = makeProfile("quick-duration");
    const t = today(pid);
    practiceTarget(pid, "Sauna", 3, null);

    // Nothing logged yet: no history and no declared default, so the sheet offers a
    // BLANK stepper. The app does not invent a duration (#2204 constraint 2).
    expect(getTrackedPractices(pid)[0].previousDurationMin).toBeNull();

    // Tap one: the user types 20 into the stepper and accepts it.
    logPracticeSession(pid, "Sauna", t, "page", { durationMin: 20 });
    expect(getTrackedPractices(pid)[0].previousDurationMin).toBe(20);

    // A tie is resolved by the newest recorded duration.
    logPracticeSession(pid, "Sauna", t, "page", { durationMin: 25 });
    expect(rows(pid).map((r) => r.duration_min)).toEqual([20, 25]);
    expect(getTrackedPractices(pid)[0].previousDurationMin).toBe(25);

    // A duration-less newest row does not erase the recorded usual.
    logPracticeSession(pid, "Sauna", t, "page", { durationMin: null });
    expect(getTrackedPractices(pid)[0].previousDurationMin).toBe(25);

    // Once 20 has the most votes it becomes the usual despite a newer 25.
    logPracticeSession(pid, "Sauna", t, "page", { durationMin: 20 });
    expect(getTrackedPractices(pid)[0].previousDurationMin).toBe(20);
  });

  it("folds the prefill across an identity's spellings and stays profile-scoped", () => {
    const mine = makeProfile("quick-duration-mine");
    const theirs = makeProfile("quick-duration-theirs");
    const t = today(mine);
    practiceTarget(mine, "Sauna", 3, null);
    practiceTarget(theirs, "Sauna", 3, null);

    // Another profile's longer session may not leak into mine.
    logPracticeSession(theirs, "Sauna", t, "page", { durationMin: 45 });
    expect(getTrackedPractices(mine)[0].previousDurationMin).toBeNull();

    // Two stored spellings of ONE identity: the newest row wins, whichever it is
    // spelled as — the same fold the today-count uses.
    logPracticeSession(mine, "sauna", shiftDateStr(t, -1), "page", {
      durationMin: 12,
    });
    expect(getTrackedPractices(mine)[0].previousDurationMin).toBe(12);
    logPracticeSession(mine, "Sauna", t, "page", { durationMin: 18 });
    expect(getTrackedPractices(mine)[0].previousDurationMin).toBe(18);
  });

  it("uses one full-history usual-duration vote after more than 50 logs", () => {
    const pid = makeProfile("usual-full-history");
    practiceTarget(pid, "Sauna", 3, null);
    const t = today(pid);
    for (let i = 0; i < 26; i += 1)
      logPracticeSession(pid, "Sauna", shiftDateStr(t, -2), "page", {
        durationMin: 10,
      });
    for (let i = 0; i < 25; i += 1)
      logPracticeSession(pid, "sauna", shiftDateStr(t, -1), "page", {
        durationMin: 20,
      });

    expect(getPracticeUsualDuration(pid, "Sauna")).toBe(10);
    expect(getWellnessPractices(pid)[0].previousDurationMin).toBe(10);
    expect(getTrackedPractices(pid)[0].previousDurationMin).toBe(10);
  });

  it("leaves the Wellness card's own prefill reading the same value", () => {
    const pid = makeProfile("quick-duration-card");
    const t = today(pid);
    practiceTarget(pid, "Sauna", 3, null);
    logPracticeSession(pid, "Sauna", t, "page", { durationMin: 30 });
    // One question, one computation: the sheet and the card format the SAME pure
    // resolution, so the two surfaces cannot offer different defaults.
    expect(getWellnessPractices(pid)[0].previousDurationMin).toBe(
      getTrackedPractices(pid)[0].previousDurationMin
    );
    expect(getWellnessPractices(pid)[0].previousDurationMin).toBe(30);
  });
});

describe("live practice sessions (#3143)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-31T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("starts once, returns the open row on a second start, and ends from two taps", () => {
    const pid = makeProfile("live-window");
    const started = startLivePracticeSession(pid, "Sauna", "page");
    expect(started).toMatchObject({
      kind: "started",
      count: 1,
      date: "2026-08-31",
      session: { date: "2026-08-31", startTime: "12:00" },
    });
    expect(startLivePracticeSession(pid, "sauna", "page")).toMatchObject({
      kind: "already-live",
      session: { id: started.kind === "started" ? started.session.id : -1 },
    });

    vi.setSystemTime(new Date("2026-08-31T12:37:00Z"));
    const ended =
      started.kind === "started"
        ? endLivePracticeSession(pid, started.session.id)
        : { kind: "not-live" as const };
    expect(ended).toMatchObject({
      kind: "ended",
      session: {
        start_time: "12:00",
        end_time: "12:37",
        duration_min: 37,
        live: 0,
        derived_window: 1,
      },
    });
    expect(
      started.kind === "started"
        ? endLivePracticeSession(pid, started.session.id)
        : null
    ).toEqual({ kind: "not-live" });
  });

  // #5091 — A LIVE ROW THAT KNOWS ITS OWN LENGTH COMPLETES ITSELF. A Start now stamps
  // the practice's usual duration with `derived_window = 1` (#4897) and nothing read it
  // as an END, so a 15-minute red-light session started at 06:28 was still "running" at
  // 10:52 and drew four hours wide. The second tap is the tap the one-tap doctrine says
  // a person should not owe when the row already knows when it finished.
  //
  // `Rowing` is given two 15-minute sessions first, because the usual duration IS the
  // history: a practice with none has nothing to complete at, which is the third case
  // below.
  function seedUsual(pid: number, minutes: number): void {
    for (const date of ["2026-08-29", "2026-08-30"])
      logPracticeSession(pid, "Rowing", date, "page", { durationMin: minutes });
  }

  it("completes a known-length session at start plus its duration, with no tap", () => {
    const pid = makeProfile("live-completes");
    seedUsual(pid, 15);
    expect(getPracticeUsualDuration(pid, "Rowing")).toBe(15);
    const started = startLivePracticeSession(pid, "Rowing", "page");
    expect(started.kind).toBe("started");

    vi.setSystemTime(new Date("2026-08-31T12:20:00Z"));
    closeAbandonedPracticeSessions(pid);
    const [row] = getPracticeSessions(pid, "Rowing");
    expect(row).toMatchObject({
      date: "2026-08-31",
      start_time: "12:00",
      // The row's OWN start plus its OWN duration, not the minute the sweep ran.
      end_time: "12:15",
      duration_min: 15,
      live: 0,
      // Still derived, so the chart and the note go on hedging the end (#4948). A
      // completion that cleared this would turn a derived end into a stated one.
      derived_window: 1,
    });
  });

  it("is still live before that instant, and an End tap writes the observed end", () => {
    const pid = makeProfile("live-before-derived");
    seedUsual(pid, 15);
    const started = startLivePracticeSession(pid, "Rowing", "page");
    expect(started.kind).toBe("started");
    if (started.kind !== "started") return;

    vi.setSystemTime(new Date("2026-08-31T12:10:00Z"));
    closeAbandonedPracticeSessions(pid);
    expect(getPracticeSessions(pid, "Rowing")[0]).toMatchObject({ live: 1 });
    // The End tap still wins before the derived end: what was observed beats what was
    // expected, which is the whole reason the tap stays.
    expect(endLivePracticeSession(pid, started.session.id)).toMatchObject({
      kind: "ended",
      session: { end_time: "12:10", duration_min: 10, live: 0 },
    });
  });

  it("leaves a session with no usual duration exactly as it was", () => {
    // The unchanged case, read at the SAME offsets as the two above rather than by
    // reading the branch: a practice with no history has no length to complete at.
    const pid = makeProfile("live-no-usual");
    const started = startLivePracticeSession(pid, "Rowing", "page");
    expect(started.kind).toBe("started");
    for (const at of ["2026-08-31T12:10:00Z", "2026-08-31T12:20:00Z"]) {
      vi.setSystemTime(new Date(at));
      closeAbandonedPracticeSessions(pid);
      expect(getPracticeSessions(pid, "Rowing")[0]).toMatchObject({
        live: 1,
        end_time: null,
        duration_min: null,
      });
    }
    // ...and the six-hour bound still closes it start-only.
    vi.setSystemTime(new Date("2026-08-31T19:00:00Z"));
    expect(closeAbandonedPracticeSessions(pid)).toBe(1);
    expect(getPracticeSessions(pid, "Rowing")[0]).toMatchObject({
      live: 0,
      end_time: null,
      duration_min: null,
    });
  });

  it("leaves the usual duration no abandoned derived row to vote with (#4900)", () => {
    // ASSERTED AS AN ABSENCE, with its reason: #4900 was about a row that was never
    // finished voting in the usual. For a practice that HAS a usual, such a row can no
    // longer exist — it completes at its own derived end long before the six-hour
    // bound — so the vote is over finished sessions only.
    const pid = makeProfile("live-no-abandoned-vote");
    seedUsual(pid, 15);
    startLivePracticeSession(pid, "Rowing", "page");
    vi.setSystemTime(new Date("2026-08-31T19:00:00Z"));
    closeAbandonedPracticeSessions(pid);
    expect(
      getPracticeSessions(pid, "Rowing").filter(
        (row) =>
          row.live === 0 && row.start_time !== null && row.end_time === null
      )
    ).toEqual([]);
    expect(getPracticeUsualDuration(pid, "Rowing")).toBe(15);
  });

  it("closes a live row whose start is stranded ahead of the clock", () => {
    // A westward timezone edit can leave a stored wall clock reading as future. It is
    // not a session in progress however little quiet has passed, and this is the claim
    // about the ROW that the shared episode model (#5142) deliberately does not make:
    // the model bounds quiet, and a start ahead of the clock is judged here.
    const pid = makeProfile("live-future-start");
    const started = startLivePracticeSession(pid, "Rowing", "page");
    expect(started.kind).toBe("started");
    vi.setSystemTime(new Date("2026-08-31T09:00:00Z")); // three hours BEFORE the start
    expect(closeAbandonedPracticeSessions(pid)).toBe(1);
    expect(getPracticeSessions(pid, "Rowing")[0]).toMatchObject({
      live: 0,
      end_time: null,
      duration_min: null,
    });
  });

  // THE PRACTICE KIND'S STALE WINDOW IS ZERO-WIDTH, written down here so the next
  // reader does not have to derive it (#5142). `EPISODE_BOUNDS.practice` has
  // `staleMin === abandonMin === 360`, so the instant a practice stops reading as in
  // progress is the same instant the sweep clears it: `stale` is a state the practice
  // kind can be IN, but no clock lands in it for longer than the gap between two
  // sweeps. That is not an oversight — practice is the one kind with no "Still going?"
  // nudge, and a suggest nobody sends needs no window to be sent in.
  //
  // The two clocks below are the convention, and they are the reason `episodeIsOpen`
  // is not dead code even though a green suite could be had without it: `staleMin` is
  // reached INCLUSIVELY, `abandonMin` is passed STRICTLY, so exactly at the bound the
  // row is stale-and-open and one minute later it is gone.
  it("holds a live practice AT its bound and abandons it one minute past", () => {
    const pid = makeProfile("live-at-the-bound");
    setTimezone(pid, "UTC");
    vi.setSystemTime(new Date("2026-08-31T06:00:00Z"));
    expect(startLivePracticeSession(pid, "Sauna", "page").kind).toBe("started");

    // Exactly six hours of quiet. Stale, and stale is open.
    vi.setSystemTime(new Date("2026-08-31T12:00:00Z"));
    expect(closeAbandonedPracticeSessions(pid)).toBe(0);
    expect(getPracticeSessions(pid, "Sauna")[0]).toMatchObject({
      live: 1,
      end_time: null,
      duration_min: null,
    });

    vi.setSystemTime(new Date("2026-08-31T12:01:00Z"));
    expect(closeAbandonedPracticeSessions(pid)).toBe(1);
    expect(getPracticeSessions(pid, "Sauna")[0]).toMatchObject({
      live: 0,
      end_time: null,
      duration_min: null,
    });
  });

  // THE ARM NO PRODUCT PATH REACHES, asserted so that it cannot rot silently. A live
  // row is opened with a start and nothing in the app clears one, so `startedAt == null`
  // is unreachable from the outside — which is exactly why it is worth pinning: an
  // unread branch that quietly starts returning "still going" would hold a row open
  // forever with no evidence at all behind it. The start is nulled in SQL because that
  // is the only way to reach the state, and the assertion is that an episode with NO
  // readable start is abandoned immediately rather than defaulted to now.
  it("abandons a live row whose start the app cannot read at all", () => {
    const pid = makeProfile("live-unreadable-start");
    setTimezone(pid, "UTC");
    vi.setSystemTime(new Date("2026-08-31T12:00:00Z"));
    const started = startLivePracticeSession(pid, "Sauna", "page");
    expect(started.kind).toBe("started");
    if (started.kind !== "started") return;

    // KEYED ON THE PRIMARY KEY ON PURPOSE, and unscoped by profile for that reason
    // (#5233 review): an id names one row and cannot reach another profile's. Said
    // here so the SQL-shape scans have their answer in the file rather than in an
    // allowlist entry someone has to go and read.
    db.prepare("UPDATE practice_logs SET start_time = NULL WHERE id = ?").run(
      started.session.id
    );

    // No quiet has passed at all — it is the unreadable start, not the elapsed span,
    // that decides this.
    expect(closeAbandonedPracticeSessions(pid)).toBe(1);
    expect(getPracticeSessions(pid, "Sauna")[0]).toMatchObject({
      live: 0,
      start_time: null,
      end_time: null,
      duration_min: null,
    });
  });

  it("closes a carried-over live row as start-only without fabricating values", () => {
    const pid = makeProfile("live-rollover");
    const started = startLivePracticeSession(pid, "Meditation", "page");
    expect(started.kind).toBe("started");
    vi.setSystemTime(new Date("2026-09-01T00:05:00Z"));
    expect(closeAbandonedPracticeSessions(pid)).toBe(1);
    const [row] = getPracticeSessions(pid, "Meditation");
    expect(row).toMatchObject({
      date: "2026-08-31",
      start_time: "12:00",
      end_time: null,
      duration_min: null,
      live: 0,
    });
  });

  it("keeps a notes-only live edit open, but changing its start abandons lifecycle", () => {
    const pid = makeProfile("live-edit");
    const started = startLivePracticeSession(pid, "Sauna", "page");
    expect(started.kind).toBe("started");
    if (started.kind !== "started") return;

    expect(
      updatePracticeSession(pid, started.session.id, {
        date: "2026-08-31",
        startTime: "12:00",
        endTime: null,
        durationMin: null,
        notes: "still running",
      })
    ).toMatchObject({ kind: "updated", session: { live: 1 } });

    expect(
      updatePracticeSession(pid, started.session.id, {
        date: "2026-08-31",
        startTime: "11:55",
        endTime: null,
        durationMin: null,
        notes: "corrected start",
      })
    ).toMatchObject({
      kind: "updated",
      session: { live: 0, start_time: "11:55", end_time: null },
    });
    expect(endLivePracticeSession(pid, started.session.id)).toEqual({
      kind: "not-live",
    });

    const moved = startLivePracticeSession(pid, "Breathwork", "page");
    expect(moved.kind).toBe("started");
    if (moved.kind !== "started") return;
    expect(
      updatePracticeSession(pid, moved.session.id, {
        date: "2026-08-30",
        startTime: "12:00",
        endTime: null,
        durationMin: null,
        notes: null,
      })
    ).toMatchObject({
      kind: "updated",
      session: { date: "2026-08-30", start_time: "12:00", live: 0 },
    });

    const cleared = startLivePracticeSession(pid, "Meditation", "page");
    expect(cleared.kind).toBe("started");
    if (cleared.kind !== "started") return;
    expect(
      updatePracticeSession(pid, cleared.session.id, {
        date: "2026-08-31",
        startTime: null,
        endTime: null,
        durationMin: null,
        notes: null,
      })
    ).toMatchObject({
      kind: "updated",
      session: { start_time: null, live: 0, end_time: null },
    });
  });

  it("abandons a live row from a different local day after a westward zone change", () => {
    const pid = makeProfile("live-westward");
    setTimezone(pid, "Pacific/Kiritimati");
    vi.setSystemTime(new Date("2026-08-31T12:30:00Z")); // Sep 1 at UTC+14
    const started = startLivePracticeSession(pid, "Sauna", "page");
    expect(started).toMatchObject({ kind: "started", date: "2026-09-01" });

    setTimezone(pid, "Pacific/Honolulu"); // Aug 31 at UTC-10
    expect(closeAbandonedPracticeSessions(pid)).toBe(1);
    expect(getPracticeSessions(pid, "Sauna")[0]).toMatchObject({
      date: "2026-09-01",
      live: 0,
      end_time: null,
      duration_min: null,
    });
    expect(startLivePracticeSession(pid, "Sauna", "page").kind).toBe("started");
  });

  it("derives elapsed duration from instants across a DST clock jump", () => {
    const pid = makeProfile("live-dst");
    setTimezone(pid, "America/New_York");
    vi.setSystemTime(new Date("2026-03-08T06:50:00Z")); // 01:50 EST
    const started = startLivePracticeSession(pid, "Sauna", "page");
    expect(started).toMatchObject({
      kind: "started",
      date: "2026-03-08",
      session: { startTime: "01:50" },
    });

    vi.setSystemTime(new Date("2026-03-08T07:10:00Z")); // 03:10 EDT
    expect(
      started.kind === "started"
        ? endLivePracticeSession(pid, started.session.id)
        : null
    ).toMatchObject({
      kind: "ended",
      date: "2026-03-08",
      session: {
        start_time: "01:50",
        end_time: "03:10",
        duration_min: 20,
        live: 0,
      },
    });

    expect(
      logFinishedPracticeSession(pid, "Breathwork", "page", 30)
    ).toMatchObject({ kind: "logged", date: "2026-03-08" });
    expect(getPracticeSessions(pid, "Breathwork")[0]).toMatchObject({
      date: "2026-03-08",
      start_time: "01:40",
      end_time: "03:10",
      duration_min: 30,
      derived_window: 1,
    });

    const repeated = makeProfile("live-dst-repeated-hour");
    setTimezone(repeated, "America/New_York");
    vi.setSystemTime(new Date("2026-11-01T05:50:00Z")); // 01:50 EDT
    const repeatedStart = startLivePracticeSession(repeated, "Sauna", "page");
    vi.setSystemTime(new Date("2026-11-01T06:20:00Z")); // 01:20 EST
    expect(
      repeatedStart.kind === "started"
        ? endLivePracticeSession(repeated, repeatedStart.session.id)
        : null
    ).toMatchObject({
      kind: "ended",
      date: "2026-11-01",
      session: {
        start_time: "01:50",
        end_time: "01:20",
        duration_min: 30,
        live: 0,
      },
    });
  });

  it.each([
    [25, "11:35", "12:00", 25],
    [null, null, "12:00", null],
  ])(
    "Just finished derives only from a visible duration (%s)",
    (duration, start, end, storedDuration) => {
      const pid = makeProfile(`finished-${duration ?? "blank"}`);
      expect(
        logFinishedPracticeSession(pid, "Breathwork", "page", duration)
      ).toMatchObject({ kind: "logged" });
      const [row] = getPracticeSessions(pid, "Breathwork");
      expect(row).toMatchObject({
        start_time: start,
        end_time: end,
        duration_min: storedDuration,
        live: 0,
      });
    }
  );

  it("derives a quick-sheet window from the earlier end the user stated", () => {
    const pid = makeProfile("finished-earlier");
    expect(
      logFinishedPracticeSession(pid, "Sauna", "quick-log", 25, null, {
        date: "2026-08-31",
        time: "07:05",
      })
    ).toMatchObject({ kind: "logged" });
    expect(getPracticeSessions(pid, "Sauna")[0]).toMatchObject({
      date: "2026-08-31",
      start_time: "06:40",
      end_time: "07:05",
      duration_min: 25,
      derived_window: 1,
    });
  });
});

// ---- The edges the lifecycle still loses (#3143 review round two) -----------
//
// Every case here was executed against `origin/main` at 1fb0be27 before the fix and is
// the reason the behaviour above changed. The westward-zone case and the two burst
// barriers already hold on main and are pinned there, so they are not repeated.
describe("a live session survives the edges of its own day", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => vi.useRealTimers());

  it("completes a session that crosses local midnight, on the day it started", () => {
    const pid = makeProfile("live-midnight");
    setTimezone(pid, "UTC");
    vi.setSystemTime(new Date("2026-08-31T23:50:00Z"));
    const started = startLivePracticeSession(pid, "Sauna", "page");
    expect(started.kind).toBe("started");
    if (started.kind !== "started") return;

    vi.setSystemTime(new Date("2026-09-01T00:10:00Z"));
    // Ending is what the second tap MEANS. An evening practice that runs past
    // midnight is the ordinary case, not an abandonment.
    expect(endLivePracticeSession(pid, started.session.id)).toMatchObject({
      kind: "ended",
      date: "2026-08-31",
      session: {
        date: "2026-08-31",
        start_time: "23:50",
        end_time: "00:10",
        duration_min: 20,
        live: 0,
      },
    });
  });

  it("keeps a notes-only edit live after local midnight", () => {
    const pid = makeProfile("live-midnight-notes");
    setTimezone(pid, "UTC");
    vi.setSystemTime(new Date("2026-08-31T23:50:00Z"));
    const started = startLivePracticeSession(pid, "Sauna", "page");
    expect(started.kind).toBe("started");
    if (started.kind !== "started") return;

    vi.setSystemTime(new Date("2026-09-01T00:05:00Z"));
    expect(
      updatePracticeSession(pid, started.session.id, {
        date: "2026-08-31",
        startTime: "23:50",
        endTime: null,
        durationMin: null,
        notes: "still running",
      })
    ).toMatchObject({
      kind: "updated",
      session: {
        date: "2026-08-31",
        start_time: "23:50",
        end_time: null,
        duration_min: null,
        notes: "still running",
        live: 1,
        derived_window: 1,
      },
    });
  });

  it("keeps the End affordance reachable on both surfaces after midnight", () => {
    const pid = makeProfile("live-midnight-surfaces");
    setTimezone(pid, "UTC");
    practiceTarget(pid, "Sauna", 3, null);
    vi.setSystemTime(new Date("2026-08-31T23:50:00Z"));
    expect(startLivePracticeSession(pid, "Sauna", "page").kind).toBe("started");

    vi.setSystemTime(new Date("2026-09-01T00:10:00Z"));
    // The sweep every page gather runs FIRST must spare it: twenty minutes old is a
    // session, whatever day label it carries.
    expect(closeAbandonedPracticeSessions(pid)).toBe(0);
    const asOf = "2026-09-01";
    // Both surfaces render the End button from `liveSession`. A row that answers
    // `ended` but shows no End button is a lifecycle nobody can finish.
    expect(getWellnessPractices(pid, asOf)[0].liveSession).toMatchObject({
      date: "2026-08-31",
      startTime: "23:50",
    });
    expect(getTrackedPractices(pid, asOf)[0].liveSession).toMatchObject({
      date: "2026-08-31",
      startTime: "23:50",
    });
  });

  // The BOUND, which is what lets the two fixes above be safe: once the day
  // comparison stops refusing, only a plausibility limit stands between a forgotten
  // Start and a fabricated multi-day session.
  it("abandons a session left running past the plausibility bound", () => {
    const pid = makeProfile("live-stranded");
    setTimezone(pid, "UTC");
    vi.setSystemTime(new Date("2026-08-30T12:00:00Z"));
    const started = startLivePracticeSession(pid, "Sauna", "page");
    expect(started.kind).toBe("started");
    if (started.kind !== "started") return;

    // 28.5 hours later — the shape that self-healed into a 1710-minute session.
    vi.setSystemTime(new Date("2026-08-31T16:30:00Z"));
    expect(endLivePracticeSession(pid, started.session.id)).toEqual({
      kind: "not-live",
    });
    expect(getPracticeSessions(pid, "Sauna")[0]).toMatchObject({
      date: "2026-08-30",
      start_time: "12:00",
      end_time: null,
      duration_min: null,
      live: 0,
    });
  });
});

describe("a just-finished tap states the day it was tapped on", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => vi.useRealTimers());

  it("files a post-midnight tap on today, not on the day the derived start lands", () => {
    const pid = makeProfile("finished-midnight");
    setTimezone(pid, "UTC");
    vi.setSystemTime(new Date("2026-09-01T00:20:00Z"));
    expect(logFinishedPracticeSession(pid, "Sauna", "page", 45)).toMatchObject({
      kind: "logged",
      date: "2026-09-01",
      count: 1,
    });
    expect(getPracticeDayCount(pid, "Sauna", "2026-09-01")).toBe(1);
    expect(getPracticeDayCount(pid, "Sauna", "2026-08-31")).toBe(0);
    // The only OBSERVED instant is the end. A start that would land on another day
    // cannot be stated by a row that carries one date, so it is not invented.
    expect(getPracticeSessions(pid, "Sauna")[0]).toMatchObject({
      date: "2026-09-01",
      start_time: null,
      end_time: "00:20",
      duration_min: 45,
    });
  });

  it("still writes the derived window when it fits inside the tap's own day", () => {
    const pid = makeProfile("finished-same-day");
    setTimezone(pid, "UTC");
    vi.setSystemTime(new Date("2026-09-01T12:20:00Z"));
    expect(logFinishedPracticeSession(pid, "Sauna", "page", 45)).toMatchObject({
      kind: "logged",
      date: "2026-09-01",
    });
    expect(getPracticeSessions(pid, "Sauna")[0]).toMatchObject({
      date: "2026-09-01",
      start_time: "11:35",
      end_time: "12:20",
      duration_min: 45,
    });
  });

  // THE TELEGRAM DOOR, which is where this was reachable: Done ✅ has no End button
  // beside it, so a second row would double-log the day AND leave the lifecycle open.
  it("ends the open live session instead of opening a second one", () => {
    const pid = makeProfile("finished-while-live");
    setTimezone(pid, "UTC");
    const target = practiceTarget(pid, "Sauna", 3, null);
    vi.setSystemTime(new Date("2026-09-01T12:00:00Z"));
    expect(startLivePracticeSession(pid, "Sauna", "page").kind).toBe("started");

    vi.setSystemTime(new Date("2026-09-01T12:30:00Z"));
    expect(
      logFinishedPracticeByTargetId(pid, target, "telegram-nudge")
    ).toMatchObject({ kind: "logged", count: 1, date: "2026-09-01" });
    const rows = getPracticeSessions(pid, "Sauna");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      start_time: "12:00",
      end_time: "12:30",
      duration_min: 30,
      live: 0,
    });
  });

  it("writes its own session when the open row turns out to be abandoned", () => {
    const pid = makeProfile("finished-while-stale");
    setTimezone(pid, "UTC");
    vi.setSystemTime(new Date("2026-09-01T02:00:00Z"));
    expect(startLivePracticeSession(pid, "Sauna", "page").kind).toBe("started");

    vi.setSystemTime(new Date("2026-09-01T12:00:00Z")); // ten hours later
    expect(logFinishedPracticeSession(pid, "Sauna", "page", 15)).toMatchObject({
      kind: "logged",
      date: "2026-09-01",
    });
    // The abandoned row keeps exactly what was observed; the tap states its own window.
    expect(
      getPracticeSessions(pid, "Sauna").map((row) => [
        row.start_time,
        row.end_time,
        row.live,
      ])
    ).toEqual([
      ["11:45", "12:00", 0],
      ["02:00", null, 0],
    ]);
  });
});
