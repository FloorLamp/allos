// DB INTEGRATION TIER (issue #1670): the frequency-target right-sizing loop end-to-end
// against the real schema, once per domain that declares a floor in `frequency_targets`
// — a wellness practice, a training frequency goal, and a food-group habit.
//
// The #448 builder-over-fixture obligation is discharged here: each domain gets a
// realistic fixture, is asserted through buildTargetRightSizeFindings, and its dedupeKey
// is asserted to carry the REGISTERED prefix and resolve the registered COACHING tier.
// Beyond that, the three properties the whole feature rests on are pinned directly:
// accepting lands in the domain's own no-expectation state, the ledger survives it, and
// nothing writes a floor without a user action.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setWeekMode } from "@/lib/settings";
import {
  getFrequencyTargetProgress,
  getFrequencyTargetWeeklyHistory,
  getWellnessPractices,
  getPracticeSessions,
  dismissFinding,
  getFindingSuppressions,
} from "@/lib/queries";
import { activeFindings } from "@/lib/findings";
import {
  buildTargetRightSizeFindings,
  collectRightSizeCandidates,
  collectCoachingFindings,
} from "@/lib/rule-findings";
import {
  lowerFrequencyTargetFloor,
  stopTrackingFrequencyTarget,
} from "@/lib/target-rightsize-write";
import {
  RIGHTSIZE_PREFIX,
  RIGHTSIZE_WEEKS,
  rightSizeSignalKey,
} from "@/lib/target-rightsize";
import { tierForDedupeKey } from "@/lib/rule-finding-prefixes";
import { logPracticeSession } from "@/lib/queries";
import { practiceIdentity } from "@/lib/practice";
import { buildPracticeReminder } from "@/lib/notifications/practices";
import { rightSizeLowerCallback } from "@/lib/notifications/callback-data";

// The frozen clock: a Wednesday, so the rolling week window used throughout is simply
// the trailing seven days and every offset below reads as "N days ago".
const NOW = new Date("2026-06-17T12:00:00Z");

function makeProfile(name: string): number {
  const pid = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  // Rolling mode makes the week window the trailing 7 days, so the completed-week
  // buckets below are exact 7-day blocks counted back from today.
  setWeekMode(pid, "rolling");
  return pid;
}

function dayBack(pid: number, back: number): string {
  return shiftDateStr(today(pid), -back);
}

// A target created well before the window opens. `created_at` MUST be set explicitly:
// the column defaults to SQLite's own `datetime('now')`, which the fake JS clock does
// not move, so a defaulted row would look younger than the window and be excluded by
// the cold-start guard.
function makeTarget(
  profileId: number,
  kind: string,
  value: string,
  floor: number
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO frequency_targets
           (profile_id, scope_kind, scope_value, scope_identity, per_week, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        kind,
        value,
        kind === "practice" ? practiceIdentity(value) : null,
        floor,
        `${dayBack(profileId, 200)} 08:00:00`
      ).lastInsertRowid
  );
}

function logActivity(profileId: number, date: string, type: string): void {
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, source)
     VALUES (?, ?, ?, 'Session', 'manual')`
  ).run(profileId, date, type);
}

function logFood(
  profileId: number,
  date: string,
  group: string,
  servings: number
): void {
  db.prepare(
    "INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, ?)"
  ).run(profileId, date, group, servings);
}

// The only right-size finding for this profile (the fixtures below each own exactly
// one target, so a second finding would be a bug rather than shared-seed noise).
function soleFinding(profileId: number) {
  const findings = buildTargetRightSizeFindings(profileId, today(profileId));
  expect(findings).toHaveLength(1);
  return findings[0];
}

describe("frequency-target right-sizing (#1670)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- The weekly-history read ------------------------------------------

  it("reads COMPLETED weeks only, oldest first, and never the in-progress one", () => {
    const pid = makeProfile("rs-history");
    makeTarget(pid, "practice", "Meditation", 3);
    // One session in each completed week, plus two in the CURRENT week — which must
    // not appear anywhere in the history (a partial week is under its floor by
    // construction, so counting it would make almost every target look chronic).
    for (const back of [30, 24, 17, 10]) {
      logPracticeSession(pid, "Meditation", dayBack(pid, back));
    }
    logPracticeSession(pid, "Meditation", dayBack(pid, 1));
    logPracticeSession(pid, "Meditation", today(pid));

    const [history] = getFrequencyTargetWeeklyHistory(pid, RIGHTSIZE_WEEKS);
    expect(history.weeks.map((w) => w.count)).toEqual([1, 1, 1, 1]);
    expect(history.weeks.map((w) => w.start)).toEqual([
      dayBack(pid, 34),
      dayBack(pid, 27),
      dayBack(pid, 20),
      dayBack(pid, 13),
    ]);
    expect(history.existedWholeWindow).toBe(true);
    // The current week's two sessions are visible where they belong.
    expect(
      getFrequencyTargetProgress(pid).find(
        (p) => p.target.scope_kind === "practice"
      )!.count
    ).toBe(2);
  });

  it("excludes a target younger than the window (cold start)", () => {
    const pid = makeProfile("rs-young");
    const tid = makeTarget(pid, "practice", "Breathwork", 4);
    db.prepare("UPDATE frequency_targets SET created_at = ? WHERE id = ?").run(
      `${dayBack(pid, 10)} 08:00:00`,
      tid
    );

    expect(
      getFrequencyTargetWeeklyHistory(pid, RIGHTSIZE_WEEKS)[0]
        .existedWholeWindow
    ).toBe(false);
    expect(buildTargetRightSizeFindings(pid, today(pid))).toEqual([]);
  });

  // ---- Domain 1: wellness practice ---------------------------------------

  it("suggests a practice's observed cadence, and accepting lands in logs-only", () => {
    const pid = makeProfile("rs-practice");
    const tid = makeTarget(pid, "practice", "Sauna", 4);
    // One session a week for four completed weeks against a 4×/week goal.
    for (const back of [30, 24, 17, 10])
      logPracticeSession(pid, "Sauna", dayBack(pid, back));

    const finding = soleFinding(pid);
    expect(finding.dedupeKey).toBe(rightSizeSignalKey(tid, "2026"));
    expect(finding.dedupeKey.startsWith(RIGHTSIZE_PREFIX)).toBe(true);
    expect(tierForDedupeKey(finding.dedupeKey)).toBe("coaching");
    expect(finding.title).toContain("Sauna");
    expect(finding.detail).toContain("1×");
    expect(finding.evidence).toContain("4 sessions");
    // It joins the ONE coaching set, so the dashboard rollup and the coaching tab get
    // it without a second registration.
    expect(
      collectCoachingFindings(pid, today(pid), "kg").map((f) => f.dedupeKey)
    ).toContain(finding.dedupeKey);

    // Accepting "stop tracking" lands in the #1621 logs-only posture: the practice is
    // still a card, still has its history, and simply has no weekly goal.
    expect(stopTrackingFrequencyTarget(pid, tid)).toBe("stopped");
    expect(getPracticeSessions(pid, "Sauna")).toHaveLength(4);
    expect(getWellnessPractices(pid)).toMatchObject([
      { name: "Sauna", targetId: null, perWeek: null, sessionCount: 4 },
    ]);
    expect(buildTargetRightSizeFindings(pid, today(pid))).toEqual([]);
  });

  it("lowers a practice floor to the best week and the suggestion self-clears", () => {
    const pid = makeProfile("rs-practice-lower");
    const tid = makeTarget(pid, "practice", "Cold plunge", 5);
    // Best completed week is two sessions.
    for (const back of [30, 24, 23, 17, 10])
      logPracticeSession(pid, "Cold plunge", dayBack(pid, back));

    const [candidate] = collectRightSizeCandidates(pid, today(pid));
    expect(candidate.suggestedFloor).toBe(2);

    expect(lowerFrequencyTargetFloor(pid, tid, 2)).toBe("lowered");
    expect(
      db.prepare("SELECT per_week FROM frequency_targets WHERE id = ?").get(tid)
    ).toEqual({ per_week: 2 });
    // Every logged session survives, and the suggestion is gone because the window it
    // was computed over now clears the new floor — no dismissal bookkeeping needed.
    expect(getPracticeSessions(pid, "Cold plunge")).toHaveLength(5);
    expect(buildTargetRightSizeFindings(pid, today(pid))).toEqual([]);
  });

  // ---- Domain 2: training frequency goal ---------------------------------

  it("suggests a training routine's observed cadence, and accepting untracks it", () => {
    const pid = makeProfile("rs-training");
    const tid = makeTarget(pid, "type", "cardio", 4);
    for (const back of [30, 24, 17, 10])
      logActivity(pid, dayBack(pid, back), "cardio");

    const finding = soleFinding(pid);
    expect(tierForDedupeKey(finding.dedupeKey)).toBe("coaching");
    expect(finding.title).toContain("Cardio");
    expect(finding.evidence).toContain("4 days");
    expect(finding.actionHref).toBe("/training?tab=goals");

    expect(stopTrackingFrequencyTarget(pid, tid)).toBe("stopped");
    expect(
      db.prepare("SELECT 1 FROM frequency_targets WHERE id = ?").get(tid)
    ).toBeUndefined();
    // The sessions the routine measured are untouched — a target is a commitment, not
    // a container.
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM activities WHERE profile_id = ? AND type = 'cardio'"
        )
        .get(pid)
    ).toEqual({ n: 4 });
  });

  it("nulls a protocol's link before removing the target it measured", () => {
    const pid = makeProfile("rs-training-protocol");
    const tid = makeTarget(pid, "type", "cardio", 4);
    for (const back of [30, 24, 17, 10])
      logActivity(pid, dayBack(pid, back), "cardio");
    db.prepare(
      `INSERT INTO protocols
         (profile_id, name, start_date, frequency_target_id, owns_frequency_target)
       VALUES (?, 'Zone 2 block', ?, ?, 0)`
    ).run(pid, dayBack(pid, 60), tid);

    expect(stopTrackingFrequencyTarget(pid, tid)).toBe("stopped");
    expect(
      db
        .prepare(
          "SELECT frequency_target_id FROM protocols WHERE profile_id = ?"
        )
        .get(pid)
    ).toEqual({ frequency_target_id: null });
  });

  // ---- Domain 3: food group ----------------------------------------------

  it("suggests a food habit's observed servings, and accepting untracks the habit", () => {
    const pid = makeProfile("rs-food");
    const tid = makeTarget(pid, "food_group", "leafy_greens", 14);
    // Under a quarter of the target every completed week; the best week is 4 servings.
    for (const [back, n] of [
      [30, 3],
      [24, 4],
      [17, 2],
      [10, 3],
    ] as const)
      logFood(pid, dayBack(pid, back), "leafy_greens", n);

    const finding = soleFinding(pid);
    expect(tierForDedupeKey(finding.dedupeKey)).toBe("coaching");
    expect(finding.title).toContain("Leafy greens");
    expect(finding.evidence).toContain("12 servings");
    expect(finding.detail).toContain("4×");
    expect(finding.detail).toContain("food log");

    expect(stopTrackingFrequencyTarget(pid, tid)).toBe("stopped");
    // The food log — the actual record of what was eaten — is untouched.
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM food_log WHERE profile_id = ? AND group_key = 'leafy_greens'"
        )
        .get(pid)
    ).toEqual({ n: 4 });
  });

  // ---- Recovery, exclusions, and the typed refusals -----------------------

  it("clears the suggestion the moment one week meets the floor", () => {
    const pid = makeProfile("rs-recovery");
    makeTarget(pid, "practice", "Meditation", 2);
    for (const back of [30, 24, 17, 10])
      logPracticeSession(pid, "Meditation", dayBack(pid, back));
    expect(buildTargetRightSizeFindings(pid, today(pid))).toHaveLength(1);

    // A second session in the most recent completed week takes it to the floor.
    logPracticeSession(pid, "Meditation", dayBack(pid, 9));
    expect(buildTargetRightSizeFindings(pid, today(pid))).toEqual([]);
  });

  it("never suggests right-sizing a substance CAP", () => {
    const pid = makeProfile("rs-substance");
    makeTarget(pid, "substance", "alcohol", 7);
    expect(buildTargetRightSizeFindings(pid, today(pid))).toEqual([]);
  });

  it("refuses a target belonging to another profile", () => {
    const mine = makeProfile("rs-mine");
    const theirs = makeProfile("rs-theirs");
    const tid = makeTarget(theirs, "practice", "Sauna", 4);
    for (const back of [30, 24, 17, 10])
      logPracticeSession(theirs, "Sauna", dayBack(theirs, back));

    expect(lowerFrequencyTargetFloor(mine, tid, 1)).toBe("not-found");
    expect(stopTrackingFrequencyTarget(mine, tid)).toBe("not-found");
    // The other profile's commitment is exactly as it was.
    expect(
      db.prepare("SELECT per_week FROM frequency_targets WHERE id = ?").get(tid)
    ).toEqual({ per_week: 4 });
  });

  it("refuses a floor that would not be a reduction (downward only, at the write)", () => {
    const pid = makeProfile("rs-downward");
    const tid = makeTarget(pid, "practice", "Sauna", 3);
    expect(lowerFrequencyTargetFloor(pid, tid, 3)).toBe("already-lower");
    expect(lowerFrequencyTargetFloor(pid, tid, 9)).toBe("already-lower");
    expect(lowerFrequencyTargetFloor(pid, tid, 0)).toBe("already-lower");
    expect(
      db.prepare("SELECT per_week FROM frequency_targets WHERE id = ?").get(tid)
    ).toEqual({ per_week: 3 });
  });

  it("hides a dismissed suggestion through the shared bus without touching the target", () => {
    const pid = makeProfile("rs-dismiss");
    const tid = makeTarget(pid, "practice", "Sauna", 4);
    for (const back of [30, 24, 17, 10])
      logPracticeSession(pid, "Sauna", dayBack(pid, back));

    const finding = soleFinding(pid);
    dismissFinding(pid, finding.dedupeKey);
    expect(
      activeFindings(
        buildTargetRightSizeFindings(pid, today(pid)),
        getFindingSuppressions(pid),
        today(pid)
      )
    ).toEqual([]);
    // "Keep as is" is not a write: the commitment is untouched.
    expect(
      db.prepare("SELECT per_week FROM frequency_targets WHERE id = ?").get(tid)
    ).toEqual({ per_week: 4 });
  });

  // ---- The notification ride-along (#1670) -------------------------------

  describe("the practice nudge ride-along", () => {
    // The whole push contract in one place: the suggestion NEVER originates a send. It
    // only decorates the pace nudge that was already firing because the practice is
    // behind THIS week — and it appears there only once the shortfall has been chronic.
    it("adds no button before the threshold and originates no message of its own", () => {
      const pid = makeProfile("rs-nudge-quiet");
      makeTarget(pid, "practice", "Sauna", 2);
      // Behind THIS week (nothing logged yet against a floor of two), so the pace nudge
      // fires — but the most recent completed week met the floor, so there is no
      // chronic shortfall and nothing to right-size.
      for (const back of [10, 9])
        logPracticeSession(pid, "Sauna", dayBack(pid, back));

      const msg = buildPracticeReminder(pid, "nonce");
      expect(msg).not.toBeNull();
      expect(
        (msg?.actions ?? []).filter((a) =>
          String(a.data ?? "").startsWith("rslower:")
        )
      ).toEqual([]);
    });

    it("rides the nudge past the threshold, and the accept stops the nudge", () => {
      const pid = makeProfile("rs-nudge-ride");
      const tid = makeTarget(pid, "practice", "Sauna", 4);
      for (const back of [30, 24, 17, 10])
        logPracticeSession(pid, "Sauna", dayBack(pid, back));
      // One session this week keeps the practice behind, so the pace nudge fires.
      logPracticeSession(pid, "Sauna", today(pid));

      const msg = buildPracticeReminder(pid, "nonce");
      const ride = (msg?.actions ?? []).find(
        (a) => a.data === rightSizeLowerCallback(pid, tid)
      );
      expect(ride).toBeDefined();
      expect(ride!.label).toContain("1×/wk");

      // Accepting takes the floor to the cadence actually kept — which this week's
      // single session already meets, so the nudge has nothing left to say.
      expect(lowerFrequencyTargetFloor(pid, tid, 1)).toBe("lowered");
      expect(buildPracticeReminder(pid, "nonce")).toBeNull();
    });

    it("keeps the ride-along on a message a dismissed CARD would not stop", () => {
      // An in-app dismiss means "keep asking me about this practice" — a statement
      // about the card, not about whether a message already being sent may offer to
      // shrink the commitment. The button is governed by detection state alone.
      const pid = makeProfile("rs-nudge-dismissed");
      const tid = makeTarget(pid, "practice", "Sauna", 4);
      for (const back of [30, 24, 17, 10])
        logPracticeSession(pid, "Sauna", dayBack(pid, back));
      logPracticeSession(pid, "Sauna", today(pid));

      dismissFinding(pid, rightSizeSignalKey(tid, "2026"));
      expect(
        (buildPracticeReminder(pid, "nonce")?.actions ?? []).map((a) => a.data)
      ).toContain(rightSizeLowerCallback(pid, tid));
    });
  });
});
