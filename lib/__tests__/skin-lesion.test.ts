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

  it("folds loose import phrasings onto the coarse map (#1038)", () => {
    // The issue's alias matrix — synonym terms.
    expect(normalizeBodyRegion("belly")).toBe("abdomen");
    expect(normalizeBodyRegion("Tummy")).toBe("abdomen");
    expect(normalizeBodyRegion("stomach")).toBe("abdomen");
    expect(normalizeBodyRegion("sole")).toBe("foot");
    expect(normalizeBodyRegion("heel")).toBe("foot");
    expect(normalizeBodyRegion("calf")).toBe("leg");
    expect(normalizeBodyRegion("shin")).toBe("leg");
    expect(normalizeBodyRegion("temple")).toBe("face");
    expect(normalizeBodyRegion("forehead")).toBe("face");
    expect(normalizeBodyRegion("palm")).toBe("hand");
    expect(normalizeBodyRegion("bicep")).toBe("arm");
    expect(normalizeBodyRegion("belly button")).toBe("abdomen");
    expect(normalizeBodyRegion("shoulder blade")).toBe("back");
  });

  it("strips laterality/position qualifiers and re-matches the core (#1038)", () => {
    expect(normalizeBodyRegion("left upper arm")).toBe("arm");
    expect(normalizeBodyRegion("R forearm")).toBe("forearm");
    expect(normalizeBodyRegion("upper back")).toBe("back");
    expect(normalizeBodyRegion("lower back")).toBe("back");
    expect(normalizeBodyRegion("Left lower leg")).toBe("leg");
    expect(normalizeBodyRegion("right upper outer thigh")).toBe("thigh");
    // Qualifier stripping composes with the synonym table.
    expect(normalizeBodyRegion("left calf")).toBe("leg");
  });

  it("stays conservative: an unmatched token degrades to null, never a guess (#1038)", () => {
    expect(normalizeBodyRegion("widget")).toBeNull();
    // Ambiguous / boundary terms are deliberately NOT folded.
    expect(normalizeBodyRegion("wrist")).toBeNull();
    expect(normalizeBodyRegion("groin")).toBeNull();
    expect(normalizeBodyRegion("torso")).toBeNull();
    expect(normalizeBodyRegion("left widget")).toBeNull(); // stripped core still unknown
    // A multi-word core that isn't a listed phrase stays null.
    expect(normalizeBodyRegion("hand ring finger")).toBeNull();
    // The manual form's canonical tokens still pass through unchanged.
    for (const r of ["scalp", "face", "arm", "leg", "foot", "other"]) {
      expect(normalizeBodyRegion(r)).toBe(r);
    }
  });

  it("normalizeBodySide reads abbreviations and a leading laterality word (#1038)", () => {
    expect(normalizeBodySide("L")).toBe("left");
    expect(normalizeBodySide("rt")).toBe("right");
    expect(normalizeBodySide("left upper arm")).toBe("left");
    expect(normalizeBodySide("R forearm")).toBe("right");
    // Non-laterality leading words stay null — no guessing.
    expect(normalizeBodySide("upper arm")).toBeNull();
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

  it("groups two loose-phrased observations of ONE mole together (#1038)", () => {
    // The split-track case the fold heals: the same mole imported once with the
    // canonical region and later with a derm report's loose phrasing. Both key
    // through normalizeBodyRegion/normalizeBodySide, so the identity matches.
    const a = les({
      id: 1,
      label: "mole near elbow",
      body_region: "arm",
      body_side: "left",
    });
    const b = les({
      id: 2,
      label: "Mole near elbow",
      body_region: "left upper arm",
      body_side: "L",
    });
    expect(skinLesionIdentityKey(a)).toBe(skinLesionIdentityKey(b));
    expect(sameLesion(a, b)).toBe(true);
  });
});
