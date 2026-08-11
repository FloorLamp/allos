// DB INTEGRATION TIER — the finish-triggered post-workout nudge ORCHESTRATOR
// (issue #921), following the notify-orchestrators harness (a FAKE CHANNEL at the
// fetch seam) end-to-end: derived workout presence → post_workout dose gather →
// dispatch → per-activity one-shot marker. Pins the acceptance fixture:
//   • a live session that just ended → nudge fires once
//   • the same session re-observed → no repeat (one-shot per activity id)
//   • an imported run synced 3h later → NO nudge (freshness/window)
//   • nothing pending → no send, one-shot NOT burned
//
// Every value is synthetic (fake supplement + a fake HA webhook URL; no phones).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import {
  setProfileHomeAssistant,
  getProfileSetting,
  setLoginTelegramDisabledKinds,
} from "@/lib/settings";
import { seedLoginTelegram } from "./fixtures";
import { utcSqlString } from "@/lib/date";
import {
  runPostWorkoutFinish,
  runPostWorkoutForActivity,
  postWorkoutFinishMarkerKey,
} from "@/lib/notifications/workout-presence";
import { setProfileSetting } from "@/lib/settings";
import { classifyActivityType } from "@/lib/activity-type-write";
import { getFrequencyTargetProgress } from "@/lib/queries";

const HA_URL = "http://homeassistant.local:8123/api/webhook/allos-postworkout";
const NOW = new Date("2026-07-17T18:00:00Z");

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function configureHA(profileId: number): void {
  setProfileHomeAssistant(profileId, {
    enabled: true,
    webhookUrl: HA_URL,
    secret: "",
    disabledKinds: [],
  });
}

function stubFetch(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

// A post_workout supplement with one dose. Returns { itemId, doseId }.
function seedPostWorkoutSupp(profileId: number): {
  itemId: number;
  doseId: number;
} {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation)
         VALUES (?, 'Creatine (test)', 1, 'supplement', 'post_workout', 'should')`
      )
      .run(profileId).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '5 g', 'anytime', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  return { itemId, doseId };
}

// hh:mm (UTC wall time) of an instant `minAgo` minutes before NOW.
function hhmmAgo(minAgo: number): string {
  return new Date(NOW.getTime() - minAgo * 60_000).toISOString().slice(11, 16);
}

// A manually-logged session that ended `endMinAgo` before NOW (source NULL).
function seedManualFinished(
  profileId: number,
  date: string,
  endMinAgo: number
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, start_time, end_time, created_at, updated_at, source)
         VALUES (?, ?, 'strength', 'Push day', ?, ?, ?, ?, NULL)`
      )
      .run(
        profileId,
        date,
        hhmmAgo(endMinAgo + 60),
        hhmmAgo(endMinAgo),
        utcSqlString(new Date(NOW.getTime() - (endMinAgo + 60) * 60_000)),
        utcSqlString(new Date(NOW.getTime() - endMinAgo * 60_000))
      ).lastInsertRowid
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  // The delivery-health marker is now the notify_lifecycle row (issue #942), not the
  // legacy notify_last_error* settings keys — reset both so a prior case cannot leak.
  db.prepare("DELETE FROM notify_lifecycle").run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'notify_last_error%'").run();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("runPostWorkoutFinish orchestrator", () => {
  it("fires ONCE when a live session just finished, then never repeats", async () => {
    const p = newProfile("PWFire");
    const { itemId } = seedPostWorkoutSupp(p);
    const date = today(p);
    const activityId = seedManualFinished(p, date, 20); // ended 20 min ago
    configureHA(p);
    const fetchMock = stubFetch();

    const r1 = await runPostWorkoutFinish(p, NOW);
    expect(r1.failed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getProfileSetting(p, postWorkoutFinishMarkerKey(activityId))).toBe(
      date
    );
    void itemId;

    // Same session re-observed on the next tick → one-shot already fired → no send.
    const r2 = await runPostWorkoutFinish(p, NOW);
    expect(r2.failed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire for an imported run synced 3h after it ended", async () => {
    const p = newProfile("PWImportLate");
    seedPostWorkoutSupp(p);
    const date = today(p);
    // Ran 07:00-08:00 (~10-11h before 18:00), row created just now (bulk sync).
    db.prepare(
      `INSERT INTO activities
         (profile_id, date, type, title, start_time, end_time, created_at, updated_at, source, external_id)
       VALUES (?, ?, 'cardio', 'Morning run', '07:00', '08:00', ?, NULL, 'strava', 'strava:1')`
    ).run(p, date, utcSqlString(NOW));
    configureHA(p);
    const fetchMock = stubFetch();

    const r = await runPostWorkoutFinish(p, NOW);
    expect(r.failed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends nothing (and does NOT burn the one-shot) when the post_workout dose is already taken", async () => {
    const p = newProfile("PWDone");
    const { itemId, doseId } = seedPostWorkoutSupp(p);
    const date = today(p);
    const activityId = seedManualFinished(p, date, 15);
    // Log the dose taken today.
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, recorded_at, status)
       VALUES (?, ?, ?, ?, 'taken')`
    ).run(doseId, itemId, date, utcSqlString(NOW));
    configureHA(p);
    const fetchMock = stubFetch();

    const r = await runPostWorkoutFinish(p, NOW);
    expect(r.failed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    // Marker unset — a later still-pending dose could still be delivered.
    expect(
      getProfileSetting(p, postWorkoutFinishMarkerKey(activityId))
    ).toBeUndefined();
  });

  it("no channel configured ⇒ no marker, retries next tick", async () => {
    const p = newProfile("PWNoChannel");
    seedPostWorkoutSupp(p);
    const date = today(p);
    const activityId = seedManualFinished(p, date, 20);
    const fetchMock = stubFetch();

    const r = await runPostWorkoutFinish(p, NOW);
    expect(r.failed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      getProfileSetting(p, postWorkoutFinishMarkerKey(activityId))
    ).toBeUndefined();
  });
});

// The recap-led composition (#924): the finish nudge OPENS with the session recap
// line, then the due post-workout supplement section. The recap line is gated by
// the per-profile workout-recap toggle; either alone still sends.
function addWorkingSets(activityId: number, exercise: string): void {
  db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps, target_reps)
       VALUES (?, ?, 1, 60, 5, 5), (?, ?, 2, 60, 5, 5)`
  ).run(activityId, exercise, activityId, exercise);
}

// Parse the JSON body POSTed to the (fake) HA webhook.
function lastPayload(fetchMock: ReturnType<typeof vi.fn>): {
  title: string;
  body: string;
  kind: string;
} {
  const init = fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1] as {
    body: string;
  };
  return JSON.parse(init.body);
}

describe("recap-led finish nudge composition (#924)", () => {
  it("leads the dose nudge with the recap line when the toggle is on", async () => {
    const p = newProfile("RecapLead");
    seedPostWorkoutSupp(p);
    const date = today(p);
    const activityId = seedManualFinished(p, date, 20);
    addWorkingSets(activityId, "Bench Press");
    configureHA(p);
    const fetchMock = stubFetch();

    const r = await runPostWorkoutFinish(p, NOW);
    expect(r.failed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = lastPayload(fetchMock);
    // Recap line leads; the dose section (Creatine) follows.
    expect(payload.body.startsWith("Push day done")).toBe(true);
    expect(payload.body).toContain("Creatine (test)");
    // The chat form (#2172) states the target verdict rather than the bare set count:
    // this session declared targets and hit them, so THAT is what the line says.
    expect(payload.body).toContain("all targets hit");
    // Combined message keeps the SAFETY-tier dose kind.
    expect(payload.kind).toBe("dose");
  });

  it("strips the recap line when the workout-recap kind is off on every channel — dose section only", async () => {
    const p = newProfile("RecapOff");
    seedPostWorkoutSupp(p);
    const date = today(p);
    const activityId = seedManualFinished(p, date, 20);
    addWorkingSets(activityId, "Bench Press");
    // Disable workout-recap on every configured channel — the recap line rides in
    // the finish nudge unless it's off everywhere. Telegram is login-scoped (#1072):
    // seed a managing login whose Telegram has workout-recap turned off, plus HA.
    const l = seedLoginTelegram(p, "555900");
    setLoginTelegramDisabledKinds(l, ["workout-recap"]);
    setProfileHomeAssistant(p, {
      enabled: true,
      webhookUrl: HA_URL,
      secret: "",
      disabledKinds: ["workout-recap"],
    });
    const fetchMock = stubFetch();

    await runPostWorkoutFinish(p, NOW);
    const payload = lastPayload(fetchMock);
    expect(payload.body.startsWith("Push day done")).toBe(false);
    expect(payload.body).toContain("Creatine (test)");
  });

  it("sends a recap-only nudge (no pending doses) as a workout-recap message", async () => {
    const p = newProfile("RecapOnly");
    // No post_workout supplement at all → no dose section.
    const date = today(p);
    const activityId = seedManualFinished(p, date, 20);
    addWorkingSets(activityId, "Bench Press");
    configureHA(p);
    const fetchMock = stubFetch();

    const r = await runPostWorkoutFinish(p, NOW);
    expect(r.failed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = lastPayload(fetchMock);
    expect(payload.kind).toBe("workout-recap");
    expect(payload.body.startsWith("Push day done")).toBe(true);
    // Burns the one-shot (a recap-only finish still fires once).
    expect(getProfileSetting(p, postWorkoutFinishMarkerKey(activityId))).toBe(
      date
    );
  });

  // #1721: the finish nudge is a DISPATCH-path builder, so it never met the tick's
  // prefixMessage — "🏋️ Post-workout — 2 doses" in a household chat named nobody.
  it("labels the message with the profile in a multi-profile instance (#1721)", async () => {
    const p = newProfile("Ada");
    newProfile("Bo"); // a second data subject makes the label meaningful
    seedPostWorkoutSupp(p);
    const date = today(p);
    const activityId = seedManualFinished(p, date, 20);
    addWorkingSets(activityId, "Bench Press");
    configureHA(p);
    const fetchMock = stubFetch();

    await runPostWorkoutFinish(p, NOW);
    const payload = lastPayload(fetchMock);
    expect(payload.title).toContain("[Ada]");
    // Still the SAFETY-tier dose kind — attribution changes the label, nothing else.
    expect(payload.kind).toBe("dose");
    // The single-profile "no label at all" half lives in the pure tier
    // (profileMessagePrefix): this file shares one in-memory DB across its cases, so
    // the instance always holds several profiles by the time it runs.
  });

  it("sends nothing when a pure-cardio-style finish has no working sets and no doses", async () => {
    const p = newProfile("RecapNoWork");
    const date = today(p);
    seedManualFinished(p, date, 20); // no exercise sets, no supplement
    configureHA(p);
    const fetchMock = stubFetch();

    const r = await runPostWorkoutFinish(p, NOW);
    expect(r.failed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// #1154 §B — the shared per-activity dispatch core the delayed write-path timer
// calls (runPostWorkoutForActivity with fire-time verification). The presence
// flagship above delegates to the same core, so these pin only the direct-path
// deltas: the no-finish fallback (a retroactive/imported completed session
// OUTSIDE the presence window still delivers), the fire-time completed check (an
// undone finish sends nothing and doesn't burn the one-shot), the shared marker
// (a flagship delivery makes the direct path a no-op), and the #1156 floor on
// the dose section.
describe("runPostWorkoutForActivity (the delayed-dispatch core, #1154 §B)", () => {
  it("delivers for a retroactive completed session that ended hours ago (not bucket-dependent)", async () => {
    const p = newProfile("PWRetro");
    seedPostWorkoutSupp(p);
    const date = today(p);
    // Ended 3h ago — far outside the presence flagship's 60-min window.
    const activityId = seedManualFinished(p, date, 180);
    configureHA(p);
    const fetchMock = stubFetch();

    // The presence path sees nothing…
    const r0 = await runPostWorkoutFinish(p, NOW);
    expect(r0.failed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    // …but the direct per-activity dispatch delivers.
    const r = await runPostWorkoutForActivity(p, activityId, {
      verifyCompletedToday: true,
    });
    expect(r.failed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getProfileSetting(p, postWorkoutFinishMarkerKey(activityId))).toBe(
      date
    );
  });

  it("fire-time verification: an UNDONE finish (live draft again) sends nothing and keeps the one-shot", async () => {
    const p = newProfile("PWUndone");
    seedPostWorkoutSupp(p);
    const date = today(p);
    // A started-but-unended, duration-less row: the live-draft signature.
    const activityId = Number(
      db
        .prepare(
          `INSERT INTO activities
             (profile_id, date, type, title, start_time, end_time, created_at, updated_at, source)
           VALUES (?, ?, 'strength', 'Draft (test)', ?, NULL, ?, ?, NULL)`
        )
        .run(
          p,
          date,
          hhmmAgo(30),
          utcSqlString(new Date(NOW.getTime() - 30 * 60_000)),
          utcSqlString(NOW)
        ).lastInsertRowid
    );
    configureHA(p);
    const fetchMock = stubFetch();

    const r = await runPostWorkoutForActivity(p, activityId, {
      verifyCompletedToday: true,
    });
    expect(r.failed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      getProfileSetting(p, postWorkoutFinishMarkerKey(activityId))
    ).toBeUndefined();
  });

  it("shares the one-shot marker with the tick flagship: whoever delivers first wins", async () => {
    const p = newProfile("PWSharedMarker");
    seedPostWorkoutSupp(p);
    const date = today(p);
    const activityId = seedManualFinished(p, date, 20);
    configureHA(p);
    const fetchMock = stubFetch();

    // The direct path (as if the ~60s timer fired) delivers and stamps…
    await runPostWorkoutForActivity(p, activityId, {
      verifyCompletedToday: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // …so the tick's presence flagship skips (no double send).
    const r = await runPostWorkoutFinish(p, NOW);
    expect(r.failed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a cross-profile/unknown activity id is a no-op", async () => {
    const p = newProfile("PWForeign");
    const other = newProfile("PWForeignOwner");
    seedPostWorkoutSupp(p);
    const foreign = seedManualFinished(other, today(other), 20);
    configureHA(p);
    const fetchMock = stubFetch();
    const r = await runPostWorkoutForActivity(p, foreign, {
      verifyCompletedToday: true,
    });
    expect(r.failed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("#1156 floor: a LOW-priority post_workout supplement is excluded; an all-low finish sends nothing", async () => {
    const p = newProfile("PWFloor");
    const date = today(p);
    // One low post_workout supplement — the whole dose section goes silent, and
    // with no working sets there's no recap either → no send, one-shot kept.
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, obligation)
         VALUES (?, 'Low Post (test)', 1, 'supplement', 'post_workout', 'may')`
        )
        .run(p).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '5 g', 'anytime', 'any', 0)`
    ).run(itemId);
    const activityId = seedManualFinished(p, date, 20);
    configureHA(p);
    const fetchMock = stubFetch();

    const r = await runPostWorkoutFinish(p, NOW);
    expect(r.failed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      getProfileSetting(p, postWorkoutFinishMarkerKey(activityId))
    ).toBeUndefined();
    void setProfileSetting; // referenced to keep the shared import stable
  });
});

// ── #2272: the recap finally fires for an IMPORT, and asks when nobody classified ──
//
// Measured on a real profile before this change: every notify_last_post_workout_
// marker ever written belonged to a MANUAL strength session with logged sets, and no
// imported activity had ever produced a recap. Presence detection was never the
// problem — an import that ends inside FINISHED_WINDOW_MIN and lands inside
// IMPORT_FRESHNESS_MIN reaches `finished` fine. The message simply had nothing to
// say: getSessionRecap is honest about a row with no exercise_sets, and
// recapNudgeLine then declined the whole line.

// An imported session that ended `endMinAgo` before NOW and was first seen just now.
function seedImportedFinished(
  profileId: number,
  date: string,
  type: string,
  over: {
    endMinAgo?: number;
    durationMin?: number | null;
    distanceKm?: number | null;
    avgHr?: number | null;
    maxHr?: number | null;
    relativeEffort?: number | null;
    title?: string;
    externalId?: string;
  } = {}
): number {
  const o = {
    endMinAgo: 20,
    durationMin: 60,
    distanceKm: null,
    avgHr: null,
    maxHr: null,
    relativeEffort: null,
    title: "Workout",
    externalId: `health-connect:${type}:${date}`,
    ...over,
  };
  return Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, start_time, end_time, duration_min,
            distance_km, avg_hr, max_hr, relative_effort, created_at, source, external_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'health-connect', ?)`
      )
      .run(
        profileId,
        date,
        type,
        o.title,
        hhmmAgo(o.endMinAgo + 60),
        hhmmAgo(o.endMinAgo),
        o.durationMin,
        o.distanceKm,
        o.avgHr,
        o.maxHr,
        o.relativeEffort,
        utcSqlString(NOW),
        o.externalId
      ).lastInsertRowid
  );
}

describe("an imported finish gets its own recap line (#2272)", () => {
  it("recaps the facts the import carries — with no volume, PR or target language", async () => {
    // The reported shape: 60 minutes, no sets, and a profile with ZERO post_workout
    // intake items — the case that produced no send at all.
    const p = newProfile("ImportRecap");
    const date = today(p);
    const activityId = seedImportedFinished(p, date, "cardio", {
      title: "Morning Ride",
      distanceKm: 24.5,
      avgHr: 138,
      maxHr: 161,
    });
    configureHA(p);
    const fetchMock = stubFetch();

    const r = await runPostWorkoutFinish(p, NOW);
    expect(r.failed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = lastPayload(fetchMock);
    expect(payload.kind).toBe("workout-recap");
    expect(payload.body).toContain("Morning Ride done");
    expect(payload.body).toContain("60 min");
    expect(payload.body).toContain("24.5 km");
    expect(payload.body).toContain("avg HR 138 (max 161)");
    expect(payload.body).not.toMatch(/set|volume|PR|target/i);
    // A recap-only imported finish still burns the one-shot.
    expect(getProfileSetting(p, postWorkoutFinishMarkerKey(activityId))).toBe(
      date
    );
  });

  it("stays silent for an import that carries no fact beyond its own existence", async () => {
    const p = newProfile("ImportBare");
    const date = today(p);
    seedImportedFinished(p, date, "cardio", { durationMin: null });
    configureHA(p);
    const fetchMock = stubFetch();

    await runPostWorkoutFinish(p, NOW);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves a MANUAL sessionless finish exactly as it was — still no send", async () => {
    // The import line is gated on `source`, so the pre-#2272 manual behaviour (no sets,
    // no doses ⇒ nothing to say) is untouched. Pinned again here beside its new sibling.
    const p = newProfile("ManualUnchanged");
    const date = today(p);
    seedManualFinished(p, date, 20);
    configureHA(p);
    const fetchMock = stubFetch();

    await runPostWorkoutFinish(p, NOW);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── #2439: the weekly line is about THIS session, and the title names what finished ──
//
// The reported message, verbatim: "🏋️ Workout complete / Afternoon Walk done · 33 min ·
// 1.42 km · avg HR 84 (max 99) · effort 3 / Chest — 1 of 2 this week, one more to go."
// Two claims a 1.42 km walk had no business making. The weekly rollup is profile-wide
// and nothing tied it to the finishing activity, so the line led with the closest-to-done
// target ANYWHERE — a chest target a barbell session had advanced days earlier — and then
// nudged toward a chest day the walk had not touched.

function makeTarget(
  profileId: number,
  kind: string,
  value: string,
  perWeek: number
): void {
  db.prepare(
    `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
     VALUES (?, ?, ?, ?)`
  ).run(profileId, kind, value, perWeek);
}

// The walk from the report — an imported cardio row with no sets, finishing now.
function seedWalk(profileId: number, date: string): number {
  return seedImportedFinished(profileId, date, "cardio", {
    title: "Afternoon Walk",
    durationMin: 33,
    distanceKm: 1.42,
    avgHr: 84,
    maxHr: 99,
    relativeEffort: 3,
    externalId: `health-connect:walk:${date}`,
  });
}

describe("the weekly line names only what this session advanced (#2439)", () => {
  it("does not credit a walk with the chest day a barbell session did", async () => {
    const p = newProfile("WalkNotChest");
    const date = today(p);
    makeTarget(p, "region", "Chest", 2);
    // The lift that actually advanced Chest — earlier today, far outside the finished
    // window, so the walk is what presence observes.
    addWorkingSets(seedManualFinished(p, date, 400), "Bench Press");
    seedWalk(p, date);
    configureHA(p);
    const fetchMock = stubFetch();

    await runPostWorkoutFinish(p, NOW);
    const payload = lastPayload(fetchMock);
    expect(payload.body).toContain("Afternoon Walk done");
    expect(payload.body).toContain("1.42 km");
    // The rollup still says Chest is 1 of 2 this week. This message may not say so.
    expect(getFrequencyTargetProgress(p)).toMatchObject([
      { count: 1, per_week: 2, met: false },
    ]);
    expect(payload.body).not.toMatch(/Chest|this week|more to go/i);
  });

  it("still speaks for the target the walk DID advance", async () => {
    const p = newProfile("WalkOwnTarget");
    const date = today(p);
    makeTarget(p, "region", "Chest", 2);
    makeTarget(p, "type", "cardio", 3);
    addWorkingSets(seedManualFinished(p, date, 400), "Bench Press");
    seedWalk(p, date);
    configureHA(p);
    const fetchMock = stubFetch();

    await runPostWorkoutFinish(p, NOW);
    const payload = lastPayload(fetchMock);
    expect(payload.body).toContain("Cardio — 1 of 3 this week, 2 more to go.");
    expect(payload.body).not.toContain("Chest");
  });

  it("titles the message by what actually finished", async () => {
    const p = newProfile("WalkTitle");
    const date = today(p);
    seedWalk(p, date);
    configureHA(p);
    const fetchMock = stubFetch();

    await runPostWorkoutFinish(p, NOW);
    // The barbell rode every import from #2272 until here; a walk is not a workout.
    expect(lastPayload(fetchMock).title).toContain("🏃 Cardio complete");
    expect(lastPayload(fetchMock).title).not.toMatch(/workout/i);
  });

  it("keeps the barbell for the strength session it was written for", async () => {
    const p = newProfile("LiftTitle");
    const date = today(p);
    addWorkingSets(seedManualFinished(p, date, 20), "Bench Press");
    configureHA(p);
    const fetchMock = stubFetch();

    await runPostWorkoutFinish(p, NOW);
    expect(lastPayload(fetchMock).title).toContain("🏋️ Workout complete");
  });
});

describe("the type ask rides that recap, and only when nobody classified (#2272)", () => {
  it("asks for an `unclassified` finish", async () => {
    // The Home Assistant payload carries no generic actions, so the BUTTONS are pinned
    // over Telegram in activity-type-ask.test.ts; what this pins is that the ask rode
    // the message at all, and that it is the row's TYPE that decides.
    const p = newProfile("AskUnclassified");
    const date = today(p);
    seedImportedFinished(p, date, "unclassified");
    configureHA(p);
    const fetchMock = stubFetch();

    await runPostWorkoutFinish(p, NOW);
    expect(lastPayload(fetchMock).body).toContain("didn't say what this was");
  });

  it("does NOT ask when the source did state a type", async () => {
    const p = newProfile("AskClassified");
    const date = today(p);
    seedImportedFinished(p, date, "cardio", { title: "Morning Ride" });
    configureHA(p);
    const fetchMock = stubFetch();

    await runPostWorkoutFinish(p, NOW);
    const payload = lastPayload(fetchMock);
    expect(payload.body).toContain("Morning Ride done");
    expect(payload.body).not.toContain("didn't say what this was");
  });

  it("is offered ONCE — the nudge's own one-shot is the whole re-ask policy", async () => {
    const p = newProfile("AskOnce");
    const date = today(p);
    seedImportedFinished(p, date, "unclassified");
    configureHA(p);
    const fetchMock = stubFetch();

    await runPostWorkoutFinish(p, NOW);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // A queue that re-asks is how a signal gets trained into noise: the row stays
    // `unclassified` and stays correctable in the app forever, but it is never asked
    // about again.
    await runPostWorkoutFinish(p, NOW);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("classifyActivityType — the ask's answer (#2272)", () => {
  it("writes that row only, and locks it against the next re-sync", async () => {
    const p = newProfile("ClassifyWrite");
    const date = today(p);
    const target = seedImportedFinished(p, date, "unclassified");
    const bystander = seedImportedFinished(p, date, "unclassified", {
      endMinAgo: 200,
      externalId: "health-connect:other",
    });

    expect(classifyActivityType(p, target, "strength")).toEqual({
      kind: "classified",
      activityId: target,
      type: "strength",
    });
    const row = db
      .prepare(`SELECT type, edited FROM activities WHERE id = ?`)
      .get(target) as { type: string; edited: number };
    expect(row.type).toBe("strength");
    // `edited` is not decoration: upsertActivities WRITES `type` on every re-sync and
    // isEditLocked is the only thing standing between a hand correction and the
    // importer. Without this the answer would silently revert to `unclassified`.
    expect(row.edited).toBe(1);
    // The answer applies to THAT ROW — no remembered per-profile inference rule.
    expect(
      (
        db
          .prepare(`SELECT type FROM activities WHERE id = ?`)
          .get(bystander) as { type: string }
      ).type
    ).toBe("unclassified");
  });

  it("refuses a second tap and a row that was merged away, honestly", async () => {
    const p = newProfile("ClassifyRefuse");
    const date = today(p);
    const id = seedImportedFinished(p, date, "unclassified");
    classifyActivityType(p, id, "cardio");
    // A stale keyboard tapped again: the compare-and-swap consumed the absence it was
    // offered for, so the second answer cannot overwrite the first.
    expect(classifyActivityType(p, id, "sport")).toEqual({
      kind: "already-classified",
      activityId: id,
      type: "cardio",
    });
    // …and a keyboard whose row was absorbed by the duplicate auto-merge (#2271).
    db.prepare(`DELETE FROM activities WHERE id = ?`).run(id);
    expect(classifyActivityType(p, id, "sport")).toEqual({ kind: "not-found" });
  });

  it("refuses to reach another profile's row", async () => {
    const owner = newProfile("ClassifyOwner");
    const other = newProfile("ClassifyOther");
    const date = today(owner);
    const id = seedImportedFinished(owner, date, "unclassified");
    expect(classifyActivityType(other, id, "cardio")).toEqual({
      kind: "not-found",
    });
    expect(
      (
        db.prepare(`SELECT type FROM activities WHERE id = ?`).get(id) as {
          type: string;
        }
      ).type
    ).toBe("unclassified");
  });
});
