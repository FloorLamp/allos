import { describe, it, expect } from "vitest";
import {
  normalizeDentalStatus,
  normalizeToothSystem,
  normalizeTooth,
  normalizeSurface,
  toothLabel,
  dentalDisplayLabel,
  isInvasiveDentalProcedure,
} from "@/lib/dental";

describe("dental status/system normalizers (#705)", () => {
  it("coerces status onto the enum with 'completed' default", () => {
    expect(normalizeDentalStatus("completed")).toBe("completed");
    expect(normalizeDentalStatus("Planned")).toBe("planned");
    expect(normalizeDentalStatus("treatment plan")).toBe("planned");
    expect(normalizeDentalStatus("watch")).toBe("watch");
    expect(normalizeDentalStatus("monitor")).toBe("watch");
    expect(normalizeDentalStatus("recheck in 6 months")).toBe("watch");
    expect(normalizeDentalStatus("")).toBe("completed");
    expect(normalizeDentalStatus(null)).toBe("completed");
    expect(normalizeDentalStatus("gibberish")).toBe("completed");
  });

  it("coerces tooth system onto the enum or null", () => {
    expect(normalizeToothSystem("Universal")).toBe("universal");
    expect(normalizeToothSystem("ada")).toBe("universal");
    expect(normalizeToothSystem("FDI")).toBe("fdi");
    expect(normalizeToothSystem("ISO")).toBe("fdi");
    expect(normalizeToothSystem("palmer")).toBe("palmer");
    expect(normalizeToothSystem("")).toBeNull();
    expect(normalizeToothSystem("nonsense")).toBeNull();
  });

  it("tidies tooth + surface", () => {
    expect(normalizeTooth("  14 ")).toBe("14");
    expect(normalizeTooth("")).toBeNull();
    expect(normalizeSurface("mod")).toBe("MOD");
    expect(normalizeSurface("buccal")).toBe("buccal"); // long word left as typed
    expect(normalizeSurface("")).toBeNull();
  });
});

describe("dental display labels (#705)", () => {
  it("toothLabel prefixes # and appends surface", () => {
    expect(toothLabel({ tooth: "14", surface: "MOD" })).toBe("#14 MOD");
    expect(toothLabel({ tooth: "#30", surface: null })).toBe("#30");
    expect(toothLabel({ tooth: null, surface: "MOD" })).toBe("");
  });

  it("dentalDisplayLabel joins name and tooth", () => {
    expect(
      dentalDisplayLabel({
        name: "Composite filling",
        tooth: "14",
        surface: "MOD",
      })
    ).toBe("Composite filling · #14 MOD");
    expect(
      dentalDisplayLabel({ name: "Prophylaxis", tooth: null, surface: null })
    ).toBe("Prophylaxis");
  });
});

describe("isInvasiveDentalProcedure — the #704 gate (#705)", () => {
  it("flags extraction / implant / surgical perio / apicoectomy by name", () => {
    expect(isInvasiveDentalProcedure("Extraction", null)).toBe(true);
    expect(isInvasiveDentalProcedure("Surgical extraction of #17", null)).toBe(
      true
    );
    expect(isInvasiveDentalProcedure("Implant placement", null)).toBe(true);
    expect(isInvasiveDentalProcedure("Osseous surgery", null)).toBe(true);
    expect(isInvasiveDentalProcedure("Gingivectomy", null)).toBe(true);
    expect(isInvasiveDentalProcedure("Apicoectomy", null)).toBe(true);
    expect(isInvasiveDentalProcedure("Bone graft", null)).toBe(true);
  });

  it("flags surgical CDT code categories", () => {
    expect(isInvasiveDentalProcedure("Removal of tooth", "D7140")).toBe(true); // oral surgery
    expect(isInvasiveDentalProcedure("Implant", "D6010")).toBe(true); // surgical implant
    expect(isInvasiveDentalProcedure("Flap", "D4260")).toBe(true); // osseous surgery
  });

  it("does NOT flag routine cleaning / exam / filling / crown (non-invasive)", () => {
    expect(isInvasiveDentalProcedure("Prophylaxis", "D1110")).toBe(false);
    expect(isInvasiveDentalProcedure("Adult cleaning", null)).toBe(false);
    expect(isInvasiveDentalProcedure("Periodic oral exam", "D0120")).toBe(
      false
    );
    expect(isInvasiveDentalProcedure("Bitewing radiograph", "D0274")).toBe(
      false
    );
    expect(isInvasiveDentalProcedure("Composite filling", "D2392")).toBe(false);
    expect(isInvasiveDentalProcedure("Crown", "D2740")).toBe(false);
    // Scaling & root planing is subgingival but not bony surgery → non-invasive here.
    expect(isInvasiveDentalProcedure("Scaling and root planing", "D4341")).toBe(
      false
    );
  });

  it("an unrecognized procedure is not flagged (under-fires, absence != clearance)", () => {
    expect(isInvasiveDentalProcedure("Something unusual", null)).toBe(false);
    expect(isInvasiveDentalProcedure(null, null)).toBe(false);
  });
});
