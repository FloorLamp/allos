// DB INTEGRATION TIER — the normalized panel taxonomy against real SQL (#1502).
//
// The taxonomy's pure guards live in lib/__tests__/biomarker-panels.test.ts. What
// only a real DB can prove is that the SQL realization — post-#1629 the
// `biomarker_panel()` user function, not a generated preimage CASE — actually
// behaves like the JS resolver inside the query layer: that the Timeline
// groups and titles a multi-panel draw by CLINICAL panel instead of the lab-vendor
// heading, that the biomarkers facet filters by resolved panel rather than the
// stored `panel` column, and that the stored column is left untouched as
// provenance. Every fixture value is synthetic.

import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getTimelineEvents } from "@/lib/timeline";
import { getClinicalObservations } from "@/lib/queries";
import {
  BIOMARKER_PANELS,
  OTHER_PANEL,
  panelForCanonicalName,
  panelMemberSpellings,
  type PanelId,
} from "@/lib/biomarker-panels";
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
    const rows = getClinicalObservations(subject.profileId, {
      panel: "lipids",
    });
    expect(rows.map((r) => r.canonical_name).sort()).toEqual([
      "HDL Cholesterol",
      "LDL Cholesterol",
      "Total Cholesterol",
    ]);
  });

  it("`?panel=other` is the unclassified view, not a vendor bucket", () => {
    const rows = getClinicalObservations(subject.profileId, { panel: "other" });
    expect(rows.map((r) => r.name)).toContain("Zorblax Index");
    expect(rows.map((r) => r.name)).not.toContain("LDL Cholesterol");
  });

  it("the SQL preimage agrees with the JS resolver on the seeded rows", () => {
    for (const [name] of DRAW) {
      const panel = panelForCanonicalName(name);
      const rows = getClinicalObservations(subject.profileId, { panel });
      expect(
        rows.some((r) => r.canonical_name === name),
        `${name} missing from its own panel (${panel})`
      ).toBe(true);
    }
  });

  it("sorting by panel orders by the curated clinical order, `other` last", () => {
    const rows = getClinicalObservations(subject.profileId, {
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

// ---- #1629: the panel facet resolves a MATCH-ONLY family spelling ------------
//
// The panel key used to be a second, independent realization of panel membership —
// a generated `IN (<enumerated member spellings>)` CASE. A stored display name that
// only a family's freeform `match` matcher catches (an un-snapped AI-coined A1c
// spelling) was therefore a full family member to the family key (post-#1627 SQL
// calls biomarkerFamily(), so dedup / is_latest / star / retest all agreed) and
// panel `other` to the panel facet — so one reading of a family filed under its
// clinical panel while its canonical sibling filed under "Other". The panel key now
// calls the same pure resolver, so both agree on every name.
describe("a match-only family spelling files under its family's panel (#1629)", () => {
  let drifter: SeededProfile;
  const DAY = "2026-01-21";
  // Caught by isA1cFamily's regex, in NO family `members` list and in no panel's
  // enumerated assignment — the exact shape the old preimage could not see.
  const MATCH_ONLY = "HbA1c (Whole Blood)";

  beforeAll(() => {
    drifter = seedProfile("PanelMatchOnly");
    const ins = db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value, value_num, unit, panel, canonical_name)
       VALUES (?, ?, 'lab', ?, ?, ?, ?, ?, ?)`
    );
    // The canonical sibling and the un-snapped spelling, same analyte, same draw.
    ins.run(
      drifter.profileId,
      DAY,
      "Hemoglobin A1c",
      "5.4",
      5.4,
      "%",
      "Meridian Reference Labs",
      "Hemoglobin A1c"
    );
    ins.run(
      drifter.profileId,
      DAY,
      MATCH_ONLY,
      "5.6",
      5.6,
      "%",
      "Meridian Reference Labs",
      MATCH_ONLY
    );
  });

  it("`?panel=glycemic` returns BOTH spellings of the family", () => {
    const names = getClinicalObservations(drifter.profileId, {
      panel: "glycemic",
    }).map((r) => r.name);
    expect(names).toContain("Hemoglobin A1c");
    expect(names).toContain(MATCH_ONLY);
  });

  it("`?panel=other` no longer strands it away from its siblings", () => {
    const rows = getClinicalObservations(drifter.profileId, { panel: "other" });
    expect(rows.map((r) => r.name)).not.toContain(MATCH_ONLY);
  });

  it("the Timeline files both readings under ONE clinical panel event", () => {
    const events = getTimelineEvents(drifter.profileId, {
      category: "medical",
      startDate: DAY,
      endDate: DAY,
    });
    const titles = events.map((e) => e.title);
    expect(titles).toEqual(["Glucose & insulin results"]);
    expect(events[0].subtitle).toContain("2 results");
  });

  it("the biomarker_panel() user function agrees with the JS resolver", () => {
    // Walk the enumerated corpus (its surviving job) plus the match-only spelling
    // and the NULL/blank name, straight through SQL.
    const call = db.prepare("SELECT biomarker_panel(?) AS panel");
    const names = [
      ...(Object.keys(BIOMARKER_PANELS) as Exclude<PanelId, "other">[]).flatMap(
        (id) => panelMemberSpellings(id)
      ),
      MATCH_ONLY,
      "Zorblax Index",
      "",
    ];
    for (const name of names)
      expect((call.get(name) as { panel: string }).panel, name).toBe(
        panelForCanonicalName(name)
      );
    // A NULL display name resolves to the reserved fallback, exactly as the CASE's
    // ELSE did — never NULL, which would match no facet at all.
    expect((call.get(null) as { panel: string }).panel).toBe(OTHER_PANEL);
  });
});
