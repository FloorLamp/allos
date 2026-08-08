// DB INTEGRATION TIER — the cross-TYPE duplicate the loaders used to hide (#2271).
//
// THE REPORTED DEFECT. One gym session, recorded by two providers, landed as two
// activities and 120 minutes. Health Connect sent EXERCISE_TYPE_OTHER_WORKOUT ("a
// workout, unspecified") and the parser answered that stated absence with `sport`;
// Strava called the same session `strength`. The two copies differed ONLY in `type`,
// and `type` was a prerequisite for two rows to be COMPARED at all: both loaders
// grouped candidates by `(date, type)`, the adjacent-day widening carried
// `AND l.type = e.type`, and the pure detector gated cross-source pairs on
// `a.type === b.type`. So an INVENTED classification blocked duplicate matching, and
// nothing ever reached Review or the auto-merge sweep.
//
// The pure suite covers where the type gate now lives (lib/__tests__/import-review*).
// This file proves the SQL PRE-FILTERS actually let a cross-type bucket through — the
// half a pure test structurally cannot see — and that the reported pair now collapses.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { autoMergeActivityDuplicates } from "@/lib/import-review/auto-merge";
import { getActivityDuplicates, getPairDecisions } from "@/lib/queries";
import { ACTIVITY_DOMAIN } from "@/lib/import-review/detect";

const DATE = "2026-08-07";

let profileId: number;
beforeEach(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('XTYPE')").run()
      .lastInsertRowid
  );
});

interface Act {
  type: string;
  title: string;
  source: string | null;
  external_id: string | null;
  start_time: string | null;
  end_time: string | null;
  duration_min?: number | null;
  distance_km?: number | null;
  avg_hr?: number | null;
  max_hr?: number | null;
  relative_effort?: number | null;
  date?: string;
}

function insertActivity(o: Act): number {
  const r = {
    duration_min: 60,
    distance_km: null,
    avg_hr: null,
    max_hr: null,
    relative_effort: null,
    date: DATE,
    ...o,
  };
  return Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, source, external_id, start_time, end_time,
            duration_min, distance_km, avg_hr, max_hr, relative_effort)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        r.date,
        r.type,
        r.title,
        r.source,
        r.external_id,
        r.start_time,
        r.end_time,
        r.duration_min,
        r.distance_km,
        r.avg_hr,
        r.max_hr,
        r.relative_effort
      ).lastInsertRowid
  );
}

// The two rows exactly as reported: 14:30–15:30 from Health Connect carrying nothing,
// and 14:30–15:29 from Strava carrying the heart rate and the effort score.
function seedReportedPair(): { hc: number; strava: number } {
  const hc = insertActivity({
    type: "unclassified",
    title: "Workout",
    source: "health-connect",
    external_id: "health-connect:2026-08-07T18:30:17Z",
    start_time: "14:30",
    end_time: "15:30",
  });
  const strava = insertActivity({
    type: "strength",
    title: "Afternoon Workout",
    source: "strava",
    external_id: "strava:9001",
    start_time: "14:30",
    end_time: "15:29",
    duration_min: 59,
    avg_hr: 142,
    max_hr: 157,
    relative_effort: 64,
  });
  return { hc, strava };
}

describe("the Review inbox loader reaches a cross-type overlapping pair (#2271)", () => {
  it("offers the reported pair at high confidence", () => {
    seedReportedPair();
    const pairs = getActivityDuplicates(profileId);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].confidence).toBe("high");
    expect([pairs[0].a.type, pairs[0].b.type].sort()).toEqual([
      "strength",
      "unclassified",
    ]);
  });

  it("still refuses a cross-type pair whose only evidence is PROXIMITY", () => {
    // The gate's own rationale, preserved: without a type check this would start
    // pairing a 30-minute run with a 30-minute swim. Neither row has a clock window,
    // so all the classifier has is closeness.
    insertActivity({
      type: "cardio",
      title: "Lunch run",
      source: null,
      external_id: null,
      start_time: null,
      end_time: null,
      duration_min: 30,
      distance_km: 5,
    });
    insertActivity({
      type: "sport",
      title: "Lunch swim",
      source: "strava",
      external_id: "strava:swim",
      start_time: null,
      end_time: null,
      duration_min: 30,
      distance_km: 5,
    });
    expect(getActivityDuplicates(profileId)).toHaveLength(0);
  });

  it("still refuses a cross-type pair across midnight (the wrong-offset rescue)", () => {
    // #2011's rescue rests on proximity agreement, not on overlap — two rows an offset
    // apart never overlap — so it keeps asking about type. The SQL widening no longer
    // does, which is fine: a pre-filter may only ever be a SUPERSET.
    insertActivity({
      type: "cardio",
      title: "Late ride",
      source: null,
      external_id: null,
      start_time: "23:30",
      end_time: "23:59",
      duration_min: 29,
      distance_km: 10,
      date: "2026-08-06",
    });
    insertActivity({
      type: "sport",
      title: "Late ride",
      source: "strava",
      external_id: "strava:mid",
      start_time: "00:30",
      end_time: "00:59",
      duration_min: 29,
      distance_km: 10,
      date: "2026-08-07",
    });
    expect(getActivityDuplicates(profileId)).toHaveLength(0);
  });
});

describe("the auto-merge sweep collapses the reported pair (#2271)", () => {
  it("keeps the richer sourced row, absorbs the other, and records the decision", () => {
    const { hc, strava } = seedReportedPair();
    // The day reads 2 workouts and 120 minutes before the sweep — the reported symptom.
    const before = db
      .prepare(
        `SELECT COUNT(*) AS c, SUM(duration_min) AS mins FROM activities
          WHERE profile_id = ? AND date = ?`
      )
      .get(profileId, DATE) as { c: number; mins: number };
    expect(before).toEqual({ c: 2, mins: 119 });

    expect(autoMergeActivityDuplicates(profileId)).toBe(1);

    const after = db
      .prepare(
        `SELECT id, type, avg_hr, max_hr, relative_effort, duration_min
           FROM activities WHERE profile_id = ? AND date = ?`
      )
      .all(profileId, DATE) as Record<string, unknown>[];
    expect(after).toHaveLength(1);
    // autoMergeKeeperId prefers a sourced row, then richness — the Strava copy carries
    // HR and effort, the Health Connect one carries nothing. The survivor therefore
    // also keeps the more useful `strength` label.
    expect(after[0].id).toBe(strava);
    expect(after[0].type).toBe("strength");
    expect(after[0].avg_hr).toBe(142);
    expect(after[0].max_hr).toBe(157);
    expect(after[0].relative_effort).toBe(64);
    // The fold GAP-FILLS; it never overwrites a value the keeper already had, so the
    // day's duration is the keeper's own 59 minutes and not the doubled 119.
    expect(after[0].duration_min).toBe(59);

    expect(
      db
        .prepare(`SELECT COUNT(*) AS c FROM activities WHERE id = ?`)
        .get(hc)
    ).toEqual({ c: 0 });

    // A durable `merged` decision, so the collapse stays inspectable and reversible in
    // Review exactly like a manual one.
    const decisions = [...getPairDecisions(profileId, ACTIVITY_DOMAIN).values()];
    expect(decisions).toEqual(["merged"]);
  });

  it("also collapses the pre-#2272 shape of the same defect (an invented `sport`)", () => {
    // Rows already stored before the migration keep their invented `sport` — there is
    // deliberately no backfill — so the gate fix has to reach them too. It does: the
    // detector never asks what the types are, only whether the clocks overlap.
    insertActivity({
      type: "sport",
      title: "Workout",
      source: "health-connect",
      external_id: "health-connect:legacy",
      start_time: "14:30",
      end_time: "15:30",
    });
    const strava = insertActivity({
      type: "strength",
      title: "Afternoon Workout",
      source: "strava",
      external_id: "strava:legacy",
      start_time: "14:30",
      end_time: "15:29",
      duration_min: 59,
      avg_hr: 142,
    });
    expect(autoMergeActivityDuplicates(profileId)).toBe(1);
    const rows = db
      .prepare(`SELECT id FROM activities WHERE profile_id = ?`)
      .all(profileId) as { id: number }[];
    expect(rows).toEqual([{ id: strava }]);
  });
});
