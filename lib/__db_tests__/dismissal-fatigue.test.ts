// DB INTEGRATION TIER (issue #2386) — repeat dismissal read as an answer, end to end
// over the real `upcoming_dismissals` store and a real coaching finding.
//
// The pure bands live in lib/__tests__/dismissal-fatigue.test.ts. What only this tier
// can prove is that the whole path holds against the actual schema and the actual
// builders: the unique (profile_id, signal_key) index really does fold several
// dismissals inside one raising into one row, a real episode-anchored finding really
// does accumulate a family across separate raisings, and — the one that must not be
// missing — a SAFETY-tier finding is untouched no matter how often it is dismissed.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  dismissFinding,
  getFindingSuppressions,
} from "@/lib/queries/upcoming/suppressions";
import { buildTrainingObservationFindings } from "@/lib/rule-findings";
import {
  STALE_MIN_SESSIONS,
  staleExerciseLegacyKey,
  staleExerciseSignalKey,
} from "@/lib/training-observations";
import {
  RETIRE_AFTER_DISMISSED_RAISINGS,
  QUIET_AFTER_DISMISSED_RAISINGS,
  dismissedRaisings,
  dismissedSignalKeys,
  findingEpisodeFamily,
  findingProminence,
  rankByDismissalFatigue,
  routineOrder,
} from "@/lib/dismissal-fatigue";
import { mentalHealthCrisisItems } from "@/lib/queries/upcoming/intake-safety";
import { upcomingToFinding } from "@/lib/findings";
import { TRAINING_OBS_PREFIX } from "@/lib/training-observations";

const LAPSED_LIFT = "Skullcrusher";

function makeProfile(name: string): { profileId: number; anchor: string } {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  return { profileId, anchor: today(profileId) };
}

// A lift trained enough to be "in rotation" and last touched inside the stale band
// (21…56 days), so buildTrainingObservationFindings raises a real stale finding for it.
function seedLapsedLift(
  profileId: number,
  anchor: string,
  lastDay: number
): void {
  const insAct = db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, duration_min)
       VALUES (?, ?, 'strength', 'Arms', 30)`
  );
  const insSet = db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
       VALUES (?, ?, ?, 30, 10)`
  );
  for (let i = 0; i < STALE_MIN_SESSIONS; i++) {
    const actId = Number(
      insAct.run(profileId, shiftDateStr(anchor, lastDay - i * 7))
        .lastInsertRowid
    );
    insSet.run(actId, LAPSED_LIFT, 1);
  }
}

function staleFinding(profileId: number, anchor: string) {
  const f = buildTrainingObservationFindings(profileId, anchor).find(
    (x) => x.domain === "training-stale"
  );
  if (!f) throw new Error("fixture did not produce a stale finding");
  return f;
}

// Record a dismissal of one PAST raising of the same topic — a separate episode, so a
// separate signal_key, exactly as the engine would have minted it at that time.
function dismissPastRaising(profileId: number, monthAnchor: string): void {
  dismissFinding(profileId, staleExerciseSignalKey(LAPSED_LIFT, monthAnchor));
}

describe("dismissal fatigue over a real coaching finding (#2386)", () => {
  it("de-prioritises a topic declined across separate raisings", () => {
    const { profileId, anchor } = makeProfile("fatigue-quiet");
    seedLapsedLift(profileId, anchor, -30);
    const finding = staleFinding(profileId, anchor);

    // The finding declares an episode anchor, so it has a family to accumulate in.
    expect(finding.dedupeKey.startsWith(`${TRAINING_OBS_PREFIX}stale:`)).toBe(
      true
    );
    expect(findingEpisodeFamily(finding)).toBe(
      staleExerciseLegacyKey(LAPSED_LIFT)
    );

    // Nothing declined yet: it leads.
    expect(
      findingProminence(
        finding,
        dismissedSignalKeys(getFindingSuppressions(profileId))
      )
    ).toBe("routine");

    // Two earlier lapses of the same lift, each raised and each declined.
    dismissPastRaising(profileId, "2025-09");
    dismissPastRaising(profileId, "2026-01");
    expect(QUIET_AFTER_DISMISSED_RAISINGS).toBe(2);
    expect(
      findingProminence(
        finding,
        dismissedSignalKeys(getFindingSuppressions(profileId))
      )
    ).toBe("quiet");

    // De-prioritised, never removed: it still renders, behind everything unfatigued.
    const other = {
      domain: "training-stale",
      title: "Row has gone quiet",
      dedupeKey: staleExerciseSignalKey("Row", "2026-07"),
      supersedes: staleExerciseLegacyKey("Row"),
    };
    const ordered = routineOrder(
      [finding, other],
      getFindingSuppressions(profileId)
    );
    expect(ordered.map((f) => f.dedupeKey)).toEqual([
      other.dedupeKey,
      finding.dedupeKey,
    ]);
  });

  it("retires a sustained pattern from the routine surface, still reachable", () => {
    const { profileId, anchor } = makeProfile("fatigue-retire");
    seedLapsedLift(profileId, anchor, -30);
    const finding = staleFinding(profileId, anchor);

    for (const month of ["2024-11", "2025-03", "2025-08", "2026-02"])
      dismissPastRaising(profileId, month);
    expect(RETIRE_AFTER_DISMISSED_RAISINGS).toBe(4);

    const map = getFindingSuppressions(profileId);
    const ranked = rankByDismissalFatigue([finding], map);
    expect(ranked.routine).toEqual([]);
    expect(ranked.quiet).toEqual([]);
    expect(ranked.onDemand.map((f) => f.dedupeKey)).toEqual([
      finding.dedupeKey,
    ]);

    // Reachable where the user goes looking: the builder still emits it in full, and
    // the shared suppression bus has not been touched — no row was written for it.
    expect(
      buildTrainingObservationFindings(profileId, anchor).map(
        (f) => f.dedupeKey
      )
    ).toContain(finding.dedupeKey);
    expect(map.has(finding.dedupeKey)).toBe(false);
  });

  it("counts raisings, not rows: repeated dismissals inside one raising count once", () => {
    const { profileId, anchor } = makeProfile("fatigue-one-raising");
    seedLapsedLift(profileId, anchor, -30);
    const finding = staleFinding(profileId, anchor);
    const family = findingEpisodeFamily(finding);

    // One raising, declined five times (dismiss → restore → dismiss → …, or simply a
    // repeated tap). The unique index means one row.
    const oneRaising = staleExerciseSignalKey(LAPSED_LIFT, "2025-09");
    for (let i = 0; i < 5; i++) dismissFinding(profileId, oneRaising);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM upcoming_dismissals WHERE profile_id = ? AND signal_key = ?"
        )
        .get(profileId, oneRaising)
    ).toEqual({ n: 1 });

    const keys = dismissedSignalKeys(getFindingSuppressions(profileId));
    expect(dismissedRaisings(family, keys)).toBe(1);
    expect(findingProminence(finding, keys)).toBe("routine");
  });

  it("does not count a snooze as an answer", () => {
    const { profileId, anchor } = makeProfile("fatigue-snooze");
    seedLapsedLift(profileId, anchor, -30);
    const finding = staleFinding(profileId, anchor);

    dismissPastRaising(profileId, "2025-09");
    db.prepare(
      `INSERT INTO upcoming_dismissals (profile_id, signal_key, snooze_until, dismissed_at)
         VALUES (?, ?, ?, NULL)`
    ).run(
      profileId,
      staleExerciseSignalKey(LAPSED_LIFT, "2026-01"),
      shiftDateStr(anchor, 7)
    );

    const keys = dismissedSignalKeys(getFindingSuppressions(profileId));
    expect(dismissedRaisings(findingEpisodeFamily(finding), keys)).toBe(1);
    expect(findingProminence(finding, keys)).toBe("routine");
  });

  it("counts a stored dismissal whose timestamp is null", () => {
    // #2386's data note: a null dismissed_at is a dismissal of unknown date. It is
    // neither discarded nor given an invented date — the count never reads the column.
    const { profileId, anchor } = makeProfile("fatigue-null-stamp");
    seedLapsedLift(profileId, anchor, -30);
    const finding = staleFinding(profileId, anchor);

    const insNullStamp = db.prepare(
      `INSERT INTO upcoming_dismissals (profile_id, signal_key, snooze_until, dismissed_at)
         VALUES (?, ?, NULL, NULL)`
    );
    insNullStamp.run(profileId, staleExerciseSignalKey(LAPSED_LIFT, "2025-09"));
    insNullStamp.run(profileId, staleExerciseSignalKey(LAPSED_LIFT, "2026-01"));

    const keys = dismissedSignalKeys(getFindingSuppressions(profileId));
    expect(dismissedRaisings(findingEpisodeFamily(finding), keys)).toBe(2);
    expect(findingProminence(finding, keys)).toBe("quiet");
  });

  it("resets when the evidence moves: a different topic starts at zero", () => {
    // The #203/#482 re-keying discipline #2386 cites. A dozen declined raisings of one
    // lift's staleness say nothing about a different lift going quiet, and a family is
    // an identity — when the evidence moves the finding to another one, the count is 0.
    const { profileId, anchor } = makeProfile("fatigue-reset");
    seedLapsedLift(profileId, anchor, -30);

    for (const month of ["2024-11", "2025-03", "2025-08", "2026-02"])
      dismissPastRaising(profileId, month);

    const moved = {
      domain: "training-stale",
      title: "Front Squat has gone quiet",
      dedupeKey: staleExerciseSignalKey("Front Squat", "2026-07"),
      supersedes: staleExerciseLegacyKey("Front Squat"),
    };
    const keys = dismissedSignalKeys(getFindingSuppressions(profileId));
    expect(dismissedRaisings(findingEpisodeFamily(moved), keys)).toBe(0);
    expect(findingProminence(moved, keys)).toBe("routine");
  });
});

describe("the safety floor is absolute (#2386)", () => {
  // A PHQ-9 in the severe band raises the NON-DISMISSIBLE crisis finding (#716):
  // suppressionPolicy "safety-ungated", so the bus can never hide it.
  function seedCrisis(name: string): { profileId: number; anchor: string } {
    const { profileId, anchor } = makeProfile(name);
    // Synthetic score on a fictional profile — no PHI.
    db.prepare(
      `INSERT INTO medical_records
         (date, category, name, value, value_num, unit, canonical_name, profile_id)
       VALUES (?, 'instrument', 'PHQ-9', '22', 22, NULL, 'PHQ-9', ?)`
    ).run(shiftDateStr(anchor, -2), profileId);
    return { profileId, anchor };
  }

  it("never quiets a safety-ungated finding, however often it is dismissed", () => {
    const { profileId } = seedCrisis("fatigue-safety-crisis");
    const items = mentalHealthCrisisItems(profileId);
    expect(items).toHaveLength(1);
    const crisis = upcomingToFinding(items[0]);
    expect(crisis.suppressionPolicy).toBe("safety-ungated");

    // Dismiss its own key and a long run of sibling episodes of the same topic — far
    // past the retirement threshold. (The UI renders no dismiss control for it at all;
    // these rows stand in for every way one could reach the store.)
    const family = crisis.dedupeKey.slice(0, crisis.dedupeKey.lastIndexOf(":"));
    dismissFinding(profileId, crisis.dedupeKey);
    for (let i = 0; i < 12; i++)
      dismissFinding(profileId, `${family}:decline${i}`);

    const map = getFindingSuppressions(profileId);
    const ranked = rankByDismissalFatigue([crisis], map);
    expect(ranked.routine.map((f) => f.dedupeKey)).toEqual([crisis.dedupeKey]);
    expect(ranked.quiet).toEqual([]);
    expect(ranked.onDemand).toEqual([]);
    expect(routineOrder([crisis], map).map((f) => f.dedupeKey)).toEqual([
      crisis.dedupeKey,
    ]);
  });

  it("never quiets an item whose policy resists a dismiss (snooze-only care)", () => {
    const { profileId, anchor } = makeProfile("fatigue-safety-persistent");
    // A care-persistent item derives "snooze-only": a dismiss is RESISTED, so however
    // many are recorded they are not an answer about it.
    const persistent = upcomingToFinding({
      key: "followup:9001:2026-08",
      domain: "followup",
      title: "Overdue follow-up",
      href: "/records",
      dueDate: shiftDateStr(anchor, -30),
      carePersistent: true,
    });
    persistent.supersedes = "followup:9001";
    expect(persistent.suppressionPolicy).toBe("snooze-only");

    for (const n of ["2025-01", "2025-06", "2026-01", "2026-04", "2026-06"])
      dismissFinding(profileId, `followup:9001:${n}`);

    const map = getFindingSuppressions(profileId);
    expect(
      dismissedRaisings(
        findingEpisodeFamily(persistent),
        dismissedSignalKeys(map)
      )
    ).toBe(5);
    // The count is real; the response is not. A resisted dismiss is not an answer.
    expect(rankByDismissalFatigue([persistent], map).routine).toHaveLength(1);
  });
});
