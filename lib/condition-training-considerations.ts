// Pure CONDITION → TRAINING-CONSIDERATION matching (issue #666). The clinical member of
// the training-context taxonomy: given a profile's ACTIVE conditions (name + optional
// ICD-10 code), it returns the curated training CONSIDERATION notes for those conditions —
// e.g. "osteoporosis → favor controlled progressive loading", "uncontrolled hypertension →
// avoid maximal Valsalva efforts". Modeled on lib/food-drug-interactions.ts (the per-item
// food-guidance matcher): a curated, cited dataset, name/synonym matching with a code
// fallback, INFORMATIONAL framing. No DB, no network — the facts live in the committed
// lib/datasets/data/condition-training-considerations.json (public ACOG/NIH/NHLBI/CDC
// sourcing) consumed via lib/datasets/condition-training-considerations.ts.
//
// THE #666 LINE: a condition produces a NOTE only — it NEVER gates the recommendation and
// NEVER re-ranks the user's targets (medical judgment stays with the clinician). The note
// rides ALONGSIDE the unchanged recommendation on the ONE shared model
// (lib/workout-recommendation.ts), so the dashboard widget, the Training overview, and the
// Telegram nudge all agree (#221). Calm, coaching-tier reach (#449): never a notification.
//
// Matching mirrors the food-drug name fallback: a normalized name/synonym match is
// authoritative (a word-boundary CONTIGUOUS token match so "hypertension" doesn't hit
// inside an unrelated word), with an ICD-10 code-PREFIX hint as a second path (a condition
// carrying `code = "M80.08"` matches the osteoporosis entry's `M80` prefix). A condition
// matches at most one entry; absence of a match means NOTHING (an unmapped condition
// carries no note — never a guess).

import {
  CONDITION_TRAINING_CONSIDERATIONS,
  type ConditionConsiderationEntry,
} from "./datasets/condition-training-considerations";

const ENTRIES: ConditionConsiderationEntry[] =
  CONDITION_TRAINING_CONSIDERATIONS;

// One matched condition→training consideration. `key` is the entry id (a stable React key
// + identity + suppression key). `conditionLabel` names the canonical condition the note
// is for; `note` is the calm consideration line; `source` is the citation.
export interface ConditionConsideration {
  key: string;
  conditionLabel: string;
  note: string;
  source: string;
}

// A live condition the matcher resolves: its display name and optional coded identity.
export interface ConditionInput {
  name: string;
  code?: string | null;
  codeSystem?: string | null;
}

// Normalize a name/synonym to the matcher's canonical token form: lowercased,
// punctuation collapsed to single spaces (mirrors food-drug-interactions.normalize).
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Whether the normalized synonym appears as a CONTIGUOUS token subsequence of the
// normalized condition name — a word-boundary match, so "hypertension" hits "Uncontrolled
// hypertension" but never inside an unrelated word.
function nameContains(nameNorm: string, synNorm: string): boolean {
  if (!synNorm) return false;
  return ` ${nameNorm} `.includes(` ${synNorm} `);
}

// Normalize an ICD-10-ish code to compare against an entry's prefixes: uppercased, spaces
// stripped (dots kept — prefixes are dotted, e.g. "M85.8").
function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/\s+/g, "");
}

// Whether the entry matches this ONE condition, by name/synonym (authoritative) or an
// ICD-10 code-prefix hint (fallback).
function entryMatches(
  e: ConditionConsiderationEntry,
  cond: ConditionInput
): boolean {
  const nameNorm = normalize(cond.name);
  if (e.synonyms.some((syn) => nameContains(nameNorm, normalize(syn))))
    return true;
  const code = cond.code ? normalizeCode(cond.code) : "";
  if (code && e.codePrefixes.some((p) => code.startsWith(normalizeCode(p))))
    return true;
  return false;
}

// The training considerations for a set of ACTIVE conditions. Each entry contributes at
// most one note even if several conditions map to it (de-duplicated by entry key), so two
// osteoporosis rows don't double the note. Deterministic order (entry/source order). An
// unmapped condition contributes nothing — never a guess.
export function matchConditionConsiderations(
  conditions: readonly ConditionInput[]
): ConditionConsideration[] {
  const byKey = new Map<string, ConditionConsideration>();
  for (const e of ENTRIES) {
    if (conditions.some((c) => entryMatches(e, c))) {
      byKey.set(e.key, {
        key: e.key,
        conditionLabel: e.conditionLabel,
        note: e.note,
        source: e.source,
      });
    }
  }
  return [...byKey.values()];
}

// The suppression/identity prefix for a condition consideration note (findings bus). A
// dismissal is keyed `condition-consideration:<entryKey>` — on the curated entry key, not
// the raw condition name (the identity-family discipline, #482), so the note is dismissed
// per consideration and a same-family second condition row can't resurrect it.
export const CONDITION_CONSIDERATION_PREFIX = "condition-consideration:";

export function conditionConsiderationSignalKey(entryKey: string): string {
  return `${CONDITION_CONSIDERATION_PREFIX}${entryKey}`;
}
