import { describe, it, expect } from "vitest";
import {
  isSurgicalTitle,
  surgeryBridgeSuggestion,
  surgeryBridgeDismissKey,
  situationForPhase,
  isBuiltInSurgerySituation,
  BUILTIN_PRESURGERY_SITUATION,
  BUILTIN_POSTOP_SITUATION,
  SURGERY_BRIDGE_PREFIX,
} from "@/lib/surgery-bridge";
import { dedupeKeyHasKnownPrefix } from "@/lib/rule-finding-prefixes";
import {
  resolveSuppressedKeyDisplay,
  SUPPRESSION_DISPLAY_PREFIXES,
} from "@/lib/suppression-display";

// Pure tests for the pre-surgery / post-op suggest-only bridge (#1299): the keyword
// matcher (positives, -ectomy/-otomy forms, negatives), the lead-time window math, and
// the per-procedure dedupeKey resolving against the display registry.

describe("isSurgicalTitle", () => {
  it("matches direct surgical keywords", () => {
    for (const t of [
      "Knee surgery",
      "Surgical procedure",
      "Pre-op appointment",
      "Procedure under anesthesia",
      "Arthroscopy — left shoulder",
      "Skin biopsy",
    ])
      expect(isSurgicalTitle(t), t).toBe(true);
  });

  it("matches the productive operative suffix forms", () => {
    for (const t of [
      "Appendectomy",
      "Tonsillectomy",
      "Craniotomy",
      "Colostomy",
      "Rhinoplasty",
      "Colonoscopy",
    ])
      expect(isSurgicalTitle(t), t).toBe(true);
  });

  it("rejects non-operative visits and negative keywords", () => {
    for (const t of [
      "Annual physical",
      "Dental cleaning",
      "Surgical consultation", // a talk, not the operation
      "Follow-up about possible surgery",
      "Eye exam",
      "",
      null,
    ])
      expect(isSurgicalTitle(t), String(t)).toBe(false);
  });
});

describe("surgeryBridgeSuggestion — lead window (#1299)", () => {
  const visit = {
    visitId: 7,
    title: "Arthroscopy",
    scheduledDate: "2026-08-12",
  };
  const inactive = { presurgery: false, postop: false };

  it("suggests PRE inside the lead window, not before", () => {
    // 8 days before (default lead 7) → too early, no suggestion.
    expect(surgeryBridgeSuggestion(visit, "2026-08-04", inactive)).toBeNull();
    // 7 days before → window opens.
    const s = surgeryBridgeSuggestion(visit, "2026-08-05", inactive);
    expect(s?.phase).toBe("pre");
    // Day-of still counts as pre (date >= today).
    expect(surgeryBridgeSuggestion(visit, "2026-08-12", inactive)?.phase).toBe(
      "pre"
    );
  });

  it("does not suggest PRE when Pre-surgery is already active", () => {
    expect(
      surgeryBridgeSuggestion(visit, "2026-08-10", {
        presurgery: true,
        postop: false,
      })
    ).toBeNull();
  });

  it("suggests POST once the date passes (clear Pre-surgery / activate Post-op)", () => {
    const s = surgeryBridgeSuggestion(visit, "2026-08-13", {
      presurgery: true,
      postop: false,
    });
    expect(s?.phase).toBe("post");
    expect(s?.presurgeryActive).toBe(true);
  });

  it("keeps offering to CLEAR Pre-surgery long after the date while it's still active", () => {
    // 60 days later, Pre-surgery never cleared → still suggest (safety: resume held meds).
    expect(
      surgeryBridgeSuggestion(visit, "2026-10-11", {
        presurgery: true,
        postop: false,
      })?.phase
    ).toBe("post");
  });

  it("stops nagging Post-op activation once the recovery window closes", () => {
    // Pre-surgery already cleared, Post-op not active, well past the window → null.
    expect(
      surgeryBridgeSuggestion(visit, "2026-10-11", {
        presurgery: false,
        postop: false,
      })
    ).toBeNull();
    // …but inside the window it still offers Post-op.
    expect(
      surgeryBridgeSuggestion(visit, "2026-08-15", {
        presurgery: false,
        postop: false,
      })?.phase
    ).toBe("post");
  });

  it("a non-surgical title never suggests", () => {
    expect(
      surgeryBridgeSuggestion(
        { visitId: 1, title: "Dental cleaning", scheduledDate: "2026-08-12" },
        "2026-08-10",
        inactive
      )
    ).toBeNull();
  });

  it("honors a custom lead", () => {
    // 14-day lead: 10 days out is inside.
    expect(
      surgeryBridgeSuggestion(visit, "2026-08-02", inactive, 14)?.phase
    ).toBe("pre");
  });
});

describe("phase → situation + built-in recognition", () => {
  it("pre activates Pre-surgery, post activates Post-op", () => {
    expect(situationForPhase("pre")).toBe(BUILTIN_PRESURGERY_SITUATION);
    expect(situationForPhase("post")).toBe(BUILTIN_POSTOP_SITUATION);
  });

  it("recognizes the built-ins case/whitespace-folded", () => {
    expect(isBuiltInSurgerySituation("pre-surgery")).toBe(true);
    expect(isBuiltInSurgerySituation(" Post-op ")).toBe(true);
    expect(isBuiltInSurgerySituation("Travel")).toBe(false);
  });
});

describe("dismissal key hygiene (#203 / #448)", () => {
  it("keys per-procedure + phase so distinct surgeries never collide", () => {
    expect(surgeryBridgeDismissKey("pre", 7)).toBe(
      `${SURGERY_BRIDGE_PREFIX}pre:7`
    );
    expect(surgeryBridgeDismissKey("post", 7)).not.toBe(
      surgeryBridgeDismissKey("pre", 7)
    );
    expect(surgeryBridgeDismissKey("pre", 7)).not.toBe(
      surgeryBridgeDismissKey("pre", 99)
    );
  });

  it("the key resolves against the suppression-display registry, not the rule-finding one", () => {
    const key = surgeryBridgeDismissKey("pre", 7);
    // It is a suggestion, not a rule-finding builder — so it is NOT a rule-finding prefix…
    expect(dedupeKeyHasKnownPrefix(key)).toBe(false);
    // …but the central Snoozed & dismissed view can still name it.
    expect(SUPPRESSION_DISPLAY_PREFIXES).toContain(SURGERY_BRIDGE_PREFIX);
    const disp = resolveSuppressedKeyDisplay(key);
    expect(disp?.domain).toBe("Suggestions");
    expect(disp?.label).toBe("Pre-surgery suggestion");
    expect(
      resolveSuppressedKeyDisplay(surgeryBridgeDismissKey("post", 7))?.label
    ).toBe("Post-op suggestion");
  });
});
