import { describe, expect, it } from "vitest";
import { deriveIntakeKind, intakeKindAskPrompt } from "@/lib/intake-kind";

// Kind derivation for the one intake form (#3216 decision 1). The form no longer asks
// which kind you are adding; it works it out from the name and shows a correctable
// chip. Each acceptance case below is a DIFFERENT decision, so each is asserted on the
// two things that decide behaviour — the kind, and the SOURCE that explains it — never
// on the chip's wording.

const NOTHING = {
  inMedicationVocabulary: false,
  inSupplementVocabulary: false,
};

describe("deriveIntakeKind (#3216)", () => {
  it("a medication-vocabulary pick decides medication, correctably", () => {
    const d = deriveIntakeKind({
      name: "Ibuprofen",
      ...NOTHING,
      inMedicationVocabulary: true,
    });
    expect(d.kind).toBe("medication");
    expect(d.source).toBe("medication-vocabulary");
    // The whole point of deriving rather than asking is that it stays correctable.
    expect(d.correctable).toBe(true);
  });

  it("a supplement-vocabulary pick decides supplement", () => {
    const d = deriveIntakeKind({
      name: "Vitamin D3",
      ...NOTHING,
      inSupplementVocabulary: true,
    });
    expect(d.kind).toBe("supplement");
    expect(d.source).toBe("supplement-vocabulary");
  });

  it("a name on BOTH lists asks, and says it is on both", () => {
    const d = deriveIntakeKind({
      name: "Melatonin",
      inMedicationVocabulary: true,
      inSupplementVocabulary: true,
    });
    expect(d.kind).toBeNull();
    expect(d.source).toBe("ambiguous");
  });

  it("a name on NEITHER list asks a different question", () => {
    const d = deriveIntakeKind({ name: "Nettle tea", ...NOTHING });
    expect(d.kind).toBeNull();
    expect(d.source).toBe("unknown");
    // The two asks are not interchangeable: one says we know it as both, the other
    // that we do not know it. Collapsing them would tell the melatonin case nothing.
    expect(intakeKindAskPrompt("ambiguous")).not.toBe(
      intakeKindAskPrompt("unknown")
    );
  });

  it("a bottle's sibling breaks a both-lists tie", () => {
    const d = deriveIntakeKind({
      name: "Melatonin",
      inMedicationVocabulary: true,
      inSupplementVocabulary: true,
      bottleSiblingKind: "supplement",
    });
    expect(d.kind).toBe("supplement");
    expect(d.source).toBe("bottle-sibling");
  });

  it("a bottle with nothing linked to it still asks", () => {
    const d = deriveIntakeKind({
      name: "Melatonin",
      inMedicationVocabulary: true,
      inSupplementVocabulary: true,
      bottleSiblingKind: null,
    });
    expect(d.kind).toBeNull();
    expect(d.source).toBe("ambiguous");
  });

  it("an UNAMBIGUOUS vocabulary hit outranks the bottle's sibling", () => {
    // The vocabularies describe the substance; a sibling only records how one member
    // of the household filed it. A bottle of ibuprofen someone filed as a supplement
    // does not make the next person's ibuprofen a supplement.
    const d = deriveIntakeKind({
      name: "Ibuprofen",
      ...NOTHING,
      inMedicationVocabulary: true,
      bottleSiblingKind: "supplement",
    });
    expect(d.kind).toBe("medication");
    expect(d.source).toBe("medication-vocabulary");
  });

  it("a kind-locked door answers it and offers nothing to change", () => {
    const d = deriveIntakeKind({
      name: "Melatonin",
      locked: "supplement",
      inMedicationVocabulary: true,
      inSupplementVocabulary: true,
    });
    expect(d.kind).toBe("supplement");
    expect(d.source).toBe("locked");
    // Not merely "it picked supplement": a locked door must not render a `change`
    // toggle, or the door stops being a door.
    expect(d.correctable).toBe(false);
  });

  it("the person's own correction outranks the vocabulary", () => {
    const d = deriveIntakeKind({
      name: "Ibuprofen",
      chosen: "supplement",
      ...NOTHING,
      inMedicationVocabulary: true,
    });
    expect(d.kind).toBe("supplement");
    expect(d.source).toBe("chosen");
  });

  it("a blank name decides nothing, whatever the flags claim", () => {
    const d = deriveIntakeKind({
      name: "   ",
      inMedicationVocabulary: true,
      inSupplementVocabulary: false,
    });
    expect(d.kind).toBeNull();
    expect(d.source).toBe("unknown");
  });
});
