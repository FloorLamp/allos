// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Issue #923 — the two DB gathers the strength editor reads: getFormDeloadContext
// (whether the active routine's deload week shaves this lift's next-set suggestion) and
// buildActivePlateauHints (the calm inline plateau hint, a findings builder per #448).
// Both reuse the SAME gathers the Training-watch / session-card surfaces read, so the
// form can't disagree with them; these seed realistic rows and assert the wiring.
//
// Runs via `npm run test:db` (vitest.db.config.ts). The `db` singleton points at a
// throwaway per-file temp DB (lib/__db_tests__/setup.ts).

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  createCustomRoutine,
  activateRoutine,
  getFormDeloadContext,
} from "@/lib/routines";
import { buildActivePlateauHints } from "@/lib/rule-findings";
import { dismissFinding, restoreFinding } from "@/lib/queries";
import { exerciseHistoryKey } from "@/lib/lifts";
import { TRAINING_OBS_PREFIX } from "@/lib/training-observations";

function makeProfile(name: string): { profileId: number; anchor: string } {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  return { profileId, anchor: today(profileId) };
}

// An active routine whose cycle places `anchor` in `weekOffset % cycleWeeks`. The one
// day carries two candidate slots so the key set is more than a single lift.
function seedCycledRoutine(
  profileId: number,
  anchor: string,
  cycleWeeks: number,
  weekOffset: number
): number {
  const rid = createCustomRoutine(profileId, {
    name: "Push cycle",
    cycleWeeks,
    days: [
      {
        label: "Push",
        focus: ["Chest"],
        slots: [
          {
            candidates: ["Barbell Bench Press", "Bench Press"],
            sets: 4,
            repMin: 5,
            repMax: 8,
          },
          { candidates: ["Overhead Press"], sets: 3, repMin: 5, repMax: 8 },
        ],
      },
    ],
  });
  activateRoutine(profileId, rid);
  db.prepare(`UPDATE routines SET started_date = ? WHERE id = ?`).run(
    shiftDateStr(anchor, -7 * weekOffset),
    rid
  );
  return rid;
}

// Seed a flat plateau for `exercise`: four fixed-load sessions spanning >21 days inside
// the 42-day plateau window → flat e1RM + flat reps → a plateau finding.
function seedFlatPlateau(
  profileId: number,
  anchor: string,
  exercise: string
): void {
  const insAct = db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, duration_min)
       VALUES (?, ?, 'strength', 'Session', 30)`
  );
  const insSet = db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
       VALUES (?, ?, 1, 30, 5)`
  );
  for (const day of [-35, -28, -14, 0]) {
    const actId = Number(
      insAct.run(profileId, shiftDateStr(anchor, day)).lastInsertRowid
    );
    insSet.run(actId, exercise);
  }
}

describe("getFormDeloadContext (#923)", () => {
  it("in the deload week, returns the routine's candidate keys (variant-collapsed)", () => {
    const { profileId, anchor } = makeProfile("form-deload");
    seedCycledRoutine(profileId, anchor, 2, 1); // week 1 of 2 = deload
    const ctx = getFormDeloadContext(profileId, anchor);
    expect(ctx.isDeloadWeek).toBe(true);
    // Both bench spellings collapse to ONE canonical key; the OHP is its own.
    expect(ctx.routineKeys).toContain(
      exerciseHistoryKey("Barbell Bench Press")
    );
    expect(ctx.routineKeys).toContain(exerciseHistoryKey("Bench Press"));
    expect(exerciseHistoryKey("Barbell Bench Press")).toBe(
      exerciseHistoryKey("Bench Press")
    );
    expect(ctx.routineKeys).toContain(exerciseHistoryKey("Overhead Press"));
    // A lift outside the routine is never in the shave set.
    expect(ctx.routineKeys).not.toContain(exerciseHistoryKey("Skullcrusher"));
  });

  it("off the deload week the shave set is empty (no shaving)", () => {
    const { profileId, anchor } = makeProfile("form-nondeload");
    seedCycledRoutine(profileId, anchor, 4, 0); // week 0 of 4 = not deload
    const ctx = getFormDeloadContext(profileId, anchor);
    expect(ctx.isDeloadWeek).toBe(false);
    expect(ctx.routineKeys).toEqual([]);
  });

  it("with no active routine, it's byte-for-byte the prior behavior", () => {
    const { profileId, anchor } = makeProfile("form-noroutine");
    expect(getFormDeloadContext(profileId, anchor)).toEqual({
      isDeloadWeek: false,
      routineKeys: [],
    });
  });
});

describe("buildActivePlateauHints (#923)", () => {
  it("returns the active plateau keyed by exerciseHistoryKey, sharing the finding's dedupeKey", () => {
    const { profileId, anchor } = makeProfile("form-plateau");
    seedFlatPlateau(profileId, anchor, "Skullcrusher");
    const hints = buildActivePlateauHints(profileId, anchor);
    expect(hints).toHaveLength(1);
    expect(hints[0].exerciseKey).toBe(exerciseHistoryKey("Skullcrusher"));
    expect(
      hints[0].dedupeKey.startsWith(`${TRAINING_OBS_PREFIX}plateau:`)
    ).toBe(true);
    // The legacy (episode-less) key is carried for the #436 dual-read.
    expect(hints[0].supersedes).toBe(
      `${TRAINING_OBS_PREFIX}plateau:skullcrusher`
    );
  });

  it("a dismissal on the shared bus removes it (dismiss once, silence everywhere)", () => {
    const { profileId, anchor } = makeProfile("form-plateau-dismiss");
    seedFlatPlateau(profileId, anchor, "Skullcrusher");
    const [hint] = buildActivePlateauHints(profileId, anchor);
    expect(hint).toBeTruthy();

    dismissFinding(profileId, hint.dedupeKey);
    expect(buildActivePlateauHints(profileId, anchor)).toEqual([]);

    // Restoring it (un-dismiss) brings the hint back.
    restoreFinding(profileId, hint.dedupeKey);
    expect(buildActivePlateauHints(profileId, anchor)).toHaveLength(1);
  });

  it("no plateau → no hint", () => {
    const { profileId, anchor } = makeProfile("form-noplateau");
    expect(buildActivePlateauHints(profileId, anchor)).toEqual([]);
  });
});
