// DB INTEGRATION TIER — imported vitals unit gaps (#1018). Drives the REAL
// document-import boundary (parseCcda → healthRecordToPersistInput →
// persistDocumentImport, the exact health-record pipeline) and the REAL episode
// assembly, and proves the two safety properties end-to-end:
//   (1) an imported Celsius temperature is stored in canonical °F and gets its
//       reference-range flag (a fever IS fever-flagged), and an imported
//       UCUM-spelled "mm[Hg]" blood pressure converts against the canonical band
//       and flags (chart-membership + flag recovery, values already correct);
//   (2) the episode fever curve is unit-gated: a legacy unconverted Cel row
//       (stored before the boundary conversion existed) is CONVERTED, an
//       unknown-unit row is EXCLUDED, and the red-flag engine judges the
//       converted value — a 40.3 Cel latest reading is a 104.5 °F hyperpyrexia
//       crossing, not a sub-normal "40.3 °F" that suppresses the flag.
// All values synthetic (Test Patient–class fixtures; no PHI).

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { parseCcda } from "@/lib/cda";
import { healthRecordToPersistInput } from "@/lib/import-shape";
import {
  persistDocumentImport,
  applyImportFollowups,
} from "@/lib/import-persist";
import { assembleIllnessEpisode } from "@/lib/illness-episode";
import { detectEpisodeTempRedFlag } from "@/lib/temp-red-flag";
import { up as convergeTemps } from "@/lib/migrations/versions/073-imported-temperature-degf";

const D = "2026-06-10";

// A synthetic MyChart-shaped vitals section: a Celsius temperature, a UCUM-spelled
// systolic blood pressure, and an unrecognized-unit temperature (stays verbatim).
const VITALS_CCD = `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <component><structuredBody><component><section>
    <code code="8716-3" codeSystem="2.16.840.1.113883.6.1"/>
    <title>Vital Signs</title>
    <entry><organizer classCode="CLUSTER" moodCode="EVN">
      <component><observation classCode="OBS" moodCode="EVN">
        <code code="8310-5" codeSystem="2.16.840.1.113883.6.1" displayName="Body temperature"/>
        <effectiveTime value="20260610"/>
        <value type="PQ" value="38.5" unit="Cel"/>
      </observation></component>
      <component><observation classCode="OBS" moodCode="EVN">
        <code code="8480-6" codeSystem="2.16.840.1.113883.6.1" displayName="Systolic blood pressure"/>
        <effectiveTime value="20260610"/>
        <value type="PQ" value="158" unit="mm[Hg]"/>
      </observation></component>
    </organizer></entry>
  </section></component></structuredBody></component>
</ClinicalDocument>`;

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function newDocument(profileId: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, extraction_status, doc_type)
         VALUES (?, 'vitals-ccd.xml', '', 'processing', 'ccd')`
      )
      .run(profileId).lastInsertRowid
  );
}

describe("imported temperature/BP unit normalization (#1018, import boundary)", () => {
  let profile: number;

  beforeAll(() => {
    profile = newProfile("IMPORTED-VITALS-UNITS");
    const parsed = parseCcda(VITALS_CCD);
    const input = healthRecordToPersistInput(parsed, "ccd", "CCD");
    const outcome = persistDocumentImport(profile, newDocument(profile), input);
    // The pipeline's post-commit follow-ups (lib/health-record-doc.ts) own the
    // flag reconcile — run them exactly as the real import path does.
    applyImportFollowups(profile, {
      demographics: input.demographics,
      canonicalNames: input.canonicalNamesToRegister,
      insertedRecordIds: outcome.insertedRecordIds,
      records: input.records,
    });
  });

  it("stores the Celsius reading in canonical °F and fever-flags it", () => {
    const row = db
      .prepare(
        `SELECT value, value_num, unit, flag FROM medical_records
          WHERE profile_id = ? AND canonical_name = 'Body Temperature'`
      )
      .get(profile) as {
      value: string;
      value_num: number;
      unit: string;
      flag: string | null;
    };
    expect(row).toMatchObject({
      value: "101.3",
      value_num: 101.3,
      unit: "degF",
    });
    // 101.3 °F against the canonical 97–99 band — the imported fever IS flagged.
    expect(row.flag).toBe("high");
  });

  it("flags the UCUM mm[Hg] blood pressure against the canonical mmHg band", () => {
    const row = db
      .prepare(
        `SELECT value_num, unit, flag FROM medical_records
          WHERE profile_id = ? AND canonical_name = 'Blood Pressure Systolic'`
      )
      .get(profile) as { value_num: number; unit: string; flag: string | null };
    // The value was always numerically correct; the unit stays as shipped —
    // sameUnit's bracket stripping is what makes it convertible.
    expect(row.value_num).toBe(158);
    expect(row.unit).toBe("mm[Hg]");
    // 158 against the canonical 90–120 mmHg band → high (was: no flag, ever).
    expect(row.flag).toBe("high");
  });
});

describe("episode fever curve unit gate (#1018, stored-row defense)", () => {
  let profile: number;

  const insertTemp = (
    date: string,
    value_num: number,
    unit: string | null,
    opts: { time?: string; external?: string } = {}
  ) =>
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, value, value_num, unit,
            canonical_name, source, external_id, notes)
         VALUES (?, ?, 'vitals', 'Body Temperature', ?, ?, ?,
                 'Body Temperature', ?, ?, ?)`
      )
      .run(
        profile,
        date,
        String(value_num),
        value_num,
        unit,
        opts.external ? "ccd" : "manual",
        opts.external ?? null,
        opts.time ?? null
      );

  beforeAll(() => {
    profile = newProfile("EPISODE-TEMP-GATE");
    // A canonical manual reading, then a LEGACY unconverted imported Cel row
    // (stored before the #1018 boundary conversion) as the LATEST reading, plus
    // an unknown-unit row that must never plot on the °F axis.
    insertTemp(D, 100.2, "degF", { time: "08:00" });
    insertTemp(D, 40.3, "Cel", {
      time: "20:00",
      external: "ccda:vital:8310-5:2026-06-10:40.3",
    });
    insertTemp(D, 311.2, "K", {
      time: "21:00",
      external: "ccda:vital:8310-5:2026-06-10:311.2",
    });
  });

  const assembled = () =>
    assembleIllnessEpisode(profile, {
      situation: "Illness",
      start: D,
      end: null,
    });

  it("converts the legacy Cel row, keeps °F rows, and excludes unknown units", () => {
    const ep = assembled();
    expect(ep.temperatures.map((t) => t.degF)).toEqual([100.2, 104.5]);
    // maxTempF / latestTemp reflect the CONVERTED value, not raw 40.3.
    expect(ep.maxTempF).toBe(104.5);
    expect(ep.latestTemp?.degF).toBe(104.5);
  });

  it("feeds the red-flag engine the converted reading (the missed-flag direction)", () => {
    // 40.3 Cel == 104.5 °F — a hyperpyrexia crossing. Pre-gate, the raw 40.3
    // plotted as "40.3 °F" and the red flag was silently suppressed.
    const f = detectEpisodeTempRedFlag(assembled(), { ageMonths: 30 * 12 });
    expect(f?.ruleKey).toBe("hyperpyrexia");
    expect(f?.degF).toBe(104.5);
  });
});

describe("migration 073 — stored-row temperature converge (#1018)", () => {
  let profile: number;
  const rows = () =>
    db
      .prepare(
        `SELECT value, value_num, unit, edited FROM medical_records
          WHERE profile_id = ? AND canonical_name = 'Body Temperature'
          ORDER BY id`
      )
      .all(profile) as {
      value: string;
      value_num: number;
      unit: string;
      edited: number;
    }[];

  beforeAll(() => {
    profile = newProfile("MIGRATION-073-TEMPS");
    const ins = db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value, value_num, unit,
          canonical_name, source, external_id, edited)
       VALUES (?, '2026-05-01', 'vitals', 'Body Temperature', ?, ?, ?,
               'Body Temperature', 'ccd', ?, ?)`
    );
    // 1: legacy unconverted Celsius import → converts.
    ins.run(profile, "38.5", 38.5, "Cel", "ccda:vital:t:1", 0);
    // 2: UCUM-spelled Fahrenheit → unit respelled, value untouched.
    ins.run(profile, "101.3", 101.3, "[degF]", "ccda:vital:t:2", 0);
    // 3: hand-edited Cel row (#133) → never re-converted.
    ins.run(profile, "101.5", 101.5, "Cel", "ccda:vital:t:3", 1);
    // 4: unrecognized unit → stays verbatim.
    ins.run(profile, "311.2", 311.2, "K", "ccda:vital:t:4", 0);
    // 5: implausible Celsius → stays verbatim (junk never enters the series).
    ins.run(profile, "900", 900, "Cel", "ccda:vital:t:5", 0);
    convergeTemps(db);
  });

  it("converts recognized Celsius rows and respells UCUM °F, honoring the edit lock", () => {
    expect(rows()).toEqual([
      { value: "101.3", value_num: 101.3, unit: "degF", edited: 0 },
      { value: "101.3", value_num: 101.3, unit: "degF", edited: 0 },
      { value: "101.5", value_num: 101.5, unit: "Cel", edited: 1 },
      { value: "311.2", value_num: 311.2, unit: "K", edited: 0 },
      { value: "900", value_num: 900, unit: "Cel", edited: 0 },
    ]);
  });

  it("replays as a pure no-op (the migrate() wrapper re-runs up())", () => {
    const before = rows();
    convergeTemps(db);
    expect(rows()).toEqual(before);
  });
});
