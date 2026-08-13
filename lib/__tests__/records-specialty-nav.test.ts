import { describe, it, expect } from "vitest";
import { visibleSpecialtyPanes } from "@/app/(app)/records/nav";
import { isMinor } from "@/lib/life-stage";
import { specialtyRelevanceForView } from "@/lib/nav-relevance";

// The Records › Specialty section-visibility model (#1079 + #1174/#1175). Vision
// and Dental gate on data presence; Substance use gates on LIFE STAGE — its
// AUDIT/DAST instruments are adult-validated, so the section (and its jump-link)
// hide for a KNOWN minor. The gate predicate is `!isMinor(age)`, computed once in
// getRecordsSpecialtyRelevance and consumed by visibleSpecialtyPanes here.

// The substance-use visibility predicate exactly as getRecordsSpecialtyRelevance
// computes it: adult OR unknown age → shown; hide only on a positive under-age
// match (isMinor's documented "never hide on missing data" policy).
const substanceUseVisible = (age: number | null) => !isMinor(age);

describe("substance-use section gate (#1174/#1175) — !isMinor", () => {
  it("hides for a known minor, shows for an adult, shows on unknown age", () => {
    expect(substanceUseVisible(10)).toBe(false); // known minor → gated
    expect(substanceUseVisible(17)).toBe(false); // still a minor at 17
    expect(substanceUseVisible(18)).toBe(true); // adult floor
    expect(substanceUseVisible(30)).toBe(true); // adult → shown
    expect(substanceUseVisible(null)).toBe(true); // unknown → shown (never hide on missing data)
  });
});

describe("visibleSpecialtyPanes — substance-use pane follows the gate", () => {
  const shown = { vision: true, dental: true, substanceUse: true };

  it("includes the substance-use pane (with its jump-link href) for an adult", () => {
    const ids = visibleSpecialtyPanes(shown).map((p) => p.id);
    expect(ids).toContain("substance-use");
    const pane = visibleSpecialtyPanes(shown).find(
      (p) => p.id === "substance-use"
    );
    expect(pane?.href).toBe("/records/specialty/substance-use");
    // Sits with/after Mental health (the sibling specialty section).
    expect(ids.indexOf("substance-use")).toBeGreaterThan(
      ids.indexOf("mental-health")
    );
  });

  it("drops BOTH the pane and its jump-link for a known minor (#1042 rule)", () => {
    const minor = { vision: true, dental: true, substanceUse: false };
    const ids = visibleSpecialtyPanes(minor).map((p) => p.id);
    expect(ids).not.toContain("substance-use");
    // Mental health stays — it is deliberately NOT life-stage gated (#1174).
    expect(ids).toContain("mental-health");
  });

  it("gates substance-use independently of Vision/Dental data gating", () => {
    const noOptical = { vision: false, dental: false, substanceUse: true };
    const ids = visibleSpecialtyPanes(noOptical).map((p) => p.id);
    expect(ids).not.toContain("vision");
    expect(ids).not.toContain("dental");
    expect(ids).toContain("substance-use"); // adult keeps it even with no optical/dental rows
    expect(ids).toContain("skin");
  });
});

// The multi-profile half (#2557). Dental and Vision now LIST every profile in view,
// which forced the issue's product question — "relevant to whom?" — to be answered
// rather than inherited from the acting profile. The answer is split by the KIND of
// question each bit asks, and this is where that split is pinned.
describe("specialtyRelevanceForView — the pane set for a VIEW (#2557)", () => {
  const adult = { vision: false, dental: false, substanceUse: true };

  it("reproduces the single-profile answer when the acting profile is the view", () => {
    const acting = { vision: true, dental: false, substanceUse: true };
    expect(
      specialtyRelevanceForView({ acting, inView: [acting] })
    ).toStrictEqual(acting);
  });

  it("shows Dental when ANY member in view has dental rows, not just the actor", () => {
    // The caregiver has no dental records of their own; the child in view does.
    const view = specialtyRelevanceForView({
      acting: adult,
      inView: [
        { vision: false, dental: false },
        { vision: false, dental: true },
      ],
    });
    expect(view.dental).toBe(true);
    expect(visibleSpecialtyPanes(view).map((p) => p.id)).toContain("dental");
  });

  it("shows Vision on the same rule, and hides both when NOBODY in view has rows", () => {
    expect(
      specialtyRelevanceForView({
        acting: adult,
        inView: [
          { vision: true, dental: false },
          { vision: false, dental: false },
        ],
      }).vision
    ).toBe(true);
    const none = specialtyRelevanceForView({
      acting: adult,
      inView: [
        { vision: false, dental: false },
        { vision: false, dental: false },
      ],
    });
    expect(none).toStrictEqual({
      vision: false,
      dental: false,
      substanceUse: true,
    });
  });

  it("does NOT fold substanceUse — the life-stage gate stays the ACTING profile's", () => {
    // A known minor acting, with an adult member in view. The substance-use section
    // is not multi-view: it serves one data subject, and that subject is the actor,
    // so an adult in view must not unhide adult-validated instruments (#1174/#1279).
    const minorActing = { vision: false, dental: false, substanceUse: false };
    const view = specialtyRelevanceForView({
      acting: minorActing,
      inView: [
        { vision: false, dental: true },
        { vision: true, dental: false },
      ],
    });
    expect(view.substanceUse).toBe(false);
    expect(visibleSpecialtyPanes(view).map((p) => p.id)).not.toContain(
      "substance-use"
    );
    // …while the two DATA bits did fold, so the panes the view has rows for show.
    expect(view.dental).toBe(true);
    expect(view.vision).toBe(true);
  });

  it("hides both data panes for an empty view set", () => {
    const empty = specialtyRelevanceForView({ acting: adult, inView: [] });
    expect(empty.vision).toBe(false);
    expect(empty.dental).toBe(false);
  });
});
