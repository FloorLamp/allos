// DB INTEGRATION TIER (#2579, owner ruling 1): WHICH weekly floor targets reach the
// planning ledger.
//
// `trainingItems` filtered `!met`; `practiceItems` filtered `!met && !atCeiling &&
// pace === "behind"`. The asymmetry was real and undecided, and the owner ruled
// SURFACE ALL UNMET for both — /upcoming is the planning ledger and completeness is
// its charter, so a target absent because it happens to be on pace reads as missing.
//
// Exercised against the real schema because "on pace but not met" is a property of
// the profile's WEEK WINDOW (how much of it has elapsed) and of the logs inside it —
// stored state the pure pace helper is only handed the summary of.

import { describe, it, expect } from "vitest";
import { shiftDateStr, weekdayOfDateStr } from "@/lib/date";
import { db, today } from "@/lib/db";
import { practiceItems, trainingItems } from "@/lib/queries/upcoming/plans";
import { getFrequencyTargetProgress } from "@/lib/queries";
import { practiceIdentity, practiceSignalKey } from "@/lib/practice";
import { setWeekMode, setWeekStart, type WeekStart } from "@/lib/settings";
import { trainingSignalKey } from "@/lib/workout-nudge";

// A profile whose week window STARTS TODAY. That is the whole fixture: with one day
// elapsed of seven, a target owes `floor * 1/7` rounded down — zero — so a target with
// nothing logged is genuinely ON PACE and genuinely NOT MET at the same time. In
// rolling mode that state cannot exist (the window is always fully elapsed, so on-pace
// and met are the same question), which is exactly why this test sets calendar mode
// rather than borrowing the identity suite's rolling fixture.
function makeProfile(name: string): { profileId: number; anchor: string } {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setWeekMode(profileId, "calendar");
  const anchor = today(profileId);
  setWeekStart(profileId, weekdayOfDateStr(anchor) as WeekStart);
  return { profileId, anchor };
}

function addTarget(
  profileId: number,
  scopeKind: string,
  scopeValue: string,
  perWeek: number,
  perWeekMax: number | null = null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO frequency_targets
           (profile_id, scope_kind, scope_value, per_week, per_week_max, scope_identity)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        scopeKind,
        scopeValue,
        perWeek,
        perWeekMax,
        scopeKind === "practice" ? practiceIdentity(scopeValue) : null
      ).lastInsertRowid
  );
}

function logPractice(profileId: number, name: string, date: string): void {
  db.prepare(
    "INSERT INTO practice_logs (profile_id, practice, date) VALUES (?, ?, ?)"
  ).run(profileId, name, date);
}

describe("every unmet weekly target reaches the ledger (#2579 ruling 1)", () => {
  it("an ON-PACE practice target renders — the pace gate is gone", () => {
    const { profileId } = makeProfile("wtc-onpace-practice");
    const id = addTarget(profileId, "practice", "Cold plunge", 3);

    // The fixture states what it is testing rather than assuming it: nothing logged,
    // one day of the week elapsed, so this target is under its floor and keeping up.
    const progress = getFrequencyTargetProgress(profileId).find(
      (p) => p.target.id === id
    );
    expect(progress).toBeDefined();
    expect(progress!.met).toBe(false);
    expect(progress!.atCeiling).toBe(false);
    expect(progress!.pace).toBe("on-pace");

    const item = practiceItems(profileId).find(
      (i) => i.key === practiceSignalKey(id)
    );
    expect(item).toBeDefined();
    expect(item!.domain).toBe("practice");
    expect(item!.band).toBe("week");
    expect(item!.dueText).toBe("0/3 this week");
  });

  it("practice and training answer the SAME question about the same week", () => {
    // The asymmetry, stated as the symmetry that replaced it. Two targets in one
    // profile, both unmet, both on pace: before the ruling the training one rendered
    // and the practice one did not, for no reason either row could have explained.
    const { profileId } = makeProfile("wtc-symmetry");
    const practiceId = addTarget(profileId, "practice", "Sauna", 3);
    const trainingId = addTarget(profileId, "region", "Chest", 3);

    for (const id of [practiceId, trainingId]) {
      const p = getFrequencyTargetProgress(profileId).find(
        (x) => x.target.id === id
      );
      expect(p!.met).toBe(false);
      expect(p!.pace).toBe("on-pace");
    }

    expect(
      practiceItems(profileId).some(
        (i) => i.key === practiceSignalKey(practiceId)
      )
    ).toBe(true);
    expect(
      trainingItems(profileId).some(
        (i) => i.key === trainingSignalKey(trainingId)
      )
    ).toBe(true);
  });

  it("a BEHIND practice target still renders, with its range in the due-text", () => {
    // The old gate's own case has to keep working — widening a filter must not move
    // what was already inside it. Five days into the week with nothing logged is
    // behind on a 3×/week floor.
    const { profileId, anchor } = makeProfile("wtc-behind-practice");
    setWeekStart(profileId, ((weekdayOfDateStr(anchor) + 3) % 7) as WeekStart);
    const id = addTarget(profileId, "practice", "Red light", 3, 5);

    const progress = getFrequencyTargetProgress(profileId).find(
      (p) => p.target.id === id
    );
    expect(progress!.pace).toBe("behind");

    const item = practiceItems(profileId).find(
      (i) => i.key === practiceSignalKey(id)
    );
    expect(item).toBeDefined();
    expect(item!.dueText).toBe("0/3–5 this week");
  });

  it("a target at its weekly ceiling stays quiet — plenty is not a shortfall", () => {
    // #1259's calm range state survives the ruling: `atCeiling` is excluded because
    // met-by-another-name is not unmet. On well-formed data a ceiling sits at or above
    // the floor, so reaching it also meets the floor — the row's absence is the
    // observable, and it is the one the user sees.
    const { profileId, anchor } = makeProfile("wtc-ceiling");
    // Two days back into the window, because a practice week counts DISTINCT LOGGED
    // DAYS: two sessions on one date are one day, and the ceiling would never be hit.
    setWeekStart(profileId, ((weekdayOfDateStr(anchor) + 5) % 7) as WeekStart);
    const id = addTarget(profileId, "practice", "Breath work", 1, 2);
    logPractice(profileId, "Breath work", anchor);
    logPractice(profileId, "Breath work", shiftDateStr(anchor, -1));

    const progress = getFrequencyTargetProgress(profileId).find(
      (p) => p.target.id === id
    );
    expect(progress!.atCeiling).toBe(true);

    expect(
      practiceItems(profileId).some((i) => i.key === practiceSignalKey(id))
    ).toBe(false);
  });
});
