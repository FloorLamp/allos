// DB INTEGRATION TIER — timeline query coverage.
//
// Timeline is a cross-domain read layer over real profile-owned tables. These
// tests exercise the SQL against the migrated temp DB so unit formatting,
// category/date filtering, and profile scoping are covered beyond pure helpers.

import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { getTimelineDates, getTimelineEvents } from "@/lib/timeline";
import { seedProfile, type SeededProfile } from "./fixtures";
import { setTimezone } from "@/lib/settings";

let imperial: SeededProfile;
let other: SeededProfile;

// Ids for the clinical categories the shared fixture does NOT seed (conditions /
// allergies / encounters / insights). Seeded per-profile here so the cross-profile
// non-bleed assertions actually exercise those four reads. (Seeded in this test
// rather than fixtures.ts because export.test.ts asserts exact per-profile row
// counts on some of these tables.)
interface ClinicalIds {
  conditionId: number;
  allergyId: number;
  encounterId: number;
  insightId: number;
}

function seedClinical(
  profileId: number,
  tag: string,
  dateStr: string
): ClinicalIds {
  const conditionId = Number(
    db
      .prepare(
        `INSERT INTO conditions (profile_id, name, status, onset_date)
         VALUES (?, ?, 'active', '2020-01-01')`
      )
      .run(profileId, `${tag} Hypertension`).lastInsertRowid
  );
  const allergyId = Number(
    db
      .prepare(
        `INSERT INTO allergies (profile_id, substance, reaction, severity, status, onset_date)
         VALUES (?, ?, 'rash', 'moderate', 'active', '2019-03-03')`
      )
      .run(profileId, `${tag} Penicillin`).lastInsertRowid
  );
  const encounterId = Number(
    db
      .prepare(
        `INSERT INTO encounters (profile_id, date, type, reason)
         VALUES (?, ?, ?, 'annual checkup')`
      )
      .run(profileId, dateStr, `${tag} Office Visit`).lastInsertRowid
  );
  const insightId = Number(
    db
      .prepare(
        `INSERT INTO insights (profile_id, date, summary, model)
         VALUES (?, ?, ?, 'test-model')`
      )
      .run(profileId, dateStr, `${tag} weekly insight summary`).lastInsertRowid
  );
  return { conditionId, allergyId, encounterId, insightId };
}

let imperialClinical: ClinicalIds;
let otherClinical: ClinicalIds;

beforeAll(() => {
  imperial = seedProfile("TLINE", { weightKg: 80 });
  other = seedProfile("OTHER", { weightKg: 95 });
  imperialClinical = seedClinical(
    imperial.profileId,
    "TLINE",
    imperial.todayStr
  );
  otherClinical = seedClinical(other.profileId, "OTHER", other.todayStr);
});

describe("getTimelineEvents", () => {
  it("formats activity distance and body weight with supplied unit prefs", () => {
    const events = getTimelineEvents(imperial.profileId, {
      units: { distanceUnit: "mi", weightUnit: "lb" },
    });

    const run = events.find(
      (e) => e.id === `activity:${imperial.cardioActivityId}`
    );
    expect(run?.subtitle).toContain("3.11 mi");
    expect(run?.subtitle).not.toContain("5.00 km");

    const body = events.find((e) => e.id.startsWith("body:"));
    expect(body?.subtitle).toContain("176.4 lb");
    expect(body?.subtitle).not.toContain("80.0 kg");
  });

  it("includes expandable strength exercise summaries on activity events", () => {
    const events = getTimelineEvents(imperial.profileId, {
      units: { distanceUnit: "km", weightUnit: "lb" },
    });

    const strength = events.find(
      (e) => e.id === `activity:${imperial.strengthActivityId}`
    );
    expect(strength?.detailItems).toContainEqual({
      label: "Back Squat",
      value: "220.5lb × 5 × 2",
    });
  });

  it("includes medical result values and intake dosages as expansion details", () => {
    db.prepare(
      "UPDATE medical_records SET flag = 'high' WHERE profile_id = ? AND name = 'Glucose'"
    ).run(imperial.profileId);

    const events = getTimelineEvents(imperial.profileId);

    const medical = events.find((e) => e.id.startsWith("medical:"));
    expect(medical?.detailItems).toContainEqual({
      label: "Glucose",
      value: "130",
      unit: "mg/dL",
      flag: "high",
    });

    const supplement = events.find(
      (e) => e.id === `intake:supplement:${imperial.todayStr}`
    );
    expect(supplement?.detailItems).toContainEqual({
      label: "TLINE Vitamin D",
      value: "1 cap",
    });
  });

  it("scopes timeline events to the requested profile", () => {
    const events = getTimelineEvents(imperial.profileId);
    const text = events
      .map((e) => `${e.title} ${e.subtitle ?? ""} ${e.detail ?? ""}`)
      .join("\n");

    expect(text).toContain("TLINE");
    expect(text).not.toContain("OTHER");
    expect(
      events.some((e) => e.id === `activity:${other.cardioActivityId}`)
    ).toBe(false);
  });

  it("surfaces conditions, allergies, encounters and insights without cross-profile bleed", () => {
    const events = getTimelineEvents(imperial.profileId);
    const ids = new Set(events.map((e) => e.id));

    // Each of the four clinical categories is read for the requesting profile.
    expect(ids.has(`condition:${imperialClinical.conditionId}`)).toBe(true);
    expect(ids.has(`allergy:${imperialClinical.allergyId}`)).toBe(true);
    expect(ids.has(`visit:${imperialClinical.encounterId}`)).toBe(true);
    expect(ids.has(`insight:${imperialClinical.insightId}`)).toBe(true);

    // ...and NONE of the other profile's rows leak in (including the insight,
    // whose tag lives only in its detail/summary, not its title/subtitle).
    expect(ids.has(`condition:${otherClinical.conditionId}`)).toBe(false);
    expect(ids.has(`allergy:${otherClinical.allergyId}`)).toBe(false);
    expect(ids.has(`visit:${otherClinical.encounterId}`)).toBe(false);
    expect(ids.has(`insight:${otherClinical.insightId}`)).toBe(false);

    const otherEvents = getTimelineEvents(other.profileId);
    const otherText = otherEvents
      .map((e) => `${e.title} ${e.subtitle ?? ""} ${e.detail ?? ""}`)
      .join("\n");
    expect(otherText).toContain("OTHER");
    expect(otherText).not.toContain("TLINE");
  });

  it("shows future-dated events (e.g. a goal target date) in the default view", () => {
    const futureDate = shiftDateStr(imperial.todayStr, 30);
    const futureGoalId = Number(
      db
        .prepare(
          `INSERT INTO goals (profile_id, title, category, status, target_date, archived)
             VALUES (?, 'TLINE Future Marathon', 'endurance', 'active', ?, 0)`
        )
        .run(imperial.profileId, futureDate).lastInsertRowid
    );

    // Default view (no date range) must NOT cap at today: the future goal appears
    // and, being newest, sorts to the very top of the feed.
    const events = getTimelineEvents(imperial.profileId);
    const future = events.find((e) => e.id === `goal:${futureGoalId}`);
    expect(future).toBeDefined();
    expect(future?.date).toBe(futureDate);
    expect(events[0]?.id).toBe(`goal:${futureGoalId}`);

    // An explicit upper bound of today still excludes it.
    const bounded = getTimelineEvents(imperial.profileId, {
      endDate: imperial.todayStr,
    });
    expect(bounded.some((e) => e.id === `goal:${futureGoalId}`)).toBe(false);
  });

  it("pushes the date window into SQL so an old bounded window returns its rows even with a small limit", () => {
    const oldDate = shiftDateStr(imperial.todayStr, -120);
    const ancientId = Number(
      db
        .prepare(
          `INSERT INTO activities
             (profile_id, date, type, title, duration_min, distance_km)
           VALUES (?, ?, 'cardio', 'TLINE Ancient Run', 20, 2)`
        )
        .run(imperial.profileId, oldDate).lastInsertRowid
    );

    // A window centered on the OLD date with a tiny page size must still surface
    // the old row — the range is filtered in SQL, not by slicing the most-recent
    // rows in JS (the pre-fix bug returned the newest N then filtered to empty).
    const events = getTimelineEvents(imperial.profileId, {
      category: "activity",
      startDate: shiftDateStr(oldDate, -2),
      endDate: shiftDateStr(oldDate, 2),
      limit: 25,
    });
    expect(events.some((e) => e.id === `activity:${ancientId}`)).toBe(true);
    // Recent activity is correctly outside the old window.
    expect(
      events.some((e) => e.id === `activity:${imperial.cardioActivityId}`)
    ).toBe(false);
  });

  it("can exclude training events while retaining non-training timeline history", () => {
    const events = getTimelineEvents(imperial.profileId, {
      includeTrainingEvents: false,
    });

    expect(events.some((e) => e.category === "activity")).toBe(false);
    expect(events.some((e) => e.category === "goal")).toBe(false);
    expect(events.some((e) => e.category === "body")).toBe(true);
    expect(events.some((e) => e.category === "medical")).toBe(true);
    expect(events.some((e) => e.category === "medication")).toBe(true);
  });

  it("returns timeline calendar dates with optional training exclusion", () => {
    const activityOnlyDate = shiftDateStr(imperial.todayStr, -12);
    const medicalOnlyDate = shiftDateStr(imperial.todayStr, -13);
    db.prepare(
      `INSERT INTO activities
         (profile_id, date, type, title, duration_min)
       VALUES (?, ?, 'strength', 'TLINE Activity Only', 20)`
    ).run(imperial.profileId, activityOnlyDate);
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value)
       VALUES (?, ?, 'lab', 'TLINE Medical Only', 'ok')`
    ).run(imperial.profileId, medicalOnlyDate);

    expect(getTimelineDates(imperial.profileId)).toContain(activityOnlyDate);
    expect(getTimelineDates(imperial.profileId)).toContain(medicalOnlyDate);

    const restrictedDates = getTimelineDates(imperial.profileId, {
      includeTrainingEvents: false,
    });
    expect(restrictedDates).not.toContain(activityOnlyDate);
    expect(restrictedDates).toContain(medicalOnlyDate);
  });

  it("honors category and date filters", () => {
    const oldDate = shiftDateStr(imperial.todayStr, -45);
    const oldActivityId = Number(
      db
        .prepare(
          `INSERT INTO activities
             (profile_id, date, type, title, duration_min, distance_km)
           VALUES (?, ?, 'cardio', 'TLINE Old Run', 20, 2)`
        )
        .run(imperial.profileId, oldDate).lastInsertRowid
    );

    const activityEvents = getTimelineEvents(imperial.profileId, {
      category: "activity",
      startDate: shiftDateStr(imperial.todayStr, -7),
      endDate: imperial.todayStr,
    });

    expect(activityEvents.every((e) => e.category === "activity")).toBe(true);
    expect(activityEvents.map((e) => e.id)).toContain(
      `activity:${imperial.cardioActivityId}`
    );
    expect(activityEvents.map((e) => e.id)).not.toContain(
      `activity:${oldActivityId}`
    );
  });
});

describe("getTimelineDates — tz-correct created-at fallback (#619)", () => {
  it("highlights the day the timeline places a created-at-fallback event on", () => {
    // Profile in America/New_York; a document uploaded 01:00 UTC July 13 = 21:00
    // local July 12. The event resolves to July 12 (dateFromCreatedAt), so the
    // calendar highlight must be July 12 too — not the raw-UTC July 13 the old
    // substr() slice emitted (which highlighted an EMPTY day).
    const p = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('tz fallback')").run()
        .lastInsertRowid
    );
    setTimezone(p, "America/New_York");
    db.prepare(
      `INSERT INTO medical_documents
         (profile_id, filename, stored_path, extraction_status, uploaded_at)
       VALUES (?, 'labs.pdf', '', 'done', '2026-07-13 01:00:00')`
    ).run(p);

    // Where the timeline actually places the event.
    const eventDates = getTimelineEvents(p, { category: "document" }).map(
      (e) => e.date
    );
    expect(eventDates).toContain("2026-07-12");

    // The calendar dates must agree: July 12 highlighted, July 13 not.
    const calDates = getTimelineDates(p);
    expect(calDates).toContain("2026-07-12");
    expect(calDates).not.toContain("2026-07-13");
  });

  it("a document with an explicit document_date is unaffected by tz", () => {
    const p = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('tz explicit')").run()
        .lastInsertRowid
    );
    setTimezone(p, "America/New_York");
    db.prepare(
      `INSERT INTO medical_documents
         (profile_id, filename, stored_path, extraction_status, document_date, uploaded_at)
       VALUES (?, 'labs.pdf', '', 'done', '2026-07-13', '2026-07-13 01:00:00')`
    ).run(p);
    expect(getTimelineDates(p)).toContain("2026-07-13");
  });
});
