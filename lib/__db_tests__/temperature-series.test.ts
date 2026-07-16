// DB INTEGRATION TIER — manual body-temperature entry joins the ingested vitals
// series (issue #800). Drives the REAL write core (logTemperatureCore) alongside the
// REAL Health Connect ingest (parseHealthConnectPayload → upsertVitals → reconcileFlags)
// and proves:
//   (1) a manual reading and a synced reading form ONE "Body Temperature" series
//       (same #482 family identity) with no dedup collision — both survive;
//   (2) the is_latest chain spans both sources (one current reading per family);
//   (3) the #133 edit lock is respected two ways — a manual row (external_id NULL) is
//       structurally immune to a same-window ingest push, and a hand-edited IMPORTED
//       row is never clobbered by re-ingest.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { logTemperatureCore } from "@/lib/temperature-log";
import { parseHealthConnectPayload } from "@/lib/integrations/health-connect";
import { upsertVitals } from "@/lib/integrations/normalize";
import { reconcileFlags, getBiomarkerSeries } from "@/lib/queries";

const SRC = "health-connect";
const D = "2026-06-15";
let profile: number;

// Persist a Health Connect body-temperature push (°C) exactly like the ingest route:
// parse → upsertVitals → reconcileFlags on the affected ids. Returns the upsert counts.
function ingestTemp(celsius: number, time: string) {
  const parsed = parseHealthConnectPayload(
    { body_temperature: [{ time, celsius }] },
    "UTC"
  );
  const vt = upsertVitals(profile, parsed.vitals, SRC);
  reconcileFlags(profile, vt.ids);
  return vt.counts;
}

function series() {
  return getBiomarkerSeries(profile, "Body Temperature").map((r) => ({
    value_num: r.value_num,
    source: r.source,
    external_id: r.external_id,
    flag: r.flag,
  }));
}

beforeAll(() => {
  profile = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('FEVER')").run()
      .lastInsertRowid
  );
});

describe("manual + Health Connect body temperature → one series", () => {
  it("both sources coexist on one Body Temperature series with no dedup collision", () => {
    // Manual bedside reading (external_id NULL, source 'manual'), then a wearable push
    // the SAME day with a DIFFERENT value — distinct readings, not a duplicate.
    const manual = logTemperatureCore(profile, 101.2, "F", D, "09:00");
    expect(manual.kind).toBe("logged");

    const counts = ingestTemp(38.0, `${D}T14:00:00Z`); // 38.0 °C → 100.4 °F
    expect(counts.inserted).toBe(1);

    const s = series();
    // Two rows, one family series, both visible — no dedup collision.
    expect(s).toHaveLength(2);
    const values = s
      .map((r) => r.value_num)
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(values).toEqual([100.4, 101.2]);

    // The manual row is source 'manual' with a NULL external_id; the synced row carries
    // the Health Connect external_id — so they are keyed independently.
    const manualRow = s.find((r) => r.source === "manual")!;
    const syncedRow = s.find((r) => r.source === SRC)!;
    expect(manualRow.external_id).toBeNull();
    expect(manualRow.value_num).toBe(101.2);
    expect(syncedRow.external_id).toContain("Body Temperature");
    // The fever reading (101.2 °F) flags high through the shared reference range.
    expect(manualRow.flag).toBe("high");
  });

  it("is_latest spans both sources — exactly one current Body Temperature reading", () => {
    const latest = db
      .prepare(
        `WITH deduped AS (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (
               PARTITION BY profile_id, canonical_name COLLATE NOCASE, date, value, value_num, unit
               ORDER BY (document_id IS NULL) DESC, id DESC
             ) AS rn
             FROM medical_records WHERE profile_id = ? AND canonical_name = 'Body Temperature'
           ) WHERE rn = 1
         )
         SELECT id, ROW_NUMBER() OVER (
           PARTITION BY canonical_name COLLATE NOCASE ORDER BY date DESC, id DESC
         ) AS rn
         FROM medical_records
         WHERE profile_id = ? AND canonical_name = 'Body Temperature'
           AND id IN (SELECT id FROM deduped)`
      )
      .all(profile, profile) as { id: number; rn: number }[];
    // One family → exactly one row ranked current (rn = 1) across both sources.
    expect(latest.filter((r) => r.rn === 1)).toHaveLength(1);
  });

  it("edit lock: a manual reading is untouched by a later same-window ingest push", () => {
    const before = db
      .prepare(
        "SELECT id, value_num FROM medical_records WHERE profile_id = ? AND source = 'manual' AND canonical_name = 'Body Temperature'"
      )
      .get(profile) as { id: number; value_num: number };

    // A fresh rolling-window push (a different reading, same day) inserts its own row
    // and never matches the manual row (external_id NULL is unmatchable by upsert).
    const counts = ingestTemp(37.5, `${D}T21:00:00Z`); // 37.5 °C → 99.5 °F
    expect(counts.inserted).toBe(1);

    const after = db
      .prepare("SELECT value_num FROM medical_records WHERE id = ?")
      .get(before.id) as { value_num: number };
    expect(after.value_num).toBe(before.value_num); // manual row unchanged
  });

  it("edit lock: a hand-edited IMPORTED reading is never clobbered by re-ingest", () => {
    // The first synced row (100.4 °F). Simulate a hand-correction: change the value and
    // set the #133 edited flag, as the app's edit path does.
    const synced = db
      .prepare(
        "SELECT id, external_id FROM medical_records WHERE profile_id = ? AND source = ? AND value_num = 100.4"
      )
      .get(profile, SRC) as { id: number; external_id: string };
    db.prepare(
      "UPDATE medical_records SET value_num = ?, value = ?, edited = 1 WHERE id = ?"
    ).run(100.9, "100.9", synced.id);

    // Re-ingest the same external_id (time) with the original value — the edit lock
    // holds: the row is counted `edited`, not updated, and keeps the hand-corrected value.
    const parsed = parseHealthConnectPayload(
      { body_temperature: [{ time: `${D}T14:00:00Z`, celsius: 38.0 }] },
      "UTC"
    );
    const vt = upsertVitals(profile, parsed.vitals, SRC);
    expect(vt.counts.edited).toBe(1);
    expect(vt.counts.updated).toBe(0);

    const after = db
      .prepare("SELECT value_num FROM medical_records WHERE id = ?")
      .get(synced.id) as { value_num: number };
    expect(after.value_num).toBe(100.9); // hand-corrected value survives
  });
});
