import { describe, expect, it } from "vitest";
import { rankedVaccineOptions } from "../immunization-rank";
import { assessSchedule } from "../immunization-status";
import { PICKER_NAMES } from "../immunization-catalog";

// The Combobox shows 8 rows and an empty query keeps source order (#1677).
const PICKER_ROWS = 8;
const TODAY = "2026-08-01";

const head = (options: string[]) => options.slice(0, PICKER_ROWS);

// The picker order a real profile of this age/dose history would see — the ranker
// reading the SAME status engine the schedule grid draws from.
function pickerFor(
  ageMonths: number | null,
  records: { vaccine: string; date: string }[] = []
): string[] {
  const summary = assessSchedule(records, ageMonths, null, TODAY);
  return rankedVaccineOptions(
    summary.assessments.map((a) => ({ code: a.code, status: a.status }))
  );
}

describe("rankedVaccineOptions", () => {
  it("changes ORDER only — membership matches PICKER_NAMES exactly", () => {
    const ranked = pickerFor(45 * 12);
    expect(ranked).toHaveLength(PICKER_NAMES.length);
    expect(new Set(ranked)).toEqual(new Set(PICKER_NAMES));
  });

  it("is the catalog order when nothing is known about the profile", () => {
    // No facts at all ⇒ every vaccine lands in the neutral bucket, so the ranker
    // degrades to the ACIP order rather than to nonsense.
    expect(rankedVaccineOptions([])).toEqual(PICKER_NAMES);
  });

  it("sinks the infant series out of an ADULT's visible eight", () => {
    // Before #1677 an adult opened on Hep B / Rotavirus / DTaP / Hib / PCV / IPV /
    // MMR / Varicella — a newborn's first year.
    expect(head(PICKER_NAMES)).toContain("Rotavirus");

    const adult = head(pickerFor(45 * 12));
    expect(adult).not.toContain("Rotavirus");
    expect(adult).not.toContain("Haemophilus influenzae type b (Hib)");
  });

  it("leads an adult's picker with the vaccines that adult is plausibly next given", () => {
    const summary = assessSchedule([], 45 * 12, null, TODAY);
    const dueNow = new Set(
      summary.assessments
        .filter((a) => a.status === "due" || a.status === "overdue")
        .map((a) => a.name)
    );
    expect(dueNow.size).toBeGreaterThan(0);
    for (const name of head(pickerFor(45 * 12)).slice(0, dueNow.size)) {
      expect(dueNow.has(name)).toBe(true);
    }
  });

  it("keeps the infant series leading an INFANT's picker", () => {
    const infant = head(pickerFor(2));
    expect(infant).toContain("Rotavirus");
    expect(infant).toContain("Diphtheria, Tetanus & Pertussis (DTaP)");
  });

  it("sinks a combination shot with its components' life stage", () => {
    // Vaxelis is DTaP-IPV-Hib-HepB: an infant shot. It must not outrank an adult's
    // own due vaccines just because it sits in the combination block.
    const adult = pickerFor(45 * 12);
    const infant = pickerFor(2);
    expect(infant.indexOf("Vaxelis (DTaP-IPV-Hib-HepB)")).toBeLessThan(
      adult.indexOf("Vaxelis (DTaP-IPV-Hib-HepB)")
    );
  });

  it("ranks a due vaccine ahead of one already complete", () => {
    const ranked = rankedVaccineOptions([
      { code: "hepb", status: "complete" },
      { code: "rv", status: "due" },
    ]);
    expect(ranked.indexOf("Rotavirus")).toBeLessThan(
      ranked.indexOf("Hepatitis B")
    );
  });

  it("puts a declined vaccine last, without removing it", () => {
    const ranked = rankedVaccineOptions([{ code: "hepb", status: "declined" }]);
    expect(ranked).toContain("Hepatitis B");
    expect(ranked[ranked.length - 1]).toBe("Hepatitis B");
  });

  it("keeps a combination offered for the half that is still relevant", () => {
    // Twinrix is HepA+HepB. Declining Hep B must not sink the shot that also covers
    // Hep A — a combination is as relevant as the most relevant thing it covers.
    const ranked = rankedVaccineOptions([{ code: "hepb", status: "declined" }]);
    expect(ranked.indexOf("Twinrix (HepA-HepB)")).toBeLessThan(
      ranked.indexOf("Hepatitis B")
    );
  });

  it("preserves ACIP order inside a bucket", () => {
    const ranked = rankedVaccineOptions([
      { code: "rv", status: "due" },
      { code: "hepb", status: "due" },
    ]);
    // Hepatitis B precedes Rotavirus in the catalog, and both are due.
    expect(ranked.slice(0, 2)).toEqual(["Hepatitis B", "Rotavirus"]);
  });

  it("is stable — the same facts always give the same picker", () => {
    const facts = pickerFor(45 * 12);
    expect(pickerFor(45 * 12)).toEqual(facts);
  });
});
