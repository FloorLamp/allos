import { describe, it, expect } from "vitest";
import { visibleSpecialtyPanes } from "@/app/(app)/records/nav";
import { isMentalHealthScreeningRelevant, isMinor } from "@/lib/life-stage";
import { specialtyRelevanceForView } from "@/lib/nav-relevance";

// The Records › Specialty section-visibility model (#1079 + #1174/#1175 + #2807).
// Vision and Dental gate on data presence; Substance use and Mental health gate on
// LIFE STAGE, each at the line its OWN instruments are validated to. The predicates are
// `!isMinor(age)` and `isMentalHealthScreeningRelevant(age)`, computed once in
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

// #2807 — the SECOND life-stage gate, and the point of it is that it is a DIFFERENT
// line, not a copy: PHQ-9/GAD-7 are validated from adolescence (PHQ-A is the
// adolescent form), so 13 keeps the pane that 13 loses next door.
describe("mental-health section gate (#2807) — adolescent and up", () => {
  it("hides for an infant and a child, keeps an adolescent, adult and unknown age", () => {
    expect(isMentalHealthScreeningRelevant(0)).toBe(false); // infant
    expect(isMentalHealthScreeningRelevant(1)).toBe(false); // the 22-month-old repro
    expect(isMentalHealthScreeningRelevant(12)).toBe(false); // still a child
    expect(isMentalHealthScreeningRelevant(13)).toBe(true); // adolescent floor
    expect(isMentalHealthScreeningRelevant(30)).toBe(true);
    expect(isMentalHealthScreeningRelevant(null)).toBe(true); // never hide on missing data
  });

  it("sits BELOW the substance-use line — an adolescent keeps one and loses the other", () => {
    expect(isMentalHealthScreeningRelevant(15)).toBe(true);
    expect(substanceUseVisible(15)).toBe(false);
  });
});

describe("visibleSpecialtyPanes — substance-use pane follows the gate", () => {
  const shown = {
    vision: true,
    dental: true,
    substanceUse: true,
    mentalHealth: true,
  };

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
    const minor = {
      vision: true,
      dental: true,
      substanceUse: false,
      mentalHealth: true,
    };
    const ids = visibleSpecialtyPanes(minor).map((p) => p.id);
    expect(ids).not.toContain("substance-use");
    // Mental health stays for an ADOLESCENT minor — its own gate sits lower (#2807).
    expect(ids).toContain("mental-health");
  });

  it("drops the mental-health pane on its own bit, and never empties the strip", () => {
    // The toddler (#2807): both life-stage panes gone, Vision/Dental absent for lack of
    // rows — Hearing and Skin are ungated, so the group tab and the bounce target below
    // still have a first pane to land on.
    const toddler = {
      vision: false,
      dental: false,
      substanceUse: false,
      mentalHealth: false,
    };
    const ids = visibleSpecialtyPanes(toddler).map((p) => p.id);
    expect(ids).not.toContain("mental-health");
    expect(ids).not.toContain("substance-use");
    expect(ids).toEqual(["hearing", "skin"]);
  });

  it("gates substance-use independently of Vision/Dental data gating", () => {
    const noOptical = {
      vision: false,
      dental: false,
      substanceUse: true,
      mentalHealth: true,
    };
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
  const adult = {
    vision: false,
    dental: false,
    substanceUse: true,
    mentalHealth: true,
  };

  it("reproduces the single-profile answer when the acting profile is the view", () => {
    const acting = {
      vision: true,
      dental: false,
      substanceUse: true,
      mentalHealth: true,
    };
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
      mentalHealth: true,
    });
  });

  it("does NOT fold the life-stage bits — they stay the ACTING profile's", () => {
    // A young profile acting, with an adult member in view. Neither section is
    // multi-view: each serves one data subject, and that subject is the actor, so an
    // adult in view must not unhide age-inappropriate instruments (#1174/#1279/#2807).
    const childActing = {
      vision: false,
      dental: false,
      substanceUse: false,
      mentalHealth: false,
    };
    const view = specialtyRelevanceForView({
      acting: childActing,
      inView: [
        { vision: false, dental: true },
        { vision: true, dental: false },
      ],
    });
    expect(view.substanceUse).toBe(false);
    expect(view.mentalHealth).toBe(false);
    const ids = visibleSpecialtyPanes(view).map((p) => p.id);
    expect(ids).not.toContain("substance-use");
    expect(ids).not.toContain("mental-health");
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
