// Pure FOOD LOG × FOOD–DRUG RULE detection (issue #2021). The gap this closes: the app
// printed "Avoid all alcohol during treatment and for 3 days after" on a metronidazole row
// and then watched the user log an alcohol serving that evening in complete silence. The
// two datasets sat in one database and were never joined — `matchFoodInteractions` takes an
// ITEM and never touches `food_log`.
//
// This module is the join, and it is deliberately narrow. It fires ONLY on entries whose
// committed `catalog` mapping says it may (`rule: "event" | "variance"`); every other entry
// declares an exclusion with a written reason and is unreachable from here by construction
// — the granularity gap (grapefruit collapsing into `fruit`, tyramine hiding inside
// `fermented`, a dairy SEPARATION window needing an eating time) caps what may be claimed
// rather than being approximated. No DB, no clock: the builder
// (lib/food-drug-ledger-findings.ts) gathers, this decides, each surface formats.
//
// TONE (#992/#716). Every string here states a FACT the user's own log contains plus the
// entry's own cited advice line. Nothing here judges, warns off, or infers a consequence:
// "Alcohol logged today while taking Flagyl" and the label's sentence — never "you
// shouldn't have", never a diagnosis, never a number we invented.

import { shiftDateStr } from "./date";
import type { FoodInteractionHit } from "./food-drug-interactions";
import { foodGroupBySlug } from "./food-groups";

// ---- Identity (the findings-bus namespaces) ----

// A serving of a mapped group logged inside an item's rule window. Keyed by item ×
// rule × DAY, so each day's co-occurrence is its own finding and a dismissal covers that
// day rather than the topic forever (a second course is a second signal).
export const FOOD_DRUG_EVENT_PREFIX = "food-drug-event:";

// A swing in a mapped group's trailing intake against a "keep it steady" rule. Keyed by
// item × rule only: the steadiness question is continuous, so a dismissal is "I know about
// this" rather than "for today", and recovery clears the finding on its own.
export const FOOD_DRUG_VARIANCE_PREFIX = "food-drug-variance:";

export function foodDrugEventKey(
  itemId: number,
  ruleId: string,
  date: string
): string {
  return `${FOOD_DRUG_EVENT_PREFIX}${itemId}:${ruleId}:${date}`;
}

export function foodDrugVarianceKey(itemId: number, ruleId: string): string {
  return `${FOOD_DRUG_VARIANCE_PREFIX}${itemId}:${ruleId}`;
}

// ---- Inputs ----

// One intake item as the ledger sees it: identity, whether it is still active, and the
// COURSE window its dose schedule declares. The window is what makes "and for 3 days
// after" computable — see `ruleWindow`.
export interface LedgerItem {
  id: number;
  name: string;
  active: boolean;
  // Earliest dose start_date, or null when the schedule declares none (open at that end).
  courseStart: string | null;
  // Latest dose end_date, or null when ANY current dose is open-ended.
  courseEnd: string | null;
  // The item's matched food–drug guidance, already age-gated by the caller
  // (matchFoodInteractions) — this module never re-matches.
  hits: readonly FoodInteractionHit[];
}

// One day's servings of one food group, straight from the food_log day counter.
export interface LedgerServing {
  group: string;
  date: string;
  servings: number;
}

// The inclusive [start, end] days a rule applies on, or null when the item declares no
// window the log can be checked against. `tailDays` extends the END only — it is the
// entry's own stated tail ("and for 3 days after"), never a default.
//
// The refusals are the honest part:
//   • an INACTIVE item with no recorded course end has an unknowable window (we cannot
//     date "when treatment stopped"), so nothing fires — silence over a guess;
//   • an ACTIVE item with no course end is open at the end, which is exactly what an
//     ongoing prescription means.
export function ruleWindow(
  item: LedgerItem,
  tailDays?: number
): { start: string | null; end: string | null } | null {
  if (item.courseEnd == null) {
    return item.active ? { start: item.courseStart, end: null } : null;
  }
  return {
    start: item.courseStart,
    end: tailDays ? shiftDateStr(item.courseEnd, tailDays) : item.courseEnd,
  };
}

// Whether `date` falls inside a window (inclusive; null ends are open).
export function withinRuleWindow(
  window: { start: string | null; end: string | null },
  date: string
): boolean {
  if (window.start != null && date < window.start) return false;
  if (window.end != null && date > window.end) return false;
  return true;
}

// ---- Event findings (a serving logged inside the window) ----

export interface FoodDrugEventFinding {
  dedupeKey: string;
  itemId: number;
  itemName: string;
  ruleId: string;
  date: string;
  // The mapped groups that actually carried servings today, and their total.
  groups: string[];
  servings: number;
  // Days past the course end, when the finding is firing inside the entry's stated tail
  // rather than during treatment. 0 = during treatment.
  daysAfterCourse: number;
  hit: FoodInteractionHit;
}

// Every (item × event rule × today) co-occurrence: a mapped group logged on `date` while
// the item's rule window covers it. Deterministic order (item id, then rule key).
export function detectFoodDrugEvents(
  items: readonly LedgerItem[],
  servings: readonly LedgerServing[],
  date: string
): FoodDrugEventFinding[] {
  const today = new Map<string, number>();
  for (const s of servings) {
    if (s.date !== date || s.servings <= 0) continue;
    today.set(s.group, (today.get(s.group) ?? 0) + s.servings);
  }
  const out: FoodDrugEventFinding[] = [];
  for (const item of items) {
    for (const hit of item.hits) {
      if (hit.catalog.rule !== "event") continue;
      const window = ruleWindow(item, hit.catalog.tailDays);
      if (!window || !withinRuleWindow(window, date)) continue;
      const groups = hit.catalog.groups.filter((g) => (today.get(g) ?? 0) > 0);
      if (groups.length === 0) continue;
      const total = groups.reduce((sum, g) => sum + (today.get(g) ?? 0), 0);
      out.push({
        dedupeKey: foodDrugEventKey(item.id, hit.key, date),
        itemId: item.id,
        itemName: item.name,
        ruleId: hit.key,
        date,
        groups,
        servings: total,
        daysAfterCourse: daysBetween(item.courseEnd, date),
        hit,
      });
    }
  }
  return out.sort(
    (a, b) => a.itemId - b.itemId || a.ruleId.localeCompare(b.ruleId)
  );
}

// Whole days from an (optional) course end to `date`, floored at 0. 0 for an open-ended
// course or a date on/before the end — i.e. "still during treatment".
function daysBetween(courseEnd: string | null, date: string): number {
  if (courseEnd == null || date <= courseEnd) return 0;
  const ms =
    Date.parse(`${date}T00:00:00Z`) - Date.parse(`${courseEnd}T00:00:00Z`);
  return Math.max(0, Math.round(ms / 86_400_000));
}

// ---- Variance findings (a swing against "keep it steady") ----

// The trailing window each side of the comparison. Seven days a side: a week is the unit
// the "steady intake" advice is stated in, and two of them is the shortest span in which a
// change is a change rather than a weekend.
export const FOOD_DRUG_VARIANCE_WINDOW_DAYS = 7;

// The floor a swing must clear, in servings, before it is a signal at all. Below this the
// difference is ordinary week-to-week noise in a hand-tapped log.
export const FOOD_DRUG_VARIANCE_MIN_DELTA = 3;

// How many days of the PRIOR window must carry any food log before a comparison is
// honest. Without it, a profile that started logging last Tuesday would read as a sudden
// dietary increase — an artifact of adoption, not a swing.
export const FOOD_DRUG_VARIANCE_MIN_PRIOR_DAYS = 3;

export interface FoodDrugVarianceFinding {
  dedupeKey: string;
  itemId: number;
  itemName: string;
  ruleId: string;
  groups: string[];
  // Servings in the trailing window and in the one before it.
  recent: number;
  prior: number;
  direction: "up" | "down";
  hit: FoodInteractionHit;
}

// Every (item × variance rule) whose mapped groups swung week over week while the item's
// rule window covers today. A swing must clear BOTH gates — an absolute floor and a
// doubling/halving — so a 4→7 drift stays silent while 2→9 does not.
export function detectFoodDrugVariance(
  items: readonly LedgerItem[],
  servings: readonly LedgerServing[],
  date: string,
  // Distinct days in the PRIOR window carrying any food log at all — the adoption guard.
  priorWindowLoggedDays: number
): FoodDrugVarianceFinding[] {
  const recentStart = shiftDateStr(date, -(FOOD_DRUG_VARIANCE_WINDOW_DAYS - 1));
  const priorStart = shiftDateStr(
    date,
    -(2 * FOOD_DRUG_VARIANCE_WINDOW_DAYS - 1)
  );
  const priorEnd = shiftDateStr(recentStart, -1);
  const out: FoodDrugVarianceFinding[] = [];
  if (priorWindowLoggedDays < FOOD_DRUG_VARIANCE_MIN_PRIOR_DAYS) return out;
  for (const item of items) {
    for (const hit of item.hits) {
      if (hit.catalog.rule !== "variance") continue;
      const window = ruleWindow(item, hit.catalog.tailDays);
      if (!window || !withinRuleWindow(window, date)) continue;
      const groups = new Set(hit.catalog.groups);
      let recent = 0;
      let prior = 0;
      for (const s of servings) {
        if (!groups.has(s.group) || s.servings <= 0) continue;
        if (s.date >= recentStart && s.date <= date) recent += s.servings;
        else if (s.date >= priorStart && s.date <= priorEnd)
          prior += s.servings;
      }
      if (!isSwing(recent, prior)) continue;
      out.push({
        dedupeKey: foodDrugVarianceKey(item.id, hit.key),
        itemId: item.id,
        itemName: item.name,
        ruleId: hit.key,
        groups: hit.catalog.groups,
        recent,
        prior,
        direction: recent > prior ? "up" : "down",
        hit,
      });
    }
  }
  return out.sort(
    (a, b) => a.itemId - b.itemId || a.ruleId.localeCompare(b.ruleId)
  );
}

// Both gates: an absolute floor AND a doubling/halving. Equal totals never qualify.
export function isSwing(recent: number, prior: number): boolean {
  const hi = Math.max(recent, prior);
  const lo = Math.min(recent, prior);
  if (hi - lo < FOOD_DRUG_VARIANCE_MIN_DELTA) return false;
  return hi >= 2 * lo;
}

// ---- Copy (one formatter per shape, every surface reads it) ----

// The mandatory tail every food–drug string in the app carries. Kept here so the two
// finding shapes cannot drift from each other or from the /medicine row's posture.
const INFORMATIONAL_TAIL = "Informational, not medical advice.";

// "Alcohol logged today while taking Flagyl" / "…, 2 days after finishing Flagyl". The
// finding is built for the profile's TODAY, which is what licenses the word.
export function foodDrugEventTitle(f: FoodDrugEventFinding): string {
  const food = f.hit.food;
  if (f.daysAfterCourse > 0) {
    const days =
      f.daysAfterCourse === 1 ? "1 day" : `${f.daysAfterCourse} days`;
    return `${food} logged today, ${days} after finishing ${f.itemName}`;
  }
  return `${food} logged today while taking ${f.itemName}`;
}

// The guidance itself: the entry's OWN advice line (the same sentence the medication row
// prints), its coverage note when the mapping is partial, its citation, and the
// informational tail. Nothing is added to the label's claim.
export function foodDrugEventDetail(f: FoodDrugEventFinding): string {
  return joinSentences([
    f.hit.advice,
    f.hit.catalog.coverageNote,
    `Source: ${f.hit.source}.`,
    INFORMATIONAL_TAIL,
  ]);
}

// What the log actually says, as the evidence line: the count and the groups it came
// from, which the title does not name.
export function foodDrugEventEvidence(f: FoodDrugEventFinding): string {
  return `${formatServings(f.servings)} of ${groupLabel(f.groups)} in today's food log.`;
}

// "Leafy greens up this week — Warfarin". A direction and a subject, no verdict. Named by
// the CATALOG GROUP rather than the entry's food phrase, because the group is literally
// what was counted.
export function foodDrugVarianceTitle(f: FoodDrugVarianceFinding): string {
  const dir = f.direction === "up" ? "up" : "down";
  return `${sentenceCase(groupLabel(f.groups))} ${dir} this week — ${f.itemName}`;
}

export function foodDrugVarianceDetail(f: FoodDrugVarianceFinding): string {
  return joinSentences([
    f.hit.advice,
    f.hit.catalog.coverageNote,
    `Source: ${f.hit.source}.`,
    INFORMATIONAL_TAIL,
  ]);
}

export function foodDrugVarianceEvidence(f: FoodDrugVarianceFinding): string {
  return (
    `${formatServings(f.recent)} in the last ${FOOD_DRUG_VARIANCE_WINDOW_DAYS} days ` +
    `vs ${formatServings(f.prior)} in the ${FOOD_DRUG_VARIANCE_WINDOW_DAYS} before.`
  );
}

// The catalog's own display names for the mapped groups, so a finding names the food the
// same way the log bar the user tapped does.
function groupLabel(groups: readonly string[]): string {
  const names = groups.map((g) => foodGroupBySlug(g)?.name.toLowerCase() ?? g);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function sentenceCase(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function formatServings(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return `${rounded} ${rounded === 1 ? "serving" : "servings"}`;
}

function joinSentences(parts: (string | undefined)[]): string {
  return parts.filter((p): p is string => !!p && p.trim().length > 0).join(" ");
}
