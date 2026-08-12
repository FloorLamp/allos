// DB INTEGRATION TIER — one session, one contact, whatever the ingest did (#2570).
//
// One bike ride produced THREE post-workout notifications in one afternoon. Health
// Connect is a hub: several apps mirrored the ride into it, one of them wrote it twice
// (32 seconds apart, so the start-instant identity kept both), and the direct provider
// sync landed its own copies later. The send is one-shot per ACTIVITY ID, and a session
// was several ids.
//
// What makes this file worth reading is what it is NOT allowed to prove. The old code
// already delivered one contact for the common case — because a freshly-imported
// duplicate was usually auto-merged away inside its 60-second dispatch window, so its
// timer found no row. That is merge TIMING, not a property of the send, and a fixture
// that let the row be deleted before the dispatch ran would have re-encoded exactly the
// emergent behaviour this issue is about. So every case here fires the dispatch against
// rows that are still present, and asserts on the MARKER as well as on the send count:
// a fold that silently dropped the marker would otherwise pass.
//
// Every value is synthetic — fictional external ids, a fake supplement, a fake Home
// Assistant webhook. No PHI.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, today, writeTx } from "@/lib/db";
import { setProfileHomeAssistant, getProfileSetting } from "@/lib/settings";
import {
  runPostWorkoutForActivity,
  postWorkoutFinishMarkerKey,
} from "@/lib/notifications/workout-presence";
import { autoMergeActivityDuplicates } from "@/lib/import-review/auto-merge";
import { getActivityDuplicates } from "@/lib/queries/integrations";
import { carryPostWorkoutMarker } from "@/lib/notifications/post-workout-marker";
import { writeActivityFold } from "@/lib/merge-activity";

const HA_URL = "http://homeassistant.local:8123/api/webhook/allos-dupes";
const NOW = new Date("2026-07-17T18:00:00Z");

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setProfileHomeAssistant(id, {
    enabled: true,
    webhookUrl: HA_URL,
    secret: "",
    disabledKinds: [],
  });
  // One post_workout dose, so the dispatch always has something to say and a silent
  // run can never be mistaken for a declined one.
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation)
         VALUES (?, 'Electrolytes (test)', 1, 'supplement', 'post_workout', 'should')`
      )
      .run(id).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 sachet', 'anytime', 'any', 0)`
  ).run(itemId);
  return id;
}

function stubFetch(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

/**
 * One imported copy of the ride. The times are wall clock on the profile's date, which
 * is what `activityWindow` reads — the two Health Connect rows differ by the 32 seconds
 * the real records did, rounded to the minute the column stores.
 */
function seedRide(
  profileId: number,
  opts: {
    source: string;
    externalId: string;
    start: string;
    end: string;
    type?: string;
    title?: string;
    distanceKm?: number;
    avgHr?: number | null;
    elevationM?: number | null;
  }
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, start_time, end_time, duration_min,
            distance_km, avg_hr, elevation_m, source, external_id)
         VALUES (?, ?, ?, ?, ?, ?, 57, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        today(profileId),
        opts.type ?? "cardio",
        opts.title ?? "Biking",
        opts.start,
        opts.end,
        opts.distanceKm ?? 20.26,
        opts.avgHr ?? null,
        opts.elevationM ?? null,
        opts.source,
        opts.externalId
      ).lastInsertRowid
  );
}

function marker(profileId: number, activityId: number): string | null {
  return (
    getProfileSetting(profileId, postWorkoutFinishMarkerKey(activityId)) ?? null
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db.prepare("DELETE FROM notify_lifecycle").run();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── The identity that makes this reachable ───────────────────────────────────

describe("the two Health Connect rows are ONE session and are detected as one", () => {
  it("pairs them at HIGH confidence even though nothing merged them", () => {
    // Pinned rather than asserted away: a 32-second disagreement about the start
    // instant is two external ids, so it is two rows, and it will stay two rows. What
    // must be true is that the detector SEES them as one session — including across
    // the two different types the two records carried, because one app wrote the ride
    // untyped (#2271 dropped the type gate for exactly this).
    const p = newProfile("PWD-detect");
    const a = seedRide(p, {
      source: "health-connect",
      externalId: "health-connect:fixture-ride-a",
      start: "09:04",
      end: "10:01",
    });
    const b = seedRide(p, {
      source: "health-connect",
      externalId: "health-connect:fixture-ride-b",
      start: "09:03",
      end: "10:01",
      type: "unclassified",
      title: "Workout",
    });

    const pairs = getActivityDuplicates(p);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].confidence).toBe("high");
    expect(pairs[0].reason).toBe("Overlapping times from one source");
    expect([pairs[0].a.id, pairs[0].b.id].sort()).toEqual([a, b].sort());

    // And auto-merge still declines it — the cross-source gate is deliberate, and this
    // fix does not touch it. The pair sits undecided in Review, which is precisely the
    // state the dispatch has to survive.
    expect(autoMergeActivityDuplicates(p)).toBe(0);
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM activities WHERE profile_id = ?")
        .get(p)
    ).toEqual({ n: 2 });
  });
});

// ── Sends 1 and 2: no merge happens at all ───────────────────────────────────

describe("a same-source duplicate pair delivers ONE contact (#2570)", () => {
  it("declines the second dispatch, with both rows still present", async () => {
    const fetchMock = stubFetch();
    const p = newProfile("PWD-samesource");
    const a = seedRide(p, {
      source: "health-connect",
      externalId: "health-connect:fixture-ride-a",
      start: "09:04",
      end: "10:01",
    });
    const b = seedRide(p, {
      source: "health-connect",
      externalId: "health-connect:fixture-ride-b",
      start: "09:03",
      end: "10:01",
      type: "unclassified",
      title: "Workout",
    });

    await runPostWorkoutForActivity(p, a, { verifyCompletedToday: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(marker(p, a)).not.toBeNull();

    // Fifteen minutes later the second push's dispatch fires. NOTHING has merged —
    // that is the point — so the fold cannot be what saves this.
    await runPostWorkoutForActivity(p, b, { verifyCompletedToday: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM activities WHERE profile_id = ?")
        .get(p)
    ).toEqual({ n: 2 });

    // The declined row's one-shot is NOT burned: a later merge could still make it the
    // keeper of a session, and the marker should record what happened rather than what
    // was declined.
    expect(marker(p, b)).toBeNull();
  });

  it("is symmetric — whichever row is dispatched first is the one that speaks", async () => {
    const fetchMock = stubFetch();
    const p = newProfile("PWD-samesource-rev");
    const a = seedRide(p, {
      source: "health-connect",
      externalId: "health-connect:fixture-ride-a",
      start: "09:04",
      end: "10:01",
    });
    const b = seedRide(p, {
      source: "health-connect",
      externalId: "health-connect:fixture-ride-b",
      start: "09:03",
      end: "10:01",
    });
    await runPostWorkoutForActivity(p, b, { verifyCompletedToday: true });
    await runPostWorkoutForActivity(p, a, { verifyCompletedToday: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(marker(p, b)).not.toBeNull();
    expect(marker(p, a)).toBeNull();
  });

  it("still announces a genuinely SEPARATE session on the same day", async () => {
    // The cost of declining, bounded. Two sessions whose clock windows do not overlap
    // are not a duplicate at any confidence, so the second one still speaks — this
    // guard must never turn "two workouts today" into one contact.
    const fetchMock = stubFetch();
    const p = newProfile("PWD-two-sessions");
    const morning = seedRide(p, {
      source: "health-connect",
      externalId: "health-connect:fixture-morning",
      start: "09:04",
      end: "10:01",
    });
    const evening = seedRide(p, {
      source: "health-connect",
      externalId: "health-connect:fixture-evening",
      start: "17:10",
      end: "18:07",
    });
    await runPostWorkoutForActivity(p, morning, {
      verifyCompletedToday: true,
    });
    await runPostWorkoutForActivity(p, evening, {
      verifyCompletedToday: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(marker(p, morning)).not.toBeNull();
    expect(marker(p, evening)).not.toBeNull();
  });

  it("honours a KEPT-BOTH decision — the user said these are two sessions", async () => {
    // The one case where declining would be the app overruling the user. A recorded
    // kept-both is the user's statement that the pair is two real workouts, and
    // `undecidedPairs` is what makes the gather respect it.
    const fetchMock = stubFetch();
    const p = newProfile("PWD-keptboth");
    const a = seedRide(p, {
      source: "health-connect",
      externalId: "health-connect:fixture-ride-a",
      start: "09:04",
      end: "10:01",
    });
    const b = seedRide(p, {
      source: "health-connect",
      externalId: "health-connect:fixture-ride-b",
      start: "09:03",
      end: "10:01",
    });
    const signature = getActivityDuplicates(p)[0].signature;
    db.prepare(
      `INSERT INTO import_pair_decisions (profile_id, domain, pair_signature, decision)
       VALUES (?, 'activity', ?, 'kept-both')`
    ).run(p, signature);

    await runPostWorkoutForActivity(p, a, { verifyCompletedToday: true });
    await runPostWorkoutForActivity(p, b, { verifyCompletedToday: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ── Send 3: the merge itself manufactured an unmarked id ─────────────────────

describe("a merge carries the announcement onto its keeper (#2570)", () => {
  it("leaves the keeper marked and delivers nothing further", async () => {
    const fetchMock = stubFetch();
    const p = newProfile("PWD-merge");
    // The two hub copies land first and one of them speaks.
    const a = seedRide(p, {
      source: "health-connect",
      externalId: "health-connect:fixture-ride-a",
      start: "09:04",
      end: "10:01",
    });
    const b = seedRide(p, {
      source: "health-connect",
      externalId: "health-connect:fixture-ride-b",
      start: "09:03",
      end: "10:01",
      type: "unclassified",
      title: "Workout",
    });
    await runPostWorkoutForActivity(p, a, { verifyCompletedToday: true });
    await runPostWorkoutForActivity(p, b, { verifyCompletedToday: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Then the direct provider sync lands a RICHER copy. It wins the keeper contest —
    // sourced, then richer — so the survivor is a row that did not exist a moment ago
    // and has never carried a marker.
    const rich = seedRide(p, {
      source: "strava",
      externalId: "strava:fixture-ride",
      start: "09:04",
      end: "10:01",
      avgHr: 141,
      elevationM: 220,
    });
    expect(autoMergeActivityDuplicates(p)).toBeGreaterThan(0);
    const survivors = db
      .prepare("SELECT id FROM activities WHERE profile_id = ? ORDER BY id")
      .all(p) as { id: number }[];
    expect(survivors.map((r) => r.id)).toEqual([rich]);

    // THE ASSERTION THE FOLD IS FOR — on the marker, not only on the send count. A
    // fold that silently dropped it would pass a send-count-only test right up until
    // the next dispatch for this row.
    expect(marker(p, rich)).not.toBeNull();
    expect(marker(p, rich)).toBe(marker(p, a));

    await runPostWorkoutForActivity(p, rich, { verifyCompletedToday: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("delivers ONE contact whichever provider syncs first — the arrival-order tell", async () => {
    // The regression that hid this for weeks. With the rich provider arriving FIRST the
    // old code already produced one contact, because the hub copy lost the keeper
    // contest and was merged away inside its own dispatch window. Same providers, same
    // merge rule, opposite outcomes — decided by which sync ran first. Both orders now
    // deliver one contact for a stated reason.
    for (const richFirst of [true, false]) {
      const fetchMock = stubFetch();
      const p = newProfile(`PWD-order-${richFirst}`);
      const seedRich = () =>
        seedRide(p, {
          source: "strava",
          externalId: "strava:fixture-ride",
          start: "09:04",
          end: "10:01",
          avgHr: 141,
          elevationM: 220,
        });
      const seedHub = () =>
        seedRide(p, {
          source: "health-connect",
          externalId: "health-connect:fixture-ride-a",
          start: "09:04",
          end: "10:01",
        });

      const first = richFirst ? seedRich() : seedHub();
      await runPostWorkoutForActivity(p, first, {
        verifyCompletedToday: true,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const second = richFirst ? seedHub() : seedRich();
      // The dispatch runs BEFORE the merge, so a row deleted by the merge can never be
      // the reason nothing was sent. That ordering is the whole point of the fixture.
      await runPostWorkoutForActivity(p, second, {
        verifyCompletedToday: true,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      autoMergeActivityDuplicates(p);
      const survivor = (
        db.prepare("SELECT id FROM activities WHERE profile_id = ?").all(p) as {
          id: number;
        }[]
      ).map((r) => r.id);
      expect(survivor).toHaveLength(1);
      expect(marker(p, survivor[0])).not.toBeNull();

      await runPostWorkoutForActivity(p, survivor[0], {
        verifyCompletedToday: true,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      vi.unstubAllGlobals();
    }
  });
});

// ── The fold itself ──────────────────────────────────────────────────────────

describe("carryPostWorkoutMarker", () => {
  it("does not overwrite a keeper's own marker", () => {
    const p = newProfile("PWD-carry-keep");
    const keep = seedRide(p, {
      source: "strava",
      externalId: "strava:fixture-keep",
      start: "09:04",
      end: "10:01",
    });
    const drop = seedRide(p, {
      source: "health-connect",
      externalId: "health-connect:fixture-drop",
      start: "09:04",
      end: "10:01",
    });
    db.prepare(
      `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, '2026-07-16')`
    ).run(p, postWorkoutFinishMarkerKey(keep));
    db.prepare(
      `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, '2026-07-17')`
    ).run(p, postWorkoutFinishMarkerKey(drop));

    expect(carryPostWorkoutMarker(p, keep, [drop])).toBeNull();
    expect(marker(p, keep)).toBe("2026-07-16");
  });

  it("is a no-op when no member was ever announced", () => {
    const p = newProfile("PWD-carry-none");
    const keep = seedRide(p, {
      source: "strava",
      externalId: "strava:fixture-keep",
      start: "09:04",
      end: "10:01",
    });
    expect(carryPostWorkoutMarker(p, keep, [9991, 9992])).toBeNull();
    expect(marker(p, keep)).toBeNull();
  });

  it("runs from writeActivityFold on the MANUAL merge path too", () => {
    // The fold is where this lives precisely so no caller can forget it — the
    // unattended auto-merge, Data → Review's resolver and the Training Log's manual
    // pair merge all go through it.
    const p = newProfile("PWD-carry-manual");
    const keep = seedRide(p, {
      source: "strava",
      externalId: "strava:fixture-keep",
      start: "09:04",
      end: "10:01",
    });
    const drop = seedRide(p, {
      source: "health-connect",
      externalId: "health-connect:fixture-drop",
      start: "09:04",
      end: "10:01",
    });
    db.prepare(
      `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, '2026-07-17')`
    ).run(p, postWorkoutFinishMarkerKey(drop));

    const keepRow = db
      .prepare("SELECT * FROM activities WHERE id = ?")
      .get(keep) as Record<string, unknown>;
    const dropRow = db
      .prepare("SELECT * FROM activities WHERE id = ?")
      .get(drop) as Record<string, unknown>;
    writeTx(() => writeActivityFold(p, keep, keepRow, [dropRow]));

    expect(marker(p, keep)).toBe("2026-07-17");
  });
});
