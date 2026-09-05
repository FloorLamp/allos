// DB INTEGRATION TIER — timeline query coverage.
//
// Timeline is a cross-domain read layer over real profile-owned tables. These
// tests exercise the SQL against the migrated temp DB so unit formatting,
// category/date filtering, and profile scoping are covered beyond pure helpers.

import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  getTimelineDates,
  getTimelineEvents,
  TIMELINE_DATE_UNION,
  timelineDatesUnionSql,
} from "@/lib/timeline";
import { seedProfile, seedSchemaRow, type SeededProfile } from "./fixtures";
import { setStoredAge, setTimezone } from "@/lib/settings";

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
      units: { distanceUnit: "mi", weightUnit: "lb", temperatureUnit: "F" },
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

  it("links cycling events to ride detail while other activities open their own page (#2870)", () => {
    const rideId = Number(
      db
        .prepare(
          `INSERT INTO activities
             (profile_id, date, type, title, duration_min, components)
           VALUES (?, ?, 'cardio', 'TLINE Ride', 45, ?)`
        )
        .run(
          imperial.profileId,
          imperial.todayStr,
          JSON.stringify([{ name: "Cycling", type: "cardio" }])
        ).lastInsertRowid
    );

    const events = getTimelineEvents(imperial.profileId);
    expect(
      events.find((event) => event.id === `activity:${rideId}`)?.href
    ).toBe(`/training/activity/${rideId}`);
    expect(
      events.find(
        (event) => event.id === `activity:${imperial.cardioActivityId}`
      )?.href
    ).toBe(`/training/activity/${imperial.cardioActivityId}`);
  });

  it("includes expandable strength exercise summaries on activity events", () => {
    const events = getTimelineEvents(imperial.profileId, {
      units: { distanceUnit: "km", weightUnit: "lb", temperatureUnit: "F" },
    });

    const strength = events.find(
      (e) => e.id === `activity:${imperial.strengthActivityId}`
    );
    expect(strength?.detailItems).toContainEqual({
      label: "Back Squat",
      value: "220.5 lb × 5 × 2",
    });
  });

  it("includes medical result values as expansion details", () => {
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
  });

  it("does not duplicate first-class dose rows as day summaries", () => {
    const p = seedProfile("DOSEKIND");
    const medDoseId = db
      .prepare(`SELECT id FROM intake_item_doses WHERE item_id = ?`)
      .get(p.medicationId) as { id: number };
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date) VALUES (?, ?, ?)`
    ).run(medDoseId.id, p.medicationId, p.todayStr);

    const events = getTimelineEvents(p.profileId);
    expect(events.filter((event) => event.id.startsWith("intake:"))).toEqual(
      []
    );
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

  it("derives only schedule-backed immunization dose positions", () => {
    const profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('DOSE POSITION')").run()
        .lastInsertRowid
    );
    const insert = db.prepare(
      `INSERT INTO immunizations (profile_id, date, vaccine, dose_label)
       VALUES (?, ?, ?, ?)`
    );
    const mmr1 = Number(
      insert.run(profileId, "2000-01-01", "mmr", null).lastInsertRowid
    );
    const mmr2 = Number(
      insert.run(profileId, "2001-01-01", "mmr", null).lastInsertRowid
    );
    const explicit = Number(
      insert.run(profileId, "2000-03-01", "hepb", "Birth dose").lastInsertRowid
    );
    const tooClose = [
      Number(
        insert.run(profileId, "2000-04-01", "varicella", null).lastInsertRowid
      ),
      Number(
        insert.run(profileId, "2000-04-10", "varicella", null).lastInsertRowid
      ),
    ];
    const unknown = Number(
      insert.run(profileId, "2000-05-01", "novel-jab", null).lastInsertRowid
    );

    const events = getTimelineEvents(profileId, { category: "immunization" });
    const subtitle = (id: number) =>
      events.find((event) => event.id === `immunization:${id}`)?.subtitle;
    expect(subtitle(mmr1)).toBe("Dose 1 of 2");
    expect(subtitle(mmr2)).toBe("Dose 2 of 2");
    expect(subtitle(explicit)).toBe("Birth dose");
    expect(tooClose.map(subtitle)).toEqual([null, null]);
    expect(subtitle(unknown)).toBeNull();

    // Position is assessed from the full record, not restarted at the page window.
    expect(
      getTimelineEvents(profileId, {
        category: "immunization",
        startDate: "2000-12-01",
      })[0]?.subtitle
    ).toBe("Dose 2 of 2");
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

  it("links a visit to the records its import document produced (#662)", () => {
    const p = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('LINEAGE')").run()
        .lastInsertRowid
    );
    const docId = Number(
      db
        .prepare(
          `INSERT INTO medical_documents
             (profile_id, filename, stored_path, extraction_status, doc_type)
           VALUES (?, 'ccd.xml', '', 'done', 'ccd')`
        )
        .run(p).lastInsertRowid
    );
    const visitId = Number(
      db
        .prepare(
          `INSERT INTO encounters (profile_id, date, type, reason, document_id)
           VALUES (?, '2026-05-01', 'Office Visit', 'annual', ?)`
        )
        .run(p, docId).lastInsertRowid
    );
    // Sibling records produced by the SAME document.
    db.prepare(
      `INSERT INTO procedures (profile_id, name, date, source, document_id)
       VALUES (?, 'Colonoscopy', '2026-05-01', 'extracted', ?)`
    ).run(p, docId);
    db.prepare(
      `INSERT INTO care_plan_items (profile_id, description, source, document_id)
       VALUES (?, 'Follow-up in 6 months', 'extracted', ?)`
    ).run(p, docId);
    db.prepare(
      `INSERT INTO intake_items (profile_id, name, kind, source, document_id)
       VALUES (?, 'Lisinopril', 'medication', 'extracted', ?)`
    ).run(p, docId);
    // A record on a DIFFERENT document must NOT leak into this visit's context.
    const otherDoc = Number(
      db
        .prepare(
          `INSERT INTO medical_documents
             (profile_id, filename, stored_path, extraction_status, doc_type)
           VALUES (?, 'other.pdf', '', 'done', 'lab')`
        )
        .run(p).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO procedures (profile_id, name, date, source, document_id)
       VALUES (?, 'Unrelated biopsy', '2026-05-01', 'extracted', ?)`
    ).run(p, otherDoc);

    const events = getTimelineEvents(p);
    const visit = events.find((e) => e.id === `visit:${visitId}`);
    const labels = (visit?.linkedRefs ?? []).map((r) => r.label);
    expect(labels).toEqual([
      "Procedure: Colonoscopy",
      "Care plan: Follow-up in 6 months",
      "Medication: Lisinopril",
    ]);
    expect(visit?.linkedRefs).toContainEqual({
      label: "Medication: Lisinopril",
      href: "/medications",
    });
    // The other document's procedure is not part of this visit's lineage.
    expect(labels).not.toContain("Procedure: Unrelated biopsy");
  });

  it("a manual visit (no document) carries no linked context (#662)", () => {
    const p = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('MANUALVISIT')").run()
        .lastInsertRowid
    );
    const visitId = Number(
      db
        .prepare(
          `INSERT INTO encounters (profile_id, date, type, reason)
           VALUES (?, '2026-05-02', 'Office Visit', 'manual')`
        )
        .run(p).lastInsertRowid
    );
    const events = getTimelineEvents(p);
    const visit = events.find((e) => e.id === `visit:${visitId}`);
    expect(visit).toBeDefined();
    expect(visit?.linkedRefs).toBeUndefined();
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

// EVERY UNION arm of getTimelineDates filters by profile (#5117). The arms are
// literals inside ONE prepared statement, so the profile-scoping scan reads the
// wrapper and never them — its ALLOW_COMPOSED entry rests on this block instead.
//
// The cases are SPLIT OUT OF THE STRING getTimelineDates interpolates, not read from
// a list beside it: while the array was assembled in getTimelineDates, an arm pushed
// between the call and the `.prepare` reached the running statement and no case here.
// Each row is built from the arm's own table, so an eighteenth arm arrives with its
// case already written, wherever in timelineDatesUnionSql it is added.
describe("getTimelineDates: every UNION arm is profile-scoped", () => {
  const tableOf = (arm: string) => /\bFROM\s+(\w+)/i.exec(arm)?.[1];
  const dateColOf = (arm: string) =>
    /^\s*SELECT\s+(?:\w+\.)?(\w+)/i.exec(arm)?.[1];

  // One row in the arm's own table, on `date`, belonging to `profileId` — the rest of
  // the columns filled from the schema by the shared fixture seeder, which is also
  // what the PROVIDER_LINK_SELECTS arm rule in lib/__db_tests__/export.test.ts builds
  // its cases with.
  function seedArmRow(arm: string, profileId: number, date: string) {
    const table = tableOf(arm);
    const dateCol = dateColOf(arm);
    expect(table && dateCol, `unreadable arm: ${arm}`).toBeTruthy();
    seedSchemaRow(table as string, { [dateCol as string]: date }, profileId);
  }

  let leaky: SeededProfile;
  beforeAll(() => {
    leaky = seedProfile("ARMS");
  });

  const arms = timelineDatesUnionSql(true).split(TIMELINE_DATE_UNION);

  it("reads the arm list off the statement itself", () => {
    // A parse that silently found nothing would make every case below vacuous.
    expect(arms.length).toBeGreaterThan(10);
    for (const arm of arms) {
      expect(tableOf(arm), arm).toBeTruthy();
      expect(dateColOf(arm), arm).toBeTruthy();
      // …and each slice is ONE simple SELECT. The split is on the separator
      // literal, and each case reads only the FIRST `FROM` of its slice — so an arm
      // that is itself a compound (an indented `UNION` of its own) is one slice
      // whose second half no case ever looks at, while still GAINING a case, which
      // is what makes it look covered. Refused by naming the offence: write it as
      // separate arms and each half gets its own case.
      expect(
        arm.match(/\bSELECT\b/gi)?.length,
        `this arm is itself a compound — split it into separate arms: ${arm}`
      ).toBe(1);
    }
    // The cases are built from the includeTrainingEvents=true statement, which today
    // is a superset: the flag only PUSHES arms. An arm reaching the `false` statement
    // and no case would be invisible here, so that containment is asserted rather
    // than assumed.
    for (const arm of timelineDatesUnionSql(false).split(TIMELINE_DATE_UNION))
      expect(
        arms,
        `an arm only the bounded statement carries: ${arm}`
      ).toContain(arm);
  });

  it.each(arms.map((arm, i) => [i, tableOf(arm), arm] as const))(
    "arm %i (%s) keeps its own profile's dates off another profile's calendar",
    (i, _table, arm) => {
      const date = `2007-05-${String(i + 1).padStart(2, "0")}`;
      seedArmRow(arm, leaky.profileId, date);
      // The positive control: the seeded row REACHES the read, so the absence
      // asserted next is about the filter and not about an unreachable fixture.
      expect(getTimelineDates(leaky.profileId)).toContain(date);
      expect(getTimelineDates(imperial.profileId)).not.toContain(date);
    }
  );
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

describe("protocol timeline events follow the record at every age (#3133)", () => {
  function profileWithProtocol(name: string, age: number | null): number {
    const id = Number(
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
        .lastInsertRowid
    );
    if (age != null) setStoredAge(id, age);
    db.prepare(
      `INSERT INTO protocols (profile_id, name, start_date, outcome_keys)
       VALUES (?, 'Synthetic protocol', '2026-01-01', '[]')`
    ).run(id);
    return id;
  }

  // A recorded protocol is the profile's OWN data, and a profile's own data is
  // never filtered from that profile (#3067). Re-wrapping lib/timeline.ts's
  // protocols read in isLongevityRelevant reds the minor and unknown-age cases.
  it.each([
    ["adult", 30],
    ["minor", 10],
    ["unknown-age", null],
  ] as const)("shows a %s profile's own protocol events", (label, age) => {
    const id = profileWithProtocol(`timeline-${label}-protocol`, age);
    expect(
      getTimelineEvents(id).some((event) => event.category === "protocol")
    ).toBe(true);
  });
});
