import { describe, expect, it } from "vitest";
import {
  findCrossReactivity,
  crossReactivityFamilies,
} from "../allergen-cross-reactivity";

describe("allergen cross-reactivity dataset", () => {
  it("every family has members, a label and a citation", () => {
    const families = crossReactivityFamilies();
    expect(families.length).toBeGreaterThan(0);
    for (const f of families) {
      expect(f.members.length).toBeGreaterThan(1);
      expect(f.label.trim().length).toBeGreaterThan(0);
      expect(f.citation.trim().length).toBeGreaterThan(0);
    }
  });

  it("family ids are unique", () => {
    const ids = crossReactivityFamilies().map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("findCrossReactivity — matching", () => {
  it("surfaces birch oral allergy syndrome from a birch sensitization", () => {
    const [m, ...rest] = findCrossReactivity(["Birch"]);
    expect(rest).toHaveLength(0);
    expect(m.familyId).toBe("birch-oas");
    expect(m.triggers).toEqual(["Birch"]);
    // Trigger member excluded from the related list; well-known members present.
    expect(m.related).not.toContain("birch");
    expect(m.related).toEqual(
      expect.arrayContaining(["apple", "cherry", "hazelnut", "kiwi"])
    );
  });

  it("uses informational, non-diagnostic wording", () => {
    const [m] = findCrossReactivity(["Birch"]);
    expect(m.note).toContain("commonly cross-reacts with");
    expect(m.note).toContain("Informational only");
    // Never diagnostic phrasing.
    expect(m.note).not.toMatch(/you are allergic|will react|diagnos/i);
  });

  it("matches the crustacean group from a shrimp allergy (plural + alias)", () => {
    const [m] = findCrossReactivity(["Shrimp"]);
    expect(m.familyId).toBe("crustacean");
    expect(m.related).toEqual(
      expect.arrayContaining(["crab", "lobster", "crawfish"])
    );
    // A plural spelling still matches.
    expect(findCrossReactivity(["Shrimps"])[0]?.familyId).toBe("crustacean");
  });

  it("surfaces the finned-fish (parvalbumin) group from a salmon allergy", () => {
    const [m, ...rest] = findCrossReactivity(["Salmon"]);
    expect(rest).toHaveLength(0);
    expect(m.familyId).toBe("finned-fish");
    expect(m.related).not.toContain("salmon");
    expect(m.related).toEqual(
      expect.arrayContaining(["cod", "tuna", "halibut"])
    );
  });

  it("matches peanut↔lupin cross-reactivity (incl. the lupine alias)", () => {
    const [m] = findCrossReactivity(["Peanut"]);
    expect(m.familyId).toBe("peanut-lupin");
    expect(m.related).toEqual(["lupin"]);
    expect(findCrossReactivity(["Lupine"])[0]?.familyId).toBe("peanut-lupin");
  });

  it("matches mammalian milk via a bare 'Milk' alias", () => {
    const [m] = findCrossReactivity(["Milk"]);
    expect(m.familyId).toBe("mammalian-milk");
    expect(m.related).toEqual(
      expect.arrayContaining(["goat's milk", "sheep's milk"])
    );
  });

  it("normalizes casing and extracted-IgE style names", () => {
    // Names coming from allergenFromIgEName keep source casing, e.g. "Cashew".
    const [m] = findCrossReactivity(["cashew"]);
    expect(m.familyId).toBe("tree-nut-cashew-pistachio");
    expect(m.related).toEqual(["pistachio"]);
  });
});

describe("findCrossReactivity — no-match", () => {
  it("returns nothing for allergens in no family", () => {
    expect(
      findCrossReactivity(["Penicillin", "Sulfa drugs", "Pollen"])
    ).toEqual([]);
  });

  it("returns nothing for empty / blank input", () => {
    expect(findCrossReactivity([])).toEqual([]);
    expect(findCrossReactivity(["", "   "])).toEqual([]);
  });
});

describe("findCrossReactivity — multi-family allergen", () => {
  it("kiwi belongs to birch-OAS and latex-fruit; both surface", () => {
    const matches = findCrossReactivity(["Kiwi"]);
    const ids = matches.map((m) => m.familyId).sort();
    expect(ids).toEqual(["birch-oas", "latex-fruit"]);
    for (const m of matches) {
      expect(m.triggers).toEqual(["Kiwi"]);
      // kiwi is the trigger, so it is excluded from each family's related list.
      expect(m.related).not.toContain("kiwi");
    }
    // Latex-fruit still lists banana/avocado; birch-OAS still lists apple.
    const latex = matches.find((m) => m.familyId === "latex-fruit")!;
    expect(latex.related).toEqual(
      expect.arrayContaining(["banana", "avocado"])
    );
    const birch = matches.find((m) => m.familyId === "birch-oas")!;
    expect(birch.related).toContain("apple");
  });

  it("collapses multiple triggers within one family into a single note", () => {
    const matches = findCrossReactivity(["Birch", "Apple"]);
    const birch = matches.find((m) => m.familyId === "birch-oas")!;
    expect(birch.triggers).toEqual(["Birch", "Apple"]);
    // Both matched members drop out of the related list.
    expect(birch.related).not.toContain("apple");
    expect(birch.related).not.toContain("birch");
    expect(birch.related).toContain("hazelnut");
  });
});
