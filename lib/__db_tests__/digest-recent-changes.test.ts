// DB INTEGRATION TIER (#1713 / #1723) — the recent-changes collector, the
// weather-aware light line, and the daily step target, end to end against the real
// schema and through the real digest gather.
//
// The three things this pins:
//   1. the collector surfaces what the digest was structurally blind to (an
//      out-of-range vital, a mood check-in, a symptom, overnight arrival), ranked
//      under the flagged floor and capped;
//   2. a quiet 24h produces NOTHING — the digest never manufactures news;
//   3. the #1723 lines appear only under their own gates, and the step observation
//      goes SILENT on stale data rather than guessing.

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr, utcInstant } from "@/lib/date";
import {
  setHomeLocation,
  setStepsDailyTarget,
  setTimezone,
  setWeekMode,
} from "@/lib/settings";
import { collectRecentChanges } from "@/lib/queries/recent-changes";
import { getLightExposureLine } from "@/lib/queries/light-exposure";
import {
  getStepsDigestLines,
  getStepsPaceObservation,
} from "@/lib/queries/steps-target";
import {
  upsertUvHours,
  upsertWeatherDays,
} from "@/lib/integrations/weather-cache";
import { gatherDigestInput } from "@/lib/notifications/digest-data";
import { buildDigest } from "@/lib/notifications/digest";
import { collectUpcoming } from "@/lib/queries";
import { stepsPaceKey } from "@/lib/steps-target";
import { practiceIdentity } from "@/lib/practice";
import { plainBody } from "@/lib/notifications/rich-text";

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(id, "UTC");
  return id;
}

// A canonical VITALS reading with an out-of-range flag — the case #1076 deliberately
// keeps out of the lab-scoped flagged read, and therefore out of the digest until now.
function seedFlaggedVital(
  profileId: number,
  date: string,
  canonical: string,
  value: string,
  flag = "high"
) {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, name, canonical_name, category, value, flag, created_at)
     VALUES (?, ?, ?, ?, 'vitals', ?, ?, datetime('now'))`
  ).run(profileId, date, canonical, canonical, value, flag);
}

function seedMood(profileId: number, date: string, valence: number) {
  db.prepare(
    `INSERT INTO mood_logs (profile_id, date, valence, energy)
     VALUES (?, ?, ?, 3)`
  ).run(profileId, date, valence);
}

function seedSymptom(
  profileId: number,
  date: string,
  symptom: string,
  severity = 3
) {
  db.prepare(
    `INSERT INTO symptom_logs (profile_id, date, symptom, severity)
     VALUES (?, ?, ?, ?)`
  ).run(profileId, date, symptom, severity);
}

// A successful sync that WROTE rows, carrying the PER-ROW PROVENANCE a real ingest
// persists (#1333) — which is where the arrival line's kinds come from since #1819
// item 2. `kinds` names the target table each written row landed in; a
// `metric_samples` row gets a real sample so the kind resolves to its metric.
// `bareInserted` seeds an event whose counts claim inserts with NO provenance behind
// them, the pre-#1333 legacy shape.
function seedSyncArrival(
  profileId: number,
  provider: string,
  kinds: { table: string; metric?: string }[],
  bareInserted = 0
) {
  const eventId = Number(
    db
      .prepare(
        `INSERT INTO integration_sync_events
           (profile_id, provider, at, ok, inserted, updated, unchanged)
         VALUES (?, ?, ?, 1, ?, 0, 0)`
      )
      .run(profileId, provider, utcInstant(), kinds.length + bareInserted)
      .lastInsertRowid
  );
  const link = db.prepare(
    `INSERT INTO integration_sync_rows
       (event_id, target_table, target_id, disposition)
     VALUES (?, ?, ?, 'inserted')`
  );
  const day = today(profileId);
  let nth = 0;
  for (const k of kinds) {
    let targetId = 1;
    if (k.table === "metric_samples") {
      targetId = Number(
        db
          .prepare(
            `INSERT INTO metric_samples
               (profile_id, source, metric, date, start_time, end_time, value)
             VALUES (?, ?, ?, ?, ?, ?, 1)`
          )
          .run(
            profileId,
            provider,
            k.metric,
            day,
            `${day}T${String(nth++).padStart(2, "0")}:00:00Z`,
            `${day}T23:00:00Z`
          ).lastInsertRowid
      );
    }
    link.run(eventId, k.table, targetId);
  }
  return eventId;
}

function seedSteps(
  profileId: number,
  date: string,
  value: number,
  endTime = `${date}T20:00:00Z`
) {
  db.prepare(
    `INSERT INTO metric_samples
       (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, 'health-connect', 'steps', ?, ?, ?, ?)`
  ).run(profileId, date, `${date}T00:00:00Z`, endTime, value);
}

describe("collectRecentChanges — the digest's 24h window (#1713)", () => {
  it("surfaces the four categories the digest was blind to, ranked under the floor", () => {
    const pid = newProfile("Ada Lovelace");
    const td = today(pid);
    const yd = shiftDateStr(td, -1);

    seedMood(pid, yd, 2);
    seedSymptom(pid, yd, "Headache");
    seedFlaggedVital(pid, yd, "Blood Pressure Systolic", "165");
    seedSyncArrival(pid, "oura", [
      { table: "metric_samples", metric: "sleep_min" },
      { table: "activities" },
    ]);

    const out = collectRecentChanges(pid, {
      sinceDays: 1,
      today: td,
      exclude: ["labs"],
      overflowLabel: "since yesterday",
    });

    const categories = out.changes.map((c) => c.category);
    expect(categories).toContain("vitals");
    expect(categories).toContain("mood");
    expect(categories).toContain("symptoms");
    expect(categories).toContain("data");

    // The out-of-range vital holds the floor: it can never rank below a routine line.
    expect(out.changes[0].category).toBe("vitals");
    expect(out.changes[0].flagged).toBe(true);
    expect(out.lines[0]).toContain("Blood Pressure Systolic");
    expect(out.lines[0]).toContain("165");
  });

  it("a QUIET 24h produces no lines at all", () => {
    const pid = newProfile("Quiet Quinn");
    const out = collectRecentChanges(pid, { sinceDays: 1, today: today(pid) });
    expect(out.changes).toEqual([]);
    expect(out.lines).toEqual([]);
  });

  it("respects the window edge — a change two days old is out at 24h, in at 7 days", () => {
    const pid = newProfile("Edge Edwards");
    const td = today(pid);
    seedSymptom(pid, shiftDateStr(td, -3), "Cough");

    expect(
      collectRecentChanges(pid, { sinceDays: 1, today: td }).changes
    ).toEqual([]);
    expect(
      collectRecentChanges(pid, { sinceDays: 7, today: td }).changes.map(
        (c) => c.category
      )
    ).toContain("symptoms");
  });

  it("caps the lines and says +N more rather than spilling", () => {
    const pid = newProfile("Busy Bee");
    const td = today(pid);
    const yd = shiftDateStr(td, -1);
    for (const name of ["Headache", "Nausea", "Cough"]) {
      seedSymptom(pid, yd, name);
    }
    seedMood(pid, yd, 3);
    seedFlaggedVital(pid, yd, "Oxygen Saturation", "88", "low");
    seedSyncArrival(pid, "oura", [
      { table: "metric_samples", metric: "sleep_min" },
    ]);
    seedSyncArrival(pid, "strava", [{ table: "activities" }]);

    const out = collectRecentChanges(pid, {
      sinceDays: 1,
      today: td,
      max: 3,
      overflowLabel: "since yesterday",
    });
    expect(out.lines).toHaveLength(4);
    expect(out.lines.at(-1)).toMatch(/^\+\d+ more since yesterday$/);
    // The floor still leads even under a tight cap.
    expect(out.lines[0]).toContain("Oxygen Saturation");
  });

  it("the mood line reports the value and a shift, never a judgment or a streak", () => {
    const pid = newProfile("Mood Morgan");
    const td = today(pid);
    for (let i = 2; i <= 8; i++) seedMood(pid, shiftDateStr(td, -i), 5);
    seedMood(pid, shiftDateStr(td, -1), 2);

    const out = collectRecentChanges(pid, { sinceDays: 1, today: td });
    const mood = out.changes.find((c) => c.category === "mood");
    expect(mood).toBeDefined();
    expect(mood!.text).toContain("mood 2/5");
    expect(mood!.text).toContain("below your recent average");
    expect(mood!.text).not.toMatch(
      /\b(low|bad|poor|rough|streak|days in a row)\b/i
    );
    // A real shift is notable, so it survives per-category demotion.
    expect(mood!.notable).toBe(true);
  });

  it("a behavioral-health visit is masked on a SHARED surface and full on the profile's own", () => {
    const pid = newProfile("Private Pat");
    const td = today(pid);
    db.prepare(
      `INSERT INTO encounters (profile_id, date, type, reason)
       VALUES (?, ?, 'Psychiatry', 'Therapy session')`
    ).run(pid, shiftDateStr(td, -1));

    const own = collectRecentChanges(pid, { sinceDays: 1, today: td });
    expect(own.changes.find((c) => c.category === "visits")!.text).toContain(
      "Psychiatry"
    );

    const shared = collectRecentChanges(pid, {
      sinceDays: 1,
      today: td,
      shared: true,
    });
    const line = shared.changes.find((c) => c.category === "visits")!.text;
    expect(line).toContain("Medical appointment");
    expect(line).not.toMatch(/psychiatry|therapy/i);
  });

  it("the digest renders the collector's lines in its New section", () => {
    const pid = newProfile("Digest Dana");
    const td = today(pid);
    seedFlaggedVital(
      pid,
      shiftDateStr(td, -1),
      "Blood Pressure Systolic",
      "170"
    );

    const model = buildDigest(gatherDigestInput(pid, "Digest Dana"));
    expect(model).not.toBeNull();
    const section = model!.sections.find((s) => s.heading === "New");
    expect(section).toBeDefined();
    expect(section!.lines.map(plainBody).join("\n")).toContain(
      "Blood Pressure Systolic"
    );
  });

  it("the household 7-day window and the digest 24h window agree on their overlap", () => {
    const pid = newProfile("Overlap Olive");
    const td = today(pid);
    seedFlaggedVital(
      pid,
      shiftDateStr(td, -1),
      "Oxygen Saturation",
      "89",
      "low"
    );

    const short = collectRecentChanges(pid, { sinceDays: 1, today: td });
    const long = collectRecentChanges(pid, { sinceDays: 7, today: td });
    const overlap = long.changes.filter((c) =>
      short.changes.some((s) => s.id === c.id)
    );
    expect(overlap.map((c) => c.text)).toEqual(
      short.changes.map((c) => c.text)
    );
  });
});

// ---- Data arrival: substrate out, news in (#1819 items 1 and 2) -----------
//
// Through the REAL collector and the REAL digest gather, because both defects were
// about what the SQL reports, not about how a string is formatted.
describe("data arrival — the digest's overnight line (#1819)", () => {
  const LAT = 40.7;
  const LNG = -74;

  // Fresh forecast cells, the way the sliding fetch window produces them every day.
  function seedForecastCells(date: string) {
    upsertWeatherDays(
      LAT,
      LNG,
      [
        {
          date,
          tempMaxC: 21,
          tempMinC: 13,
          pressureMslHpa: 1013,
          precipitationMm: 0,
          weatherCode: 1,
          uvIndexMax: 5,
          aqi: null,
          pollenTree: null,
          pollenGrass: null,
          pollenWeed: null,
        },
      ],
      "fixture"
    );
    upsertUvHours(
      LAT,
      LNG,
      [9, 11, 13, 15].map((h) => ({
        hourTs: `${date}T${String(h).padStart(2, "0")}:00`,
        uvIndex: 4,
        uvIndexClearSky: 5,
        shortwaveRadiation: null,
        directRadiation: null,
        diffuseRadiation: null,
        precipitationMm: null,
      })),
      "fixture"
    );
  }

  it("reports WHICH kinds arrived, never a summed record count", () => {
    const pid = newProfile("Arrival Ada");
    seedSyncArrival(pid, "health-connect", [
      { table: "metric_samples", metric: "sleep_min" },
      { table: "metric_samples", metric: "steps" },
      { table: "metric_samples", metric: "steps" },
      { table: "activities" },
    ]);

    const out = collectRecentChanges(pid, { sinceDays: 1, today: today(pid) });
    const arrival = out.changes.find((c) => c.category === "data");
    // Deterministic order: the kind that wrote most rows leads. This provider has
    // never synced before, so the line is its FIRST-data announcement (#1913 item 1).
    expect(arrival?.text).toBe(
      "📥 First data from Google Health Connect: steps, workouts, sleep"
    );
    // The old line's shape — a bare count of rows — must not come back.
    expect(arrival?.text).not.toMatch(/\d+ new record/);
  });

  it("EXCLUDES a cache-kind provider, and keeps excluding it day after day", () => {
    const pid = newProfile("Forecast Fran");
    setHomeLocation(pid, { lat: LAT, lng: LNG });
    const td = today(pid);

    // The permanent-line case, reproduced: a weather sync whose counts claim
    // hundreds of inserts, plus the forecast cells behind them — every morning.
    for (const offset of [0, 1]) {
      seedForecastCells(shiftDateStr(td, offset));
      seedSyncArrival(pid, "weather", [], 406);
      const out = collectRecentChanges(pid, { sinceDays: 1, today: td });
      expect(out.changes.filter((c) => c.category === "data")).toEqual([]);
      expect(out.lines.join("\n")).not.toContain("Weather");
    }
  });

  it("excludes it on its KIND, not on its id — even with provenance behind it", () => {
    const pid = newProfile("Kinded Kim");
    // Even if a cache-kind provider ever did record per-row provenance, it is still
    // not reporting records ABOUT the profile. `syncVocabularyForKind` decides.
    seedSyncArrival(pid, "weather", [
      { table: "metric_samples", metric: "steps" },
    ]);
    expect(
      collectRecentChanges(pid, { sinceDays: 1, today: today(pid) }).changes
    ).toEqual([]);
  });

  it("says nothing for a sync whose counts claim inserts it cannot name", () => {
    const pid = newProfile("Legacy Lee");
    seedSyncArrival(pid, "oura", [], 40);
    expect(
      collectRecentChanges(pid, { sinceDays: 1, today: today(pid) }).changes
    ).toEqual([]);
  });

  it("reaches the digest's New section through the real gather", () => {
    const pid = newProfile("Digest Dana");
    setHomeLocation(pid, { lat: LAT, lng: LNG });
    seedForecastCells(today(pid));
    seedSyncArrival(pid, "weather", [], 406);
    seedSyncArrival(pid, "oura", [
      { table: "metric_samples", metric: "sleep_min" },
    ]);

    const model = buildDigest(gatherDigestInput(pid, "Digest Dana"));
    const New = model?.sections.find((s) => s.heading === "New");
    expect(New?.lines.map(plainBody)).toContain(
      "📥 First data from Oura Ring: sleep"
    );
    expect(New?.lines.map(plainBody).join("\n")).not.toContain("Weather");
  });
});

describe("light-exposure line (#1723 part 1)", () => {
  const LAT = 40.7;
  const LNG = -74;

  beforeEach(() => {
    // Weekly pace is intentionally exercised midweek. On Sunday, 0/5 is already
    // outside the reachable window and the shared progress core suppresses the
    // ordinary "behind" phrase, so wall-clock test dates change the scenario.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-17T12:00:00Z")); // Wednesday
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function seedDay(
    date: string,
    weatherCode: number,
    uvIndexMax: number,
    precipitationMm = 0
  ) {
    upsertWeatherDays(
      LAT,
      LNG,
      [
        {
          date,
          tempMaxC: 22,
          tempMinC: 14,
          pressureMslHpa: 1015,
          precipitationMm,
          weatherCode,
          uvIndexMax,
          aqi: null,
          pollenTree: null,
          pollenGrass: null,
          pollenWeed: null,
        },
      ],
      "fixture"
    );
    upsertUvHours(
      LAT,
      LNG,
      [10, 12, 14, 16].map((h) => ({
        hourTs: `${date}T${String(h).padStart(2, "0")}:00`,
        uvIndex: 3,
        uvIndexClearSky: 4,
        shortwaveRadiation: null,
        directRadiation: null,
        diffuseRadiation: null,
        precipitationMm: null,
      })),
      "fixture"
    );
  }

  function trackedProfile(name: string): number {
    const pid = newProfile(name);
    setHomeLocation(pid, { lat: LAT, lng: LNG });
    db.prepare(
      `INSERT INTO frequency_targets
         (profile_id, scope_kind, scope_value, scope_identity, per_week)
       VALUES (?, 'practice', 'Morning light exposure', ?, 5)`
    ).run(pid, practiceIdentity("Morning light exposure"));
    return pid;
  }

  it("a sunny day for a profile that tracks the practice gets the line", () => {
    const pid = trackedProfile("Sunny Sam");
    const td = today(pid);
    seedDay(td, 0, 4);
    const line = getLightExposureLine(pid, td);
    expect(line).toContain("good window for light exposure");
    expect(line).toContain("UV moderate");
  });

  it("a rainy day gets nothing", () => {
    const pid = trackedProfile("Rainy Rae");
    const td = today(pid);
    seedDay(td, 61, 4, 8);
    expect(getLightExposureLine(pid, td)).toBeNull();
  });

  it("a profile with no light practice and no sun surface gets nothing on the same day", () => {
    const pid = newProfile("Indoor Ida");
    setHomeLocation(pid, { lat: LAT, lng: LNG });
    const td = today(pid);
    seedDay(td, 0, 4);
    expect(getLightExposureLine(pid, td)).toBeNull();
  });

  it("no cached forecast means no line, even for a tracked profile", () => {
    const pid = trackedProfile("Blank Blake");
    expect(getLightExposureLine(pid, "2099-01-01")).toBeNull();
  });

  it("composes the practice's pace when it is behind", () => {
    const pid = trackedProfile("Behind Bea");
    // Rolling mode makes the week window a mature, deterministic 7 days regardless of
    // the calendar day the test runs. In calendar mode, on the first day(s) of a fresh
    // week frequencyPace owes floor(5×elapsed/7)=0 sessions, so 0/5 reads "on-pace"
    // (#748's early-week grace) and the pace clause is rightly dropped — the very
    // behavior this test is NOT about. Rolling keeps 0/5 unambiguously "behind".
    setWeekMode(pid, "rolling");
    const td = today(pid);
    seedDay(td, 0, 4);
    const line = getLightExposureLine(pid, td);
    expect(line).toContain("Morning light exposure is 0/5 this week");
  });

  it("the digest carries it in the Today section without creating a send", () => {
    const pid = trackedProfile("Digest Dee");
    const td = today(pid);
    seedDay(td, 0, 4);
    const model = buildDigest(gatherDigestInput(pid, "Digest Dee"));
    const todaySection = model!.sections.find((s) => s.heading === "Today");
    expect(todaySection!.lines.map(plainBody).join("\n")).toContain(
      "good window for light exposure"
    );
    // The digest is the ONLY channel: nothing here mints an action or a second kind.
    expect(model!.sections.every((s) => s.heading !== "Steps")).toBe(true);
  });
});

describe("daily step target (#1723 part 2)", () => {
  it("no declared target means no lines anywhere — the resting state", () => {
    const pid = newProfile("No-Target Nora");
    const td = today(pid);
    seedSteps(pid, shiftDateStr(td, -1), 9000);
    expect(getStepsDigestLines(pid, td)).toEqual({
      yesterday: null,
      today: null,
    });
    expect(getStepsPaceObservation(pid, td)).toBeNull();
  });

  it("yesterday's line states the verdict against the declared target", () => {
    const pid = newProfile("Target Tess");
    const td = today(pid);
    setStepsDailyTarget(pid, 8000);
    seedSteps(pid, shiftDateStr(td, -1), 8400);
    expect(getStepsDigestLines(pid, td).yesterday).toBe(
      "8,400 steps ▲ target met"
    );

    const pid2 = newProfile("Under Uma");
    const td2 = today(pid2);
    setStepsDailyTarget(pid2, 8000);
    seedSteps(pid2, shiftDateStr(td2, -1), 5100);
    expect(getStepsDigestLines(pid2, td2).yesterday).toBe(
      "5,100 of 8,000 steps"
    );
  });

  it("the digest renders the verdict in its Yesterday section", () => {
    const pid = newProfile("Walker Wren");
    const td = today(pid);
    setStepsDailyTarget(pid, 8000);
    seedSteps(pid, shiftDateStr(td, -1), 5100);
    const model = buildDigest(gatherDigestInput(pid, "Walker Wren"));
    const yesterday = model!.sections.find((s) => s.heading === "Yesterday");
    expect(yesterday!.lines.map(plainBody).join("\n")).toContain(
      "5,100 of 8,000 steps"
    );
  });

  it("the afternoon observation appears in Upcoming when the day is well behind", () => {
    const pid = newProfile("Behind Ben");
    const td = today(pid);
    setStepsDailyTarget(pid, 8000);
    const afternoon = new Date(`${td}T17:00:00Z`);
    // Fresh: the sample ends minutes before the evaluation instant.
    seedSteps(pid, td, 900, `${td}T16:50:00Z`);

    const obs = getStepsPaceObservation(pid, td, afternoon);
    expect(obs).not.toBeNull();
    expect(obs!.detail).toBe("900 of 8,000 today");

    // And it rides the aggregation every existing surface already formats — that IS
    // the "ride the nag" mechanism, and it is what makes a dedicated send unnecessary.
    const prev = process.env.ALLOS_TEST_NOW;
    process.env.ALLOS_TEST_NOW = afternoon.toISOString();
    try {
      expect(collectUpcoming(pid, td).map((i) => i.key)).toContain(
        stepsPaceKey(td)
      );
    } finally {
      if (prev == null) delete process.env.ALLOS_TEST_NOW;
      else process.env.ALLOS_TEST_NOW = prev;
    }
  });

  it("STALE step data goes silent rather than manufacturing a 'behind'", () => {
    const pid = newProfile("Stale Stan");
    const td = today(pid);
    setStepsDailyTarget(pid, 8000);
    // The newest sample landed this morning; by the evening it is far past the
    // freshness cutoff, so the day's real count is unknown.
    seedSteps(pid, td, 900, `${td}T02:00:00Z`);
    const evening = new Date(`${td}T22:00:00Z`);
    expect(getStepsPaceObservation(pid, td, evening)).toBeNull();
  });

  it("stays silent before the evaluation hour and on an on-track day", () => {
    const pid = newProfile("Early Elle");
    const td = today(pid);
    setStepsDailyTarget(pid, 8000);
    const now = new Date();
    seedSteps(pid, td, 900, now.toISOString());
    expect(
      getStepsPaceObservation(pid, td, new Date(`${td}T09:00:00Z`))
    ).toBeNull();

    const pid2 = newProfile("OnTrack Otis");
    const td2 = today(pid2);
    setStepsDailyTarget(pid2, 8000);
    seedSteps(pid2, td2, 7000, new Date().toISOString());
    expect(
      getStepsPaceObservation(pid2, td2, new Date(`${td2}T17:00:00Z`))
    ).toBeNull();
  });

  it("clearing the target removes it entirely", () => {
    const pid = newProfile("Clear Cleo");
    setStepsDailyTarget(pid, 8000);
    setStepsDailyTarget(pid, null);
    const td = today(pid);
    seedSteps(pid, shiftDateStr(td, -1), 100);
    expect(getStepsDigestLines(pid, td).yesterday).toBeNull();
  });
});

// ---- Arrivals fold into the lines they describe (#1913 item 1) -------------
//
// "📥 Google Health Connect: hrv ms, sleep light, sleep awake, sleep rem, +10 more" was
// kinds-not-counts done literally: raw substrate vocabulary about records the same
// message was already listing one section down. The arrival's only value is PROVENANCE,
// and the content lines carry that themselves now.

describe("routine arrivals fold into the content lines they describe (#1913)", () => {
  // The same seeder, but backdated so the sync sits BEFORE the digest's 24h window —
  // which is what makes the next one "routine" rather than a first.
  function backdateSyncs(profileId: number, daysBack: number): void {
    db.prepare(
      `UPDATE integration_sync_events SET at = ?
        WHERE profile_id = ?`
    ).run(utcInstant(new Date(Date.now() - daysBack * 86_400_000)), profileId);
    // The seeded samples share the natural key with the ones the NEXT seed writes for
    // the same metric, so move them off today the way a real prior night's data is.
    db.prepare(
      `UPDATE metric_samples SET date = ?, start_time = start_time || '-old',
              end_time = end_time || '-old'
        WHERE profile_id = ?`
    ).run(shiftDateStr(today(profileId), -3), profileId);
  }

  it("says nothing about a routine overnight arrival", () => {
    const pid = newProfile("Routine Rae");
    // Yesterday: the provider synced these kinds already.
    seedSyncArrival(pid, "oura", [
      { table: "metric_samples", metric: "sleep_min" },
      { table: "metric_samples", metric: "hrv" },
    ]);
    backdateSyncs(pid, 3);
    // This morning: the same kinds again, which is every morning forever.
    seedSyncArrival(pid, "oura", [
      { table: "metric_samples", metric: "sleep_min" },
      { table: "metric_samples", metric: "hrv" },
    ]);

    const out = collectRecentChanges(pid, { sinceDays: 1, today: today(pid) });
    expect(out.changes.filter((c) => c.category === "data")).toEqual([]);
  });

  it("still announces a kind the profile has NEVER received before", () => {
    const pid = newProfile("Firstkind Fin");
    seedSyncArrival(pid, "oura", [
      { table: "metric_samples", metric: "sleep_min" },
    ]);
    backdateSyncs(pid, 3);
    // Sleep again (routine) plus blood oxygen for the first time ever.
    seedSyncArrival(pid, "oura", [
      { table: "metric_samples", metric: "sleep_min" },
      { table: "metric_samples", metric: "spo2" },
    ]);

    const out = collectRecentChanges(pid, { sinceDays: 1, today: today(pid) });
    const arrival = out.changes.find((c) => c.category === "data");
    // The new kind, and ONLY the new kind — the routine one has a content line.
    expect(arrival?.text).toBe("📥 New from Oura Ring: blood oxygen");
  });

  it("announces a provider's FIRST sync in full — a new source is news about the setup", () => {
    const pid = newProfile("Newsource Nel");
    seedSyncArrival(pid, "oura", [
      { table: "metric_samples", metric: "sleep_min" },
    ]);
    backdateSyncs(pid, 3);
    // A second provider appears, writing a kind the profile already receives.
    seedSyncArrival(pid, "withings", [
      { table: "metric_samples", metric: "sleep_min" },
    ]);

    const out = collectRecentChanges(pid, { sinceDays: 1, today: today(pid) });
    const texts = out.changes
      .filter((c) => c.category === "data")
      .map((c) => c.text);
    expect(texts).toEqual(["📥 First data from Withings: sleep"]);
  });

  it("the digest's activity line carries the source instead", () => {
    const pid = newProfile("Provenance Pat");
    const yd = shiftDateStr(today(pid), -1);
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, distance_km, source)
       VALUES (?, ?, 'cardio', 'Morning Ride', 18.85, 'strava')`
    ).run(pid, yd);

    const model = buildDigest(gatherDigestInput(pid, "Provenance Pat"));
    const yesterday = model?.sections.find((s) => s.heading === "Yesterday");
    expect(yesterday?.lines.map(plainBody)).toContain(
      "🏋️ Morning Ride — 18.85 km · Strava"
    );
  });

  it("says nothing about provenance for a session logged by hand", () => {
    const pid = newProfile("Manual Mo");
    const yd = shiftDateStr(today(pid), -1);
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, duration_min)
       VALUES (?, ?, 'strength', 'Squats', 45)`
    ).run(pid, yd);

    const model = buildDigest(gatherDigestInput(pid, "Manual Mo"));
    const yesterday = model?.sections.find((s) => s.heading === "Yesterday");
    expect(yesterday?.lines.map(plainBody)).toEqual(["🏋️ Squats — 45 min"]);
  });
});
