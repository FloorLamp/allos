import { describe, expect, it } from "vitest";
import { sharedSupplyMemberLabels } from "../shared-supply-member-labels";

describe("sharedSupplyMemberLabels", () => {
  it("keeps a unique item label concise", () => {
    const labels = sharedSupplyMemberLabels([
      {
        itemId: 1,
        profileId: 10,
        name: "Vitamin D",
        kind: "supplement",
        doseAmounts: ["2000 IU"],
      },
    ]);

    expect(labels.get(1)).toBe("Vitamin D");
  });

  it("uses kind and dose to distinguish same-named records", () => {
    const labels = sharedSupplyMemberLabels([
      {
        itemId: 1,
        profileId: 10,
        name: "Magnesium",
        kind: "supplement",
        doseAmounts: ["200 mg"],
      },
      {
        itemId: 2,
        profileId: 10,
        name: "Magnesium",
        kind: "medication",
        doseAmounts: ["400 mg"],
      },
    ]);

    expect(labels.get(1)).toBe("Magnesium · IntakeItem · 200 mg");
    expect(labels.get(2)).toBe("Magnesium · Medication · 400 mg");
  });

  it("adds stable ordinals when meaningful details are identical", () => {
    const labels = sharedSupplyMemberLabels([
      {
        itemId: 4,
        profileId: 10,
        name: "Ibuprofen",
        kind: "medication",
        doseAmounts: ["200 mg"],
      },
      {
        itemId: 7,
        profileId: 10,
        name: "Ibuprofen",
        kind: "medication",
        doseAmounts: ["200 mg"],
      },
    ]);

    expect(labels.get(4)).toBe("Ibuprofen · Medication · 200 mg · Item 1");
    expect(labels.get(7)).toBe("Ibuprofen · Medication · 200 mg · Item 2");
  });
});
