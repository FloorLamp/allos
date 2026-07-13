// DB INTEGRATION TIER — issue #516 (+ #587). An immune-POSITIVE durable-immunity
// antibody titer (hep A/B surface Ab, MMR/varicella IgG) is durable evidence and must
// NOT nag "retest overdue" on the flat 365-day clock, the way genomics never goes
// stale. A NEGATIVE/equivocal titer of the same analyte legitimately keeps its clock
// (its followup is the risk layer's job) — proven here on a RISK-ELEVATED hepatitis-A
// titer so the #587 worthiness gate is held constant and the immune-positive result is
// the sole discriminator. An unworthy, non-risk-elevated infection marker (e.g. a
// positive hep C antibody) is separately dropped from the retest nudge by the #587
// gate and surfaces on the flag/needs-review path instead.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { collectUpcoming, getCurrentFlaggedBiomarkers } from "@/lib/queries";
import { seedProfile, type SeededProfile } from "./fixtures";

let p: SeededProfile;
let oldDate: string; // past the 365-day retest window

function addTiter(
  name: string,
  date: string,
  value: string,
  opts: {
    unit?: string;
    reference?: string;
    flag?: string;
    notes?: string;
  } = {}
) {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, reference_range, flag, notes)
     VALUES (?, ?, 'lab', ?, ?, ?, ?, ?, ?)`
  ).run(
    p.profileId,
    date,
    name,
    value,
    opts.unit ?? null,
    opts.reference ?? null,
    opts.flag ?? null,
    opts.notes ?? null
  );
}

function biomarkerKeys(): string[] {
  return collectUpcoming(p.profileId, p.todayStr)
    .filter((i) => i.domain === "biomarker")
    .map((i) => i.key);
}

beforeAll(() => {
  p = seedProfile("IMMUNITY");
  oldDate = shiftDateStr(p.todayStr, -800); // ~2.2 years ago → well past 365d
});

describe("durable-immunity retest exemption (#516)", () => {
  it("an old immune-positive anti-HBs (numeric, 'Immune' in notes) never surfaces as overdue", () => {
    db.prepare(
      "DELETE FROM medical_records WHERE profile_id = ? AND category = 'lab'"
    ).run(p.profileId);
    addTiter("Hepatitis B Surface Antibody", oldDate, "45", {
      unit: "mIU/mL",
      reference: ">=10",
      notes: "Immune",
    });

    expect(biomarkerKeys()).not.toContain(
      "biomarker:hepatitis b surface antibody"
    );
  });

  it("an old immune-positive qualitative Measles IgG ('Immune') never surfaces", () => {
    db.prepare(
      "DELETE FROM medical_records WHERE profile_id = ? AND category = 'lab'"
    ).run(p.profileId);
    addTiter("Measles IgG", oldDate, "Immune");

    expect(biomarkerKeys()).not.toContain("biomarker:measles igg");
  });

  it("an old NEGATIVE durable-immunity titer keeps its clock when risk-elevated", () => {
    // Isolate the #516 exemption from the #587 worthiness gate: a hepatitis-A antibody
    // is durable-immunity AND (for a healthcare worker) risk-elevated, so it passes the
    // worthiness gate. A NEGATIVE result is not immune-positive → the exemption does NOT
    // apply → it stays overdue like any lab. This proves the exemption is RESULT-driven
    // (not name-driven) end-to-end, with worthiness held constant.
    db.prepare(
      "DELETE FROM medical_records WHERE profile_id = ? AND category = 'lab'"
    ).run(p.profileId);
    db.prepare(
      `INSERT INTO profile_settings (profile_id, key, value)
       VALUES (?, 'risk_healthcare_worker', '1')
       ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
    ).run(p.profileId);
    addTiter("Hepatitis A Antibody", oldDate, "Negative", { flag: "low" });

    expect(biomarkerKeys()).toContain("biomarker:hepatitis a antibody");

    // …and the immune-POSITIVE counterpart, though risk-elevated, is still exempt.
    db.prepare(
      "DELETE FROM medical_records WHERE profile_id = ? AND category = 'lab'"
    ).run(p.profileId);
    addTiter("Hepatitis A Antibody", oldDate, "45", {
      unit: "mIU/mL",
      reference: ">=10",
      notes: "Immune",
    });
    expect(biomarkerKeys()).not.toContain("biomarker:hepatitis a antibody");
    db.prepare(
      "DELETE FROM profile_settings WHERE profile_id = ? AND key = 'risk_healthcare_worker'"
    ).run(p.profileId);
  });

  it("a positive NON-immunity infection marker (hep C antibody) is dropped from the retest nudge but surfaces on the flag path (#587)", () => {
    db.prepare(
      "DELETE FROM medical_records WHERE profile_id = ? AND category = 'lab'"
    ).run(p.profileId);
    addTiter("Hepatitis C Antibody", oldDate, "Positive", { flag: "high" });

    // A positive hep C antibody is disease, not durable immunity — so #516's exemption
    // never applies. But it's an incidental infection-workup one-off (not routine
    // recurring monitoring) with no risk elevation, so the #587 worthiness gate drops it
    // from the retest nudge; it surfaces on the Biomarkers flag/needs-review path instead.
    expect(biomarkerKeys()).not.toContain("biomarker:hepatitis c antibody");
    const flaggedNames = getCurrentFlaggedBiomarkers(p.profileId).map((f) =>
      f.name.toLowerCase()
    );
    expect(flaggedNames).toContain("hepatitis c antibody");
  });
});
