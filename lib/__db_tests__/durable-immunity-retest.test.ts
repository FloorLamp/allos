// DB INTEGRATION TIER — issue #516. An immune-POSITIVE durable-immunity antibody
// titer (hep A/B surface Ab, MMR/varicella IgG) is durable evidence and must NOT nag
// "retest overdue" on the flat 365-day clock, the way genomics never goes stale. A
// NEGATIVE/equivocal titer of the same analyte legitimately keeps its clock (its
// followup is the risk layer's job). This proves the exemption end-to-end through the
// real Upcoming retest generator, keyed on immune-positive rather than the analyte name.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { collectUpcoming } from "@/lib/queries";
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

  it("an old NEGATIVE varicella titer still surfaces as overdue (keeps its clock)", () => {
    db.prepare(
      "DELETE FROM medical_records WHERE profile_id = ? AND category = 'lab'"
    ).run(p.profileId);
    addTiter("Varicella IgG", oldDate, "Negative", { flag: "low" });

    // Not immune-positive → the exemption does NOT apply → it's overdue like any lab.
    expect(biomarkerKeys()).toContain("biomarker:varicella igg");
  });

  it("a positive NON-immunity infection marker (hep C antibody) is NOT exempt", () => {
    db.prepare(
      "DELETE FROM medical_records WHERE profile_id = ? AND category = 'lab'"
    ).run(p.profileId);
    addTiter("Hepatitis C Antibody", oldDate, "Positive");

    // A positive hep C antibody is disease, not durable immunity — it stays on the clock.
    expect(biomarkerKeys()).toContain("biomarker:hepatitis c antibody");
  });
});
