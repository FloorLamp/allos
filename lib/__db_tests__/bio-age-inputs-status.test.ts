// DB INTEGRATION TIER — the bio-age inputs card's status line, over the REAL derived
// gather (#3050).
//
// THE STATE THIS FILE EXISTS TO BUILD. The card's checklist asks "do you have any
// usable reading of this analyte?" — the right question for the import CTA — while its
// footnote states the model's requirement: all nine FROM ONE DRAW. The two can diverge:
// albumin from an old draw and the other eight from a recent one ticks nine boxes and
// carries the sentence "All 9 inputs present.", while NO draw is computable, so the
// `See biological age` button lands on a section that renders nothing at all.
//
// The issue filed that divergence as reachable by construction but not exhibited in
// the reporting household (both adults' "ever" count and their best single draw are
// both nine). This is the fixture that exhibits it — and the pairing it asserts is the
// point: the card must not claim a result the page it links to does not render.
//
// Only this tier can prove it: the "nine present" and the "no computable draw" halves
// come from the same real gather over the real catalog, so a fixture cannot fake one
// without the other.
//
// SYNTHETIC ONLY: invented profiles, invented values. No PHI.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getBioAgeReadings } from "@/lib/queries";
import { setProfileBirthdate } from "@/lib/settings";
import {
  bioAgeInputsStatus,
  bioAgeSurface,
  inputCompleteness,
  isBioAgeHiddenForAge,
  PHENOAGE_INPUT_NAMES,
} from "@/lib/bio-age";
import { DEFAULT_FORMAT_PREFS } from "@/lib/format-date";

const CRP = "High-Sensitivity C-Reactive Protein (hs-CRP)";

// The nine PhenoAge inputs in their canonical units, as clean numbers.
const NINE: [string, string, number][] = [
  ["Albumin", "g/dL", 4.4],
  ["Creatinine", "mg/dL", 0.9],
  ["Glucose", "mg/dL", 90],
  ["Lymphocytes", "%", 32],
  ["Mean Corpuscular Volume (MCV)", "fL", 89],
  ["Red Cell Distribution Width (RDW)", "%", 13],
  ["Alkaline Phosphatase", "U/L", 62],
  ["White Blood Cell Count", "10^3/uL", 5.5],
  [CRP, "mg/L", 0.4],
];

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setProfileBirthdate(id, "1980-01-01");
  return id;
}

// Write a draw on `date` carrying every one of the nine EXCEPT `omit`.
function draw(profileId: number, date: string, omit: string[] = []): void {
  for (const [canonical, unit, value] of NINE) {
    if (omit.includes(canonical)) continue;
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value, unit, canonical_name, value_num)
       VALUES (?, ?, 'lab', ?, ?, ?, ?, ?)`
    ).run(profileId, date, canonical, String(value), unit, canonical, value);
  }
}

// What the card computes, end to end, for one profile.
function card(profileId: number) {
  const { draws, presentInputs, panels } = getBioAgeReadings(profileId);
  const completeness = inputCompleteness(presentInputs);
  return {
    draws,
    completeness,
    status: bioAgeInputsStatus(
      completeness,
      draws,
      panels,
      DEFAULT_FORMAT_PREFS
    ),
    // The surface BOTH bio-age pages read (#2367). "hero" is the only state in which
    // the Longevity section renders anything at all.
    surface: bioAgeSurface(
      isBioAgeHiddenForAge(46),
      draws.length,
      completeness.presentCount
    ),
  };
}

describe("nine ticked, never on one draw", () => {
  it("says so, instead of claiming a result the linked page does not render", () => {
    const p = newProfile("bioage_never_together");
    // Albumin alone on an old draw; the other eight on a recent one.
    draw(
      p,
      "2020-02-02",
      PHENOAGE_INPUT_NAMES.filter((n) => n !== "Albumin")
    );
    draw(p, "2026-06-03", ["Albumin"]);

    const { draws, completeness, status, surface } = card(p);

    // The divergence, exhibited: nine ticks, and nothing computable.
    expect(completeness.complete).toBe(true);
    expect(completeness.presentCount).toBe(9);
    expect(draws).toHaveLength(0);

    // THE PAIRING. The card renders (its checklist is still the useful thing to show)
    // but the section behind `See biological age` does not — and the status line now
    // says exactly that rather than "All 9 inputs present."
    expect(surface).toBe("checklist");
    expect(status.kind).toBe("never-together");
    expect(status.message).toBe(
      "All 9 inputs present, but not from one draw — the model needs them together."
    );
  });
});

describe("a draw that DID compute", () => {
  it("names which draw the result behind the button is from", () => {
    const p = newProfile("bioage_computed");
    draw(p, "2026-06-03");

    const { draws, status, surface } = card(p);
    expect(draws.map((d) => d.date)).toEqual(["2026-06-03"]);
    expect(surface).toBe("hero");
    expect(status.kind).toBe("computed");
    expect(status.message).toBe(
      "All 9 inputs present · computed from your Jun 3, 2026 draw."
    );
  });

  it("names the gap and the still-live draw after a partial re-draw", () => {
    const p = newProfile("bioage_stale");
    draw(p, "2026-06-03");
    // A routine re-draw that came back without hs-CRP: it computes nothing, so the
    // number on /longevity is still June's, and nothing on the card used to say so.
    draw(p, "2026-07-12", [CRP]);

    const { draws, status } = card(p);
    expect(draws.map((d) => d.date)).toEqual(["2026-06-03"]);
    expect(status.kind).toBe("stale");
    expect(status.message).toBe(
      `Your Jul 12, 2026 panel is missing ${CRP} — your biological age is still from Jun 3, 2026.`
    );
  });

  it("is not disturbed by a later day carrying one stray input", () => {
    const p = newProfile("bioage_cgm_day");
    draw(p, "2026-06-03");
    // One glucose from a continuous monitor — a day, not a re-drawn panel.
    draw(
      p,
      "2026-08-12",
      PHENOAGE_INPUT_NAMES.filter((n) => n !== "Glucose")
    );

    expect(card(p).status.kind).toBe("computed");
  });
});

describe("the panels the gather now carries", () => {
  it("describes every dated panel, including the ones that computed nothing", () => {
    const p = newProfile("bioage_panels");
    draw(p, "2026-06-03");
    draw(p, "2026-07-12", [CRP]);

    const { panels } = getBioAgeReadings(p);
    expect(panels.map((x) => x.date)).toEqual(["2026-06-03", "2026-07-12"]);
    expect(panels[0].missing).toEqual([]);
    expect(panels[1].missing).toEqual([CRP]);
    // Present/missing partition the nine, in the checklist's own order.
    for (const x of panels)
      expect([...x.present, ...x.missing].sort()).toEqual(
        [...PHENOAGE_INPUT_NAMES].sort()
      );
  });
});
