// DB INTEGRATION TIER — the normalized panel taxonomy against real SQL (#1502).
//
// The taxonomy's pure guards live in lib/__tests__/biomarker-panels.test.ts. What
// only a real DB can prove is that the finite-preimage SQL realization (#394)
// actually behaves like the JS resolver inside the query layer: that the Timeline
// groups and titles a multi-panel draw by CLINICAL panel instead of the lab-vendor
// heading, that the biomarkers facet filters by resolved panel rather than the
// stored `panel` column, and that the stored column is left untouched as
// provenance. Every fixture value is synthetic.

import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getTimelineEvents } from "@/lib/timeline";
import { getMedicalRecords } from "@/lib/queries";
import { panelForCanonicalName } from "@/lib/biomarker-panels";
import { seedProfile, type SeededProfile } from "./fixtures";

let subject: SeededProfile;
const DRAW_DATE = "2026-01-14";

// One synthetic draw whose document heading is a LAB VENDOR (the shape the real
// corpus has) carrying three different clinical panels plus one analyte the
// canonical vocabulary doesn't know.
const DRAW: [string, number, string][] = [
  // canonical_name, value, unit
  ["Total Cholesterol", 190, "mg/dL"],
  ["LDL Cholesterol", 118, "mg/dL"],
  ["HDL Cholesterol", 52, "mg/dL"],
  ["Hemoglobin", 14.4, "g/dL"],
  ["Platelet Count", 250, "10^3/uL"],
  ["Thyroid-Stimulating Hormone (TSH)", 2.1, "uIU/mL"],
];

beforeAll(() => {
  subject = seedProfile("PanelTaxonomy");
  const ins = db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, value_num, unit, panel, canonical_name)
     VALUES (?, ?, 'lab', ?, ?, ?, ?, ?, ?)`
  );
  for (const [name, value, unit] of DRAW)
    ins.run(
      subject.profileId,
      DRAW_DATE,
      name,
      String(value),
      value,
      unit,
      // The document's own section heading — a vendor string, as in real imports.
      "Meridian Reference Labs",
      name
    );
  // An analyte no canonical entry covers: it must resolve to `other` and keep the
  // pre-#1502 behavior (titled by the stored heading, never "Other results").
  ins.run(
    subject.profileId,
    DRAW_DATE,
    "Zorblax Index",
    "3.3",
    3.3,
    "index",
    "Meridian Reference Labs",
    "Zorblax Index"
  );
});

function medicalTitlesOnDrawDate(): string[] {
  return getTimelineEvents(subject.profileId, {
    category: "medical",
    startDate: DRAW_DATE,
    endDate: DRAW_DATE,
  })
    .map((e) => e.title)
    .sort();
}

describe("Timeline medical events title by resolved panel", () => {
  it("splits one vendor draw into per-panel events with clinical titles", () => {
    const titles = medicalTitlesOnDrawDate();
    expect(titles).toContain("Lipids results");
    expect(titles).toContain("Complete blood count results");
    expect(titles).toContain("Thyroid results");
    // Six canonicalized analytes that used to render as ONE "Meridian Reference
    // Labs results" event now render as three clinical ones. The vendor string
    // survives only as the fallback title of the single unclassified row (asserted
    // next) — it no longer names a canonicalized reading anywhere.
    const events = getTimelineEvents(subject.profileId, {
      category: "medical",
      startDate: DRAW_DATE,
      endDate: DRAW_DATE,
    });
    const vendor = events.filter(
      (e) => e.title === "Meridian Reference Labs results"
    );
    expect(vendor).toHaveLength(1);
    expect(vendor[0].subtitle).toContain("1 result");
    expect(vendor[0].detail).toContain("Zorblax Index");
  });

  it("keeps the stored heading as the title for an un-canonicalized analyte", () => {
    // `other` never surfaces as "Other results": those rows fall back to exactly
    // the pre-#1502 key (stored panel, then category).
    expect(medicalTitlesOnDrawDate()).toContain(
      "Meridian Reference Labs results"
    );
  });

  it("counts and tone are per PANEL, not per vendor group", () => {
    const events = getTimelineEvents(subject.profileId, {
      category: "medical",
      startDate: DRAW_DATE,
      endDate: DRAW_DATE,
    });
    const lipids = events.find((e) => e.title === "Lipids results");
    expect(lipids?.subtitle).toContain("3 results");
    const cbc = events.find((e) => e.title === "Complete blood count results");
    expect(cbc?.subtitle).toContain("2 results");
    const thyroid = events.find((e) => e.title === "Thyroid results");
    expect(thyroid?.subtitle).toContain("1 result");
  });

  it("the event id carries the panel slug (ephemeral — nothing persists it)", () => {
    const lipids = getTimelineEvents(subject.profileId, {
      category: "medical",
      startDate: DRAW_DATE,
      endDate: DRAW_DATE,
    }).find((e) => e.title === "Lipids results");
    expect(lipids?.id).toBe(`medical:${DRAW_DATE}:lipids:manual`);
  });

  it("stays scoped to the profile", () => {
    const other = seedProfile("PanelTaxonomyOther");
    const titles = getTimelineEvents(other.profileId, {
      category: "medical",
      startDate: DRAW_DATE,
      endDate: DRAW_DATE,
    }).map((e) => e.title);
    expect(titles).not.toContain("Lipids results");
  });
});

describe("the biomarkers facet filters by resolved panel", () => {
  it("`?panel=lipids` returns the lipid analytes regardless of the vendor heading", () => {
    const rows = getMedicalRecords(subject.profileId, { panel: "lipids" });
    expect(rows.map((r) => r.canonical_name).sort()).toEqual([
      "HDL Cholesterol",
      "LDL Cholesterol",
      "Total Cholesterol",
    ]);
  });

  it("`?panel=other` is the unclassified view, not a vendor bucket", () => {
    const rows = getMedicalRecords(subject.profileId, { panel: "other" });
    expect(rows.map((r) => r.name)).toContain("Zorblax Index");
    expect(rows.map((r) => r.name)).not.toContain("LDL Cholesterol");
  });

  it("the SQL preimage agrees with the JS resolver on the seeded rows", () => {
    for (const [name] of DRAW) {
      const panel = panelForCanonicalName(name);
      const rows = getMedicalRecords(subject.profileId, { panel });
      expect(
        rows.some((r) => r.canonical_name === name),
        `${name} missing from its own panel (${panel})`
      ).toBe(true);
    }
  });

  it("sorting by panel orders by the curated clinical order, `other` last", () => {
    const rows = getMedicalRecords(subject.profileId, {
      sort: "panel",
      dir: "asc",
    });
    const panels = rows
      .map((r) => panelForCanonicalName(r.canonical_name ?? r.name))
      .filter((p, i, a) => i === 0 || a[i - 1] !== p);
    expect(panels.at(-1)).toBe("other");
    expect(panels.indexOf("lipids")).toBeLessThan(panels.indexOf("cbc"));
  });

  it("leaves the stored `panel` column untouched — it is PROVENANCE", () => {
    const stored = db
      .prepare(
        `SELECT DISTINCT panel FROM medical_records
          WHERE profile_id = ? AND date = ?`
      )
      .all(subject.profileId, DRAW_DATE) as { panel: string | null }[];
    expect(stored.map((r) => r.panel)).toEqual(["Meridian Reference Labs"]);
  });
});
