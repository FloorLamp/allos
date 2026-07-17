// DB INTEGRATION TIER (issue #685 — the #448 builder-fixture rule).
//
// conditionSuggestionsFor / conditionReviewItems GATHER DB state (the profile's
// CURRENT qualitative lab results + its existing problem list) and hand it to the pure
// condition-suggestion engine, so they carry a DB-tier fixture asserting the
// END-TO-END finding output — the pure tier can't see the SQL gather (current-reading
// dedup, the problem-list dedup, the category/value_num filter). Pins the acceptance:
// a positive infection marker yields a suggestion; a NEGATIVE one does not; a marker
// already on the problem list is deduped away; the suggestion rides Upcoming and is
// silenced by the shared dismissal bus; every emitted dedupeKey is guardable (#448).
//
// Deterministic: :memory:-backed temp DB via setup.ts; dates anchored on today.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  conditionSuggestionsFor,
  conditionReviewItems,
} from "@/lib/condition-suggestion-findings";
import { collectUpcoming, dismissFinding } from "@/lib/queries";
import {
  dedupeKeyHasKnownPrefix,
  tierForDedupeKey,
} from "@/lib/rule-finding-prefixes";
import { CONDITION_REVIEW_PREFIX } from "@/lib/condition-suggestions";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function addResult(
  p: number,
  over: {
    name: string;
    value: string | null;
    date?: string;
    loinc?: string | null;
    category?: string;
    value_num?: number | null;
  }
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, canonical_name, value, value_num, loinc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        p,
        over.date ?? today(p),
        over.category ?? "lab",
        over.name,
        over.name,
        over.value,
        over.value_num ?? null,
        over.loinc ?? null
      ).lastInsertRowid
  );
}

function addCondition(p: number, name: string, code: string | null = null) {
  db.prepare(
    `INSERT INTO conditions (profile_id, name, code, status) VALUES (?, ?, ?, 'active')`
  ).run(p, name, code);
}

describe("condition-suggestion builder (#685, #448 fixture)", () => {
  it("suggests a condition for a positive infection marker", () => {
    const p = newProfile("Infection Positive");
    addResult(p, { name: "HIV 1/2 Antibody", value: "Reactive" });
    const out = conditionSuggestionsFor(p);
    expect(out.map((s) => s.name)).toEqual(["HIV"]);
    expect(out[0].key).toBe("condition-review:name:hiv");
  });

  it("does NOT suggest for a negative infection result", () => {
    const p = newProfile("Infection Negative");
    addResult(p, { name: "HIV 1/2 Antibody", value: "Non-Reactive" });
    expect(conditionSuggestionsFor(p)).toHaveLength(0);
  });

  it("uses the CURRENT reading — a later negative supersedes an old positive", () => {
    const p = newProfile("Seroconverted Away");
    addResult(p, {
      name: "Hepatitis C Antibody",
      value: "Reactive",
      date: "2020-01-01",
    });
    addResult(p, {
      name: "Hepatitis C Antibody",
      value: "Non-Reactive",
      date: today(p),
    });
    // The latest-in-group reading is the negative, so no suggestion.
    expect(conditionSuggestionsFor(p)).toHaveLength(0);
  });

  it("dedups against an existing problem-list condition by concept", () => {
    const p = newProfile("Already Listed");
    addResult(p, { name: "Hepatitis C Antibody", value: "Reactive" });
    addCondition(p, "Hepatitis C");
    expect(conditionSuggestionsFor(p)).toHaveLength(0);
  });

  it("routes a HIGH-risk NIPT screen (by LOINC) alongside infections (#687)", () => {
    const p = newProfile("Screen Positive");
    addResult(p, {
      name: "Trisomy 21",
      value: "High Risk",
      loinc: "75983-7",
    });
    const out = conditionSuggestionsFor(p);
    expect(out.map((s) => s.name)).toEqual(["Trisomy 21 (Down syndrome)"]);
  });

  it("surfaces on Upcoming banded today, and the shared bus silences it", () => {
    const p = newProfile("Bus Test");
    addResult(p, { name: "Hepatitis B Surface Antigen", value: "Positive" });
    const items = conditionReviewItems(p);
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.domain).toBe("condition-review");
    expect(item.band).toBe("today");
    expect(item.conditionSuggestion).toEqual({
      name: "Hepatitis B",
      code: null,
    });

    const now = today(p);
    // It rides collectUpcoming (→ hero + Upcoming page).
    expect(collectUpcoming(p, now).some((i) => i.key === item.key)).toBe(true);
    // A dismiss on its dedupeKey silences it everywhere through the shared bus.
    dismissFinding(p, item.key);
    expect(collectUpcoming(p, now).some((i) => i.key === item.key)).toBe(false);
  });

  it("every emitted dedupeKey is guardable against the registry (#448)", () => {
    const p = newProfile("Guardable Keys");
    addResult(p, { name: "HIV Antibody", value: "Reactive" });
    addResult(p, { name: "RPR", value: "Reactive" });
    const items = conditionReviewItems(p);
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) {
      expect(i.key.startsWith(CONDITION_REVIEW_PREFIX)).toBe(true);
      expect(dedupeKeyHasKnownPrefix(i.key)).toBe(true);
      // #860 Track A — condition-review is a CARE-tier builder (push/hero).
      expect(tierForDedupeKey(i.key)).toBe("care");
    }
  });

  it("ignores a numeric QC metric (fetal fraction) — not qualitative", () => {
    const p = newProfile("QC Metric");
    addResult(p, {
      name: "Fetal Fraction",
      value: "8.2",
      value_num: 8.2,
      loinc: "75605-6",
    });
    expect(conditionSuggestionsFor(p)).toHaveLength(0);
  });
});
