// The FOOD-LOG × FOOD–DRUG findings BUILDER (issue #2021) — the DB gather that feeds the
// pure engine (lib/food-drug-ledger.ts), per the #448 findings-builder discipline. It
// carries no thresholds and no copy: it reads the profile's intake items (with the course
// window their dose schedule declares), matches them through the ONE food–drug matcher
// every medication surface uses, reads the food log's per-day servings, and hands both to
// the detector. No owned SQL of its own — it reads through profile-scoped queries — so the
// profile-scoping guard is unaffected.
//
// TWO SHAPES, TWO TIERS (#449), decided on purpose:
//
//   • The EVENT finding ("alcohol logged today while taking Flagyl") is CARE tier. It
//     belongs to the med-safety family the interaction / dietary-limit / allergy-med items
//     are already in, and unlike a retrospective note it is forward-looking: the label's
//     own tail ("and for 3 days after") is about the days ahead. It reaches Upcoming and
//     the non-hideable Needs-attention hero, keyed by its dedupeKey through the shared bus.
//
//     It reaches NO push channel — no digest line, no dedicated send — and that is the
//     tier being a CEILING and not a floor (#1433). The contact-consent rule says the
//     system may reduce contact unilaterally but never increase it without a user-owned
//     declaration, and nobody declared "tell me when I drink": the food log is a record of
//     what happened, not a commitment (the attention doctrine's observation domains). A
//     message that arrives because you logged a beer would also be surveillance-shaped,
//     which is the opposite of the app's posture toward the very intake it wants tracked.
//
//   • The VARIANCE finding ("leafy greens up this week — Warfarin") is COACHING tier: a
//     calm, hideable trend line on the coaching surfaces, never a notification, never the
//     hero. It quotes the entry's own "keep it steady" advice and states what it counted.
//
// Both key through the shared suppression bus, so a dismissal on any surface silences
// every surface.

import { cache } from "./request-cache";
import { getSupplements, getSupplementDoses } from "./queries/intake";
import { getFoodServingsInRange } from "./queries/nutrition";
import { getProfileAge } from "./settings";
import { matchFoodInteractions } from "./food-drug-interactions";
import { parseRxcuiIngredients } from "./rxnorm";
import { shiftDateStr } from "./date";
import {
  detectFoodDrugEvents,
  detectFoodDrugVariance,
  foodDrugEventDetail,
  foodDrugEventEvidence,
  foodDrugEventTitle,
  foodDrugVarianceDetail,
  foodDrugVarianceEvidence,
  foodDrugVarianceTitle,
  FOOD_DRUG_VARIANCE_WINDOW_DAYS,
  type FoodDrugEventFinding,
  type FoodDrugVarianceFinding,
  type LedgerItem,
  type LedgerServing,
} from "./food-drug-ledger";
import type { Finding } from "./findings";
import type { UpcomingItem } from "./upcoming";
import { intakeHref } from "./hrefs";
import type { AppRoute } from "./hrefs";

// How far back the ledger reads: two variance windows, which also covers every event
// lookup (today) with one query.
const LEDGER_WINDOW_DAYS = 2 * FOOD_DRUG_VARIANCE_WINDOW_DAYS;

// The profile's intake items as LedgerItems: identity, active flag, the course window
// their CURRENT (non-retired) doses declare, and the food–drug hits they match.
//
// The course window is read from the dose schedule's `start_date` / `end_date` (#1602's
// per-dose validity window — the same columns a taper is expressed in). `courseEnd` is the
// latest end_date and is null the moment ANY current dose is open-ended, which is what an
// ongoing prescription is; a course with no dated end simply has no tail to compute, and
// the engine refuses rather than guessing when treatment stopped.
function ledgerItems(profileId: number): LedgerItem[] {
  const age = getProfileAge(profileId);
  // Per item: the earliest declared start, the latest declared end, and whether ANY
  // current dose is open-ended (which makes the whole course open-ended).
  interface CourseWindow {
    start: string | null;
    end: string | null;
    openEnded: boolean;
  }
  const dosesByItem = new Map<number, CourseWindow>();
  for (const dose of getSupplementDoses(profileId)) {
    const acc: CourseWindow = dosesByItem.get(dose.item_id) ?? {
      start: null,
      end: null,
      openEnded: false,
    };
    if (
      dose.start_date != null &&
      (acc.start == null || dose.start_date < acc.start)
    ) {
      acc.start = dose.start_date;
    }
    if (dose.end_date == null) acc.openEnded = true;
    else if (acc.end == null || dose.end_date > acc.end)
      acc.end = dose.end_date;
    dosesByItem.set(dose.item_id, acc);
  }
  const out: LedgerItem[] = [];
  for (const item of getSupplements(profileId)) {
    const hits = matchFoodInteractions(
      {
        name: item.name,
        rxcui: item.rxcui,
        rxcuiIngredients: parseRxcuiIngredients(item.rxcui_ingredients),
      },
      age
    ).filter((h) => h.catalog.rule !== "none");
    if (hits.length === 0) continue;
    const window = dosesByItem.get(item.id);
    out.push({
      id: item.id,
      name: item.name,
      active: item.active === 1,
      courseStart: window?.start ?? null,
      courseEnd: window == null || window.openEnded ? null : window.end,
      hits,
    });
  }
  return out;
}

function ledgerServings(profileId: number, date: string): LedgerServing[] {
  const from = shiftDateStr(date, -(LEDGER_WINDOW_DAYS - 1));
  return getFoodServingsInRange(profileId, from, date).map((row) => ({
    group: row.group_key,
    date: row.date,
    servings: row.servings,
  }));
}

// Distinct days in the PRIOR variance window that carry any food log at all — the
// adoption guard, so a profile that started logging last week doesn't read as a swing.
function priorWindowLoggedDays(
  servings: readonly LedgerServing[],
  date: string
): number {
  const start = shiftDateStr(date, -(LEDGER_WINDOW_DAYS - 1));
  const end = shiftDateStr(date, -FOOD_DRUG_VARIANCE_WINDOW_DAYS);
  const days = new Set<string>();
  for (const s of servings) {
    if (s.date >= start && s.date <= end && s.servings > 0) days.add(s.date);
  }
  return days.size;
}

// The ONE gather each finding shape formats over (#221) — one function, not two
// independent re-derivations (#2060).
export interface FoodDrugLedger {
  items: LedgerItem[];
  servings: LedgerServing[];
}

// Wrapped in the shared request-scoped `cache()` shim, because the two finding shapes
// are read by DIFFERENT surfaces that a single page renders together: the event finding
// through rawUpcoming → the Needs-attention hero, the variance finding through
// collectCoachingFindings. Each builder used to run the whole gather itself — every
// intake item matched through `matchFoodInteractions`, plus the food-log range read — so
// a dashboard render paid for it twice. Keyed on (profileId, date), so one request
// collapses to one read; outside a request (the notify sidecar, the DB test tier) the
// shim calls through and the behavior is identical.
//
// The empty-items short circuit is preserved and moved INTO the gather: no matched item
// means nothing to detect, so the food log is never read for it.
export const foodDrugLedgerFor = cache(function foodDrugLedgerFor(
  profileId: number,
  date: string
): FoodDrugLedger {
  const items = ledgerItems(profileId);
  if (items.length === 0) return { items, servings: [] };
  return { items, servings: ledgerServings(profileId, date) };
});

export function foodDrugEventFindingsFor(
  profileId: number,
  date: string
): FoodDrugEventFinding[] {
  const { items, servings } = foodDrugLedgerFor(profileId, date);
  if (items.length === 0) return [];
  return detectFoodDrugEvents(items, servings, date);
}

export function foodDrugVarianceFindingsFor(
  profileId: number,
  date: string
): FoodDrugVarianceFinding[] {
  const { items, servings } = foodDrugLedgerFor(profileId, date);
  if (items.length === 0) return [];
  return detectFoodDrugVariance(
    items,
    servings,
    date,
    priorWindowLoggedDays(servings, date)
  );
}

// Both shapes link to the surface the item lives on, so the guidance line and the item it
// is about are one tap apart (the kind→surface rule, never a hand-written path).
const ITEM_HREF: AppRoute = intakeHref("medication");

// The event findings as care-tier Findings (the #448 reflection guard + any Finding-typed
// surface). Caution tone: a stated interaction worth knowing about right now, never a
// celebratory or neutral FYI.
export function buildFoodDrugEventFindings(
  profileId: number,
  date: string
): Finding[] {
  return foodDrugEventFindingsFor(profileId, date).map((f) => ({
    domain: "food-drug-event",
    dedupeKey: f.dedupeKey,
    title: foodDrugEventTitle(f),
    detail: foodDrugEventDetail(f),
    tone: "caution" as const,
    evidence: foodDrugEventEvidence(f),
    actionHref: ITEM_HREF,
    actionLabel: "View medication",
  }));
}

// The event findings as Upcoming items → the Upcoming page AND the non-hideable
// Needs-attention hero (via collectUpcoming → buildAttentionModel). Banded "today" like
// the other care-tier informational findings (dietary-limit / interaction / illness-care),
// keyed by the SAME dedupeKey so a dismiss on any surface silences all of them.
// `detail` is self-contained (the log fact + the label's advice + source + the mandatory
// informational tail) because UpcomingItem has no evidence slot.
export function foodDrugEventItems(
  profileId: number,
  date: string
): UpcomingItem[] {
  return foodDrugEventFindingsFor(profileId, date).map((f) => ({
    key: f.dedupeKey,
    domain: "food-drug-event" as const,
    title: foodDrugEventTitle(f),
    detail: `${foodDrugEventEvidence(f)} ${foodDrugEventDetail(f)}`,
    href: ITEM_HREF,
    dueDate: null,
    band: "today" as const,
    dueText: "Today",
  }));
}

// The variance findings as coaching-tier Findings — joins collectCoachingFindings, so it
// reaches the coaching tab and the hideable dashboard rollup and nothing else.
export function buildFoodDrugVarianceFindings(
  profileId: number,
  date: string
): Finding[] {
  return foodDrugVarianceFindingsFor(profileId, date).map((f) => ({
    domain: "coaching",
    dedupeKey: f.dedupeKey,
    title: foodDrugVarianceTitle(f),
    detail: foodDrugVarianceDetail(f),
    tone: "info" as const,
    evidence: foodDrugVarianceEvidence(f),
    actionHref: ITEM_HREF,
    actionLabel: "View medication",
  }));
}
