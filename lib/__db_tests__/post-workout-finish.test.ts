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
           (profile_id, name, active, kind, condition, priority, as_needed)
         VALUES (?, 'Creatine (test)', 1, 'supplement', 'post_workout', 'high', 0)`
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
      `INSERT INTO intake_item_logs (dose_id, item_id, date, given_at, status)
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
    expect(payload.body).toContain("2 sets");
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
             (profile_id, name, active, kind, condition, priority, as_needed)
           VALUES (?, 'Low Post (test)', 1, 'supplement', 'post_workout', 'low', 0)`
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
