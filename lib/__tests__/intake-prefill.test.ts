import { describe, it, expect } from "vitest";
import {
  applyPrefill,
  emptyPrefillLedger,
  resolveIntakePrefill,
  touchPrefill,
  withdrawPrefill,
  PREFILL_FIELDS,
  type PrefillLedger,
} from "@/lib/intake-prefill";
import { getMedicationInfo } from "@/lib/medication-info";
import { prnDefaultsFor } from "@/lib/prn-defaults";
import { SUPPLEMENT_CATALOG } from "@/lib/supplement-catalog";
import type { PediatricFormContext } from "@/lib/prn-dosing";

// The pure prefill resolver and its ledger (#846, #4665): picking anything suggests
// every knowable field as an editable, MARKED value that NEVER clobbers a touched
// field; an absent dataset prefills nothing; a child profile's dose comes from the
// #798 weight band. Three vocabularies, one answer.

const ibuInfo = getMedicationInfo("Ibuprofen");
const ibuPrn = prnDefaultsFor({ name: "Ibuprofen", rxcui: null });
const blank = emptyPrefillLedger();

const medication = (
  ledger: PrefillLedger = blank,
  pediatric?: PediatricFormContext
) =>
  resolveIntakePrefill({
    source: { vocabulary: "medication", info: ibuInfo, prn: ibuPrn },
    pediatric,
    ledger,
  });

const catalogEntry = (name: string) => {
  const entry = SUPPLEMENT_CATALOG.find((c) => c.name === name);
  if (!entry) throw new Error(`no catalog entry named ${name}`);
  return entry;
};

describe("the prefill ledger", () => {
  it("marks everything it writes, and merges marks rather than replacing them", () => {
    const first = applyPrefill(blank, { doseAmount: "200 mg" });
    expect(first.writes.doseAmount).toBe("200 mg");
    expect([...first.ledger.suggested]).toEqual(["doseAmount"]);

    // A LATER path seeding a different field keeps the earlier mark. This is the
    // guarantee the form used to break by assigning a fresh set.
    const second = applyPrefill(first.ledger, { minIntervalHours: 6 });
    expect([...second.ledger.suggested].sort()).toEqual([
      "doseAmount",
      "minIntervalHours",
    ]);
  });

  it("refuses a touched field and writes the rest", () => {
    const ledger = touchPrefill(blank, "doseAmount");
    const applied = applyPrefill(ledger, {
      doseAmount: "500 mg",
      minIntervalHours: 4,
    });
    expect(applied.writes.doseAmount).toBeUndefined();
    expect(applied.writes.minIntervalHours).toBe(4);
    expect(applied.ledger.suggested.has("doseAmount")).toBe(false);
  });

  it("touching a field withdraws its mark, so it stops reading as an offer", () => {
    const offered = applyPrefill(blank, { doseAmount: "200 mg" }).ledger;
    const typed = touchPrefill(offered, "doseAmount");
    expect(typed.suggested.has("doseAmount")).toBe(false);
    expect(typed.touched.has("doseAmount")).toBe(true);
  });

  it("withdrawing an offer leaves a touched value alone", () => {
    const typed = touchPrefill(blank, "doseAmount");
    expect(withdrawPrefill(typed, "doseAmount").touched.has("doseAmount")).toBe(
      true
    );
  });

  // POSITIVE CONTROL for every "refused" assertion above: with an empty ledger the same
  // offer writes every field, so a refusal is the ledger and not an offer of nothing.
  it("an empty ledger writes the whole offer", () => {
    const offer = Object.fromEntries(
      PREFILL_FIELDS.map((f) => [
        f,
        f === "asNeeded" ? true : f === "doseAmount" ? "1 mg" : 1,
      ])
    );
    const applied = applyPrefill(blank, offer);
    expect(Object.keys(applied.writes).sort()).toEqual(
      [...PREFILL_FIELDS].sort()
    );
  });
});

describe("resolveIntakePrefill — the medication vocabulary", () => {
  it("prefills the full knowable set for a catalogued OTC med (adult)", () => {
    const pf = medication();
    // Ibuprofen: PRN, with food, adult low dose 200 mg, 6h / max 4 (all cited).
    expect(pf.writes.asNeeded).toBe(true);
    expect(pf.writes.foodTiming).toBe("with_food");
    expect(pf.writes.doseAmount).toBe("200 mg");
    expect(pf.writes.minIntervalHours).toBe(6);
    expect(pf.writes.maxDailyCount).toBe(4);
    expect(pf.brandSuggestions).toEqual(
      expect.arrayContaining(["Advil", "Motrin"])
    );
    // Every suggested field is marked so the form can badge it "from label defaults".
    expect([...pf.ledger.suggested]).toEqual(
      expect.arrayContaining([
        "asNeeded",
        "foodTiming",
        "doseAmount",
        "minIntervalHours",
        "maxDailyCount",
      ])
    );
  });

  it("never clobbers a field the user already touched", () => {
    const pf = medication(touchPrefill(blank, "asNeeded", "doseAmount"));
    expect(pf.writes.asNeeded).toBeUndefined();
    expect(pf.writes.doseAmount).toBeUndefined();
    expect(pf.ledger.suggested.has("asNeeded")).toBe(false);
    expect(pf.ledger.suggested.has("doseAmount")).toBe(false);
    // Untouched fields still prefill.
    expect(pf.writes.minIntervalHours).toBe(6);
    expect(pf.ledger.suggested.has("minIntervalHours")).toBe(true);
  });

  it("an absent entry prefills nothing (never a guess)", () => {
    const pf = resolveIntakePrefill({
      source: { vocabulary: "medication", info: null, prn: null },
      ledger: blank,
    });
    expect(pf.writes).toEqual({});
    expect([...pf.ledger.suggested]).toEqual([]);
    expect(pf.brandSuggestions).toEqual([]);
  });

  it("only encodes conventions the dataset carries (typical-less med)", () => {
    // A statin-style entry with a `typical.timeOfDay` but no PRN defaults prefills the
    // convention and nothing dose-related (no prn ⇒ no dose/interval/max).
    const pf = resolveIntakePrefill({
      source: {
        vocabulary: "medication",
        info: getMedicationInfo("Simvastatin"),
        prn: null,
      },
      ledger: blank,
    });
    expect(pf.writes.timeOfDay).toBe("Evening");
    expect(pf.writes.asNeeded).toBeUndefined();
    expect(pf.writes.doseAmount).toBeUndefined();
    expect([...pf.ledger.suggested]).toEqual(["timeOfDay"]);
  });

  it("a child profile's dose comes from the #798 weight band, not the adult figure", () => {
    // A ~24 lb toddler (age 24 mo, fresh weight) bands to ibuprofen 100 mg — distinct
    // from the adult 200 mg low dose.
    const pf = medication(blank, {
      ageMonths: 24,
      weightKg: 11, // ≈ 24.3 lb → the 24 lb band
      weightDate: "2026-07-10",
      weightUnit: "lb",
      today: "2026-07-16",
    });
    expect(pf.writes.doseAmount).toBe("100 mg");
    expect(pf.ledger.suggested.has("doseAmount")).toBe(true);
    // The non-dose conventions still prefill for the child.
    expect(pf.writes.asNeeded).toBe(true);
    expect(pf.writes.minIntervalHours).toBe(6);
  });

  it("a child band refusal (no weight) prefills no dose, never the adult figure", () => {
    const pf = medication(blank, {
      ageMonths: 24,
      weightKg: null,
      weightDate: null,
      weightUnit: "lb",
      today: "2026-07-16",
    });
    expect(pf.writes.doseAmount).toBeUndefined();
    expect(pf.ledger.suggested.has("doseAmount")).toBe(false);
    // Interval/max (age-independent label facts) still prefill.
    expect(pf.writes.minIntervalHours).toBe(6);
  });
});

describe("resolveIntakePrefill — the supplement catalog vocabulary", () => {
  it("offers the label's first dosage and time of day, MARKED", () => {
    const pf = resolveIntakePrefill({
      source: { vocabulary: "catalog", entry: catalogEntry("Vitamin C") },
      ledger: blank,
    });
    expect(pf.writes.doseAmount).toBe("250 mg");
    expect(pf.writes.timeOfDay).toBe("Morning");
    // The marking is the whole point: before #4665 this arm seeded values that rendered
    // as stated facts because nothing marked them.
    expect(pf.ledger.suggested.has("doseAmount")).toBe(true);
    expect(pf.ledger.suggested.has("timeOfDay")).toBe(true);
  });

  it("falls back to the fat-soluble food heuristic when the entry states none", () => {
    const pf = resolveIntakePrefill({
      source: { vocabulary: "catalog", entry: catalogEntry("Vitamin D3") },
      ledger: blank,
    });
    expect(pf.writes.foodTiming).toBe("with_fat");
  });

  it("carries a blend's label composition and says how much of the label it is", () => {
    const blend = SUPPLEMENT_CATALOG.find(
      (c) => (c.ingredients?.length ?? 0) > 0 && c.ingredientsPartial
    );
    if (!blend) throw new Error("no partial blend in the catalog");
    const pf = resolveIntakePrefill({
      source: { vocabulary: "catalog", entry: blend },
      ledger: blank,
    });
    expect(pf.ingredients.length).toBe(blend.ingredients!.length);
    expect(pf.ingredientNote).toContain("not the whole label");
  });

  it("still refuses a touched field", () => {
    const pf = resolveIntakePrefill({
      source: { vocabulary: "catalog", entry: catalogEntry("Vitamin C") },
      ledger: touchPrefill(blank, "doseAmount"),
    });
    expect(pf.writes.doseAmount).toBeUndefined();
    expect(pf.writes.timeOfDay).toBe("Morning");
  });
});

describe("resolveIntakePrefill — the household bottle vocabulary", () => {
  it("offers the bottle's strength as a dose amount, MARKED", () => {
    const pf = resolveIntakePrefill({
      source: { vocabulary: "bottle", amount: "5000 IU" },
      ledger: blank,
    });
    expect(pf.writes.doseAmount).toBe("5000 IU");
    expect(pf.ledger.suggested.has("doseAmount")).toBe(true);
    // A bottle states a product, not a schedule or a label convention.
    expect(pf.writes.timeOfDay).toBeUndefined();
    expect(pf.writes.asNeeded).toBeUndefined();
    expect(pf.brandSuggestions).toEqual([]);
  });

  it("a bottle with no strength offers nothing", () => {
    const pf = resolveIntakePrefill({
      source: { vocabulary: "bottle", amount: "" },
      ledger: blank,
    });
    expect(pf.writes).toEqual({});
  });

  it("never overwrites a dose the person typed", () => {
    const pf = resolveIntakePrefill({
      source: { vocabulary: "bottle", amount: "5000 IU" },
      ledger: touchPrefill(blank, "doseAmount"),
    });
    expect(pf.writes.doseAmount).toBeUndefined();
  });
});

describe("a bottle outranks the label it resolves to (#4608)", () => {
  it("keeps the bottle's strength while taking the label's conventions", () => {
    const entry = catalogEntry("Vitamin D3");
    const pf = resolveIntakePrefill({
      source: {
        vocabulary: "bottle",
        amount: "5000 IU",
        label: { vocabulary: "catalog", entry },
      },
      ledger: blank,
    });
    // POSITIVE CONTROL: the label really does state a different dosage, so this is a
    // contest the bottle won and not a label that offered nothing.
    expect(entry.dosages[0]).not.toBe("5000 IU");
    expect(pf.writes.doseAmount).toBe("5000 IU");
    expect(pf.writes.timeOfDay).toBe(entry.defaultTimeOfDay);
  });

  it("falls back to the label when the bottle states no strength", () => {
    const entry = catalogEntry("Vitamin D3");
    const pf = resolveIntakePrefill({
      source: {
        vocabulary: "bottle",
        amount: "",
        label: { vocabulary: "catalog", entry },
      },
      ledger: blank,
    });
    expect(pf.writes.doseAmount).toBe(entry.dosages[0]);
  });

  it("outranks a medication label's cited dose figure too", () => {
    const pf = resolveIntakePrefill({
      source: {
        vocabulary: "bottle",
        amount: "800 mg",
        label: { vocabulary: "medication", info: ibuInfo, prn: ibuPrn },
      },
      ledger: blank,
    });
    expect(pf.writes.doseAmount).toBe("800 mg");
    // The label's other conventions still arrive.
    expect(pf.writes.asNeeded).toBe(true);
    expect(pf.writes.minIntervalHours).toBe(6);
  });
});
