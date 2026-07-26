// The shared ranking substrate (#1490, instantiating the #1463 decision).
//
// Several surfaces need the SAME mechanical guarantee — "order these known items
// by a base weight plus a small table of deterministic boosts, keep a hard floor
// class on top, and break ties stably" — for genuinely DIFFERENT questions:
//
//   • #1490 (this issue's tenant, `lib/trends-card-rank.ts`): which chart cards a
//     Trends tab leads with, from STABLE subject context (life stage, live goals,
//     monitored conditions, data presence).
//   • #1463 (unlanded): which recent-changes lines a Household member card leads
//     with, from TRANSIENT context (open episode, loop-closing lab, adherence
//     regression) under a flagged-lab / out-of-range-vital floor.
//   • #1413's `rankNowCards` (landed, lib/now-strip.ts): which dashboard card the
//     moment deserves. Left alone on purpose — it also CAPS and gates on
//     eligibility, and re-plumbing a shipped ranker buys nothing; it is named here
//     so the third tenant looks here first.
//
// The rankers themselves stay SEPARATE (#221/#860: share behaviors, never merge
// engines by shape) — a tenant brings its own item set, base weights, signal table
// and context type. What lives here is only the mechanics:
//
//   score  = base + Σ boosts                      (deterministic, explainable)
//   floors = a hard class that can never rank below a non-member
//   ties   = base weight, then declaration order  (the caller's static layout)
//
// Nothing here reads a DB, a clock, or a session: `rankItems` is a pure function of
// (items, table, context). That is what makes a tenant fixture-testable per scenario.

// The signal-table cap every tenant inherits (#1463's discipline, restated in
// #1490): a ranker with an unbounded signal list rots — every signal is also a
// builder-input bug surface (#448), and an accreted table stops being explainable.
// A new signal must DISPLACE or measurably beat an existing one.
export const RANK_SIGNAL_BUDGET = 6;

// One rankable thing. `base` is the static layout expressed as a weight: HIGHER
// ranks EARLIER, so a tenant whose layout is an ordered array uses
// `base = array.length - index`.
export interface RankItem<Id extends string = string> {
  id: Id;
  base: number;
}

// One deterministic boost rule. Returns the points to add (0 = not firing for this
// item). Must be a pure function of the item + the tenant's context — no clock, no
// DB, no randomness — so the same fixture always yields the same order.
export interface RankSignal<Id extends string, Ctx> {
  key: string;
  boost: (item: RankItem<Id>, ctx: Ctx) => number;
}

// A hard class constraint. Every item for which `holds` is true ranks above every
// item for which it is false, whatever the scores say. This is the mechanical form
// of #1463's "a flagged lab can never rank below an unflagged line" and of #1490's
// "a card with no data can never lead" — a guarantee, not a large boost, so no
// combination of signals can quietly defeat it.
export interface RankFloor<Id extends string, Ctx> {
  key: string;
  holds: (item: RankItem<Id>, ctx: Ctx) => boolean;
}

export interface RankTable<Id extends string, Ctx> {
  // Names the tenant in budget errors ("trends-cards", "household-digest", …).
  tenant: string;
  signals: readonly RankSignal<Id, Ctx>[];
  // Applied in declaration order: the FIRST floor is the outermost tier.
  floors?: readonly RankFloor<Id, Ctx>[];
  // Per-tenant override, still capped at RANK_SIGNAL_BUDGET.
  budget?: number;
}

export class RankTableError extends Error {}

// Validate a signal table at construction. Deliberately a THROW at module load
// rather than a lint: an over-budget or duplicate-keyed table is a design error
// that must never reach a user-visible order, and a static table can only fail
// this in development or CI.
export function defineRankTable<Id extends string, Ctx>(
  table: RankTable<Id, Ctx>
): RankTable<Id, Ctx> {
  const budget = table.budget ?? RANK_SIGNAL_BUDGET;
  if (budget > RANK_SIGNAL_BUDGET) {
    throw new RankTableError(
      `${table.tenant}: budget ${budget} exceeds RANK_SIGNAL_BUDGET ${RANK_SIGNAL_BUDGET}`
    );
  }
  if (table.signals.length > budget) {
    throw new RankTableError(
      `${table.tenant}: ${table.signals.length} signals exceeds the budget of ${budget} — displace one instead of accreting`
    );
  }
  const keys = new Set(table.signals.map((s) => s.key));
  if (keys.size !== table.signals.length) {
    throw new RankTableError(`${table.tenant}: duplicate signal key`);
  }
  return table;
}

export interface RankedItem<Id extends string> {
  id: Id;
  base: number;
  score: number;
  // Which floors held, outermost first — the explainability half of the guarantee.
  floors: readonly string[];
  // Every FIRING boost (amount !== 0), in signal-declaration order. Kept so a
  // tenant can explain an order ("growth leads: life-stage") in a tooltip, a test
  // assertion, or a debug view without re-deriving the scoring.
  boosts: readonly { key: string; amount: number }[];
}

// Rank `items` under `table` in `ctx`. Deterministic and total:
//
//   1. floor tier   — items holding the outermost floor first, and so on inward;
//   2. score        — base + Σ firing boosts, highest first;
//   3. base weight  — the tenant's static layout, highest first;
//   4. declaration  — the order `items` came in, so equal-base items never swap.
//
// (3) is the load-bearing tie-break: with no signal firing, the output is the input
// order EXACTLY — the "no signals → today's layout" identity every tenant tests.
export function rankItems<Id extends string, Ctx>(
  items: readonly RankItem<Id>[],
  table: RankTable<Id, Ctx>,
  ctx: Ctx
): RankedItem<Id>[] {
  const floors = table.floors ?? [];
  const scored = items.map((item, index) => {
    const boosts: { key: string; amount: number }[] = [];
    let score = item.base;
    for (const signal of table.signals) {
      const amount = signal.boost(item, ctx);
      if (amount !== 0) {
        boosts.push({ key: signal.key, amount });
        score += amount;
      }
    }
    const held: string[] = [];
    // A floor VECTOR, outermost first: floor i is compared before floor i+1, so a
    // second floor refines within the first rather than competing with it.
    const tiers = floors.map((f) => {
      const holds = f.holds(item, ctx);
      if (holds) held.push(f.key);
      return holds ? 1 : 0;
    });
    return {
      item,
      index,
      score,
      tiers,
      ranked: { id: item.id, base: item.base, score, floors: held, boosts },
    };
  });
  return scored
    .sort((a, b) => {
      for (let i = 0; i < a.tiers.length; i++) {
        if (a.tiers[i] !== b.tiers[i]) return b.tiers[i] - a.tiers[i];
      }
      if (a.score !== b.score) return b.score - a.score;
      if (a.item.base !== b.item.base) return b.item.base - a.item.base;
      return a.index - b.index;
    })
    .map((s) => s.ranked);
}

// The ranked ids alone — the shape most callers want.
export function rankedIds<Id extends string, Ctx>(
  items: readonly RankItem<Id>[],
  table: RankTable<Id, Ctx>,
  ctx: Ctx
): Id[] {
  return rankItems(items, table, ctx).map((r) => r.id);
}

// Build the `RankItem` list from a tenant's static layout array: index 0 gets the
// highest base, so "the array IS the current layout" stays literally true.
export function itemsFromLayout<Id extends string>(
  layout: readonly Id[]
): RankItem<Id>[] {
  return layout.map((id, index) => ({ id, base: layout.length - index }));
}

// A user's STORED arrangement beats the ranker permanently (#1490's override, the
// #1485-C drag contract): every id the user arranged keeps its stored position, and
// anything the stored order has never seen — a card added by a later release, or one
// that only just gained data — is APPENDED in ranked order rather than reshuffling
// what the user arranged. Unknown/stale stored ids are dropped (a card removed by a
// release must not leave a hole), which is the `resolveWidgetList` posture applied
// to a ranked default instead of a registry default.
export function mergeStoredOrder<Id extends string>(
  ranked: readonly Id[],
  stored: readonly string[] | null | undefined
): Id[] {
  if (!stored || stored.length === 0) return [...ranked];
  const known = new Set<string>(ranked);
  const seen = new Set<string>();
  const out: Id[] = [];
  for (const id of stored) {
    if (known.has(id) && !seen.has(id)) {
      out.push(id as Id);
      seen.add(id);
    }
  }
  for (const id of ranked) {
    if (!seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  return out;
}
