import { describe, expect, it } from "vitest";
import { providerPickerModel, providerSubmitName } from "@/lib/provider-picker";
import type { Provider } from "@/lib/types";

// Fully synthetic provider rows (no real PHI): obviously-fictional names, no NPIs.
function prov(over: Partial<Provider> & { id: number }): Provider {
  return {
    id: over.id,
    name: over.name ?? "Test Provider",
    type: over.type ?? "individual",
    npi: over.npi ?? null,
    identifier: over.identifier ?? null,
    phone: over.phone ?? null,
    address: over.address ?? null,
    specialty_code: null,
    specialty: over.specialty ?? null,
    archived: 0,
    contact_edited: 0,
    created_at: "2026-01-01",
  };
}

describe("providerPickerModel (issue #1176)", () => {
  it("uses the bare name as the label when it's unique, mapping back to the name", () => {
    const rows = [
      prov({ id: 1, name: "Dr. Ada Lovelace", type: "individual" }),
      prov({ id: 2, name: "Sample Care East", type: "organization" }),
    ];
    const model = providerPickerModel(rows);
    expect(model.labels).toEqual(["Dr. Ada Lovelace", "Sample Care East"]);
    expect(model.labelToName.get("Dr. Ada Lovelace")).toBe("Dr. Ada Lovelace");
    expect(model.labelToType.get("Dr. Ada Lovelace")).toBe("individual");
    expect(model.labelToType.get("Sample Care East")).toBe("organization");
  });

  it("disambiguates two same-named providers into DISTINCT labels, each keeping its type", () => {
    const rows = [
      prov({ id: 1, name: "City Medical", type: "individual" }),
      prov({ id: 2, name: "City Medical", type: "organization" }),
    ];
    const model = providerPickerModel(rows);
    // The two collapse to distinct labels (the datalist's dedup-by-name bug is fixed).
    expect(new Set(model.labels).size).toBe(2);
    // Each disambiguated label still maps back to the shared bare name for submit …
    for (const label of model.labels)
      expect(model.labelToName.get(label)).toBe("City Medical");
    // … and carries the correct type for its icon.
    const types = model.labels.map((l) => model.labelToType.get(l));
    expect(new Set(types)).toEqual(new Set(["individual", "organization"]));
  });
});

describe("providerSubmitName (submit semantics unchanged)", () => {
  const model = providerPickerModel([
    prov({ id: 1, name: "City Medical", type: "individual" }),
    prov({ id: 2, name: "City Medical", type: "organization" }),
    prov({ id: 3, name: "Dr. Ada Lovelace", type: "individual" }),
  ]);

  it("a picked disambiguated label submits the bare provider name", () => {
    const collisionLabel = model.labels.find((l) => l !== "Dr. Ada Lovelace")!;
    expect(providerSubmitName(model, collisionLabel)).toBe("City Medical");
  });

  it("a unique label submits its own name; free text submits as typed (trimmed)", () => {
    expect(providerSubmitName(model, "Dr. Ada Lovelace")).toBe(
      "Dr. Ada Lovelace"
    );
    expect(providerSubmitName(model, "  Brand New Clinic  ")).toBe(
      "Brand New Clinic"
    );
  });
});
