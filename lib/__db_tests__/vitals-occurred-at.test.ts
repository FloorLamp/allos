// DB INTEGRATION TIER — medical_records' stated instant (#2154, below migration 165).
//
// What is pinned here, per the issue's own test list:
//
//   • a TIMED manual BP round-trips date + instant (canonical utcInstant shape) on
//     BOTH analytes — the sitting's ONE statement, shared by every observation the
//     submission writes;
//   • an UNTIMED one stores NULL and reads back day-grain through the reading
//     model — never a midnight anchor;
//   • a statement whose profile-local date disagrees with the row's `date` is
//     REFUSED at the boundary: the reading lands, the statement is dropped, the
//     row is never re-dated;
//   • the peak-flow blow derives its metric_samples `start_time` from the SAME
//     accepted instant (that store's natural key wants its own profile-local
//     shape), so one sitting states one "when" everywhere it lands;
//   • a PRE-FOLD queued intent's legacy `temperatureTime` still replays: the
//     temperature row — and only it — gets the instant, and no note is written;
//   • the IMPORTER writes the instant it already encodes into external_id, the
//     dedupe key stays external_id alone, a rolling-window re-send backfills a
//     pre-#2154 row's NULL as an ordinary update (no revision row), and the #133
//     edit lock holds the instant out of an edited row exactly as it holds the
//     value (the #2091/#1999 discipline — the column-set pin itself was edited by
//     the migration PR, its one legitimate path, and is asserted in
//     reading-series.test.ts, not re-pinned here);
//   • the temperature quick-log core writes occurred_at and leaves `notes` NULL —
//     the retired #800/#843 convention is never minted again — and the episode
//     fever curve reads the time off the column.
//
// All fixtures SYNTHETIC; dates sit in the past so the acceptance gate's future
// check (real clock — the db tier does not freeze time) can never fire.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { insertVitals } from "@/lib/offline/writes";
import { upsertVitals, type NormVital } from "@/lib/integrations/normalize";
import {
  logTemperatureCore,
  updateTemperatureCore,
} from "@/lib/temperature-log";
import { getReadingSeries } from "@/lib/queries/readings";

let profileId: number;

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  // Deterministic acceptance-gate math: the stated instants below are on their
  // row's day in UTC, whatever zone the host happens to run in.
  db.prepare(
    "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'timezone', 'UTC')"
  ).run(id);
  return id;
}

function medRows(canonical: string, date: string) {
  return db
    .prepare(
      `SELECT id, date, occurred_at, value_num, unit, source, external_id, notes, edited
         FROM medical_records
        WHERE profile_id = ? AND canonical_name = ? AND date = ? ORDER BY id`
    )
    .all(profileId, canonical, date) as {
    id: number;
    date: string;
    occurred_at: string | null;
    value_num: number;
    unit: string;
    source: string | null;
    external_id: string | null;
    notes: string | null;
    edited: number | null;
  }[];
}

beforeAll(() => {
  profileId = newProfile("VITALS-OCCURRED-AT");
});

describe("the manual vitals core (insertVitals)", () => {
  it("round-trips a timed BP: date + one canonical instant on both analytes", () => {
    expect(
      insertVitals(
        profileId,
        "2026-03-02",
        { systolic: "118", diastolic: "76" },
        // Millisecond ISO in — the shape a client's toISOString() posts.
        "2026-03-02T07:12:00.000Z"
      )
    ).toBe(true);
    for (const canonical of [
      "Blood Pressure Systolic",
      "Blood Pressure Diastolic",
    ]) {
      const rows = medRows(canonical, "2026-03-02");
      expect(rows).toHaveLength(1);
      // Normalized to lib/date.ts's utcInstant shape (second resolution, `Z`),
      // never stored in the caller's serialization.
      expect(rows[0].occurred_at).toBe("2026-03-02T07:12:00Z");
      expect(rows[0].date).toBe("2026-03-02");
      expect(rows[0].source).toBe("manual");
      expect(rows[0].external_id).toBeNull();
    }
    // The reading model presents the same instant — measuredAt now means one
    // thing across all three stores.
    const reading = getReadingSeries(profileId, "Blood Pressure Systolic").find(
      (r) => r.date === "2026-03-02"
    );
    expect(reading?.measuredAt).toBe("2026-03-02T07:12:00Z");
  });

  it("stores NULL for an untimed sitting, which reads back day-grain", () => {
    expect(insertVitals(profileId, "2026-03-03", { spo2: "97" }, null)).toBe(
      true
    );
    const rows = medRows("Oxygen Saturation", "2026-03-03");
    expect(rows).toHaveLength(1);
    // Honest absence — never a `${date}T00:00:00` anchor.
    expect(rows[0].occurred_at).toBeNull();
    const reading = getReadingSeries(profileId, "Oxygen Saturation").find(
      (r) => r.date === "2026-03-03"
    );
    expect(reading).toBeDefined();
    expect(reading!.measuredAt).toBeNull();
  });

  it("refuses a statement whose local date is not the row's date — reading kept, never re-dated", () => {
    expect(
      insertVitals(
        profileId,
        "2026-03-04",
        { glucose: "94", glucoseUnit: "mg/dL" },
        "2026-03-05T01:30:00Z" // the NEXT UTC day — off the row's own day
      )
    ).toBe(true);
    const rows = medRows("Glucose", "2026-03-04");
    expect(rows).toHaveLength(1);
    expect(rows[0].occurred_at).toBeNull();
    expect(rows[0].date).toBe("2026-03-04");
  });

  it("drives the peak-flow blow's start_time from the same sitting statement", () => {
    expect(
      insertVitals(
        profileId,
        "2026-03-05",
        { peakFlow: "410" },
        "2026-03-05T07:30:00Z"
      )
    ).toBe(true);
    // metric_samples keeps its own convention: the instant's profile-local wall
    // clock on the row's own day, part of the natural key — a second blow at
    // another time is a second reading, not a correction.
    const sample = db
      .prepare(
        `SELECT start_time, value FROM metric_samples
          WHERE profile_id = ? AND metric = 'peak_flow_lmin' AND date = '2026-03-05'`
      )
      .all(profileId) as { start_time: string; value: number }[];
    expect(sample).toEqual([{ start_time: "2026-03-05T07:30:00", value: 410 }]);
    expect(
      insertVitals(
        profileId,
        "2026-03-05",
        { peakFlow: "380" },
        "2026-03-05T20:10:00Z"
      )
    ).toBe(true);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM metric_samples
            WHERE profile_id = ? AND metric = 'peak_flow_lmin' AND date = '2026-03-05'`
        )
        .get(profileId)
    ).toEqual({ n: 2 });
  });

  it("replays a pre-fold intent's temperatureTime onto the temperature row alone, note-free", () => {
    // occurredAt undefined = the legacy shape: an intent queued before the fold.
    expect(
      insertVitals(profileId, "2026-03-06", {
        systolic: "121",
        diastolic: "79",
        temperature: "100.4",
        tempUnit: "F",
        temperatureTime: "19:40",
      })
    ).toBe(true);
    const temp = medRows("Body Temperature", "2026-03-06");
    expect(temp).toHaveLength(1);
    expect(temp[0].occurred_at).toBe("2026-03-06T19:40:00Z");
    // The retired #800/#843 note is never minted again.
    expect(temp[0].notes).toBeNull();
    // The per-measure time was only ever the temperature's statement.
    expect(
      medRows("Blood Pressure Systolic", "2026-03-06")[0].occurred_at
    ).toBeNull();
  });
});

describe("the importer write (upsertVitals)", () => {
  const externalId = "health-connect:Oxygen Saturation:2026-03-10T06:58:11Z";
  function spo2(over: Partial<NormVital> = {}): NormVital {
    return {
      external_id: externalId,
      date: "2026-03-10",
      occurred_at: "2026-03-10T06:58:11Z",
      category: "vitals",
      name: "Oxygen Saturation",
      canonical: "Oxygen Saturation",
      value_num: 97,
      unit: "%",
      ...over,
    };
  }

  it("writes the instant beside the external_id that already encoded it", () => {
    const { counts } = upsertVitals(profileId, [spo2()], "health-connect");
    expect(counts.inserted).toBe(1);
    const rows = medRows("Oxygen Saturation", "2026-03-10");
    expect(rows).toHaveLength(1);
    expect(rows[0].occurred_at).toBe("2026-03-10T06:58:11Z");
    expect(rows[0].external_id).toBe(externalId);
  });

  it("re-sends are unchanged; a pre-#2154 row's NULL backfills as an ordinary update", () => {
    // Identical resend → unchanged, nothing written.
    const resend = upsertVitals(profileId, [spo2()], "health-connect");
    expect(resend.counts.unchanged).toBe(1);

    // Simulate a row this source wrote BEFORE #2154: same key, no instant.
    db.prepare(
      `UPDATE medical_records SET occurred_at = NULL
        WHERE profile_id = ? AND external_id = ?`
    ).run(profileId, externalId);
    const backfill = upsertVitals(profileId, [spo2()], "health-connect");
    expect(backfill.counts.updated).toBe(1);
    const rows = medRows("Oxygen Saturation", "2026-03-10");
    expect(rows[0].occurred_at).toBe("2026-03-10T06:58:11Z");
    // An instant is DESCRIPTIVE: gaining one is not a re-issued result, so no
    // revision row was minted.
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM medical_record_revisions WHERE record_id = ?`
        )
        .get(rows[0].id)
    ).toEqual({ n: 0 });
  });

  it("the #133 edit lock holds the instant out of an edited row like the value", () => {
    const row = medRows("Oxygen Saturation", "2026-03-10")[0];
    db.prepare(
      `UPDATE medical_records SET edited = 1, occurred_at = NULL WHERE id = ?`
    ).run(row.id);
    const held = upsertVitals(profileId, [spo2()], "health-connect");
    expect(held.counts.edited).toBe(1);
    expect(held.counts.updated).toBe(0);
    expect(
      medRows("Oxygen Saturation", "2026-03-10")[0].occurred_at
    ).toBeNull();
  });
});

describe("the temperature quick-log core (the notes-hack, retired)", () => {
  it("writes occurred_at and leaves notes NULL on log AND update", () => {
    const logged = logTemperatureCore(
      profileId,
      100.2,
      "F",
      "2026-03-12",
      "08:05"
    );
    expect(logged.kind).toBe("logged");
    const id = (logged as { id: number }).id;
    let rows = medRows("Body Temperature", "2026-03-12");
    expect(rows).toHaveLength(1);
    expect(rows[0].occurred_at).toBe("2026-03-12T08:05:00Z");
    expect(rows[0].notes).toBeNull();

    // The edit sheet re-times the reading; an emptied time clears the statement.
    expect(
      updateTemperatureCore(profileId, id, 100.6, "2026-03-12", "21:15").kind
    ).toBe("updated");
    rows = medRows("Body Temperature", "2026-03-12");
    expect(rows[0].occurred_at).toBe("2026-03-12T21:15:00Z");
    expect(rows[0].notes).toBeNull();
    expect(
      updateTemperatureCore(profileId, id, 100.6, "2026-03-12", "").kind
    ).toBe("updated");
    expect(medRows("Body Temperature", "2026-03-12")[0].occurred_at).toBeNull();
  });

  it("an untimed reading stores NULL — absence, not a midnight anchor", () => {
    expect(logTemperatureCore(profileId, 98.9, "F", "2026-03-13").kind).toBe(
      "logged"
    );
    expect(medRows("Body Temperature", "2026-03-13")[0].occurred_at).toBeNull();
  });
});
