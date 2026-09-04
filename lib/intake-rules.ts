// The rule SENTENCES of the one intake form (#3216), and their round trip to the
// columns that already exist.
//
// THE CONSTRAINT THAT SHAPES THIS FILE. There is no rules table and there must not
// be one: every sentence below renders and writes a field that shipped years ago.
// Delete the rules UI and the data model is unchanged — that is the invariant, and
// this module is where it is enforced, because the form never touches those fields
// except through `fieldsFromRules`.
//
//   sentence                              writes
//   ────────────────────────────────────  ──────────────────────────────────────
//   Take only when [situation]            condition='situational' + situation (#560)
//   Pause while [situation]               pause_situation (#1296)
//   Take with food / on an empty stomach  the dose row's food_timing
//   Keep [N] h apart from [item]          an intake pair, relation 'separate'
//   Take together with [item]             an intake pair, relation 'with'
//
// TWO THINGS THE STORE CANNOT HOLD, and what is done about each:
//
//   • The N of "keep N h apart" has no column. It is written into the pair's own
//     free-text `note` in a canonical leading form ("2 h apart — …") and parsed back
//     out, so the sentence round-trips without a migration and a note the user wrote
//     by hand keeps working (it simply states no interval). #3216 forbids a schema
//     change; this is the honest way to honour that rather than inventing a column.
//
//   • "Take together with" carries no second column BY DECISION (#3216 item 4): the
//     `with` pair IS the alignment, and slot alignment is what that relation already
//     means downstream. Nothing is copied onto this item's dose row.
//
// SUGGESTED rules are an OFFER (#1505). `suggested` marks a rule the label data
// proposed; it renders as suggested and is deletable, and it is written only because
// the person left it in place and pressed Save.
//
// Pure: no React, no DB.

import type {
  FoodTiming,
  IntakeCondition,
  IntakePair,
  PairRelation,
} from "./types";

// One unsaved pair row. Declared here (not in a component) so this module stays free
// of React — the pairs repeater it used to mirror is gone, replaced by the two pair
// SENTENCES below.
export interface IntakePairDraft {
  otherId: number;
  relation: PairRelation;
  note: string;
}

export type IntakeRuleType =
  "only-when" | "pause-while" | "food" | "keep-apart" | "take-together";

interface RuleBase {
  // Stable within one form session so React keys and delete-by-identity work
  // without positional indexes.
  id: string;
  // From the label data rather than from the person (#1505): an offer, deletable,
  // and marked as such wherever it renders.
  suggested?: boolean;
}

export type IntakeRule = RuleBase &
  (
    | { type: "only-when"; situation: string }
    | { type: "pause-while"; situation: string }
    | { type: "food"; timing: FoodTiming }
    | {
        type: "keep-apart";
        otherId: number;
        hours: number | null;
        note: string;
      }
    | { type: "take-together"; otherId: number; note: string }
  );

export const INTAKE_RULE_TYPES: IntakeRuleType[] = [
  "only-when",
  "pause-while",
  "food",
  "keep-apart",
  "take-together",
];

// The builder menu's wording — the sentence the rule BECOMES, with its blank shown.
export const INTAKE_RULE_MENU_LABELS: Record<IntakeRuleType, string> = {
  "only-when": "Take only when…",
  "pause-while": "Pause while…",
  food: "Take with food / on an empty stomach",
  "keep-apart": "Keep apart from…",
  "take-together": "Take together with…",
};

// ---- The hours-in-the-note codec ----

const KEEP_APART_RE = /^\s*(\d+(?:\.\d+)?)\s*h\s+apart\b\s*(?:[—–-]\s*)?/i;

// "2 h apart — take the iron at lunch" from (2, "take the iron at lunch"). A null
// interval writes the free text alone, so a pair created before this feature keeps
// exactly the note it had.
export function keepApartNote(hours: number | null, note: string): string {
  const rest = note.trim();
  if (hours == null || !(hours > 0)) return rest;
  return rest ? `${hours} h apart — ${rest}` : `${hours} h apart`;
}

// The inverse. A note that does not lead with an interval parses as no interval and
// keeps its whole text — never a partial swallow.
export function parseKeepApartNote(note: string | null | undefined): {
  hours: number | null;
  note: string;
} {
  const raw = (note ?? "").trim();
  const m = raw.match(KEEP_APART_RE);
  if (!m) return { hours: null, note: raw };
  const hours = Number(m[1]);
  return {
    hours: Number.isFinite(hours) && hours > 0 ? hours : null,
    note: raw.slice(m[0].length).trim(),
  };
}

// ---- Sentences → fields ----

export interface RuleFields {
  // Only set when an only-when rule is present; otherwise the form's own condition
  // stands (a supplement's workout scheduling is not a rule).
  condition: IntakeCondition | null;
  situation: string;
  pauseSituation: string;
  // The dose rows' food timing, or null when no food rule is stated (the rows keep
  // whatever they carry).
  foodTiming: FoodTiming | null;
  pairs: IntakePairDraft[];
}

export function fieldsFromRules(rules: readonly IntakeRule[]): RuleFields {
  const out: RuleFields = {
    condition: null,
    situation: "",
    pauseSituation: "",
    foodTiming: null,
    pairs: [],
  };
  for (const rule of rules) {
    switch (rule.type) {
      case "only-when":
        if (rule.situation.trim()) {
          out.condition = "situational";
          out.situation = rule.situation.trim();
        }
        break;
      case "pause-while":
        if (rule.situation.trim()) out.pauseSituation = rule.situation.trim();
        break;
      case "food":
        out.foodTiming = rule.timing;
        break;
      case "keep-apart":
        if (rule.otherId > 0)
          out.pairs.push({
            otherId: rule.otherId,
            relation: "separate",
            note: keepApartNote(rule.hours, rule.note),
          });
        break;
      case "take-together":
        if (rule.otherId > 0)
          out.pairs.push({
            otherId: rule.otherId,
            relation: "with",
            note: rule.note.trim(),
          });
        break;
    }
  }
  return out;
}

// ---- Fields → sentences (edit mode reads the stored row back as rules) ----

let ruleSeq = 0;
export function nextRuleId(): string {
  ruleSeq += 1;
  return `rule-${ruleSeq}`;
}

export function rulesFromFields(input: {
  condition?: IntakeCondition | null;
  situation?: string | null;
  pauseSituation?: string | null;
  foodTiming?: FoodTiming | null;
  pairs?: readonly IntakePair[];
  selfId?: number | null;
}): IntakeRule[] {
  const rules: IntakeRule[] = [];
  if (input.condition === "situational" && input.situation?.trim())
    rules.push({
      id: nextRuleId(),
      type: "only-when",
      situation: input.situation.trim(),
    });
  if (input.pauseSituation?.trim())
    rules.push({
      id: nextRuleId(),
      type: "pause-while",
      situation: input.pauseSituation.trim(),
    });
  // "any" is the absence of a food rule, not a rule stating indifference — an absent
  // optional fact renders nothing (the copy doctrine's absence rule).
  if (input.foodTiming && input.foodTiming !== "any")
    rules.push({ id: nextRuleId(), type: "food", timing: input.foodTiming });
  for (const pair of input.pairs ?? []) {
    const otherId = pair.a_id === input.selfId ? pair.b_id : pair.a_id;
    if (pair.relation === "with") {
      rules.push({
        id: nextRuleId(),
        type: "take-together",
        otherId,
        note: (pair.note ?? "").trim(),
      });
    } else {
      const parsed = parseKeepApartNote(pair.note);
      rules.push({
        id: nextRuleId(),
        type: "keep-apart",
        otherId,
        hours: parsed.hours,
        note: parsed.note,
      });
    }
  }
  return rules;
}

// ---- Suggested rules ----

// The label data's offer for a picked medication: an OTC entry whose label says "take
// with food" seeds that one sentence, marked suggested and deletable. Never a silent
// write — the person deletes it or saves it (#1505).
export function suggestedRulesForFoodTiming(
  timing: FoodTiming | null | undefined
): IntakeRule[] {
  if (!timing || timing === "any") return [];
  return [{ id: nextRuleId(), type: "food", timing, suggested: true }];
}

// What a rules list SAYS about food, as one comparable string: the timings of its food
// sentences in list order, since `fieldsFromRules` above takes the last one. Two lists
// with the same statement say the same thing about food, so a difference between the
// list before a person's edit and the list after it is that person having added,
// changed or deleted a food rule (#4665).
//
// `foodTiming` is the one prefillable field with no control of its own — it is a rule
// sentence rather than an input — so this is how the form's prefill ledger learns the
// person has set it.
export function foodRuleStatement(rules: readonly IntakeRule[]): string {
  return rules.flatMap((r) => (r.type === "food" ? [r.timing] : [])).join(",");
}
