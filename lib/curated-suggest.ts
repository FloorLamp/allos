// THE curated-suggestion engine (issue #5173): ONE loop and ONE screen behind both the
// biomarker→food engine (lib/food-suggest.ts, #577) and the biomarker→supplement engine
// (lib/supplement-suggest-curated.ts, #2378).
//
// The two were the same engine written twice — the same flag sort, the same declared-
// direction pick, the same lower-cased trigger match, the same withhold-or-annotate
// screen — differing only in what their maps carry and how their copy reads. That
// difference is now DECLARED (see CuratedDeclaration) rather than forked: a declaration
// that omits a field gets the engine's null behaviour, which is what the other twin has
// today. A third curated map (a practice, a habit) is a loader and a declaration, not a
// third loop.
//
// PURE — no DB, no network, no clock, no model. The same input always yields the same
// output. The DB gathers live in lib/queries/nutrition/adequacy.ts, which keeps its own
// safety context per seam: the supplement seam widens allergens to the resolved ones
// (getIngestibleSafetyContext, #691) because an ingestible proposal stays conservative,
// and the food seam does not. That is a property of the CALLER's context, not of this
// engine, and it stays there.
//
// WHAT IS NOT SHARED, and why that is right: the screens themselves. Food screens each
// source with allergenConflict and carries a soft dietary-preference layer; supplements
// run the full deterministic belt (screenSuggestionSafety) and a stack gate. Both answer
// the SAME question — "is this candidate still offerable, and what does the reader need
// told" — so the engine asks it once, through `screenItem`, and each declaration answers
// in its own terms.

import { conditionOrSituationMatches } from "./condition-nutrient";
import { tokenContains } from "./supplement-safety";
import type { ConditionInput } from "./condition-codes";
import type { Contraindication } from "@/scripts/gen-nutrient-food-map";

// A flag string is "low-side" when the current reading is below its reference or
// optimal range — the classic direction a suggestion addresses by ADDING something
// (#577; the #2754 add-on-high entry is the declared exception, see `direction`).
export function isLowFlag(flag: string | null | undefined): boolean {
  const f = (flag ?? "").trim().toLowerCase();
  return f === "low" || f === "non-optimal-low";
}

// A flag string is "high-side" when the current reading is above its reference or
// optimal range, or qualitatively abnormal (a toxin/heavy-metal panel reports "high"
// or "abnormal"). The mirror of isLowFlag.
export function isHighFlag(flag: string | null | undefined): boolean {
  const f = (flag ?? "").trim().toLowerCase();
  return f === "high" || f === "non-optimal-high" || f === "abnormal";
}

// One currently-flagged reading the engine considers — name + its flag. Shaped to
// accept a CurrentFlaggedReading (lib/queries/medical) directly.
export interface FlaggedReading {
  name: string;
  flag: string | null;
}

// THE SECOND DOOR (issue #2383). A curated entry named DIRECTLY by a caller that already
// resolved its own shortfall, rather than found by matching a flagged biomarker against
// the entry's `biomarkers` list.
//
// A TRIGGER IS A CLAIM THE CALLER ALREADY OWNS. This type carries no threshold and no
// verdict: the caller has decided the entry applies and states the key plus the reason it
// will be shown as. The engine never re-derives that — it screens the candidates and
// hands them back. Direction is DECLARED, not assumed: `add` looks the key up in
// `entries`, `reduce` in `reduceEntries`.
export interface TargetTrigger {
  // The curated entry key in the table this trigger's `direction` names. A key with no
  // entry is simply not followed (never a guess, never a default).
  key: string;
  direction: "add" | "reduce";
  // What the suggestion should cite as its reason, in the caller's own words — the
  // `triggeredBy` a flagged reading would have supplied its biomarker name for.
  reason: string;
}

// The shape both curated maps already have, with the candidate list named ONCE as
// `items` (the loaders spell it `foods` / `supplements`; the JSON never changes).
export interface CuratedEntry<I> {
  key: string;
  // Canonical biomarker names whose CURRENT reading, flagged in `direction`, triggers
  // this entry. Matched case-insensitively.
  biomarkers: string[];
  // Which flag side triggers it — DECLARED per entry, never assumed from the table.
  direction: "low" | "high";
  // The curated candidates, best-supported first.
  items: readonly I[];
  // What to surface INSTEAD when every candidate is struck. Itself screened before it
  // renders. Null when there is no honest swap.
  allergyAlternative: I | null;
  // Condition/situation tags: "drop" withholds the whole suggestion, "caution"
  // annotates it.
  contraindications: Contraindication[];
}

// A high-side reduce entry (#775) — selected by the same trigger match, then built
// whole by the declaration. It runs no screen: a "limit" list has nothing to withhold.
export interface CuratedReduceEntry {
  key: string;
  biomarkers: string[];
}

// Why a candidate was struck. `field` drives the alternative-fallback copy; `label` is
// the human name of what struck it, where the declaration's screen knows one.
export interface CuratedStrike {
  field: "allergen" | "interaction" | "condition";
  label: string | null;
}

// A candidate that survived to render, and whether it is standing in for struck ones.
export interface CuratedRendered<I> {
  item: I;
  isAlternative: boolean;
}

// The flag sort, for a declaration that qualifies a suggestion off a SECOND reading —
// food's biomarker-driven excess caution (#775) reads the high map for mercury.
// Lower-cased name → the reading's original spelling.
export interface CuratedFlags {
  low: ReadonlyMap<string, string>;
  high: ReadonlyMap<string, string>;
}

// Everything that differs between the two curated engines, declared. Every optional
// field's absence is the OTHER twin's behaviour today, not a new default.
export interface CuratedDeclaration<
  E extends CuratedEntry<I>,
  I,
  S,
  N,
  R extends CuratedReduceEntry = never,
> {
  // The curated table, in the order suggestions surface.
  entries: readonly E[];
  // The second door (#2383). Omitted = the flagged-biomarker route only.
  extraTriggers?: readonly TargetTrigger[];
  // The high-side REDUCE table (#775), appended after the add suggestions in table
  // order. Omitted = this declaration has no reduce direction.
  reduceEntries?: readonly R[];
  // Builds a reduce suggestion whole. Required when `reduceEntries` is set.
  buildReduce?: (entry: R, triggeredBy: string[]) => S;
  // Active conditions (bare names or coded refs, so the screen is code-first, #1030)
  // and active situations, for the map-declared contraindication tags.
  conditions: ConditionInput[];
  situations: string[];
  // Names of intake items the profile already takes (#2378). A covered family already
  // being supplied yields NO suggestion. Omitted = the gate is off.
  alreadyTaking?: readonly string[];
  // The tokens that identify a candidate in an intake item's name, for that gate.
  matchTokens?: (item: I) => readonly string[];
  // The declaration's own screen over ONE candidate: the strike, or null to keep it.
  screenItem: (item: I) => CuratedStrike | null;
  // The copy for a struck candidate list — `allStruck` distinguishes "the alternative is
  // showing instead" from "some sources were left out". Null pushes no note.
  struckNote: (
    strikes: readonly CuratedStrike[],
    allStruck: boolean
  ) => N | null;
  // The food–drug interaction entry keys a candidate participates in — the INVERSE
  // index (#577), shared by both maps.
  drugKeys: (item: I) => readonly string[] | undefined;
  // Which candidates those keys are read off: the entry's whole list, or only what is
  // actually rendering. The two twins differ here and always have.
  drugNoteScope: "entry" | "rendered";
  // That key's advice for the profile's stack, or null when the stack doesn't match.
  // A thunk so a declaration can build its index lazily — nothing flagged, no work.
  drugAdvice: (key: string) => string | null;
  // The declaration's note constructor for the two kinds the engine raises itself. The
  // allergy and exclusion notes are declared WHOLE, because their copy is the thing
  // that differs.
  note: (kind: "condition" | "medication", text: string) => N;
  // Entry-level cautions the declaration raises from the flag context — food's
  // biomarker-driven excess caution (#775). After the medication notes, before the
  // soft exclusion layer: where the copy has always sat.
  extraNotes?: (entry: E, flags: CuratedFlags) => readonly N[];
  // The SOFT layer (#975 — dietary preferences): FILTER + SUBSTITUTE, never withhold. A
  // shortfall must never disappear because its top source was excluded, so when nothing
  // compatible remains the candidates stay. Omitted = the layer is off.
  exclude?: {
    isExcluded: (item: I) => boolean;
    // "some sources were left out"; "the usual sources don't fit — here's an alternative".
    filteredNote: N;
    alternativeNote: N;
  };
  // Assemble the declaration's own suggestion type from what survived.
  finish: (
    entry: E,
    triggeredBy: string[],
    rendered: readonly CuratedRendered<I>[],
    notes: N[]
  ) => S;
}

// The reasons each directly-named entry was triggered with, keyed `direction:key` so the
// two curated tables can share one index without a key in one shadowing a key in the
// other. Order within a key follows the caller's declared order.
function indexTargets(
  targets: readonly TargetTrigger[] | undefined
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of targets ?? []) {
    const key = t.key.trim();
    const reason = t.reason.trim();
    if (!key || !reason) continue;
    const id = `${t.direction}:${key}`;
    out.set(id, [...(out.get(id) ?? []), reason]);
  }
  return out;
}

// The names (and caller-declared reasons) that triggered one entry, in table order:
// every biomarker of the entry flagged on the side it declares, then every direct
// target naming it through this door.
function matchTriggers(
  entry: { key: string; biomarkers: string[] },
  flaggedOnSide: ReadonlyMap<string, string>,
  targeted: ReadonlyMap<string, string[]>,
  door: "add" | "reduce"
): string[] {
  const triggeredBy: string[] = [];
  for (const bm of entry.biomarkers) {
    const original = flaggedOnSide.get(bm.trim().toLowerCase());
    if (original) triggeredBy.push(original);
  }
  triggeredBy.push(...(targeted.get(`${door}:${entry.key}`) ?? []));
  return triggeredBy;
}

// THE build: one triggered entry → one screened suggestion, or null when it is withheld
// entirely (already supplied, a drop-severity tag, or every candidate struck with no
// viable alternative). Absence is never an all-clear — the engine never claims safety.
function buildSuggestion<
  E extends CuratedEntry<I>,
  I,
  S,
  N,
  R extends CuratedReduceEntry,
>(
  entry: E,
  triggeredBy: string[],
  decl: CuratedDeclaration<E, I, S, N, R>,
  taking: readonly string[],
  flags: CuratedFlags
): S | null {
  // 1. Already supplied. Checked FIRST and over the map's own match tokens (the
  //    candidates AND the alternative), so a profile already taking algal oil is not
  //    told to start fish oil either.
  const { matchTokens } = decl;
  if (taking.length > 0 && matchTokens) {
    const candidates = [
      ...entry.items,
      ...(entry.allergyAlternative ? [entry.allergyAlternative] : []),
    ];
    for (const c of candidates) {
      for (const token of matchTokens(c)) {
        if (taking.some((item) => tokenContains(item, token))) return null;
      }
    }
  }

  const notes: N[] = [];

  // 2. Map-declared condition/situation tags, via the SHARED matcher (code-first,
  //    #1030). A "drop" tag withholds the whole suggestion; a "caution" annotates it.
  for (const c of entry.contraindications) {
    if (
      conditionOrSituationMatches(c.match, decl.conditions, decl.situations)
    ) {
      if ((c.severity ?? "caution") === "drop") return null;
      notes.push(decl.note("condition", c.caution));
    }
  }

  // 3. The declaration's screen over each candidate. Survivors render; if EVERY one is
  //    struck, the curated alternative is screened and stands in; if that is struck too,
  //    nothing is offered at all.
  const strikes: CuratedStrike[] = [];
  const surviving: CuratedRendered<I>[] = [];
  for (const item of entry.items) {
    const strike = decl.screenItem(item);
    if (strike) {
      strikes.push(strike);
      continue;
    }
    surviving.push({ item, isAlternative: false });
  }

  let rendered = surviving;
  const allStruck = surviving.length === 0;
  if (allStruck) {
    const alt = entry.allergyAlternative;
    if (!alt || decl.screenItem(alt)) return null; // nothing safe to offer
    rendered = [{ item: alt, isAlternative: true }];
  }
  const struck = decl.struckNote(strikes, allStruck);
  if (struck) notes.push(struck);

  // 4. Medication notes from the food–drug inverse index — the same advice copy on both
  //    sides, deduped by entry key. Never a drop (a hard drop is step 3's job); a
  //    separation window is guidance, not a contraindication.
  const seen = new Set<string>();
  const scope =
    decl.drugNoteScope === "rendered"
      ? rendered.map((r) => r.item)
      : entry.items;
  for (const item of scope) {
    for (const k of decl.drugKeys(item) ?? []) {
      if (seen.has(k)) continue;
      const advice = decl.drugAdvice(k);
      if (advice !== null) {
        seen.add(k);
        notes.push(decl.note("medication", advice));
      }
    }
  }

  // 5. Declaration-raised entry cautions (food's excess caution, #775).
  for (const n of decl.extraNotes?.(entry, flags) ?? []) notes.push(n);

  // 6. The soft exclusion layer (#975). Drop the excluded candidates and lead with the
  //    compatible ones; when EVERY one is excluded, substitute the alternative if it is
  //    compatible and safe; if nothing compatible remains, KEEP the candidates — a
  //    shortfall must never vanish because its only sources are excluded.
  const { exclude } = decl;
  if (exclude) {
    const compatible = rendered.filter((r) => !exclude.isExcluded(r.item));
    if (compatible.length > 0 && compatible.length < rendered.length) {
      rendered = compatible;
      notes.push(exclude.filteredNote);
    } else if (compatible.length === 0) {
      const alt = entry.allergyAlternative;
      if (alt && !exclude.isExcluded(alt) && !decl.screenItem(alt)) {
        rendered = [{ item: alt, isAlternative: true }];
        notes.push(exclude.alternativeNote);
      }
      // else: leave the candidates in place — never an empty suggestion.
    }
  }

  return decl.finish(entry, triggeredBy, rendered, notes);
}

/**
 * THE engine: currently-flagged readings (+ any directly-named targets) and a
 * declaration → safety-screened suggestions, in the curated table's order.
 *
 * Deterministic; no DB, no clock, no model.
 */
export function suggestCurated<
  E extends CuratedEntry<I>,
  I,
  S,
  N,
  R extends CuratedReduceEntry = never,
>(
  flagged: readonly FlaggedReading[],
  decl: CuratedDeclaration<E, I, S, N, R>
): S[] {
  // Index flagged readings by lowercased name for O(1) family lookup, split by side.
  const low = new Map<string, string>(); // lower(name) -> original name
  const high = new Map<string, string>();
  for (const r of flagged) {
    const lower = r.name.trim().toLowerCase();
    if (isLowFlag(r.flag)) low.set(lower, r.name);
    else if (isHighFlag(r.flag)) high.set(lower, r.name);
  }
  const targeted = indexTargets(decl.extraTriggers);
  if (low.size === 0 && high.size === 0 && targeted.size === 0) return [];

  const flags: CuratedFlags = { low, high };
  const taking = (decl.alreadyTaking ?? []).filter((n) => n && n.trim());
  const out: S[] = [];

  // ADD side: an entry flagged on the side it DECLARES (low for the classic repletion
  // route; high for the #2754 add-on-high route), OR named directly by a target (#2383)
  // → the curated candidates, screened. The two doors compose: an entry that is both
  // flagged and short against its target cites both reasons on ONE suggestion.
  for (const entry of decl.entries) {
    const flaggedOnSide = entry.direction === "high" ? high : low;
    const triggeredBy = matchTriggers(entry, flaggedOnSide, targeted, "add");
    if (triggeredBy.length === 0) continue;
    const suggestion = buildSuggestion(entry, triggeredBy, decl, taking, flags);
    if (suggestion) out.push(suggestion);
  }

  // High side (REDUCE, #775): a flagged-high biomarker → the limit-tier list. Appended
  // after the add suggestions, in curated reduce-table order.
  const { reduceEntries, buildReduce } = decl;
  if (reduceEntries && buildReduce) {
    for (const entry of reduceEntries) {
      const triggeredBy = matchTriggers(entry, high, targeted, "reduce");
      if (triggeredBy.length === 0) continue;
      out.push(buildReduce(entry, triggeredBy));
    }
  }

  return out;
}
