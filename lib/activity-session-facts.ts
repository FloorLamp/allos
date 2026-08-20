// The SESSION-level fact chips of the activity editor (#3334), stated in the shared
// facts-with-editors grammar (#3218/#3299).
//
// The first of #3228's session facts to move: the gear the whole non-strength activity
// used (#342). The editor already computes the right answer — a recency default narrowed
// by the activity (pickDefaultActivityEquipment over equipmentForActivity, #339/#345) —
// and then rendered the machinery that produced it: a label, a <select>, and a "Manage
// equipment" link standing open whether or not anyone disagreed with the conclusion. The
// chip states the conclusion; the picker is one tap behind it, unchanged.
//
// EQUIPMENT IS AN OPTIONAL FACT, NOT A MISSING ESSENTIAL, so a session with no gear
// linked gets the "+ equipment" PROMPT (FactAddChip) rather than a dashed missing chip.
// The primitive draws that distinction on purpose: a dashed missing chip says the form
// already knows it wants this and is waiting; a ride with no bike on file is complete.
//
// WHAT A TEST SHOULD ASSERT: the chip's key, state and suggestion marking — which fact
// the row states and whether the person stated it. Not this file's wording.
//
// Pure: no React, no DB. The row is a renderer over `activitySessionFactSummary`.

export type ActivitySessionFactKey = "equipment";

/**
 * `stated` — the row can say what this fact is.
 * `add` — an optional fact with nothing to state, offered as a "+ thing" prompt.
 *
 * There is deliberately no `missing` here. That state is the primitive's dashed
 * ESSENTIAL, and no session-level fact in this editor is one: the form auto-saves
 * without any of them.
 */
export type ActivitySessionFactState = "stated" | "add";

export interface ActivitySessionFactChip {
  key: ActivitySessionFactKey;
  /** The sentence this chip states, or the noun the prompt offers to add. */
  label: string;
  state: ActivitySessionFactState;
  /**
   * The value on screen was computed FOR the person — the recency default — and they
   * have not touched it (#846). An editable suggestion, not something they asserted,
   * and the chip has to say so. Absent on a prompt, which has no value to have
   * borrowed.
   */
  suggested?: boolean;
}

export interface ActivitySessionFactSummary {
  chips: ActivitySessionFactChip[];
}

export interface ActivitySessionFactInput {
  /** The name of the gear this session is linked to, or null when none is. */
  gearName: string | null;
  /**
   * True while the linked gear is the recency default the form picked and the person
   * has not chosen for themselves. Meaningless (and ignored) when `gearName` is null.
   */
  gearSuggested: boolean;
}

/** The noun each fact is called in its prompt and in its editor heading. */
export const ACTIVITY_SESSION_FACT_NOUNS: Record<
  ActivitySessionFactKey,
  string
> = {
  equipment: "equipment",
};

export function activitySessionFactSummary(
  f: ActivitySessionFactInput
): ActivitySessionFactSummary {
  const chips: ActivitySessionFactChip[] = [];

  chips.push(
    f.gearName == null
      ? {
          key: "equipment",
          label: ACTIVITY_SESSION_FACT_NOUNS.equipment,
          state: "add",
        }
      : {
          key: "equipment",
          label: f.gearName,
          state: "stated",
          suggested: f.gearSuggested,
        }
  );

  return { chips };
}
