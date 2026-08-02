// The recent-changes collector's PURE half (#1463 §2/§2b, built here first so #1713
// can consume it — the sequencing the issues agreed: "whichever lands first creates
// the collector, the other adopts it").
//
// ONE definition of "what changed", several windows. The Household member card
// (#1463) asks it at 7 days; the morning digest (#1713) asks the SAME collector at
// 24 hours. The alternative — a second set of per-category `DigestInput` fields —
// mints a second definition that drifts from the card's, which is exactly the #221
// failure mode this repository keeps paying for.
//
// This module holds the shape, the ranker and the cap. The DB gather (which readers
// produce which category) lives in lib/queries/recent-changes.ts, auth-blind and
// profileId-first. Nothing here reads a DB, a clock or a session, so every scenario
// is fixture-testable.

import { defineRankTable, rankItems, type RankItem } from "./rank-core";
import { shiftDateStr } from "./date";
import type { LifeStage } from "./life-stage";
import type { AppRoute } from "./hrefs";

// The categories a change can belong to. The first five are #1463's table; the last
// four are #1713's owner-selected additions (out-of-range vitals ride `vitals`).
export type RecentChangeCategory =
  | "labs"
  | "visits"
  | "growth"
  | "intake"
  | "vitals"
  | "symptoms"
  | "mood"
  | "data";

export const RECENT_CHANGE_CATEGORIES: readonly RecentChangeCategory[] = [
  "labs",
  "visits",
  "growth",
  "intake",
  "vitals",
  "symptoms",
  "mood",
  "data",
];

// One collected change. `text` is ALREADY rendered and already masked (§3: masking
// happens inside the collector so no formatter can forget it). `flagged` marks the
// safety-adjacent floor class — a flagged lab or an out-of-range vital.
export interface RecentChange {
  // Unique within one collection; also the ranker's item id.
  id: string;
  category: RecentChangeCategory;
  text: string;
  // The change's own date (YYYY-MM-DD) when it has one — the newest-first tiebreak.
  date: string | null;
  // Safety-adjacent: a flagged lab or an out-of-range vital. The FLOOR class.
  flagged?: boolean;
  // Survives per-category demotion (#1714): a demoted category surfaces only its
  // notable entries. `flagged` implies notable.
  notable?: boolean;
}

// The static layout, expressed as rank-core base weights (HIGHER ranks EARLIER).
// The first five preserve #1463's table order exactly (labs → visits → growth →
// intake → vitals); #1713's additions sit below them, because the floor — not the
// base weight — is what guarantees an out-of-range vital outranks routine lines.
export const RECENT_CHANGE_BASE: Record<RecentChangeCategory, number> = {
  labs: 8,
  visits: 7,
  growth: 6,
  intake: 5,
  vitals: 4,
  symptoms: 3,
  mood: 2,
  data: 1,
};

// The already-computed subject context the signals read. Never a clock, never a DB:
// the gather resolves these once and hands them over, so the same context always
// produces the same order.
export interface RecentChangeContext {
  // Life stage of the subject — growth lines only matter for a minor.
  lifeStage: LifeStage | null;
  // An illness episode is open right now.
  openEpisode: boolean;
  // Ids whose lab closes a loop (a new result in the same biomarker family as a
  // recent FLAGGED one — "recheck arrived"), the strongest lab-relevance case.
  loopClosureIds?: ReadonlySet<string>;
  // Ids whose change touches a metric a live goal tracks.
  goalTrackedIds?: ReadonlySet<string>;
  // Ids that are a growth percentile-BAND crossing rather than a routine point.
  growthBandCrossingIds?: ReadonlySet<string>;
  // The subject's weekly intake adherence is meaningfully below their OWN baseline.
  adherenceRegression: boolean;
  // id → change, so a signal can read the item it is scoring.
  byId: ReadonlyMap<string, RecentChange>;
}

function has(set: ReadonlySet<string> | undefined, id: string): boolean {
  return set != null && set.has(id);
}

// The signal table (#1463 §2b). Five entries against the budget of six — a new
// signal must DISPLACE one, not accrete beside it.
const RECENT_CHANGE_TABLE = defineRankTable<string, RecentChangeContext>({
  tenant: "recent-changes",
  signals: [
    {
      // Life stage / growth. A minor's growth point matters; a percentile-BAND
      // crossing matters far more than a routine measurement.
      key: "life-stage-growth",
      boost: (item, ctx) => {
        const change = ctx.byId.get(item.id);
        if (!change || change.category !== "growth") return 0;
        const minor =
          ctx.lifeStage === "infant" ||
          ctx.lifeStage === "child" ||
          ctx.lifeStage === "adolescent";
        if (!minor) return 0;
        return has(ctx.growthBandCrossingIds, item.id) ? 6 : 3;
      },
    },
    {
      // An open illness episode makes vitals and visits the live question. The
      // boost is sized to clear the whole base range (labs sits at 8, vitals at 4),
      // because "vitals lead while someone is sick" is the point — a smaller boost
      // would leave a routine unflagged lab above the reading being watched.
      key: "open-episode",
      boost: (item, ctx) => {
        if (!ctx.openEpisode) return 0;
        const change = ctx.byId.get(item.id);
        if (!change) return 0;
        return change.category === "vitals" || change.category === "visits"
          ? 5
          : 0;
      },
    },
    {
      // Loop closure: a recheck arriving for a family that was recently flagged.
      key: "loop-closure",
      boost: (item, ctx) => (has(ctx.loopClosureIds, item.id) ? 5 : 0),
    },
    {
      // A change in something a live goal tracks.
      key: "goal-tracked",
      boost: (item, ctx) => (has(ctx.goalTrackedIds, item.id) ? 2 : 0),
    },
    {
      // Member-relative adherence regression lifts the intake line above routine
      // start/stop churn. Never absolute — the comparison is to their own baseline.
      key: "adherence-regression",
      boost: (item, ctx) => {
        if (!ctx.adherenceRegression) return 0;
        return ctx.byId.get(item.id)?.category === "intake" ? 3 : 0;
      },
    },
  ],
  floors: [
    {
      // #1463's floor, widened at review: a flagged lab AND an out-of-range vital
      // are the same safety-adjacent class and can never rank below a routine line.
      // A guarantee, not a large boost — no combination of signals can defeat it.
      key: "flagged",
      holds: (item, ctx) => ctx.byId.get(item.id)?.flagged === true,
    },
  ],
});

// The window's first INCLUSIVE date for a `sinceDays` window ending at `today`.
// The digest's 24h window is sinceDays 1 → yesterday and today; the household card's
// 7-day window is sinceDays 7. Both edges are computed in the SUBJECT's timezone by
// the caller resolving `today` there (#1463 §3) — never the viewer's.
export function recentChangeWindowStart(
  today: string,
  sinceDays: number
): string {
  const days = Math.max(1, Math.trunc(sinceDays));
  return shiftDateStr(today, -days);
}

// Whether a change's own date falls inside the window. A dateless change (a
// structural signal, not a dated event) is always in-window — it is about NOW.
export function inRecentChangeWindow(
  change: Pick<RecentChange, "date">,
  windowStart: string,
  today: string
): boolean {
  if (change.date == null) return true;
  return change.date >= windowStart && change.date <= today;
}

// Rank the collected changes. Deterministic and total: floor class, then score,
// then base weight, then — for equal base — newest date first, then declaration
// order. Never ranks by VIEWER (#1463): who is looking changes masking, never order.
export function rankRecentChanges(
  changes: readonly RecentChange[],
  ctx: Omit<RecentChangeContext, "byId">
): RecentChange[] {
  if (changes.length === 0) return [];
  const byId = new Map(changes.map((c) => [c.id, c]));
  // Newest-first WITHIN a category before ranking, so rank-core's declaration-order
  // tiebreak lands on the date order the domain wants.
  const ordered = [...changes].sort((a, b) => {
    const ba = RECENT_CHANGE_BASE[a.category];
    const bb = RECENT_CHANGE_BASE[b.category];
    if (ba !== bb) return bb - ba;
    const da = a.date ?? "";
    const db = b.date ?? "";
    if (da !== db) return da < db ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const items: RankItem<string>[] = ordered.map((c) => ({
    id: c.id,
    base: RECENT_CHANGE_BASE[c.category],
  }));
  return rankItems(items, RECENT_CHANGE_TABLE, { ...ctx, byId }).map((r) =>
    byId.get(r.id)!
  );
}

// ---- Data arrival: KINDS, not counts (#1819 item 2) ------------------------
//
// `📥 Google Health Connect: 2271 new records` summed raw inserts across everything,
// so minute-grain heart-rate rows and one body-weight reading counted the same: the
// number was technically true and humanly meaningless. The news is WHAT arrived, and
// the per-row provenance the sync already persists (`integration_sync_rows`, #1333)
// knows exactly that — the target table each written row landed in, and for a
// `metric_samples` row its metric. This is the PURE half: the kind word one written
// row names, and the phrase distinct kinds join into. No second accounting is minted
// — COUNTS stay where they belong, in Data → Review.

// A `metric_samples` metric key → the kind word a person recognizes. Anything
// unmapped falls back to the stored key with its unit suffix and underscores relaxed,
// so a metric added tomorrow reads sensibly before it is listed here.
const ARRIVAL_SAMPLE_KINDS: Record<string, string> = {
  steps: "steps",
  distance_km: "distance",
  active_kcal: "active calories",
  total_kcal: "calories",
  sleep_min: "sleep",
  nutrition_kcal: "nutrition",
  hrv: "HRV",
  resting_hr: "resting heart rate",
  heart_rate: "heart rate",
  spo2: "blood oxygen",
  hydration_ml: "hydration",
};

// The provenance target tables, minus `metric_samples` whose kind is per-metric.
// Keyed by the string the column stores rather than the imported union, so this pure
// module stays independent of the accounting module's type surface.
const ARRIVAL_TABLE_KINDS: Record<string, string> = {
  activities: "workouts",
  body_metrics: "body measurements",
  medical_records: "lab results",
  practice_logs: "wellness sessions",
};

export function arrivalKind(
  targetTable: string,
  metric: string | null | undefined
): string {
  if (targetTable !== "metric_samples") {
    return ARRIVAL_TABLE_KINDS[targetTable] ?? "records";
  }
  const key = (metric ?? "").trim();
  if (!key) return "daily metrics";
  return (
    ARRIVAL_SAMPLE_KINDS[key] ??
    key.replace(/_(min|km|kcal|ml|g)$/, "").replaceAll("_", " ")
  );
}

// How many kinds one arrival line names before it collapses to "+N more". An arrival
// line has to stay a line, and the tail counts KINDS — never records.
export const MAX_ARRIVAL_KINDS = 4;

// "sleep, heart rate, steps" — the distinct kinds in the order given, deduped, capped.
// Null when nothing resolvable arrived, which is the signal to omit the line: a
// provider whose writes name no user record has no arrival to report (its accounting
// lives in Data → Review), and manufacturing one would be the vocabulary disease
// #1772 named.
export function arrivalKindsPhrase(kinds: readonly string[]): string | null {
  const distinct = [...new Set(kinds.map((k) => k.trim()).filter(Boolean))];
  if (distinct.length === 0) return null;
  const named = distinct.slice(0, MAX_ARRIVAL_KINDS);
  const rest = distinct.length - named.length;
  return rest > 0 ? `${named.join(", ")}, +${rest} more` : named.join(", ");
}

// The per-member line cap (#1463 §2): a 40-record import must not flood a card.
export const RECENT_CHANGES_MAX_LINES = 4;

export interface RecentChangeRender {
  // The lines to render, cap applied, overflow line already appended when needed.
  lines: string[];
  // How many ranked changes did not fit (0 when everything fit).
  overflow: number;
}

// Apply the cap and the overflow line. Overflow SAYS "+N more" and links; it never
// spills. A quiet window produces NO lines at all — the surface must not manufacture
// news to fill space (the same rule the digest's delta line already follows).
export function renderRecentChanges(
  ranked: readonly RecentChange[],
  opts: {
    max?: number;
    // "this week" for the household card, "since yesterday" for the digest. Omitted
    // ⇒ a bare "+N more".
    overflowLabel?: string;
    // Appended to the overflow line when the surface can carry a link. A typed route
    // (or an absolute deep-link base + route the notification channels build), never a
    // free string.
    overflowHref?: AppRoute | null;
  } = {}
): RecentChangeRender {
  const max = Math.max(1, opts.max ?? RECENT_CHANGES_MAX_LINES);
  if (ranked.length === 0) return { lines: [], overflow: 0 };
  const shown = ranked.slice(0, max);
  const overflow = ranked.length - shown.length;
  const lines = shown.map((c) => c.text);
  if (overflow > 0) {
    const label = opts.overflowLabel ? ` ${opts.overflowLabel}` : "";
    const link = opts.overflowHref ? ` ${opts.overflowHref}` : "";
    lines.push(`+${overflow} more${label}${link}`);
  }
  return { lines, overflow };
}

// Per-category demotion (#1714): a demoted category surfaces ONLY its notable
// entries; every other category is untouched. Applied BEFORE ranking so a demoted
// category's routine lines never consume cap slots. `flagged` implies notable — a
// demotion is an attention preference, never a way to hide a safety-adjacent line.
export function applyRecentChangeDemotion(
  changes: readonly RecentChange[],
  demoted: ReadonlySet<RecentChangeCategory>
): RecentChange[] {
  if (demoted.size === 0) return [...changes];
  return changes.filter(
    (c) => !demoted.has(c.category) || c.notable === true || c.flagged === true
  );
}
