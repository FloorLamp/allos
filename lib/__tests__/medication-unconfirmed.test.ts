// PURE TIER — the unconfirmed imported MEDICATION detector (#2574).
//
// Every case here is a boundary the issue decided deliberately: the four gates
// (medication / import-provenanced / never logged / past the cold-start floor), and the
// one that carries the whole safety argument — ONE log of EITHER status ends the offer.
//
// The last describe block is the one that must never be deleted: this detector and the
// demotion detector produce two flags on the SAME dose row, and the claim that a row can
// gain at most one extra button is asserted here over the cross product rather than
// assumed from two files that happen to agree today.
//
// All fixture values synthetic — no real PHI.

import { describe, it, expect } from "vitest";
import type { AdherenceDot, AdherenceState } from "@/lib/intake-adherence";
import {
  IMPORTED_SOURCE,
  UNCONFIRMED_MIN_OCCURRENCES,
  UNCONFIRMED_STOP_TEXT,
  UNCONFIRMED_WINDOW_DAYS,
  detectUnconfirmedMedication,
  detectUnconfirmedMedications,
  isImportProvenanced,
  type UnconfirmedMedInput,
} from "@/lib/medication-unconfirmed";
import {
  DEMOTION_WINDOW_DAYS,
  detectDemotionCandidate,
  type DemotionInput,
} from "@/lib/supplement-demotion";
import type { IntakeItemKind, IntakeObligation } from "@/lib/types";

// Dates are relative placeholders in the far past — the detector reads only `state`.
function strip(states: AdherenceState[]): AdherenceDot[] {
  return states.map((state, i) => ({
    date: `1990-01-${String(i + 1).padStart(2, "0")}`,
    state,
  }));
}

function due(n: number): AdherenceDot[] {
  return strip(Array<AdherenceState>(n).fill("missed"));
}

function input(over: Partial<UnconfirmedMedInput> = {}): UnconfirmedMedInput {
  return {
    itemId: 41,
    name: "Inhaled Placebo (test)",
    kind: "medication",
    source: IMPORTED_SOURCE,
    obligation: "must",
    active: true,
    strip: due(UNCONFIRMED_MIN_OCCURRENCES + 1),
    lifetimeLogs: 0,
    ...over,
  };
}

describe("detectUnconfirmedMedication (#2574)", () => {
  it("fires on an import-provenanced medication nobody has ever logged", () => {
    const c = detectUnconfirmedMedication(input());
    expect(c).not.toBeNull();
    expect(c?.itemId).toBe(41);
    expect(c?.occurrences).toBe(UNCONFIRMED_MIN_OCCURRENCES + 1);
  });

  it("does not fire on an item a person created by hand", () => {
    // The whole argument for the offer is that no user action ever asserted this item.
    expect(detectUnconfirmedMedication(input({ source: "manual" }))).toBeNull();
    expect(detectUnconfirmedMedication(input({ source: null }))).toBeNull();
  });

  it("does not fire once a single dose has been TAKEN", () => {
    expect(detectUnconfirmedMedication(input({ lifetimeLogs: 1 }))).toBeNull();
  });

  it("does not fire once a single dose has been SKIPPED", () => {
    // The important boundary. One skip is a decision on the record (#232) — engagement,
    // not absence — and the claim this offer makes is NO engagement.
    expect(
      detectUnconfirmedMedication({
        ...input(),
        lifetimeLogs: 1,
        strip: strip([
          "skipped",
          ...Array<AdherenceState>(UNCONFIRMED_MIN_OCCURRENCES).fill("missed"),
        ]),
      })
    ).toBeNull();
  });

  it("does not fire inside the cold-start window", () => {
    expect(
      detectUnconfirmedMedication(
        input({ strip: due(UNCONFIRMED_MIN_OCCURRENCES - 1) })
      )
    ).toBeNull();
    expect(
      detectUnconfirmedMedication(
        input({ strip: due(UNCONFIRMED_MIN_OCCURRENCES) })
      )
    ).not.toBeNull();
  });

  it("does not count off-cadence or deliberately-skipped days as occasions", () => {
    // A weekly medication's off-days score "na" (#1602). Counting them would make a
    // sparse schedule read as abandonment, which is the mislabeling class this floor
    // exists to avoid.
    expect(
      detectUnconfirmedMedication(
        input({
          strip: strip([
            ...Array<AdherenceState>(UNCONFIRMED_WINDOW_DAYS - 4).fill("na"),
            ...Array<AdherenceState>(4).fill("missed"),
          ]),
        })
      )
    ).toBeNull();
  });

  it("does not fire on a `may` item — it interrupts nobody, so there is nothing to stop", () => {
    expect(
      detectUnconfirmedMedication(input({ obligation: "may" }))
    ).toBeNull();
  });

  it("does not fire on a paused or already-stopped item", () => {
    expect(detectUnconfirmedMedication(input({ active: false }))).toBeNull();
  });

  it("does not fire on a supplement, whatever its provenance", () => {
    expect(
      detectUnconfirmedMedication(input({ kind: "supplement" }))
    ).toBeNull();
  });

  it("orders candidates by name then id", () => {
    const out = detectUnconfirmedMedications([
      input({ itemId: 3, name: "Zafirlukast (test)" }),
      input({ itemId: 2, name: "Albuterol (test)" }),
      input({ itemId: 1, name: "Albuterol (test)" }),
    ]);
    expect(out.map((c) => c.itemId)).toEqual([1, 2, 3]);
  });
});

describe("isImportProvenanced", () => {
  it("keys on source alone, never on the document link", () => {
    // Reassignment and reprocessing move `document_id`; who CREATED the row does not
    // change, and that is the question.
    expect(isImportProvenanced({ source: IMPORTED_SOURCE })).toBe(true);
    expect(isImportProvenanced({ source: "manual" })).toBe(false);
    expect(isImportProvenanced({ source: null })).toBe(false);
  });
});

describe("the tap's copy", () => {
  it("names an outcome for every case the write can return, refusals included", () => {
    for (const text of Object.values(UNCONFIRMED_STOP_TEXT))
      expect(text.length).toBeGreaterThan(10);
    // A refusal must not read like a success — the inline-action contract.
    expect(UNCONFIRMED_STOP_TEXT["already-stopped"]).not.toContain(
      "no more reminders"
    );
    expect(UNCONFIRMED_STOP_TEXT.withdrawn).not.toContain("no more reminders");
    expect(UNCONFIRMED_STOP_TEXT["not-found"]).not.toContain(
      "no more reminders"
    );
  });
});

// ---------------------------------------------------------------------------
// Disjointness — asserted, never assumed
// ---------------------------------------------------------------------------

describe("the two dose-row flags are complements on `kind`", () => {
  it("shares one window with the demotion detector", () => {
    expect(UNCONFIRMED_WINDOW_DAYS).toBe(DEMOTION_WINDOW_DAYS);
  });

  it("never both fire, over every kind × provenance × obligation combination", () => {
    const kinds: IntakeItemKind[] = ["medication", "supplement"];
    const sources = [IMPORTED_SOURCE, "manual", null];
    const obligations: IntakeObligation[] = ["must", "should", "may"];
    for (const kind of kinds)
      for (const source of sources)
        for (const obligation of obligations) {
          // A strip that satisfies BOTH detectors' floors and would satisfy the
          // demotion rate test outright: every occasion missed, none taken.
          const shared = due(UNCONFIRMED_MIN_OCCURRENCES + 5);
          const demotion: DemotionInput = {
            itemId: 41,
            name: "Fixture (test)",
            kind,
            obligation,
            active: true,
            strip: shared,
            existedWholeWindow: true,
            periodAnchor: "1990",
          };
          const unconfirmed: UnconfirmedMedInput = {
            itemId: 41,
            name: "Fixture (test)",
            kind,
            source,
            obligation,
            active: true,
            strip: shared,
            lifetimeLogs: 0,
          };
          const both =
            detectDemotionCandidate(demotion) != null &&
            detectUnconfirmedMedication(unconfirmed) != null;
          expect(both, `${kind}/${source}/${obligation}`).toBe(false);
        }
  });
});
