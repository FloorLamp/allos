import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { gatherHistoryLog } from "@/lib/history";
import { zonedWallTimeToUtc } from "@/lib/date";
import { setLoginSetting, setProfileSetting } from "@/lib/settings";
import { logSymptomCore } from "@/lib/symptom-log-write";
import { createCycleRow } from "@/lib/cycle-store";

// PHASE 2'S THREE NEW GATHERS, at the tier that can see the boundaries they cross
// (#3958). Sleep is the hard one and it is the reason this file exists: the day a
// night belongs to is a profile-LOCAL question about the instant it ENDED, and every
// way of getting that wrong looks right inside a single UTC day.

function profile(name: string, tz: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setProfileSetting(id, "timezone", tz);
  return id;
}

// THE PAGE'S ONE CLOCK GRAMMAR IS THE 12-HOUR ONE ("10:07am", lower-nospace), and the
// login pref is what selects it — so a login that leaves the 24h default would let the
// sleep window assertion below pass without ever exercising the grammar #3958 names.
function login(): number {
  const id = Number(
    db
      .prepare("INSERT INTO logins (username, password_hash) VALUES (?, 'x')")
      .run(`hist2_${Math.random().toString(36).slice(2, 8)}`).lastInsertRowid
  );
  setLoginSetting(id, "time_format", "12h");
  return id;
}

/**
 * One night, stated in the PROFILE's own wall clock and stored as the instants that
 * wall clock means. Naive `${day}T23:38` strings would be host-UTC and the whole
 * question this file asks would be answered by the runner's timezone (#1417).
 */
function night(
  profileId: number,
  tz: string,
  opts: {
    bedDay: string;
    bedTime: string;
    wakeDay: string;
    wakeTime: string;
    minutes: number;
    /** The SOURCE's own wake-day stamp, which need not be the profile-local one. */
    storedDate?: string;
    source?: string;
  }
): void {
  const start = zonedWallTimeToUtc(
    tz,
    opts.bedDay,
    opts.bedTime
  )!.toISOString();
  const end = zonedWallTimeToUtc(
    tz,
    opts.wakeDay,
    opts.wakeTime
  )!.toISOString();
  db.prepare(
    `INSERT INTO metric_samples
       (profile_id, source, metric, date, started_at, ended_at, value)
     VALUES (?, ?, 'sleep_min', ?, ?, ?, ?)`
  ).run(
    profileId,
    opts.source ?? "oura",
    opts.storedDate ?? opts.wakeDay,
    start,
    end,
    opts.minutes
  );
}

describe("the sleep kind", () => {
  // TWO ZONES EITHER SIDE OF UTC, so a gather that used the host's clock, or the
  // session's START, or the stored `date` column, is wrong in at least one of them.
  it.each([
    ["Pacific/Auckland", "2026-08-27", "23:38", "2026-08-28", "06:41"],
    ["America/Los_Angeles", "2026-08-27", "23:38", "2026-08-28", "06:41"],
  ])(
    "files a night that crosses midnight under its WAKE day in %s",
    (tz, bedDay, bedTime, wakeDay, wakeTime) => {
      const p = profile(`history sleep ${tz}`, tz);
      const loginId = login();
      night(p, tz, {
        bedDay,
        bedTime,
        wakeDay,
        wakeTime,
        minutes: 423,
        // THE SOURCE STAMPED THE BEDTIME DAY, which some providers do. The row must
        // still land on the wake day, because the wake instant is what decides.
        storedDate: bedDay,
      });

      const rows = gatherHistoryLog(p, {
        loginId,
        limit: 200,
        kind: "sleep",
      }).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].date).toBe(wakeDay);
      // `when` IS THE WAKE INSTANT: the row sorts at 06:41 in the profile's own clock,
      // which is what puts it at the top of its day beside a 7am dose rather than at
      // the bottom of the day before.
      expect(rows[0].sortTime).toBe(wakeTime);
      expect(rows[0].detail).toContain("11:38pm – 6:41am");
      expect(rows[0].detail).toContain("7h 03m");
      // › AND NOT ⋯: an imported night is corrected at its source.
      expect(rows[0].edit).toBeNull();
      expect(rows[0].href).toBe(`/history?day=${wakeDay}`);
    }
  );

  it("is reachable on the day view of the day it woke up on", () => {
    const tz = "Pacific/Auckland";
    const p = profile("history sleep day view", tz);
    const loginId = login();
    night(p, tz, {
      bedDay: "2026-08-27",
      bedTime: "23:38",
      wakeDay: "2026-08-28",
      wakeTime: "06:41",
      minutes: 423,
      storedDate: "2026-08-27",
    });
    // THE DAY VIEW IS THE CASE A NAIVE `date >= day` READ DROPS: the session's stored
    // day is the 27th, so a read starting at the 28th never sees the row it is for.
    expect(
      gatherHistoryLog(p, { loginId, limit: 200, day: "2026-08-28" }).rows.map(
        (r) => r.kind
      )
    ).toEqual(["sleep"]);
    expect(
      gatherHistoryLog(p, { loginId, limit: 200, day: "2026-08-27" }).rows
    ).toHaveLength(0);
  });
});

describe("the symptom kind", () => {
  it("is one row per symptom-day, correctable, and earns the Photos filter", () => {
    const tz = "UTC";
    const p = profile("history symptoms", tz);
    const loginId = login();
    logSymptomCore(p, "headache", 3, "2026-08-28", "page", "throbbing");
    logSymptomCore(p, "nausea", 1, "2026-08-28", "page", "");

    const gather = gatherHistoryLog(p, {
      loginId,
      limit: 200,
      kind: "symptom",
    });
    // ONE ROW PER SYMPTOM, not the timeline's one-per-day aggregate.
    expect(gather.rows.map((r) => r.title).sort()).toEqual([
      "Headache",
      "Nausea",
    ]);
    expect(gather.rows.every((r) => r.date === "2026-08-28")).toBe(true);
    // A symptom-day carries no clock, so it sinks below the day's timed rows.
    expect(gather.rows.every((r) => r.sortTime === null)).toBe(true);
    expect(gather.rows.every((r) => r.edit?.kind === "symptom")).toBe(true);
    expect(gather.rows.map((r) => r.detail)).toContain("Severe · throbbing");

    // THE PHOTOS CHIP IS ABSENT UNTIL A ROW CARRIES MEDIA, and present after. Both
    // directions, because presence alone passes on a chip that is always rendered.
    expect(gather.rows.every((r) => r.media === 0)).toBe(true);
    expect(
      gatherHistoryLog(p, { loginId, limit: 200, media: true }).mediaApplied
    ).toBe(false);

    const logId = Number(
      (
        db
          .prepare(
            "SELECT id FROM symptom_logs WHERE profile_id = ? AND symptom = 'headache'"
          )
          .get(p) as { id: number }
      ).id
    );
    db.prepare(
      `INSERT INTO symptom_photos
         (profile_id, symptom_log_id, date, symptom, stored_path, mime_type,
          content_hash)
       VALUES (?, ?, '2026-08-28', 'headache', 'sym/one.jpg', 'image/jpeg',
               'photo hash one 1')`
    ).run(p, logId);

    const withMedia = gatherHistoryLog(p, {
      loginId,
      limit: 200,
      kind: "symptom",
    });
    expect(withMedia.rows.find((r) => r.title === "Headache")?.media).toBe(1);
    // AND THE PHOTO BINDS TO ITS OWN SYMPTOM-DAY, not to the day: two symptoms logged
    // on one day keep distinct sets, so the filter narrows to the row that has one.
    expect(withMedia.rows.find((r) => r.title === "Nausea")?.media).toBe(0);
    const filtered = gatherHistoryLog(p, {
      loginId,
      limit: 200,
      kind: "symptom",
      media: true,
    });
    expect(filtered.mediaApplied).toBe(true);
    expect(filtered.rows.map((r) => r.title)).toEqual(["Headache"]);
  });
});

describe("the cycle kind", () => {
  it("records the period's start and stop markers, and never a forecast", () => {
    const p = profile("history cycles", "UTC");
    const loginId = login();
    createCycleRow(p, "2026-08-20", "2026-08-24", "medium", null);
    createCycleRow(p, "2026-07-19", "2026-07-23", null, null);

    const rows = gatherHistoryLog(p, {
      loginId,
      limit: 200,
      kind: "cycle",
    }).rows;
    expect(rows.map((r) => `${r.date} ${r.title}`)).toEqual([
      "2026-08-24 Period ended",
      "2026-08-20 Period started",
      "2026-07-23 Period ended",
      "2026-07-19 Period started",
    ]);
    // The start marker names the cycle day the shared derivation gives it, and the
    // flow the person recorded.
    expect(rows[1].detail).toBe("Cycle day 1 · Medium");
    // A cycle marker is a DATE, so it sinks per the standing rule.
    expect(rows.every((r) => r.sortTime === null)).toBe(true);
    expect(rows.every((r) => r.edit?.kind === "cycle")).toBe(true);
    // RECORDS, NEVER FORECASTS: no row for a predicted next period.
    expect(rows.every((r) => r.date <= "2026-08-24")).toBe(true);
  });
});

// THE SEAM PHASE 2D OPENED (#662/#2920). `lib/timeline.ts` composes a visit's lineage
// refs and a lab panel's per-marker breakdown; the record's rows carry them across so
// the row's disclosure can draw them. The tier matters: the fields are built by SQL
// over an import document's siblings, so a unit fixture would be asserting the shape
// of its own literal rather than that the gather still reaches them.
describe("the feed rows carry their disclosure content (#3958 phase 2d)", () => {
  it("brings a visit's document lineage onto its row, scoped", () => {
    const loginId = login();
    const p = profile("lineage", "UTC");
    const date = "2026-08-18";
    const docId = Number(
      db
        .prepare(
          `INSERT INTO medical_documents
             (profile_id, filename, stored_path, extraction_status, doc_type)
           VALUES (?, 'lineage-ccd.xml', '', 'done', 'ccd')`
        )
        .run(p).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO encounters (profile_id, date, type, reason, document_id)
       VALUES (?, ?, 'Ophthalmology', 'blinking', ?)`
    ).run(p, date, docId);
    db.prepare(
      `INSERT INTO intake_items (profile_id, name, kind, source, document_id)
       VALUES (?, 'Albuterol', 'medication', 'extracted', ?)`
    ).run(p, docId);

    const visit = gatherHistoryLog(p, { loginId, limit: 200 }).rows.find(
      (r) => r.kind === "visit"
    );
    expect(visit?.linkedRefs).toEqual([
      { label: "Medication: Albuterol", href: "/medications" },
    ]);
    // ONE ENCOUNTER IN THE DOCUMENT, so document ≈ visit and the heading may say so
    // (#2920). The scope has to ride ALONG with the refs: "From this visit" is a
    // prefix of "From this visit's document", so a row that lost this field would
    // render a heading that still reads like a sentence.
    expect(visit?.linkedScope).toBe("document");
  });

  it("brings a lab panel's breakdown onto its row", () => {
    const loginId = login();
    const p = profile("panel", "UTC");
    // TWO ROWS OF ONE PANEL ON ONE DAY, because the breakdown is what the GATHER
    // assembles by grouping them — a single row would produce a one-item list that a
    // gather doing no grouping at all would also produce.
    for (const m of [
      { name: "Zeta protein", value: "130", unit: "mg/dL", flag: "high" },
      { name: "Omega protein", value: "55", unit: "mg/dL", flag: "" },
    ]) {
      db.prepare(
        `INSERT INTO medical_records
           (profile_id, name, value, unit, date, flag, category, panel)
         VALUES (?, ?, ?, ?, '2026-08-18', ?, 'lab', 'Complete blood count')`
      ).run(p, m.name, m.value, m.unit, m.flag);
    }

    const lab = gatherHistoryLog(p, { loginId, limit: 200 }).rows.find(
      (r) => r.kind === "lab"
    );
    // BOTH markers, as one panel's breakdown — the flag rides along, because the
    // panel's disclosure is where an out-of-range value is legible at all now that
    // the row itself is one line.
    expect(lab?.detailItems).toEqual([
      { label: "Zeta protein", value: "130", unit: "mg/dL", flag: "high" },
      { label: "Omega protein", value: "55", unit: "mg/dL" },
    ]);
  });
});
