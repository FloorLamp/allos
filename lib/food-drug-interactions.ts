// Pure FOOD–DRUG interaction matching (issue #154, extends #144). The single-item
// twin of the drug–drug checker (lib/drug-interactions.ts): given ONE intake item
// (its name + cached RxCUI), it returns the known food-relationship guidance for
// that item — e.g. "grapefruit × a statin", "vitamin-K foods × warfarin", "dairy/
// minerals × a tetracycline or levothyroxine", "alcohol × metronidazole". Unlike
// drug–drug detection this needs NO second medication to fire; it's a per-item
// guidance line. No DB, no network — the facts live in the committed, hand-
// maintained lib/food-drug-interactions.json (public-domain FDA/NIH sourcing).
//
// ONE computation, three formatters (AGENTS.md "one question, one computation"):
// the /medicine row line, the create/edit item-form notice, and the dose-reminder
// Telegram copy are all formatters over matchFoodInteractions() — they can never
// disagree about a food note.
//
// Matching mirrors drug-interactions.ts: RxCUI is authoritative (an exact match of
// ANY of the item's CUIs — the confirmed, possibly product-level rxcui plus its
// cached active-ingredient CUIs (issue #279) — against an entry's ingredient CUIs),
// a normalized name/synonym match is the fallback. INFORMATIONAL, never
// prescriptive — the framing is "discuss with your prescriber or pharmacist",
// never "stop taking X"; absence of an entry does NOT mean a food is safe with a
// drug.

import data from "./food-drug-interactions.json";
import { type Severity, SEVERITY_RANK, itemRxcuis } from "./drug-interactions";

export type { Severity };
export { SEVERITY_RANK, SEVERITY_LABEL } from "./drug-interactions";

interface RawFoodInteraction {
  key: string;
  drugLabel: string;
  rxcuis: string[];
  synonyms: string[];
  food: string;
  severity: Severity;
  advice: string;
  mechanism: string;
  source: string;
}

const ENTRIES = data.interactions as RawFoodInteraction[];

// One matched food–drug guidance for an item. `key` is the entry id (a stable React
// key + identity); an item can match several entries (e.g. warfarin → vitamin K AND
// alcohol), each a distinct guidance line.
export interface FoodInteractionHit {
  key: string;
  drugLabel: string;
  food: string;
  severity: Severity;
  advice: string;
  mechanism: string;
  source: string;
}

// Normalize a name/synonym to the matcher's canonical token form: lowercased,
// punctuation collapsed to single spaces. Mirrors drug-interactions.ts's normalize
// so the committed synonyms line up with a live item name identically across both
// datasets (kept local so the two datasets stay independent modules).
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Whether the normalized synonym appears as a CONTIGUOUS token subsequence of the
// normalized item name — a word-boundary match, so "cipro" hits "Cipro 500mg" but
// "statin" never hits inside an unrelated word.
function nameContains(itemNorm: string, synNorm: string): boolean {
  if (!synNorm) return false;
  return ` ${itemNorm} `.includes(` ${synNorm} `);
}

// The food–drug guidance hits for a single item. RxCUI is authoritative (exact
// match of ANY of the item's CUIs — product-level rxcui or cached ingredient —
// against an entry's ingredient CUIs); a normalized name/synonym match is the
// fallback — both collected so a row with only a name still matches. Severity-ranked
// (major first), then by food, then key, for a deterministic order. Each entry
// contributes at most one hit (an item can't match the same guidance twice).
export function matchFoodInteractions(item: {
  name: string;
  rxcui: string | null;
  rxcuiIngredients?: string[] | null;
}): FoodInteractionHit[] {
  const cuis = itemRxcuis(item);
  const itemNorm = normalize(item.name);
  const hits: FoodInteractionHit[] = [];
  for (const e of ENTRIES) {
    const byRxcui = e.rxcuis.some((cui) => cuis.has(cui));
    const byName =
      !byRxcui &&
      e.synonyms.some((syn) => nameContains(itemNorm, normalize(syn)));
    if (!byRxcui && !byName) continue;
    hits.push({
      key: e.key,
      drugLabel: e.drugLabel,
      food: e.food,
      severity: e.severity,
      advice: e.advice,
      mechanism: e.mechanism,
      source: e.source,
    });
  }
  return hits.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.food.localeCompare(b.food) ||
      a.key.localeCompare(b.key)
  );
}

// ---- Suppression key (issue #435) ----

// The findings-bus namespace for the per-item food–drug guidance lines. The
// /medicine dismiss action guards the whole domain with this single prefix check
// (mirroring the interaction / dietary-limit / adherence guards).
export const FOOD_TIMING_PREFIX = "food-timing:";

// The stable suppression/identity key for a food–drug guidance line:
// `food-timing:<itemId>:<ruleId>` (#435). Keyed on the AUTOINCREMENT item id (never
// recycles, #203) plus the food-rule entry key (FoodInteractionHit.key), so a
// dismissal follows the exact item×food guidance — a different item, or the same
// item's OTHER food rule, keeps its own key. The single source of truth: the
// /medicine row and any future push derive from it.
export function foodTimingSignalKey(itemId: number, ruleId: string): string {
  return `${FOOD_TIMING_PREFIX}${itemId}:${ruleId}`;
}

// ---- Formatting (shared by every surface) ----

// The actionable guidance line — the issue's "Avoid grapefruit juice — increases
// blood levels" shape. Used verbatim on the /medicine row, the item-form notice,
// and (prefixed with a warning glyph, see below) the dose reminder.
export function foodGuidanceLine(hit: FoodInteractionHit): string {
  return hit.advice;
}

// The fuller, never-prescriptive detail — mechanism + the informational framing +
// source. Shown under the guidance line on the create/edit item-form notice.
export function foodGuidanceDetail(hit: FoodInteractionHit): string {
  return (
    `${hit.mechanism} This is informational, not medical advice — discuss with ` +
    `your prescriber or pharmacist. Source: ${hit.source}.`
  );
}

// The compact one-liner for the dose-reminder tail: a warning glyph + the actionable
// advice of the MOST-SEVERE hit (already sorted first), or null when the item has no
// food guidance. Keeping it to the top hit keeps the reminder line readable.
export function foodGuidanceReminderNote(
  hits: FoodInteractionHit[]
): string | null {
  if (hits.length === 0) return null;
  return `⚠️ ${hits[0].advice}`;
}
