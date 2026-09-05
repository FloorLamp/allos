// Purpose links for an intake item (issue #2857) — the pure half. No DB, no network.
//
// An intake item's "why". Medications had the indication link (#1052); supplements had
// nothing, so the reason lived in `notes` as prose no engine can read. `intake_item_purposes`
// (migration 20260823-intake-item-purposes) makes it a first-class child row, and this
// module owns the pure jobs around it: the VOCABULARY, the WRITE BOUNDARY that reads the
// form's posted rows, DISPLAY, and the one SUGGEST-ONLY feeder.
//
// DECLARED ONLY, SUGGESTED AT MOST (#559/#1505/#798). A purpose is the person's own
// statement of intent. Nothing in this module writes; `suggestGoalPurposes` produces a
// CHIP the person taps, and their save is the write. That posture is why there is no
// inference from `notes` prose here, and no back-fill in the migration.
//
// DISPLAY OF A PURPOSE IS A FOLLOW-UP, and deliberately so — #2857 lists the item-row
// "For: eye health" line, stack-grouping and the retest context as separate issues. What
// ships here is the model, the declaration, and the suggestion.

import { tokenContains } from "./supplement-safety";

// ---- The goal vocabulary ----

// The curated goal keys. SMALL AND CLOSED on purpose: a goal is a shared axis the app
// can later group a stack by, which free text could never be. "Eye health" is a goal,
// not a diagnosed condition — a condition link alone cannot express it, which is the
// whole reason this kind exists beside the condition kind.
//
// Keys are stable ids (#203); the labels are display only and may be reworded without
// touching a stored row. Adding a key is additive; RENAMING one is a data migration,
// because rows hold the key.
export const GOAL_PURPOSES = [
  { key: "eyes", label: "Eye health" },
  { key: "sleep", label: "Sleep" },
  { key: "joints", label: "Joints" },
  { key: "heart", label: "Heart" },
  { key: "cognition", label: "Cognition" },
  { key: "immunity", label: "Immunity" },
  { key: "energy", label: "Energy" },
  { key: "mood", label: "Mood" },
  { key: "gut", label: "Gut" },
  { key: "skin-hair", label: "Skin & hair" },
  { key: "bone", label: "Bone" },
  { key: "performance", label: "Performance" },
  { key: "longevity", label: "Longevity" },
] as const;

export type GoalPurposeKey = (typeof GOAL_PURPOSES)[number]["key"];

const GOAL_BY_KEY = new Map<string, string>(
  GOAL_PURPOSES.map((g) => [g.key, g.label])
);

// Is this a goal key the app knows? The refusal gate for the write boundary: a key
// that is not in the vocabulary is dropped rather than stored, so a stale form post or
// a hand-crafted request cannot mint a goal nothing can render.
export function isGoalPurposeKey(key: string): key is GoalPurposeKey {
  return GOAL_BY_KEY.has(key);
}

// The display label for a goal key. An UNKNOWN key returns the key itself rather than
// nothing: a row written before a key was retired still renders as something a person
// can recognize and remove, which an empty string would not (the #1817 lookup-not-strip
// posture one domain over).
export function goalPurposeLabel(key: string): string {
  return GOAL_BY_KEY.get(key) ?? key;
}

// ---- The stored row ----

export type PurposeKind = "goal" | "condition" | "biomarker";

// The flag side that motivated a biomarker purpose, when the person stated one.
// DIRECTION-AGNOSTIC BY DESIGN: low 25-OH-D leading to vitamin D3 is one shape, high
// LDL/ApoB leading to psyllium (#2754's add-on-high route) is the other, and the link
// must not assume deficiency-repletion is the only story. Null is ordinary — the
// biomarker's identity is the reason; the direction is context.
export type PurposeDirection = "low" | "high";

// One purpose link of an intake item, as stored. Exactly one target is set, and it is
// the one `kind` names (a schema CHECK, not a convention).
export interface IntakeItemPurpose {
  id: number;
  item_id: number;
  kind: PurposeKind;
  goal_key: string | null;
  condition_id: number | null;
  biomarker_key: string | null;
  direction: PurposeDirection | null;
  sort: number;
}

// A purpose as the form posts it and a suggestion offers it. The stored row is DERIVED
// from this (normalizePurposeDrafts), never posted directly.
export type PurposeDraft =
  | { kind: "goal"; goalKey: string }
  | { kind: "condition"; conditionId: number }
  | {
      kind: "biomarker";
      biomarkerKey: string;
      direction?: PurposeDirection | null;
    };

// What the write path stores for one purpose row.
export interface PurposeWrite {
  kind: PurposeKind;
  goal_key: string | null;
  condition_id: number | null;
  biomarker_key: string | null;
  direction: PurposeDirection | null;
}

function isDirection(v: unknown): v is PurposeDirection {
  return v === "low" || v === "high";
}

// The identity a purpose is DEDUPED on — one row per (kind, target), so tapping the
// same chip twice, or a suggestion re-offering something already declared, cannot
// double it. The direction is NOT part of the identity: "low 25-OH-D" and "25-OH-D"
// are the same statement about the same analyte with more or less context, and storing
// both would render as the same purpose twice.
export function purposeIdentity(p: PurposeWrite): string {
  return `${p.kind}:${p.goal_key ?? ""}:${p.condition_id ?? ""}:${(
    p.biomarker_key ?? ""
  ).toLowerCase()}`;
}

// Normalize the posted purpose rows into what the write path stores.
//
// DROPPED, never guessed at: an unknown goal key, a condition id that is not a positive
// integer, a blank biomarker name, a duplicate of a row already in the set. Unlike the
// ingredient amount parse (lib/intake-ingredients), NOTHING here can stop a save — a
// purpose is an annotation, and refusing somebody's whole item edit over an unrenderable
// optional link would be the wrong trade. Every drop is a row the form itself could not
// have produced.
//
// The caller resolves condition ids against the PROFILE's own conditions before storing;
// this function cannot — it is pure, and a positive integer is all it can check.
export function normalizePurposeDrafts(
  drafts: readonly PurposeDraft[]
): PurposeWrite[] {
  const out: PurposeWrite[] = [];
  const seen = new Set<string>();
  for (const d of drafts) {
    let row: PurposeWrite | null = null;
    if (d.kind === "goal") {
      const key = (d.goalKey ?? "").trim();
      if (isGoalPurposeKey(key)) {
        row = {
          kind: "goal",
          goal_key: key,
          condition_id: null,
          biomarker_key: null,
          direction: null,
        };
      }
    } else if (d.kind === "condition") {
      if (Number.isInteger(d.conditionId) && d.conditionId > 0) {
        row = {
          kind: "condition",
          goal_key: null,
          condition_id: d.conditionId,
          biomarker_key: null,
          direction: null,
        };
      }
    } else if (d.kind === "biomarker") {
      const key = (d.biomarkerKey ?? "").trim();
      if (key) {
        row = {
          kind: "biomarker",
          goal_key: null,
          condition_id: null,
          biomarker_key: key,
          direction: isDirection(d.direction) ? d.direction : null,
        };
      }
    }
    if (!row) continue;
    const id = purposeIdentity(row);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

// ---- Display ----

// One purpose as a person reads it, given the names the caller has in hand. The
// condition NAME is not stored (#203 — the row holds the id), so the caller supplies
// the live one; an id whose condition has since gone returns null rather than a
// dangling "For: ".
export function purposeLabel(
  p: Pick<
    IntakeItemPurpose,
    "kind" | "goal_key" | "biomarker_key" | "direction"
  >,
  conditionName?: string | null
): string | null {
  if (p.kind === "goal") {
    return p.goal_key ? goalPurposeLabel(p.goal_key) : null;
  }
  if (p.kind === "condition") {
    return conditionName?.trim() ? conditionName.trim() : null;
  }
  if (!p.biomarker_key) return null;
  // Direction first, because that is how somebody says it out loud: "low vitamin D",
  // "high LDL". Plain words, no flag jargon.
  return p.direction ? `${p.direction} ${p.biomarker_key}` : p.biomarker_key;
}

// ---- The one suggest-only feeder ----

// Ingredient tokens that make the EYES goal worth offering. Curated and short: these
// three carotenoids are in a supplement for one reason, which is exactly what makes the
// suggestion honest. Nothing else in the vocabulary has a composition signature this
// unambiguous, so nothing else is inferred — a suggestion nobody would accept is worse
// than none, and a wrong one teaches people to dismiss the good ones.
const EYES_INGREDIENT_TOKENS = ["lutein", "zeaxanthin", "astaxanthin"] as const;

// Goal purposes worth OFFERING for an item, from its name and its label composition
// (#2856 — the composition half only became readable when that table shipped).
//
// SUGGEST-ONLY, and it will not re-offer something already declared. It returns goal
// KEYS; the form renders them as chips and the person's tap adds the draft. Nothing
// here writes, and nothing here is a claim about what the item does — it is a
// shortcut for a statement the person was going to make themselves.
export function suggestGoalPurposes(input: {
  name: string;
  ingredientNames?: readonly string[];
  declared?: readonly PurposeWrite[];
}): GoalPurposeKey[] {
  const haystacks = [input.name, ...(input.ingredientNames ?? [])].filter(
    (s): s is string => typeof s === "string" && s.trim().length > 0
  );
  const already = new Set(
    (input.declared ?? [])
      .filter((p) => p.kind === "goal" && p.goal_key)
      .map((p) => p.goal_key as string)
  );
  const out: GoalPurposeKey[] = [];
  const eyes = haystacks.some((h) =>
    EYES_INGREDIENT_TOKENS.some((t) => tokenContains(h, t))
  );
  if (eyes && !already.has("eyes")) out.push("eyes");
  return out;
}

// ---- Reading the projected rows ----

// Decode the `purposes_json` the item read projects (lib/queries/intake/schedule.ts).
// The ingredient half's parseItemIngredients verbatim, and for the same reasons: NULL
// is the overwhelmingly common case and costs nothing, and malformed JSON degrades to
// "no purposes" rather than throwing on a render.
export function parseItemPurposes(
  json: string | null | undefined
): IntakeItemPurpose[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as IntakeItemPurpose[]) : [];
  } catch {
    return [];
  }
}

// A stored row read back as the draft the form posts. The round trip the edit path
// needs: the form is seeded from what is stored, and posts the same shape back.
export function purposeToDraft(p: IntakeItemPurpose): PurposeDraft | null {
  if (p.kind === "goal" && p.goal_key) {
    return { kind: "goal", goalKey: p.goal_key };
  }
  if (p.kind === "condition" && p.condition_id != null) {
    return { kind: "condition", conditionId: p.condition_id };
  }
  if (p.kind === "biomarker" && p.biomarker_key) {
    return {
      kind: "biomarker",
      biomarkerKey: p.biomarker_key,
      direction: p.direction,
    };
  }
  return null;
}

// The declared purposes as ONE phrase for the intake form's fact chip (#4672).
//
// Pure over the drafts and the profile's condition names, because a purpose row stores
// the condition's ID (#203) and only the caller holds the live names. It lived inside
// the form as a memo, which meant the one place the phrase is built could not be
// exercised without rendering the form.
export function purposeDraftsSummary(
  purposes: readonly PurposeDraft[],
  conditions: readonly { id: number; name: string }[]
): string {
  return purposes
    .map((d) =>
      purposeLabel(
        {
          kind: d.kind,
          goal_key: d.kind === "goal" ? d.goalKey : null,
          biomarker_key: d.kind === "biomarker" ? d.biomarkerKey : null,
          direction: d.kind === "biomarker" ? (d.direction ?? null) : null,
        },
        d.kind === "condition"
          ? (conditions.find((c) => c.id === d.conditionId)?.name ?? null)
          : null
      )
    )
    .filter((l): l is string => !!l)
    .join(" · ");
}
