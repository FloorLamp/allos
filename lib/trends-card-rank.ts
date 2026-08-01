// Ranked DEFAULT order for the Trends tabs' chart cards (#1490) — the first tenant
// of the shared `lib/rank-core.ts` substrate.
//
// THE POSTURE (confirmed design, and the reason this is a DEFAULT and not a feed):
// chart cards are a PLACE, not a feed. Users build spatial memory against them, so
// context must never reorder an ARRANGED page (#1413's promote-don't-reorder,
// #559's refusal of invented priority). What context legitimately decides is the
// order a profile that has never arranged the tab sees on its FIRST visit — and the
// Body tab already hand-rolled one case of exactly that (minors got a growth-led
// layout, adults weight → body-fat → resting-HR). This generalizes that fork rather
// than letting a per-tab copy of it accrete on every tab.
//
// WHAT RETIRED INTO THIS MODULE:
//   • `planBodyCharts().growthCardFirst` (lib/growth-metrics) — the pediatric
//     "growth card leads" fork, now the `life-stage` signal. `planBodyCharts` keeps
//     its MEMBERSHIP job (which composition charts exist for an age, body-fat
//     dropped for a growth-tracked profile); only the ORDER moved here.
//   • `orderBodyCharts` (lib/trends-body-order, deleted) — the synced charts' and
//     tiles' "present first, most-recently-updated first" sort. Presence became the
//     `data-present` FLOOR plus the bucketed `data-presence` signal; the raw
//     latest-date sort is deliberately NOT reproduced, because it reshuffled the
//     page every time a device synced — the precise jitter #1490 exists to stop.
//
// STABLE FACTS ONLY. Every signal reads something that changes on the scale of
// weeks or life events — life stage, a live goal, an active condition, whether a
// series has data at all — never today's VALUES. A default that moved because this
// morning's weigh-in was high would be a feed.

import {
  defineRankTable,
  itemsFromLayout,
  mergeStoredOrder,
  rankItems,
  rankedIds,
  type RankItem,
} from "./rank-core";
import { daysBetweenDateStr } from "./date";
import type { BodyMetricSlug } from "./trends-body-metrics";
import type { BodyMetricKind } from "./types";

// ---------------------------------------------------------------------------
// The card id space
// ---------------------------------------------------------------------------

// A rankable card on the Body tab. The per-metric cards reuse `BodyMetricSlug`
// (lib/trends-body-metrics) verbatim — the #482 one-identity rule: the tile, the
// chart, the detail route and now the rank key are ONE name per subject. Three
// cards are not metrics: the WHO/CDC growth-percentile card, the Sleep summary tile
// (its own /sleep surface), and the "HR (day)" intraday card.
export type BodyCardId = BodyMetricSlug | "growth" | "sleep" | "hr-day";

// THE BASE LAYOUT: the Body tab's ADULT reading order, flattened across its runs.
// This array IS the stable tie-break — with no signal firing the ranker returns it
// unchanged, which is the identity property the pure + browser tiers both pin.
// Editing it changes the default layout for every never-arranged profile, so edit
// it on purpose.
//
// EVERYDAY-FIRST (#1659). It used to run vitals-first, inherited from #1486's page
// narrative. That order is only ever consulted on a TIE, and both-rich is the normal
// state for a wearable profile — Oura and watches report SpO₂ nightly, so SpO₂ is
// "rich" the moment steps is, and `BOOST_PRESENCE_RICH` fires equally for both. The
// tie-break therefore decided the whole tab, and it led every wearable profile with
// the clinical-vitals block above the metrics they actually check daily.
//
// So the base sequence is now the order a reader reaches for: composition, then the
// growth card's adult slot, then daily activity + the heart-rate family, then the
// daily subjective/environment pair, then clinical vitals, then the synced
// composition tail. Clinical cards are not demoted — they are lifted BY SIGNAL when
// they matter (a monitored condition promotes BP/SpO₂/respiratory rate), which is
// the signal's job rather than the base order's. The Today strip (#1486) keeps the
// vitals-first narrative; the card stack stops inheriting it.
export const BODY_CARD_LAYOUT: readonly BodyCardId[] = [
  // Composition — what people check daily. `height`/`head-circ` only exist for a
  // growth-tracked profile (membership is still planBodyCharts'); their ADULT-layout
  // base position is here, and the life-stage signal is what lifts them above weight
  // for a child.
  "weight",
  "body-fat",
  "height",
  "head-circ",
  // The growth-percentile card's ADULT base position (where it is empty anyway);
  // life stage lifts it to the top of the stack for a child.
  "growth",
  // Daily activity + the heart-rate family. `hrv` joins its family here rather than
  // staying in the clinical run, and `resting-hr` counts as everyday (widely tracked
  // and goal-linked).
  "steps",
  "active-calories",
  "sleep",
  "resting-hr",
  "hr",
  "hr-day",
  "hrv",
  // Daily subjective + environment. The check-in's three ratings sit together and in
  // the order the card itself asks them (#1408: mood is the one-tap hero, energy and
  // the gated Calm scale live behind its expansion). `sun` is outdoor time, not a
  // vital.
  "mood",
  "energy",
  "calm",
  "sun",
  // Clinical vitals — condition and goal signals still lift these when they matter.
  "systolic",
  "diastolic",
  "spo2",
  "respiratory-rate",
  "skin-temp",
  "temperature",
  // Synced composition tail.
  "bmi",
  "lean-mass",
  "bone-mass",
  "bmr",
  "hydration",
  "calories",
];

// Chart keys used inside the Body section predate the slug registry for four cards.
// Mapped here (rather than renaming them across a 1,400-line component that a
// parallel change is also editing) so the ranker and the renderer agree on identity.
const CHART_KEY_ALIASES: Record<string, BodyCardId> = {
  resting_hr: "resting-hr",
  skin_temp: "skin-temp",
  bodyfat: "body-fat",
  head_circumference: "head-circ",
};

// Normalize a renderer's chart/tile key to its card id.
export function bodyCardId(key: string): BodyCardId {
  return (CHART_KEY_ALIASES[key] ?? key) as BodyCardId;
}

// ---------------------------------------------------------------------------
// Data presence
// ---------------------------------------------------------------------------

// How present a card's series is. BUCKETED on purpose: the retired `orderBodyCharts`
// sorted by raw latest-date, so the page resequenced itself whenever a watch synced.
// Three coarse buckets change at most once per series per month and a card can only
// move when the underlying fact ("this metric is something the profile actually
// tracks") really changed.
export type PresenceLevel = "rich" | "sparse" | "none";

// A series counts as RICH when it has enough points to read as a trend AND its tail
// is recent enough to be something the profile is currently tracking.
export const RICH_MIN_POINTS = 3;
export const RICH_RECENT_DAYS = 45;

export function presenceLevel(
  points: number,
  latestDate: string | null,
  todayStr: string
): PresenceLevel {
  if (points <= 0 || !latestDate) return "none";
  if (points < RICH_MIN_POINTS) return "sparse";
  const age = daysBetweenDateStr(latestDate, todayStr);
  if (age === null || age > RICH_RECENT_DAYS) return "sparse";
  return "rich";
}

// ---------------------------------------------------------------------------
// Monitored conditions
// ---------------------------------------------------------------------------

// The Body-tab series an active condition puts under routine watch. Deliberately
// SMALL, with the #482 exclusion discipline: a condition earns a tag only when the
// thing its care actually monitors IS one of this tab's own series. Diabetes is the
// worked example of an exclusion — it is monitored by A1c/glucose (biomarkers, not
// Body cards), so boosting weight/BMI for a diabetic profile would be inventing a
// relevance the subject never asked for.
export type MonitorTag =
  "blood-pressure" | "heart-rate" | "respiratory" | "weight";

// Code prefixes are matched first (authoritative), then a name pattern for a
// hand-entered condition with no code.
const CONDITION_MONITORS: readonly {
  tag: MonitorTag;
  codes: readonly string[];
  name: RegExp;
}[] = [
  {
    tag: "blood-pressure",
    codes: ["I10", "I11", "I12", "I13", "I15", "I16"],
    name: /hypertens|high blood pressure/i,
  },
  {
    tag: "heart-rate",
    codes: ["I47", "I48", "I49", "R00"],
    name: /atrial fibrillation|afib|arrhythmi|tachycardi|bradycardi/i,
  },
  {
    tag: "respiratory",
    codes: ["J44", "J45", "G47.3", "G4733"],
    name: /asthma|copd|sleep apn(o?)ea/i,
  },
  { tag: "weight", codes: ["E66"], name: /obes|overweight/i },
];

// The monitor tags an ACTIVE condition list puts on the Body tab. Pure — the caller
// (the DB builder) supplies the already-filtered active rows.
export function conditionMonitorTags(
  conditions: readonly { name: string; code: string | null }[]
): MonitorTag[] {
  const tags = new Set<MonitorTag>();
  for (const c of conditions) {
    const code = (c.code ?? "").toUpperCase().replace(/\s/g, "");
    for (const m of CONDITION_MONITORS) {
      const byCode = code
        ? m.codes.some(
            (p) => code.startsWith(p.replace(".", "")) || code.startsWith(p)
          )
        : false;
      if (byCode || m.name.test(c.name)) tags.add(m.tag);
    }
  }
  return [...tags];
}

// Which cards each tag watches.
const MONITORED_CARDS: Record<MonitorTag, readonly BodyCardId[]> = {
  "blood-pressure": ["systolic", "diastolic"],
  "heart-rate": ["resting-hr", "hrv"],
  respiratory: ["spo2", "respiratory-rate", "sleep"],
  weight: ["weight", "bmi"],
};

// Which cards a live body-metric goal watches. The goal signal uses the SAME
// `Goal.body_metric` vocabulary the chart's own target overlay reads, so the card a
// goal decorates is the card the goal promotes — one definition, not two.
const GOAL_CARDS: Record<BodyMetricKind, readonly BodyCardId[]> = {
  weight: ["weight", "bmi"],
  body_fat: ["body-fat"],
  resting_hr: ["resting-hr"],
};

// The growth-tracked (pediatric) card family. `growth` LEADS the whole stack; the
// growth-charted measures lead their run.
const GROWTH_LEAD: BodyCardId = "growth";
const GROWTH_MEMBERS: readonly BodyCardId[] = ["height", "head-circ"];

// ---------------------------------------------------------------------------
// The context
// ---------------------------------------------------------------------------

// The STABLE subject facts the ranker reads. Gathered once per request by
// `buildTrendsSubjectContext` (lib/queries/trends-context.ts, the #448 builder tier);
// nothing here is a value, a threshold crossing, or a clock reading.
export interface TrendsSubjectContext {
  // Life stage: the ONE shared `isGrowthTracked` line (lib/life-stage), not a second
  // age fork.
  growthTracked: boolean;
  // Body metrics a LIVE goal tracks (`isGoalLive` + a target).
  goalMetrics: readonly BodyMetricKind[];
  // Monitor tags from the profile's ACTIVE conditions.
  monitors: readonly MonitorTag[];
  // Per-card data presence. A card absent from the map is treated as "sparse" —
  // neutral — so a card whose presence the builder cannot cheaply know is never
  // sunk by ignorance.
  presence: Partial<Record<BodyCardId, PresenceLevel>>;
}

export const EMPTY_TRENDS_CONTEXT: TrendsSubjectContext = {
  growthTracked: false,
  goalMetrics: [],
  monitors: [],
  presence: {},
};

// Signal weights. Ordered so a stronger signal can never be out-summed by weaker
// ones (the assertion lives in the pure test): life stage > condition > goal >
// presence > base layout. The base spread is bounded by the layout length (~25), so
// even the weakest boost outranks a pure base difference — a rich series really does
// float above a never-used one that happens to sit higher in the static layout.
export const BOOST_LIFE_STAGE_LEAD = 2000;
export const BOOST_LIFE_STAGE_MEMBER = 800;
export const BOOST_CONDITION = 400;
export const BOOST_GOAL = 250;
export const BOOST_PRESENCE_RICH = 100;

function presenceOf(ctx: TrendsSubjectContext, id: BodyCardId): PresenceLevel {
  return ctx.presence[id] ?? "sparse";
}

// The signal table. FOUR signals against a budget of six (RANK_SIGNAL_BUDGET) — the
// two spare slots are the room a future signal has to earn, not a target.
export const TRENDS_CARD_TABLE = defineRankTable<
  BodyCardId,
  TrendsSubjectContext
>({
  tenant: "trends-cards",
  floors: [
    {
      // A card with NO data can never lead one that has data — whatever else fires.
      // Expressed as a floor rather than a large penalty so no combination of
      // boosts can quietly promote an empty chart to the top of the tab.
      key: "data-present",
      holds: (item, ctx) => presenceOf(ctx, item.id) !== "none",
    },
  ],
  signals: [
    {
      // Life stage — the retired BodySection fork. A growth-tracked profile leads
      // with the percentile card, and height/head-circ lead the composition run.
      key: "life-stage",
      boost: (item, ctx) => {
        if (!ctx.growthTracked) return 0;
        if (item.id === GROWTH_LEAD) return BOOST_LIFE_STAGE_LEAD;
        return GROWTH_MEMBERS.includes(item.id) ? BOOST_LIFE_STAGE_MEMBER : 0;
      },
    },
    {
      // Conditions — a series under routine watch leads the run it lives in.
      key: "condition-monitored",
      boost: (item, ctx) =>
        ctx.monitors.some((t) => MONITORED_CARDS[t].includes(item.id))
          ? BOOST_CONDITION
          : 0,
    },
    {
      // Live goals — the metric the subject is actively working on.
      key: "live-goal",
      boost: (item, ctx) =>
        ctx.goalMetrics.some((m) => GOAL_CARDS[m].includes(item.id))
          ? BOOST_GOAL
          : 0,
    },
    {
      // Data presence — the strongest NEUTRAL signal. This is what serves an
      // "athlete" honestly (a profile whose HRV/steps really are tracked leads with
      // them) without an athlete classifier, and what sinks a never-measured card
      // for everyone. Empty is handled by the floor above.
      key: "data-presence",
      boost: (item, ctx) =>
        presenceOf(ctx, item.id) === "rich" ? BOOST_PRESENCE_RICH : 0,
    },
  ],
});

// ---------------------------------------------------------------------------
// The order
// ---------------------------------------------------------------------------

const BODY_ITEMS: RankItem<BodyCardId>[] = itemsFromLayout(BODY_CARD_LAYOUT);

// The Body tab's ranked DEFAULT card order — every id in BODY_CARD_LAYOUT, ranked.
// Callers filter it to what they actually render (a card with no data is usually
// present-gated out of the page entirely; the floor only matters for the cards that
// do render).
export function rankBodyCards(ctx: TrendsSubjectContext): BodyCardId[] {
  return rankedIds(BODY_ITEMS, TRENDS_CARD_TABLE, ctx);
}

// The SIGNAL a ★ may not outrank. Life stage is not a preference competing with the
// user's pins — it is the membership-tier fork `planBodyCharts().growthCardFirst`
// used to encode positionally, which #1490 moved into this table (the same tier that
// drops body fat for a growth-tracked profile whatever the user starred). #1643's own
// precedence rule says membership wins over ★, and this is that rule applied to the
// half of membership that became a signal.
const STRUCTURAL_SIGNAL = "life-stage";

// The order the tab actually renders (#1643): the profile's ★-PINNED cards first, in
// their saved order, then the ranked default for everything unpinned.
//
// There is ONE arrangement substrate on Trends — `saved_items`, the store the
// Overview grid's star, drag and ⋯-menu arrows already write. The Body tab used to
// have a second, order-only one (`trends_card_order` in profile settings) that no UI
// ever wrote; #1643 retired it rather than completing a parallel language for one job
// (#1485-C's convergence, at the data model instead of the interaction).
//
// `pinned` therefore arrives as saved-order card ids (lib/queries/trends-context.ts
// resolves them through the one series-key ↔ card-id mapping), and the composition is
// the shared `mergeStoredOrder`: pinned ids keep their saved sequence, everything else
// follows in ranked order, and a stale id naming no card is simply dropped.
//
// Two precedence consequences, both deliberate:
//   • An explicit ★ beats the `data-present` FLOOR — a pinned sparse card leads the
//     stack, because user intent outranks the neutral presence signal.
//   • It does NOT beat the structural signal above: a growth-tracked profile still
//     leads with its percentile card and its growth-charted measures, whatever is
//     starred. MEMBERSHIP is likewise untouched — a starred card the tab does not
//     render for this profile stays absent (the saved-ref-with-no-tile skip, #1487).
export function bodyCardOrder(
  ctx: TrendsSubjectContext,
  pinned?: readonly string[] | null
): BodyCardId[] {
  const ranked = rankItems(BODY_ITEMS, TRENDS_CARD_TABLE, ctx);
  const isStructural = (id: BodyCardId): boolean =>
    ranked.some(
      (r) => r.id === id && r.boosts.some((b) => b.key === STRUCTURAL_SIGNAL)
    );
  const structural = ranked.map((r) => r.id).filter(isStructural);
  const rest = ranked.map((r) => r.id).filter((id) => !isStructural(id));
  return [...structural, ...mergeStoredOrder(rest, pinned)];
}

// Sort a renderer's already-built list into a card order. Items whose key is not in
// the order keep their relative position at the end (an unregistered card is never
// dropped — the same defensive posture as the dashboard layout merge).
export function applyCardOrder<T>(
  items: readonly T[],
  order: readonly BodyCardId[],
  keyOf: (item: T) => string
): T[] {
  const pos = new Map<string, number>();
  order.forEach((id, i) => pos.set(id, i));
  return items
    .map((item, index) => ({
      item,
      index,
      rank: pos.get(bodyCardId(keyOf(item))) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((e) => e.item);
}

// `orderCardSections` and `growthCardLeads` lived here until #1674.
//
// They existed to reconcile the ranker with a SECOND source of order — the Body
// census's titled "Vitals"/"Composition" boxes: a run ranked by its best member so a
// promotion inside it stayed visible, and a predicate asking whether the growth card
// outranked everything in the chart block. Both were maintenance on that redundancy,
// and it still broke: a clinical card rode into the everyday tier inside its box
// (SpO₂ above steps), the synced-daily block never entered the ordering at all, and
// #1643's contiguous starred run was unsatisfiable — three stars in three boxes can
// only move three boxes.
//
// The census renders ONE flat stack now, so promotion visibility is native (a
// promoted card is simply first) and the growth card leads exactly when the
// life-stage boost ranks it first — which is what the retired helper was
// approximating. `applyCardOrder` over every member is the whole mechanism.
