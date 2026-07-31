import { describe, it, expect } from "vitest";
import canonicalSeed from "@/lib/canonical-biomarkers.json";
import {
  BIOMARKER_PANELS,
  isPanelId,
  orderedPanelIds,
  OTHER_PANEL,
  PANEL_IDS,
  PANEL_LABELS,
  panelForCanonicalName,
  panelLabel,
  panelMemberSpellings,
  panelOrderOfPanelExpr,
  panelSortOrder,
  parsePanelId,
  type PanelId,
} from "@/lib/biomarker-panels";
import { BIOMARKER_FAMILIES, biomarkerFamily } from "@/lib/canonical-name";
import { medicalGroupLabel } from "@/lib/timeline-format";

// The normalized panel taxonomy (#1502). These are the guards that make the
// taxonomy trustworthy as INFRASTRUCTURE rather than a lookup table that quietly
// rots: 0 unmapped canonical entries, no orphan assignments, a total label map,
// and #482 family coherence. The most important one is "every canonical biomarker
// resolves to a real panel" — a NEW canonical entry added without an assignment
// must FAIL here, not silently fall into the `other` bucket where it would look
// like a deliberate classification.

const CANONICAL_NAMES: string[] = (
  canonicalSeed as { biomarkers: { name: string; panel?: string | null }[] }
).biomarkers.map((b) => b.name);

const ASSIGNED: [PanelId, string][] = (
  Object.entries(BIOMARKER_PANELS) as [PanelId, readonly string[]][]
).flatMap(([panel, names]) =>
  names.map((n) => [panel, n] as [PanelId, string])
);

describe("the panel id registry", () => {
  it("PANEL_LABELS is total over PanelId and every label is non-empty", () => {
    for (const id of PANEL_IDS) {
      expect(PANEL_LABELS[id], `no label for ${id}`).toBeTruthy();
      expect(PANEL_LABELS[id].label.trim().length).toBeGreaterThan(0);
    }
    // Total in the other direction too: no label key without a slug.
    expect(Object.keys(PANEL_LABELS).sort()).toEqual([...PANEL_IDS].sort());
  });

  it("slugs are unique, lowercase-kebab, and orders are unique", () => {
    expect(new Set(PANEL_IDS).size).toBe(PANEL_IDS.length);
    for (const id of PANEL_IDS) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    const orders = PANEL_IDS.map((id) => PANEL_LABELS[id].order);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("`other` is the reserved fallback, carries no members, and sorts last", () => {
    expect(OTHER_PANEL).toBe("other");
    expect(BIOMARKER_PANELS).not.toHaveProperty(OTHER_PANEL);
    expect(orderedPanelIds().at(-1)).toBe(OTHER_PANEL);
    for (const id of PANEL_IDS)
      if (id !== OTHER_PANEL)
        expect(panelSortOrder(id)).toBeLessThan(panelSortOrder(OTHER_PANEL));
  });

  it("orderedPanelIds returns every slug exactly once, in curated order", () => {
    const ordered = orderedPanelIds();
    expect(ordered).toHaveLength(PANEL_IDS.length);
    expect(new Set(ordered).size).toBe(PANEL_IDS.length);
    const orders = ordered.map((id) => PANEL_LABELS[id].order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });
});

describe("the curated 277-name assignment", () => {
  // THE guard. A canonical biomarker with no panel is a build failure, not a
  // silent "Other" — the whole point of a reserved fallback slug is that it means
  // "the taxonomy doesn't know this name", which can never be true of a name the
  // canonical dataset itself defines.
  it("maps EVERY canonical biomarker to a known panel — 0 unmapped", () => {
    const unmapped = CANONICAL_NAMES.filter(
      (n) => panelForCanonicalName(n) === OTHER_PANEL
    );
    expect(
      unmapped,
      `unmapped canonical biomarkers (add each to BIOMARKER_PANELS in lib/biomarker-panels.ts): ${unmapped.join(", ")}`
    ).toEqual([]);
    expect(CANONICAL_NAMES.length).toBeGreaterThan(250);
  });

  it("has no orphan assignments — every member is a real canonical name", () => {
    const known = new Set(CANONICAL_NAMES.map((n) => n.toLowerCase()));
    const orphans = ASSIGNED.filter(
      ([, name]) => !known.has(name.toLowerCase())
    ).map(([panel, name]) => `${panel}: ${name}`);
    expect(orphans, `assignments naming no canonical entry`).toEqual([]);
  });

  it("assigns each name to exactly one panel", () => {
    const seen = new Map<string, PanelId>();
    const dupes: string[] = [];
    for (const [panel, name] of ASSIGNED) {
      const key = name.toLowerCase();
      if (seen.has(key)) dupes.push(`${name}: ${seen.get(key)} + ${panel}`);
      seen.set(key, panel);
    }
    expect(dupes).toEqual([]);
    // A bijection with the canonical vocabulary: no name assigned twice, none
    // missing (the two guards above), so the counts must agree exactly.
    expect(seen.size).toBe(CANONICAL_NAMES.length);
  });

  it("every clinical panel has at least one member", () => {
    for (const [panel, names] of Object.entries(BIOMARKER_PANELS))
      expect(names.length, `${panel} is empty`).toBeGreaterThan(0);
  });

  it("pins the headline groupings a reader would sanity-check", () => {
    expect(panelForCanonicalName("LDL Cholesterol")).toBe("lipids");
    expect(panelForCanonicalName("HDL Cholesterol")).toBe("lipids");
    expect(panelForCanonicalName("Hemoglobin")).toBe("cbc");
    expect(panelForCanonicalName("Platelet Count")).toBe("cbc");
    expect(panelForCanonicalName("Thyroid-Stimulating Hormone (TSH)")).toBe(
      "thyroid"
    );
    expect(panelForCanonicalName("Hemoglobin A1c")).toBe("glycemic");
    expect(panelForCanonicalName("Creatinine")).toBe("kidney");
    expect(panelForCanonicalName("Blood Pressure Systolic")).toBe(
      "vital-signs"
    );
    expect(panelForCanonicalName("PHQ-9")).toBe("mental-health");
    // The exclusion discipline: toxic and nutritional trace elements stay apart,
    // and the advanced lipoprotein subfraction report is its own order.
    expect(panelForCanonicalName("Lead")).toBe("heavy-metals");
    expect(panelForCanonicalName("Zinc")).toBe("minerals");
    expect(panelForCanonicalName("LDL Particle Number")).toBe(
      "lipoprotein-particles"
    );
  });

  it("the committed JSON's `panel` field agrees with the resolver for every row", () => {
    const rows = (
      canonicalSeed as { biomarkers: { name: string; panel?: string | null }[] }
    ).biomarkers;
    const mismatches = rows
      .filter((b) => b.panel !== panelForCanonicalName(b.name))
      .map((b) => `${b.name}: json=${b.panel}`);
    expect(
      mismatches,
      "regenerate with `npx tsx scripts/gen-canonical-biomarkers.ts --curated-only`"
    ).toEqual([]);
  });
});

describe("panelForCanonicalName", () => {
  it("returns `other` for an un-canonicalized or empty name", () => {
    expect(panelForCanonicalName("E2E Novel Lab")).toBe(OTHER_PANEL);
    expect(panelForCanonicalName("Zorblax Index")).toBe(OTHER_PANEL);
    expect(panelForCanonicalName("")).toBe(OTHER_PANEL);
    expect(panelForCanonicalName("   ")).toBe(OTHER_PANEL);
    expect(panelForCanonicalName(null)).toBe(OTHER_PANEL);
    expect(panelForCanonicalName(undefined)).toBe(OTHER_PANEL);
  });

  it("is insensitive to case, punctuation, and word order", () => {
    expect(panelForCanonicalName("ldl cholesterol")).toBe("lipids");
    expect(panelForCanonicalName("  LDL   Cholesterol  ")).toBe("lipids");
    // normalizeCanonicalKey folds comma inversion, so both spellings of a
    // specimen-qualified analyte land on the same panel.
    expect(panelForCanonicalName("Creatinine, Urine")).toBe("urinalysis");
    expect(panelForCanonicalName("Urine Creatinine")).toBe("urinalysis");
    // …while the un-qualified serum analyte keeps its own (different) panel.
    expect(panelForCanonicalName("Creatinine")).toBe("kidney");
  });

  it("resolves #482 FAMILY spellings to the family's panel (composition, not conflict)", () => {
    // The A1c family collapses eAG onto A1c's analyte identity; both must read as
    // one panel, or a family that groups on one surface would split on another.
    expect(panelForCanonicalName("Hemoglobin A1c")).toBe("glycemic");
    expect(panelForCanonicalName("HbA1c")).toBe("glycemic");
    expect(panelForCanonicalName("Estimated Average Glucose")).toBe("glycemic");
    expect(panelForCanonicalName("eAG")).toBe("glycemic");
    // The vitamin-D 25-OH total family, including spellings with no canonical row.
    expect(panelForCanonicalName("Vitamin D, 25-Hydroxy")).toBe("vitamins");
    expect(panelForCanonicalName("25-OH Vitamin D")).toBe("vitamins");
    expect(panelForCanonicalName("Vitamin D")).toBe("vitamins");
    // The D2/D3 fractions are deliberately OUTSIDE that family (#1193) but are
    // assigned explicitly, so they still agree.
    expect(panelForCanonicalName("Vitamin D3, 25-Hydroxy")).toBe("vitamins");
  });

  it("no registered #482 family straddles two panels", () => {
    const straddles: string[] = [];
    for (const fam of BIOMARKER_FAMILIES) {
      const panels = new Set(
        fam.members
          .map((m) => panelForCanonicalName(m))
          .filter((p) => p !== OTHER_PANEL)
      );
      if (panels.size > 1)
        straddles.push(`${fam.key}: ${[...panels].join(" + ")}`);
    }
    expect(straddles).toEqual([]);
  });

  it("every canonical name's family identity is panel-consistent", () => {
    // Two canonical entries that biomarkerFamily() collapses onto ONE analyte must
    // not be assigned to different panels — that would make the family's panel
    // depend on which member was looked up.
    const byFamily = new Map<string, Set<PanelId>>();
    for (const name of CANONICAL_NAMES) {
      const fam = biomarkerFamily(name);
      if (!fam.startsWith("family:")) continue;
      const set = byFamily.get(fam) ?? new Set<PanelId>();
      set.add(panelForCanonicalName(name));
      byFamily.set(fam, set);
    }
    for (const [fam, panels] of byFamily)
      expect([...panels], `${fam} spans panels`).toHaveLength(1);
  });
});

describe("panel label + slug parsing", () => {
  it("panelLabel reads the one display map", () => {
    expect(panelLabel("lipids")).toBe("Lipids");
    expect(panelLabel("cbc")).toBe("Complete blood count");
    expect(panelLabel(OTHER_PANEL)).toBe("Other");
  });

  it("isPanelId / parsePanelId accept only real slugs", () => {
    expect(isPanelId("lipids")).toBe(true);
    expect(isPanelId("other")).toBe(true);
    expect(isPanelId("Lipids")).toBe(false);
    expect(isPanelId("lipid")).toBe(false);
    expect(isPanelId(undefined)).toBe(false);
    expect(parsePanelId(" lipids ")).toBe("lipids");
    // A legacy bookmark carrying the old free-text vendor facet is IGNORED (no
    // filter) rather than filtering the table to nothing.
    expect(parsePanelId("Quest Diagnostics")).toBeUndefined();
    expect(parsePanelId("")).toBeUndefined();
    expect(parsePanelId(null)).toBeUndefined();
  });
});

describe("the JS↔SQL parity corpus", () => {
  // SQL no longer re-realizes panel membership — lib/queries/medical.biomarkerPanelKey
  // calls panelForCanonicalName() through the `biomarker_panel()` user function
  // (#1629), so the two answers agree on EVERY name by construction, not just the
  // enumerated ones. What survives here is the corpus itself: panelMemberSpellings
  // must stay a faithful subset of the resolver, so the DB-tier parity walk
  // (lib/__db_tests__/biomarker-panels.test.ts) is walking real spellings.
  it("every corpus spelling resolves to the panel it was collected under", () => {
    for (const id of Object.keys(BIOMARKER_PANELS) as Exclude<
      PanelId,
      "other"
    >[]) {
      for (const spelling of panelMemberSpellings(id))
        expect(panelForCanonicalName(spelling), spelling).toBe(id);
    }
    // …and every canonical name appears in exactly one panel's corpus.
    const corpus = new Map<string, PanelId>();
    for (const id of Object.keys(BIOMARKER_PANELS) as Exclude<
      PanelId,
      "other"
    >[])
      for (const s of panelMemberSpellings(id)) corpus.set(s, id);
    for (const name of CANONICAL_NAMES)
      expect(corpus.get(name.toLowerCase()), name).toBe(
        panelForCanonicalName(name)
      );
  });

  it("resolves a match-only family spelling the corpus can NEVER enumerate", () => {
    // The #1629 defect in pure form: an un-snapped A1c spelling no family `members`
    // list contains is still the A1c family (its `match` matcher catches it), so the
    // panel taxonomy must place it with its canonical siblings — the enumerated
    // corpus, by construction, cannot.
    const matchOnly = "HbA1c (Whole Blood)";
    const corpus = new Set(
      (Object.keys(BIOMARKER_PANELS) as Exclude<PanelId, "other">[]).flatMap(
        (id) => panelMemberSpellings(id)
      )
    );
    expect(corpus.has(matchOnly.toLowerCase())).toBe(false);
    expect(biomarkerFamily(matchOnly)).toBe(biomarkerFamily("Hemoglobin A1c"));
    expect(panelForCanonicalName(matchOnly)).toBe("glycemic");
  });

  it("panelOrderOfPanelExpr maps every slug to its curated order", () => {
    const sql = panelOrderOfPanelExpr("panel_id");
    for (const id of PANEL_IDS)
      expect(sql).toContain(`WHEN '${id}' THEN ${PANEL_LABELS[id].order}`);
  });
});

describe("medicalGroupLabel (the Timeline title rule)", () => {
  it("names a resolved panel by its curated label", () => {
    expect(medicalGroupLabel("lipids", "Quest Diagnostics")).toBe("Lipids");
    expect(medicalGroupLabel("cbc", null)).toBe("Complete blood count");
  });

  it("falls back to the stored heading (then the category) for `other`", () => {
    // Un-canonicalized rows keep EXACTLY the pre-#1502 title, so nothing
    // regresses into a meaningless "Other results".
    expect(medicalGroupLabel("other", "Quest Diagnostics")).toBe(
      "Quest Diagnostics"
    );
    expect(medicalGroupLabel("other", "lab")).toBe("lab");
    expect(medicalGroupLabel("other", "  ")).toBe("Lab");
    expect(medicalGroupLabel("other", null)).toBe("Lab");
  });

  it("treats an unknown slug like the fallback (defensive, never throws)", () => {
    expect(medicalGroupLabel("not-a-panel", "Home Monitor")).toBe(
      "Home Monitor"
    );
  });
});
