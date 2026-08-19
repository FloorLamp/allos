// The summary row of the one intake form (#3216): the facts the form will save,
// stated as sentences, each one the door to its own editor.
//
// THE DECISION THIS IMPLEMENTS (owner, 2026-08-19). Front-loading every field is what
// made the OTC quick-add necessary in the first place, and a first consolidation
// attempt during prototyping reproduced the same wall — grouping alone does not fix
// it. So after a pick the form renders NO editors: it renders what it is about to
// write. Complexity is paid only per fact the person disagrees with.
//
// TWO RULES THIS FILE ENFORCES, both from the copy doctrine:
//   • A missing ESSENTIAL renders as a prompt ("add a dose") — the person can see
//     what the form still needs.
//   • An absent OPTIONAL renders nothing. It stays reachable through the single
//     trailing "more" affordance, which names the facts it holds, and never as an
//     empty chip claiming a fact that is not there.
//
// WHAT A TEST SHOULD ASSERT. The chip KEYS and their states — which facts the row
// states — not this file's wording. Copy changes; "an as-needed medication with a
// redose ceiling states its timing" does not.
//
// Pure: no React, no DB. The form is a renderer over `intakeFactSummary`.

import type { FoodTiming, IntakeItemKind, IntakeObligation } from "./types";
import {
  FOOD_TIMING_LABELS,
  TIME_BUCKET_LABELS,
  timeBucket,
} from "./intake-schedule";
import type { IntakeRule } from "./intake-rules";

export type IntakeFactKey =
  | "dose"
  | "timing"
  | "importance"
  | "prescription"
  | "indication"
  | "identity"
  | "supply"
  | "stopDate"
  | "composition"
  | "notes";

export type IntakeFactState = "stated" | "missing";

export interface IntakeFactChip {
  key: IntakeFactKey;
  // The sentence this chip states. Derived here so the chip row and the item's
  // review read one wording.
  label: string;
  state: IntakeFactState;
  // The datasets supplied this and the person has not touched it (#846). It is an
  // editable SUGGESTION, not a fact they stated, and the chip has to say so — that
  // marking is the whole difference between prefilling and asserting.
  suggested?: boolean;
}

export interface IntakeRuleChip {
  ruleId: string;
  label: string;
  suggested: boolean;
}

export interface IntakeFactSummary {
  // Stated facts and missing essentials, in reading order.
  chips: IntakeFactChip[];
  // One chip per rule sentence, plus the builder's own "+ rule" affordance.
  rules: IntakeRuleChip[];
  // Optional facts with nothing to state, named by the single trailing affordance.
  more: IntakeFactKey[];
}

// What the summary reads. A flat projection of the form's state — deliberately not
// the form's state object, so the chips can be computed in a test without React.
export interface IntakeFactInput {
  kind: IntakeItemKind;
  // Dose row one's amount, and the formulation label chosen for it.
  amount: string;
  formulationLabel: string;
  // Additional dose rows beyond the first, as "[amount] at [slot]".
  extraDoses: { amount: string; timeOfDay: string }[];
  firstDoseTimeOfDay: string;
  obligation: IntakeObligation;
  critical: boolean;
  minIntervalHours: string;
  maxDailyCount: string;
  maxDailyAmountMg: string;
  cadenceSentence: string | null;
  // Medication identity.
  rx: boolean;
  prescriber: string;
  indication: string;
  // Shared identity.
  brand: string;
  product: string;
  stack: string;
  supplyLabel: string | null;
  quantityOnHand: string;
  stopDate: string;
  ingredientCount: number;
  notes: string;
  rules: readonly IntakeRule[];
  // Names for the pair sentences, by item id.
  itemNames: ReadonlyMap<number, string>;
  // Facts still showing a label-derived suggestion the person has not touched (#846).
  suggestedFacts?: ReadonlySet<IntakeFactKey>;
}

export const INTAKE_FACT_NOUNS: Record<IntakeFactKey, string> = {
  dose: "dose",
  timing: "timing",
  importance: "importance",
  prescription: "prescription",
  indication: "condition",
  identity: "brand",
  supply: "supply",
  stopDate: "stop date",
  composition: "what's in it",
  notes: "notes",
};

const OBLIGATION_SENTENCE: Record<IntakeObligation, string> = {
  must: "must take",
  should: "should take",
  may: "as needed",
};

function slotLabel(timeOfDay: string): string {
  const trimmed = timeOfDay.trim();
  if (!trimmed) return "";
  const bucket = timeBucket(trimmed);
  return bucket === "Anytime" ? trimmed : TIME_BUCKET_LABELS[bucket];
}

function join(parts: (string | null | undefined)[]): string {
  return parts.filter((p) => p && p.trim()).join(" · ");
}

// The dose sentence: the formulation and the strength, plus any further rows phrased
// the way the editor phrases them.
function doseLabel(f: IntakeFactInput): string {
  const head = join([f.formulationLabel.trim(), f.amount.trim()]);
  const extras = f.extraDoses
    .filter((d) => d.amount.trim() || d.timeOfDay.trim())
    .map((d) =>
      d.timeOfDay.trim()
        ? `also ${d.amount.trim() || "a dose"} at ${slotLabel(d.timeOfDay)}`
        : `also ${d.amount.trim()}`
    );
  return join([head, ...extras]);
}

// The timing sentence — WHEN, never how important. An as-needed item's timing is its
// redose ceiling (the two numbers that decide the #798 notice) and nothing else: the
// words "as needed" belong to the importance chip, and stating them in both places
// would be the same datum rendered twice.
function timingLabel(f: IntakeFactInput): string {
  if (f.obligation === "may") {
    return join([
      f.minIntervalHours.trim()
        ? `≤ every ${f.minIntervalHours.trim()} h`
        : null,
      f.maxDailyCount.trim() ? `max ${f.maxDailyCount.trim()}/day` : null,
      f.maxDailyAmountMg.trim()
        ? `max ${f.maxDailyAmountMg.trim()} mg/day`
        : null,
    ]);
  }
  return join([f.cadenceSentence ?? "daily", slotLabel(f.firstDoseTimeOfDay)]);
}

export function intakeRuleLabel(
  rule: IntakeRule,
  itemNames: ReadonlyMap<number, string>
): string {
  switch (rule.type) {
    case "only-when":
      return `only when ${rule.situation.trim() || "…"}`;
    case "pause-while":
      return `paused while ${rule.situation.trim() || "…"}`;
    case "food":
      return FOOD_TIMING_LABELS[rule.timing].toLowerCase();
    case "keep-apart": {
      const other = itemNames.get(rule.otherId) ?? "another item";
      return rule.hours != null
        ? `keep ${rule.hours} h apart from ${other}`
        : `keep apart from ${other}`;
    }
    case "take-together":
      return `take together with ${itemNames.get(rule.otherId) ?? "another item"}`;
  }
}

export function intakeFactSummary(f: IntakeFactInput): IntakeFactSummary {
  const chips: IntakeFactChip[] = [];
  const more: IntakeFactKey[] = [];

  const suggested = f.suggestedFacts ?? new Set<IntakeFactKey>();
  const dose = doseLabel(f);
  chips.push(
    dose
      ? {
          key: "dose",
          label: dose,
          state: "stated",
          suggested: suggested.has("dose"),
        }
      : { key: "dose", label: "add a dose", state: "missing" }
  );

  // A scheduled item always has a schedule to state; an as-needed one with no
  // confirmed ceiling has nothing, and an empty chip claiming timing is worse than
  // the trailing affordance that says where the fact lives.
  const timing = timingLabel(f);
  if (f.obligation === "may")
    pushOptional(chips, more, "timing", timing, suggested.has("timing"));
  else
    chips.push({
      key: "timing",
      label: timing,
      state: "stated",
      suggested: suggested.has("timing"),
    });

  chips.push({
    key: "importance",
    label: join([
      OBLIGATION_SENTENCE[f.obligation],
      f.critical ? "critical" : null,
    ]),
    state: "stated",
    suggested: suggested.has("importance"),
  });

  // A medication always states which it is: "OTC" is a fact, not an absence — it is
  // the difference between a drug nobody prescribed and one nobody recorded.
  if (f.kind === "medication") {
    chips.push({
      key: "prescription",
      label: f.rx ? join(["prescription", f.prescriber.trim() || null]) : "OTC",
      state: "stated",
    });
    pushOptional(
      chips,
      more,
      "indication",
      f.indication.trim() && `for ${f.indication.trim()}`
    );
  }

  pushOptional(
    chips,
    more,
    "identity",
    join([f.brand.trim(), f.product.trim(), f.stack.trim()])
  );
  pushOptional(
    chips,
    more,
    "supply",
    f.supplyLabel?.trim() ||
      (f.quantityOnHand.trim() ? `${f.quantityOnHand.trim()} on hand` : "")
  );
  pushOptional(
    chips,
    more,
    "stopDate",
    f.stopDate.trim() && `stops ${f.stopDate.trim()}`
  );
  if (f.kind === "supplement")
    pushOptional(
      chips,
      more,
      "composition",
      f.ingredientCount > 0 &&
        `${f.ingredientCount} ingredient${f.ingredientCount === 1 ? "" : "s"}`
    );
  pushOptional(chips, more, "notes", f.notes.trim() && "notes");

  return {
    chips,
    rules: f.rules.map((rule) => ({
      ruleId: rule.id,
      label: intakeRuleLabel(rule, f.itemNames),
      suggested: rule.suggested === true,
    })),
    more,
  };
}

function pushOptional(
  chips: IntakeFactChip[],
  more: IntakeFactKey[],
  key: IntakeFactKey,
  label: string | false | 0 | null | undefined,
  suggested = false
): void {
  if (label) chips.push({ key, label, state: "stated", suggested });
  else more.push(key);
}

// The single trailing affordance's own sentence: the optional facts it holds, named.
export function moreFactsLabel(more: readonly IntakeFactKey[]): string {
  if (more.length === 0) return "";
  return `${more.map((k) => INTAKE_FACT_NOUNS[k]).join(", ")}…`;
}
