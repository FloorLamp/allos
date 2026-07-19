import { describe, it, expect } from "vitest";
import {
  normalizeSkinLesionStatus,
  normalizeBodyRegion,
  normalizeBodySide,
  normalizeSizeMm,
  toFlag,
  abcdeLetters,
  skinLesionDisplayLabel,
  bodyMapLabel,
  skinLesionIdentityKey,
  sameLesion,
  skinLesionStatusLabel,
  SKIN_LESION_STATUSES,
} from "@/lib/skin-lesion";
import type { SkinLesion } from "@/lib/types";

function les(p: Partial<SkinLesion>): SkinLesion {
  return {
    id: 1,
    label: "Left forearm mole",
    body_region: "forearm",
    body_side: "left",
    size_mm: 5,
    asymmetry: 0,
    border: 0,
    color: 0,
    diameter: 0,
    evolving: 0,
    status: "active",
    observed_date: "2026-03-01",
    finding: null,
    follow_up_interval_days: null,
    provider_id: null,
    notes: null,
    source: null,
    document_id: null,
    external_id: null,
    created_at: "2026-03-01",
    ...p,
  };
}

describe("skin-lesion normalizers (#715)", () => {
  it("coerces status onto the CHECK set, degrading unknowns to 'active'", () => {
    expect(normalizeSkinLesionStatus("Watch")).toBe("watch");
    expect(normalizeSkinLesionStatus("removed")).toBe("removed");
    expect(normalizeSkinLesionStatus("suspicious")).toBe("active"); // off-vocab → safe default
    expect(normalizeSkinLesionStatus(null)).toBe("active");
    expect(SKIN_LESION_STATUSES).toContain("watch");
    expect(skinLesionStatusLabel("watch")).toBe("Watch");
  });

  it("coerces region onto the coarse map (null for empty/unknown)", () => {
    expect(normalizeBodyRegion("Forearm")).toBe("forearm");
    expect(normalizeBodyRegion("  BACK ")).toBe("back");
    expect(normalizeBodyRegion("elbow-pit")).toBeNull(); // not in the coarse map
    expect(normalizeBodyRegion("")).toBeNull();
  });

  it("coerces side + size + flags", () => {
    expect(normalizeBodySide("LEFT")).toBe("left");
    expect(normalizeBodySide("center")).toBeNull();
    expect(normalizeSizeMm("6.25")).toBe(6.3);
    expect(normalizeSizeMm("-2")).toBeNull();
    expect(normalizeSizeMm("nope")).toBeNull();
    expect(toFlag("1")).toBe(1);
    expect(toFlag("on")).toBe(1);
    expect(toFlag(null)).toBe(0);
    expect(toFlag("0")).toBe(0);
  });

  it("abcdeLetters lists only the set observations, neutrally", () => {
    expect(abcdeLetters(les({ asymmetry: 1, evolving: 1 }))).toBe("A·E");
    expect(
      abcdeLetters(
        les({ asymmetry: 1, border: 1, color: 1, diameter: 1, evolving: 1 })
      )
    ).toBe("A·B·C·D·E");
    expect(abcdeLetters(les({}))).toBe("");
  });

  it("display + body-map labels fall back gracefully", () => {
    expect(skinLesionDisplayLabel(les({ label: "Scalp spot" }))).toBe(
      "Scalp spot"
    );
    expect(
      skinLesionDisplayLabel(
        les({ label: null, body_region: "back", body_side: null })
      )
    ).toBe("Back lesion");
    expect(
      skinLesionDisplayLabel(
        les({ label: null, body_region: null, body_side: null })
      )
    ).toBe("Skin lesion");
    expect(
      bodyMapLabel(les({ body_region: "forearm", body_side: "left" }))
    ).toBe("Left forearm");
  });
});

describe("skin-lesion identity (#482)", () => {
  it("same normalized (region, side, label) tuple ⇒ same lesion", () => {
    const a = les({ id: 1, label: " Left Forearm Mole " });
    const b = les({ id: 2, label: "left forearm mole" });
    expect(skinLesionIdentityKey(a)).toBe(skinLesionIdentityKey(b));
    expect(sameLesion(a, b)).toBe(true);
  });

  it("a different region OR side OR label ⇒ a DIFFERENT lesion (exclusion discipline)", () => {
    const base = les({ id: 1 });
    expect(sameLesion(base, les({ id: 2, body_side: "right" }))).toBe(false);
    expect(sameLesion(base, les({ id: 3, body_region: "arm" }))).toBe(false);
    expect(sameLesion(base, les({ id: 4, label: "second mole" }))).toBe(false);
  });
});
