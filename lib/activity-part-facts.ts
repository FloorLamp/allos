// The PART-level fact chips of the activity editor (#3349), stated in the shared
// facts-with-editors grammar (#3218/#3299). The per-part twin of
// `lib/activity-session-facts.ts`: that one answers "what does this SESSION record",
// this one answers "what does this EXERCISE record", once per part.
//
// #3228's headline complaint was density, and it is a per-part complaint: a five-lift
// session drew the equipment row's six-plus controls AND the options row's four on
// every one of them. The equipment half moved first (#4034); this is the options half —
// `Track sides separately`, `Target reps`, `To failure` and the RPE opt-in — under the
// same grammar, so a part states its conclusions in one line and the machinery that
// produced them is one tap behind.
//
// THREE OF THE FOUR FACTS ARE ABSENT MOST OF THE TIME, which is what makes the trailing
// affordance the right shape here and the wrong shape on the session row. A bilateral
// bench press with no declared target and no effort column has nothing to say about
// sides, target or effort — and three standing "+ thing" prompts would have replaced
// four controls with four controls. `absent` collects them behind ONE affordance that
// NAMES them, which is the primitive's own rule for an optional fact with nothing to
// state.
//
// EQUIPMENT GOES BEHIND THE AFFORDANCE TOO when it has nothing to state, and that is
// `activity-session-facts`'s own prediction arriving: "the day a second and third
// session fact land behind it, that prompt becomes the trailing affordance's
// contents". #4034 shipped it as a standing `+ equipment` prompt, which was right
// while it was the only optional fact in the row. It is not any more, and two shapes
// of empty in one row — one standing prompt beside one affordance holding three facts
// — makes a reader learn which kind of absence gets which treatment. One shape, one
// affordance, and it NAMES what it holds either way.
//
// ITS MISSING STATE IS THE EXCEPTION AND STAYS IN THE ROW. A bare variant base cannot
// be saved until an implement is picked, and a dashed essential the form is waiting for
// is not an optional fact tucked away behind "more" — that is the primitive's
// distinction, not this row's.
//
// Pure: no React, no DB. The row is a renderer over `partFactSummary`.

import { isTimed, isUnilateral } from "./lifts";
import { needsEquipment } from "./activity-form-validate";
import { partIntent, type PartEntry } from "./activity-form-model";

export type PartFactKey = "equipment" | "sides" | "intent" | "effort";

/**
 * `stated` — the row can say what this fact is.
 * `missing` — a fact the form already knows it wants and is waiting for (the
 *   primitive's dashed ESSENTIAL). Only equipment reaches it: a bare variant base
 *   ("Curl") cannot be saved until an implement is picked.
 *
 * There is deliberately no `add` here. An optional fact with nothing to state does not
 * get a chip at all — it goes in `absent`, behind the one trailing affordance.
 */
export type PartFactState = "stated" | "missing";

export interface PartFactChip {
  key: PartFactKey;
  /** The sentence this chip states, or the noun it is still waiting for. */
  label: string;
  state: PartFactState;
}

export interface PartFactSummary {
  /** The facts this part can state, in reading order. */
  chips: PartFactChip[];
  /** Offered facts with nothing to state — what the trailing affordance holds. */
  absent: PartFactKey[];
}

/** The noun each fact is called in the trailing affordance and in its editor. */
export const PART_FACT_NOUNS: Record<PartFactKey, string> = {
  equipment: "equipment",
  sides: "sides",
  intent: "a target",
  effort: "effort",
};

/**
 * WHICH OPTIONS THIS PART OFFERS AT ALL — the reachability question, and the reason it
 * is a named export with its own table rather than three conditions inlined in a
 * renderer.
 *
 * `effort` is `!timed` and nothing else, which is #3367's clause and the one an
 * expression like `sides || intent || effort` would silently lose. For almost every
 * rep-based part it changes nothing, because such a part is normally either unilateral
 * (so `sides`) or bilateral (so `intent`, which is `!timed && !perSide`). The gap it
 * closes is the part whose NAME is not unilateral but whose LOADED SETS carried
 * right-side values, so `groupEditSets` marked it `perSide`: `sides` is name-based and
 * false, `intent` is perSide-based and false, and the effort opt-in would have nowhere
 * to appear. Asking each fact its own question is what makes that case survive a
 * conversion — see the table in `lib/__tests__/activity-part-facts.test.ts`.
 */
export function partOptionsOffered(p: PartEntry): {
  sides: boolean;
  intent: boolean;
  effort: boolean;
} {
  return {
    // A sides choice only where the lift is trained one side at a time.
    sides: isUnilateral(p.name),
    intent: partIntent(p).applies,
    // Rep-based sets only — a timed hold's effort IS its duration, so there is
    // nothing for a rating to add.
    effort: !isTimed(p.name),
  };
}

export interface PartFactInput {
  part: PartEntry;
  /** The name of the implement this part is using, or null when none is. */
  gearName: string | null;
  /** Is the profile's effort column on? PROFILE-wide, unlike the other three. */
  effortOn: boolean;
}

export function partFactSummary(f: PartFactInput): PartFactSummary {
  const { part: p } = f;
  const offered = partOptionsOffered(p);
  const intent = partIntent(p);
  const chips: PartFactChip[] = [];
  const absent: PartFactKey[] = [];

  // Equipment leads the row in all three of its readings, `absent` included — the
  // affordance names what it holds in row order, so the noun order follows from here.
  if (f.gearName != null)
    chips.push({ key: "equipment", label: f.gearName, state: "stated" });
  else if (needsEquipment(p.name))
    chips.push({ key: "equipment", label: "pick equipment", state: "missing" });
  else absent.push("equipment");

  if (offered.sides) {
    if (p.perSide)
      chips.push({
        key: "sides",
        label: "sides tracked separately",
        state: "stated",
      });
    else absent.push("sides");
  }

  if (offered.intent) {
    // AMRAP first: "to failure" and a rep target are the same fact answered two ways,
    // and `partIntent` already refuses to report a target while `toFailure` is set.
    if (intent.toFailure)
      chips.push({ key: "intent", label: "to failure", state: "stated" });
    else if (intent.target != null)
      chips.push({
        key: "intent",
        label: `target ${intent.target} ${intent.target === 1 ? "rep" : "reps"}`,
        state: "stated",
      });
    else absent.push("intent");
  }

  if (offered.effort) {
    if (f.effortOn)
      chips.push({ key: "effort", label: "rating effort", state: "stated" });
    else absent.push("effort");
  }

  return { chips, absent };
}

/**
 * What the trailing affordance says. Names the facts it holds, in row order, so
 * "more" never means "somewhere in here". Null when nothing is absent — the
 * affordance does not render at all then.
 */
export function moreFactsLabel(absent: readonly PartFactKey[]): string | null {
  if (absent.length === 0) return null;
  const nouns = absent.map((k) => PART_FACT_NOUNS[k]);
  if (nouns.length === 1) return `Add ${nouns[0]}`;
  const last = nouns[nouns.length - 1];
  return `Add ${nouns.slice(0, -1).join(", ")} or ${last}`;
}
