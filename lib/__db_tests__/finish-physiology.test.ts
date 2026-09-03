// DB INTEGRATION TIER — the finish message reads its HR window (#4775 §2).
//
// THE CASE THIS FILE EXISTS FOR is the second one: a sourced row whose window the
// stream has NOT covered yet. The Health Connect pipeline runs 30–61 min behind the
// wrist, so at the finish tap the session's own minutes are usually not in — and a
// clause built then is not an exception or an empty state, it is a confident sentence
// about a partial window that reads exactly like a measurement. The pin is that the
// clause is ABSENT and the import's own avg/max HR is what goes out instead.
//
// Every value is synthetic (a fake HA webhook URL; no phones).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, today } from "@/lib/db";
import { setProfileHomeAssistant, setProfileSetting } from "@/lib/settings";
import { utcSqlString } from "@/lib/date";
import { runPostWorkoutForActivity } from "@/lib/notifications/workout-presence";

const HA_URL = "http://homeassistant.local:8123/api/webhook/allos-physiology";
const NOW = new Date("2026-07-17T18:00:00Z");

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  // UTC everywhere, so the fixture's wall clock and its stored minutes are one thing
  // and a wrong answer can only come from the composition.
  setProfileSetting(id, "timezone", "UTC");
  setProfileSetting(id, "birthdate", "1986-06-01");
  const bm = db.prepare(
    `INSERT INTO body_metrics (profile_id, date, resting_hr, source)
     VALUES (?, ?, ?, 'manual')`
  );
  bm.run(id, "2026-07-14", 52);
  bm.run(id, "2026-07-15", 54);
  bm.run(id, "2026-07-16", 53);
  setProfileHomeAssistant(id, {
    enabled: true,
    webhookUrl: HA_URL,
    secret: "",
    disabledKinds: [],
  });
  return id;
}

function stubFetch(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

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

// Ended 20 minutes ago, ran for an hour: 16:40 → 17:40 on a NOW of 18:00 UTC.
const START_HHMM = "16:40";
const END_HHMM = "17:40";

function seedSession(
  profileId: number,
  date: string,
  opts: { source: string | null; avgHr?: number; maxHr?: number }
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, start_time, end_time, duration_min,
            avg_hr, max_hr, created_at, updated_at, source)
         VALUES (?, ?, 'strength', 'Push day', ?, ?, 60, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        date,
        START_HHMM,
        END_HHMM,
        opts.avgHr ?? null,
        opts.maxHr ?? null,
        utcSqlString(new Date(NOW.getTime() - 80 * 60_000)),
        utcSqlString(new Date(NOW.getTime() - 20 * 60_000)),
        opts.source
      ).lastInsertRowid
  );
}

function addWorkingSets(activityId: number): void {
  db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
       VALUES (?, 'Bench Press', 1, 60, 5), (?, 'Bench Press', 2, 60, 5)`
  ).run(activityId, activityId);
}

/**
 * Minute HR from 16:40 for `count` minutes. `count` is how far the PIPELINE has
 * delivered, which is the whole variable this file turns: 30 leaves the frontier
 * sitting inside the session, 70 carries it past the end.
 *
 * WHY 70 AND NOT 60. The window is half-open, so a 60-minute session's last in-window
 * minute is 17:39 and a frontier there is ambiguous — it looks identical whether the
 * stream covered the session exactly or simply stopped mid-window. Coverage therefore
 * asks for a minute AT OR AFTER the end, which is the only reading that distinguishes
 * the two, and the fixture has to deliver one.
 */
function seedHrMinutes(profileId: number, date: string, count: number): void {
  const insert = db.prepare(
    `INSERT INTO hr_minutes (profile_id, ts, bpm, n, source)
     VALUES (?, ?, ?, 1, 'health-connect')`
  );
  const start = Date.parse(`${date}T${START_HHMM}:00Z`);
  for (let i = 0; i < count; i++) {
    insert.run(
      profileId,
      new Date(start + i * 60_000).toISOString().slice(0, 16),
      // Two zones' worth of work under a 40-year-old's model, so the clause has
      // something to name rather than collapsing to one band.
      i < 40 ? 120 : 160
    );
  }
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

describe("the finish message's physiology clause", () => {
  it("states zones and peak for a MANUAL session the stream has covered", async () => {
    const p = newProfile("PhysCovered");
    const date = today(p);
    const activityId = seedSession(p, date, { source: null });
    addWorkingSets(activityId);
    seedHrMinutes(p, date, 70);
    const fetchMock = stubFetch();

    await runPostWorkoutForActivity(p, activityId);
    const payload = lastPayload(fetchMock);
    expect(payload.kind).toBe("workout-recap");
    // A manual strength session had no HR in this message at all before #4775.
    expect(payload.body).toMatch(/Z\d \d+ min/);
    expect(payload.body).toContain("peak 160");
    // The clause rides the recap line, so the line still leads with the session.
    expect(payload.body.startsWith("Push day done")).toBe(true);
  });

  // THE LAG CASE. The row is sourced and carries the import's own avg/max, and the
  // stream has delivered only the first half of the window.
  it("keeps the import's avg/max HR and states NO clause when the frontier sits inside the window", async () => {
    const p = newProfile("PhysUncovered");
    const date = today(p);
    const activityId = seedSession(p, date, {
      source: "strava",
      avgHr: 141,
      maxHr: 167,
    });
    seedHrMinutes(p, date, 30); // frontier at 17:10, window ends 17:40
    const fetchMock = stubFetch();

    await runPostWorkoutForActivity(p, activityId);
    const payload = lastPayload(fetchMock);
    expect(payload.body).toContain("avg HR 141");
    expect(payload.body).toContain("(max 167)");
    expect(payload.body).not.toMatch(/Z\d \d+ min/);
    expect(payload.body).not.toContain("peak");
  });

  // The same fixture with the pipeline caught up: the stream's split is the more
  // specific claim, so the import's summary of the same quantity steps aside rather
  // than sitting beside it asking the reader to reconcile two numbers.
  it("replaces the import's avg/max with the stream's split once covered", async () => {
    const p = newProfile("PhysCoveredImport");
    const date = today(p);
    const activityId = seedSession(p, date, {
      source: "strava",
      avgHr: 141,
      maxHr: 167,
    });
    seedHrMinutes(p, date, 70);
    const fetchMock = stubFetch();

    await runPostWorkoutForActivity(p, activityId);
    const payload = lastPayload(fetchMock);
    expect(payload.body).toMatch(/Z\d \d+ min/);
    expect(payload.body).not.toContain("avg HR 141");
    expect(payload.body).not.toContain("(max 167)");
  });

  it("sends the line exactly as before with neither coverage nor import HR", async () => {
    const p = newProfile("PhysNeither");
    const date = today(p);
    const activityId = seedSession(p, date, { source: null });
    addWorkingSets(activityId);
    // No hr_minutes at all — the profile has no continuous stream.
    const fetchMock = stubFetch();

    await runPostWorkoutForActivity(p, activityId);
    const payload = lastPayload(fetchMock);
    expect(payload.body.startsWith("Push day done")).toBe(true);
    expect(payload.body).not.toMatch(/Z\d \d+ min|peak|avg HR|max HR/);
  });

  // The clause rides a line and never makes one. A row with nothing to recap and no
  // pending doses sends nothing, coverage or not — the contact-consent posture.
  it("never creates a send out of physiology alone", async () => {
    const p = newProfile("PhysNoCarrier");
    const date = today(p);
    const activityId = seedSession(p, date, { source: null });
    seedHrMinutes(p, date, 70); // covered, and still nothing to say
    const fetchMock = stubFetch();

    const r = await runPostWorkoutForActivity(p, activityId);
    expect(r.outcome).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
