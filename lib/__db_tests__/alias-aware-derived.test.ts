// DB INTEGRATION TIER — alias-aware derived-index gathering.
//
// getDerivedBiomarkerReadings gathers each derived index's component series by the
// canonical INPUT name (e.g. "Mean Corpuscular Volume (MCV)"), grouping stored rows
// by their canonical_name. A stored component row under a LEGACY spelling (bare
// "MCV", as an un-migrated row would carry) must still land in the input's group —
// the series gathering snaps each row's canonical_name through the shared resolver
// first. Without it, PhenoAge would silently miss that component and never compute.
// The db singleton is redirected at a per-file temp DB by setup.ts before import.

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import { getDerivedBiomarkerReadings } from "@/lib/queries";

let profileId: number;
const DATE = "2024-01-01";

// The nine PhenoAge inputs at their canonical names + a healthy draw; MCV is
// deliberately stored under its LEGACY bare name to exercise the resolver.
const DRAW: { name: string; value: number; unit: string }[] = [
  { name: "Albumin", value: 4.7, unit: "g/dL" },
  { name: "Creatinine", value: 1.0, unit: "mg/dL" },
  { name: "Glucose", value: 90, unit: "mg/dL" },
  {
    name: "High-Sensitivity C-Reactive Protein (hs-CRP)",
    value: 0.5,
    unit: "mg/L",
  },
  { name: "Lymphocytes", value: 35, unit: "%" },
  { name: "MCV", value: 90, unit: "fL" }, // LEGACY spelling (canonical is "Mean Corpuscular Volume (MCV)")
  { name: "Red Cell Distribution Width (RDW)", value: 13, unit: "%" },
  { name: "Alkaline Phosphatase", value: 65, unit: "U/L" },
  { name: "White Blood Cell Count", value: 5.5, unit: "10^3/uL" },
];

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Alias Derived')").run()
      .lastInsertRowid
  );
  // Adult male so PhenoAge (adult-only, needs age) computes.
  db.prepare(
    "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'sex', 'male'), (?, 'birthdate', '1979-01-01')"
  ).run(profileId, profileId);
  const ins = db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, canonical_name, value, value_num, unit, flag)
     VALUES (?, ?, 'lab', ?, ?, ?, ?, ?, NULL)`
  );
  for (const d of DRAW)
    ins.run(profileId, DATE, d.name, d.name, String(d.value), d.value, d.unit);
});

describe("derived-index gathering resolves a legacy-named component", () => {
  it("computes PhenoAge even though MCV is stored under its bare legacy name", () => {
    const readings = getDerivedBiomarkerReadings(profileId);
    const pheno = readings.find(
      (r) => r.name === "PhenoAge" && r.date === DATE
    );
    // If the legacy "MCV" row were NOT resolved, the draw would be one input short
    // and PhenoAge would not compute at all.
    expect(pheno, "PhenoAge missing — legacy MCV not resolved").toBeTruthy();
    expect(pheno!.value_num).toBeGreaterThan(0);
  });
});
