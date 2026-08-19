// DB INTEGRATION TIER — the rollback contract for flag tokens (issue #2937).
//
// THE SCENARIO, built for real: a database is upgraded to a build that introduces a
// flag token, that build writes the token onto rows, and then the build is ROLLED
// BACK. The older build does not recognise the value. Before this change it never
// selected those rows for re-derivation (its `RECONCILABLE_FLAGS` list could not name
// a value that did not exist yet), while its display tier called them "Normal" and its
// care-tier read counted them as flagged — a permanent item reading "Flagged normal —
// 44", filterable by neither state.
//
// The rolled-back build is the one running this test: `FUTURE_TOKEN` stands for a
// value some later release writes, exactly as `reported-high` stood to a v10 build and
// `immune` stood to a v4 one. What only this tier can prove is the join — that the
// boot gate actually FIRES after a rollback (the future build stored ITS signature,
// which cannot equal this build's), that the row selection reaches the stranded rows,
// and that the surfaces then read a coherent result.
//
// SYNTHETIC ONLY: invented profile, invented values. No PHI.

import { describe, expect, it, beforeAll } from "vitest";
import { db } from "@/lib/db";
import {
  canonicalFlagsSignature,
  FLAG_LOGIC_VERSION,
} from "@/lib/canonical-flags-version";
import { reconcileFlagsIfCanonicalChanged } from "@/lib/migrations/boot-tasks";
import { getCurrentFlaggedBiomarkers, reconcileFlags } from "@/lib/queries";
import { biomarkerFlagDetail } from "@/lib/biomarker-flag-copy";
import { flagLabel, isNotableFlag } from "@/lib/reference-range";

// A token written by a build from the future. Not in MedicalFlag, so nothing in this
// build can produce it — which is precisely why an occurrence means "rolled back".
const FUTURE_TOKEN = "reported-critical";
const DRAW = "2026-06-03";

let profileId: number;
const ids: Record<string, number> = {};

function insert(r: {
  canonical: string;
  category?: string;
  value: string;
  valueNum: number | null;
  unit: string | null;
  printed?: string | null;
  date?: string;
  flag?: string | null;
}): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, canonical_name, value, value_num, unit,
            reference_range, flag)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        r.date ?? DRAW,
        r.category ?? "lab",
        r.canonical,
        r.canonical,
        r.value,
        r.valueNum,
        r.unit,
        r.printed ?? null,
        r.flag ?? null
      ).lastInsertRowid
  );
}

function flagOf(id: number): string | null {
  return (
    (
      db.prepare("SELECT flag FROM medical_records WHERE id = ?").get(id) as {
        flag: string | null;
      }
    ).flag ?? null
  );
}

// The signature the FUTURE build stored before the rollback: same dataset, a later
// logic version. Any build introducing a token bumps that version, so this is what a
// rolled-back build always finds in settings — and why its boot gate fires.
function futureBuildSignature(): string {
  return canonicalFlagsSignature(undefined, FLAG_LOGIC_VERSION + 1);
}

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('rollback_subject')").run()
      .lastInsertRowid
  );
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'birthdate', '1971-04-02')`
  ).run(profileId);

  // The issue's own analyte, band-less on purpose, on a report that printed no range
  // either: NOTHING this build has judges the value, so the future build's claim can
  // only be retired — and before #2937 no pass could reach it to do so.
  ids.bandless = insert({
    canonical: "Microalbumin/Creatinine Ratio, Urine",
    value: "44",
    valueNum: 44,
    unit: "mg/g",
    flag: FUTURE_TOKEN,
  });
  // The same analyte WITH the report's printed range: this build has a word for that
  // (#2799's `reported-high`), so the row is restated rather than cleared.
  ids.stated = insert({
    canonical: "Microalbumin/Creatinine Ratio, Urine",
    value: "44",
    valueNum: 44,
    unit: "mg/g",
    printed: "<30",
    date: "2026-06-10",
    flag: FUTURE_TOKEN,
  });
  // A row the catalog DOES band: the same token, on a value this build can re-judge.
  ids.banded = insert({
    canonical: "Alkaline Phosphatase",
    value: "300",
    valueNum: 300,
    unit: "U/L",
    flag: FUTURE_TOKEN,
  });
  // …and one whose value is in band, so re-derivation clears rather than re-marks.
  ids.bandedNormal = insert({
    canonical: "Albumin",
    value: "4.4",
    valueNum: 4.4,
    unit: "g/dL",
    flag: FUTURE_TOKEN,
  });
  // A QUALITATIVE row carrying the token — the `immune` shape (#544 introduced that
  // token on exactly this kind of row at v5). The numeric pass cannot reach it at all,
  // which is why the contract has a second half.
  ids.qualitative = insert({
    canonical: "Hepatitis B Surface Antibody",
    value: "Reactive",
    valueNum: null,
    unit: null,
    flag: FUTURE_TOKEN,
  });
  // The forward path's own row, unchanged by any of this: a lab-stated flag this build
  // does recognise and already knows how to retire.
  ids.recognized = insert({
    canonical: "Microalbumin/Creatinine Ratio, Urine",
    value: "44",
    valueNum: 44,
    unit: "mg/g",
    printed: "<30",
    flag: "reported-high",
  });
});

describe("a rolled-back build re-decides the tokens it does not recognise", () => {
  it("selects and retires a stranded token on the first boot after the rollback", () => {
    // The state a rollback actually leaves in settings.
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('canonical_flags_sig', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(futureBuildSignature());

    reconcileFlagsIfCanonicalChanged(db);

    // Nothing of ours judges the microalbumin, so the future build's claim is retired
    // rather than translated — this build cannot restate it in any vocabulary it has.
    expect(flagOf(ids.bandless)).toBeNull();
    // Where this build HAS a word for the row, it is restated rather than retired —
    // the report's own printed range (#2799), and our own reference band below.
    expect(flagOf(ids.stated)).toBe("reported-high");
    expect(flagOf(ids.banded)).toBe("high");
    expect(flagOf(ids.bandedNormal)).toBeNull();
    // The gate records this build's signature, so it runs once per change.
    expect(
      (
        db
          .prepare(
            "SELECT value FROM settings WHERE key = 'canonical_flags_sig'"
          )
          .get() as { value?: string }
      ).value
    ).toBe(canonicalFlagsSignature());
  });

  it("reaches the same rows through the request-path reconcile", () => {
    // The boot pass and reconcileFlags share the eligibility rule, so an import or a
    // manual edit repairs the same rows without waiting for a restart.
    const again = insert({
      canonical: "Microalbumin/Creatinine Ratio, Urine",
      value: "44",
      valueNum: 44,
      unit: "mg/g",
      date: "2026-06-17",
      flag: FUTURE_TOKEN,
    });
    reconcileFlags(profileId);
    expect(flagOf(again)).toBeNull();
  });

  it("leaves the forward path exactly as it was", () => {
    // `reported-high` is this build's own word for the same row, and it stands: the
    // value really is above the range the report printed.
    expect(flagOf(ids.recognized)).toBe("reported-high");
  });
});

describe("no row reads Normal and flagged at once", () => {
  it("keeps an unrecognised token off the care-tier flagged read", () => {
    // The qualitative row still carries the token — no pass of this build owns that
    // word on that row — and that is allowed. What is not allowed is the disagreement:
    // the shared flagged read used to admit it (`flag NOT IN ('normal','immune')`)
    // while flagLabel called it "Normal", producing "Flagged normal — 44".
    expect(flagOf(ids.qualitative)).toBe(FUTURE_TOKEN);

    const flagged = getCurrentFlaggedBiomarkers(profileId);
    for (const row of flagged) {
      expect(flagLabel(row.flag)).not.toBe("Normal");
      expect(isNotableFlag(row.flag)).toBe(true);
      expect(biomarkerFlagDetail(row.flag, row.value)).not.toContain(
        "Flagged normal"
      );
    }
  });

  it("still raises the readings this build does mark", () => {
    // The invariant above must not be satisfied by an empty list: a flag this build
    // DOES recognise still reaches the care-tier read, on the same query.
    insert({
      canonical: "Ferritin",
      value: "9",
      valueNum: 9,
      unit: "ng/mL",
      date: "2026-07-01",
      flag: "low",
    });
    const raised = getCurrentFlaggedBiomarkers(profileId);
    expect(raised.map((r) => r.name)).toContain("Ferritin");
    expect(
      raised
        .filter((r) => r.name === "Ferritin")
        .map((r) => biomarkerFlagDetail(r.flag, r.value))
    ).toEqual(["Flagged low — 9"]);
  });

  it("holds across every stored flag in the database, whatever wrote it", () => {
    // The rule is token-agnostic by construction: it asks whether THIS build
    // recognises the value, never which past release introduced it. Stated as an
    // invariant over the whole table so a future token cannot re-open the case.
    const stored = db
      .prepare(
        "SELECT DISTINCT flag FROM medical_records WHERE flag IS NOT NULL"
      )
      .all() as { flag: string }[];
    expect(stored.map((r) => r.flag)).toContain(FUTURE_TOKEN);
    for (const { flag } of stored) {
      if (flagLabel(flag) === "Normal") expect(isNotableFlag(flag)).toBe(false);
    }
  });
});
