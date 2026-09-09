// Record timestamps and captured-time validation use the app clock.
// ALLOS_TEST_NOW deliberately leads the tier's frozen Date by 58 minutes, so a
// bare Date or SQLite timestamp cannot satisfy the app-clock contract by accident.
// Ordinary fixtures use vi.setSystemTime; this file needs two different clocks.

import { beforeEach, describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { now as clockNow } from "@/lib/clock";
import { utcSqlString } from "@/lib/date";
import { toKm } from "@/lib/units";
import { saveActivityCore } from "@/lib/activity-write";
import { logMobilityMoveCore } from "@/lib/mobility-log-write";
import { finishWorkoutSession } from "@/lib/workout-finish";
import { upsertActivities } from "@/lib/integrations/normalize";
import { getWorkoutPresence } from "@/lib/queries/presence";
import { applyIntent } from "@/lib/offline/writes";
import { buildIntent } from "@/lib/__tests__/queued-intent-fixture";
import { EPISODE_BOUNDS } from "@/lib/open-episode";

const STALE_MIN = EPISODE_BOUNDS.workout.staleMin;
import { setProfileBirthdate } from "@/lib/settings/profile-attrs";

// The gap the freeze nudge produces for a run starting at 23:32Z (nudged to
// midnight + 30). Deliberately larger than STALE_MIN so a stamp on the wrong clock
// cannot pass by luck.
const NUDGE_GAP_MIN = 58;

beforeEach(() => {
  process.env.ALLOS_TEST_NOW = new Date(
    Date.now() + NUDGE_GAP_MIN * 60_000
  ).toISOString();
});

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setProfileBirthdate(id, "1990-01-01");
  return id;
}

function stamps(activityId: number): {
  created_at: string;
  updated_at: string | null;
} {
  return db
    .prepare("SELECT created_at, updated_at FROM activities WHERE id = ?")
    .get(activityId) as { created_at: string; updated_at: string | null };
}

// The live-draft signature computeWorkoutPresence reads as `active`: a started,
// un-ended, duration-less manual session on today.
function liveDraftForm(profileId: number, id?: number): FormData {
  const fd = new FormData();
  if (id != null) fd.set("id", String(id));
  fd.set("type", "strength");
  fd.set("title", "Draft session");
  fd.set("date", today(profileId));
  fd.set("start_time", "09:00");
  return fd;
}

describe("activities record instants come off the clock seam (#2287)", () => {
  it("saveActivityCore stamps created_at from the seam, not the column DEFAULT", () => {
    const p = newProfile("seam-activity-create");
    const outcome = saveActivityCore(
      p,
      liveDraftForm(p),
      {
        weightUnit: "kg",
        distanceUnit: "km",
      },
      "page"
    );
    expect(outcome.ok).toBe(true);
    const id = outcome.ok ? outcome.id : 0;
    expect(stamps(id).created_at).toBe(utcSqlString(clockNow()));
  });

  it("an edit stamps updated_at from the seam", () => {
    const p = newProfile("seam-activity-edit");
    const created = saveActivityCore(
      p,
      liveDraftForm(p),
      {
        weightUnit: "kg",
        distanceUnit: "km",
      },
      "page"
    );
    const id = created.ok ? created.id : 0;
    saveActivityCore(
      p,
      liveDraftForm(p, id),
      {
        weightUnit: "kg",
        distanceUnit: "km",
      },
      "page"
    );
    expect(stamps(id).updated_at).toBe(utcSqlString(clockNow()));
  });

  it("finishWorkoutSession stamps updated_at from the seam", () => {
    const p = newProfile("seam-activity-finish");
    const created = saveActivityCore(
      p,
      liveDraftForm(p),
      {
        weightUnit: "kg",
        distanceUnit: "km",
      },
      "page"
    );
    const id = created.ok ? created.id : 0;
    // A finish refuses a content-less draft (#1205 §4), so give it one logged set.
    db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
       VALUES (?, 'Back Squat', 1, 60, 5)`
    ).run(id);
    expect(finishWorkoutSession(p, id).kind).toBe("finished");
    expect(stamps(id).updated_at).toBe(utcSqlString(clockNow()));
  });

  it("the mobility core stamps both created_at and updated_at from the seam", () => {
    const p = newProfile("seam-mobility");
    const date = today(p);
    expect(logMobilityMoveCore(p, "neck_cars", date, "page").kind).toBe(
      "logged"
    );
    const row = db
      .prepare(
        "SELECT id FROM activities WHERE profile_id = ? AND date = ? AND type = 'mobility'"
      )
      .get(p, date) as { id: number };
    expect(stamps(row.id).created_at).toBe(utcSqlString(clockNow()));
    // A second move UPDATEs the same day's row.
    expect(logMobilityMoveCore(p, "cat_cow", date, "page").kind).toBe("logged");
    expect(stamps(row.id).updated_at).toBe(utcSqlString(clockNow()));
  });

  it("an imported activity's first-seen created_at comes off the seam", () => {
    const p = newProfile("seam-import");
    upsertActivities(
      p,
      [
        {
          date: today(p),
          type: "cardio",
          title: "Imported walk",
          duration_min: 30,
          distance_km: toKm(2, "km"),
          start_time: "08:00",
          end_time: "08:30",
          external_id: "e2e-seam-1",
        },
      ],
      "e2e-provider"
    );
    const row = db
      .prepare(
        "SELECT id FROM activities WHERE profile_id = ? AND external_id = ?"
      )
      .get(p, "e2e-seam-1") as { id: number };
    expect(stamps(row.id).created_at).toBe(utcSqlString(clockNow()));
  });

  it("a seconds-old live draft is NOT stale while the seam leads real time", () => {
    // A timestamp from either other clock would make this new draft look stale.
    const p = newProfile("seam-presence");
    const created = saveActivityCore(
      p,
      liveDraftForm(p),
      {
        weightUnit: "kg",
        distanceUnit: "km",
      },
      "page"
    );
    const id = created.ok ? created.id : 0;
    const presence = getWorkoutPresence(p);
    expect(NUDGE_GAP_MIN).toBeGreaterThan(STALE_MIN);
    expect(presence.state).toBe("active");
    expect(presence.activityId).toBe(id);
    expect(presence.stale).toBe(false);
  });
});

describe("offline food replay judges a statement on the seam's clock (#2287)", () => {
  it("keeps time_source 'stated' while the seam leads real time", () => {
    // A browser under the e2e freeze answers the SAME now the server does (the
    // fixture sets each context's system time to the frozen instant), so a "now"
    // statement captured offline carries the SEAM's instant. Judged against a bare
    // `new Date()` it read as 58 minutes in the future and was dropped.
    const p = newProfile("seam-food-replay");
    const date = today(p);
    const statedAt = clockNow().toISOString();
    const outcome = applyIntent(
      p,
      buildIntent(
        "food",
        date,
        {
          entry: "serving",
          groupKey: "berries",
          mealSlot: null,
          grams: null,
          eatenAt: statedAt,
        },
        p,
        true,
        clockNow()
      )
    );
    expect(outcome).toEqual({ status: "done" });
    const row = db
      .prepare(
        `SELECT occurred_at, time_source FROM food_log_events
          WHERE profile_id = ? AND group_key = 'berries' ORDER BY id DESC LIMIT 1`
      )
      .get(p) as { occurred_at: string | null; time_source: string | null };
    expect(row.time_source).toBe("stated");
    expect(row.occurred_at).not.toBeNull();
  });
});
