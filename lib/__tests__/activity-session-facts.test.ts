import { describe, it, expect } from "vitest";
import {
  ACTIVITY_SESSION_FACT_NOUNS,
  activitySessionFactSummary,
} from "@/lib/activity-session-facts";

// #3334: the activity editor's session-level equipment picker states its conclusion as a
// fact chip. This tier owns the POLICY — which chip, in which state, marked how — and
// asserts the keys and states rather than the wording (see the module header).

describe("the session equipment fact (#3334)", () => {
  it("states the linked gear by name", () => {
    const { chips } = activitySessionFactSummary({
      gearName: "Road Bike",
      gearSuggested: false,
    });
    expect(chips).toEqual([
      {
        key: "equipment",
        label: "Road Bike",
        state: "stated",
        suggested: false,
      },
    ]);
  });

  it("marks the recency default as a suggestion, not as something stated", () => {
    // The whole difference between prefilling and asserting (#846). The chip carries
    // the marking; `pickDefaultActivityEquipment` computed the value FOR the person.
    const { chips } = activitySessionFactSummary({
      gearName: "Road Bike",
      gearSuggested: true,
    });
    expect(chips[0].suggested).toBe(true);
  });

  it("offers a PROMPT, not a dashed missing essential, when no gear is linked", () => {
    // A session with no gear is complete — nothing is waiting to be filled in. The
    // primitive's dashed `missing` state would say the opposite, and the form would be
    // claiming it needs something it saves happily without.
    const { chips } = activitySessionFactSummary({
      gearName: null,
      gearSuggested: true,
    });
    expect(chips).toEqual([
      {
        key: "equipment",
        label: ACTIVITY_SESSION_FACT_NOUNS.equipment,
        state: "add",
      },
    ]);
  });

  it("carries no suggestion marking on the prompt", () => {
    // A chip with no value cannot have borrowed one, so `data-suggested="0"` would be a
    // claim about a value that does not exist — the primitive's stated rule for a chip
    // with nothing to state. `gearSuggested` is true here on purpose: the caller passes
    // "they have not chosen" regardless, and the summary must still drop it.
    const { chips } = activitySessionFactSummary({
      gearName: null,
      gearSuggested: true,
    });
    expect(chips[0].suggested).toBeUndefined();
  });
});
