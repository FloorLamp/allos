import { describe, expect, it } from "vitest";
import {
  DEFAULT_FORMULATION_SLUG,
  defaultFormulationSlug,
  formulationChoices,
  formulationDoseAmount,
  formulationRedosePreset,
  pediatricContextLine,
} from "@/lib/intake-formulations";
import { prnDefaultsFor } from "@/lib/prn-defaults";
import { parseAmountMg } from "@/lib/prn-redose";

// The formulation chip row (#3216 decision 2). One ingredient is several products;
// the row surfaces the choice, the profile's age picks the default, and a switch
// re-derives what the PRODUCT decides and nothing the person decided.

const ibuprofen = prnDefaultsFor({ name: "Ibuprofen", rxcui: null });
const aspirin = prnDefaultsFor({ name: "Aspirin", rxcui: null });

describe("intake formulation row (#3216)", () => {
  it("an ingredient with several products offers them; one with none offers nothing", () => {
    const choices = formulationChoices(ibuprofen);
    expect(choices.length).toBeGreaterThan(1);
    expect(choices[0].slug).toBe(DEFAULT_FORMULATION_SLUG);
    expect(choices.filter((c) => c.pediatric).length).toBeGreaterThan(0);
    // A row of one chip is a fact nobody needs stated.
    expect(formulationChoices(aspirin)).toEqual([]);
    expect(formulationChoices(null)).toEqual([]);
  });

  it("only a chosen pediatric product is stored as `product`", () => {
    const choices = formulationChoices(ibuprofen);
    expect(choices[0].product).toBe("");
    const suspension = choices.find((c) => c.pediatric);
    // The full curated label, so the concentration stays useful outside this form.
    expect(suspension?.product).toBe(suspension?.label);
    expect(suspension?.product).toContain("mL");
  });

  it("a child profile defaults to the pediatric product; an adult to neither", () => {
    const choices = formulationChoices(ibuprofen);
    const child = defaultFormulationSlug({ choices, isChildProfile: true });
    expect(choices.find((c) => c.slug === child)?.pediatric).toBe(true);
    expect(defaultFormulationSlug({ choices, isChildProfile: false })).toBe(
      DEFAULT_FORMULATION_SLUG
    );
  });

  it("a stored product outranks the age default, so an edit reads back what was saved", () => {
    const choices = formulationChoices(ibuprofen);
    const stored = choices.find((c) => c.pediatric)!.slug;
    expect(
      defaultFormulationSlug({
        choices,
        isChildProfile: false,
        storedSlug: stored,
      })
    ).toBe(stored);
  });

  it("a suspension's dose amount carries the volume AND stays readable as milligrams", () => {
    const formulation = ibuprofen!.pediatric!.formulations.find(
      (f) => f.mgPerMl === 20
    )!;
    const amount = formulationDoseAmount(formulation, 100);
    expect(amount).toContain("mL");
    // THE POINT. #1854's day-exposure counter reads the LEADING mass off the
    // snapshotted amount. An amount written volume-first parses as nothing, and the
    // milligram basis would silently degrade to counting doses for exactly the liquid
    // pediatric case that most needs it.
    expect(parseAmountMg(amount)).toBe(100);
  });

  it("a solid dose states milligrams alone", () => {
    expect(formulationDoseAmount(null, 200)).toBe("200 mg");
    expect(parseAmountMg(formulationDoseAmount(null, 200))).toBe(200);
  });

  it("switching to a pediatric product re-derives the child's redose preset", () => {
    const choices = formulationChoices(ibuprofen);
    const adult = formulationRedosePreset(ibuprofen, choices[0]);
    const child = formulationRedosePreset(
      ibuprofen,
      choices.find((c) => c.pediatric)
    );
    expect(adult?.tier).toBe("adult");
    expect(child?.tier).toBe("pediatric");
  });

  it("the #798 pediatric contract survives a formulation switch", () => {
    const choices = formulationChoices(ibuprofen);
    // It is a property of dosing a CHILD, not of the product chosen — so it holds for
    // the default chip and for a suspension alike.
    for (const choice of choices) {
      const line = pediatricContextLine(choice, true);
      expect(line).toBeTruthy();
      expect(line).toContain("weight band");
      expect(line).toContain("label");
    }
    // And an adult on the ingredient's own form is told nothing about children.
    expect(pediatricContextLine(choices[0], false)).toBeNull();
  });
});
