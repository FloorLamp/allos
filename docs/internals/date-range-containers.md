# Date-ranged container chassis

Status: **shipped** (the `rangeContainsDate` chassis lives in `lib/date-range.ts`; menstrual cycles and illness episodes both format over it — issue #943, #860 Track C)

The **date-ranged container** is a recurring shape in the app: a stored row carries
**identity + user annotations** and a **`[start, end]` window**, and **membership of a
date is DERIVED from that window** — there are **no member foreign keys**. Because
membership is computed, a boundary edit or a retro-create is automatically correct with
nothing re-parented (the #856 item-0 model decision: you can't hang stable annotations off
a tuple whose identity is a date, but you _can_ derive members by date off a stable row).

Two first-class consumers share this shape today:

- **Illness episodes** (`illness_episodes`, #856) — `lib/illness-episode-store.ts`. An
  episode is `[started_at, ended_at)`.
- **Menstrual cycles** (`cycles`, #714) — `lib/cycle.ts`. A recorded period is
  `[period_start, period_end]`.

Per #860 Track C, the pattern extracts **exactly when the second consumer arrives** —
never before (a single-consumer extraction is the speculative generality #860 rejected).
Cycles (#714) were that second consumer, so the range-membership computation now lives once
in `lib/date-range.ts` and both domains format over it (#221 one-question, one-computation).

## The one semantic the chassis owns — and the one it refuses to unify

`lib/date-range.ts` owns the **end-bound convention**, and it expresses **both** rather
than picking one and silently converting the other. A range's `end` means two genuinely
different things across the two consumers:

| Bound           | `end` means                  | Membership of `d` | Consumer                                                 |
| --------------- | ---------------------------- | ----------------- | -------------------------------------------------------- |
| `INCLUSIVE_END` | the **last member day**      | `start ≤ d ≤ end` | menstrual cycles — `period_end` is the last bleeding day |
| `EXCLUSIVE_END` | the **first non-member day** | `start ≤ d < end` | illness episodes — `ended_at` is the first inactive day  |

A null `start` is **unbounded-past** (a member since before the capped change-log); a null
`end` is **open/ongoing** (a member from `start` onward). These two conventions are NOT a
bug to reconcile — they are correct for their domains — so the chassis makes the caller
name its bound and never assumes one. Silently reading cycles' inclusive `period_end` as
illness's exclusive `ended_at` (or vice versa) would grant an off-by-one membership answer.

## The API (`lib/date-range.ts`)

```ts
export type RangeEndBound = "inclusive" | "exclusive";
export const INCLUSIVE_END: RangeEndBound; // cycles: period_end is the last bleeding day
export const EXCLUSIVE_END: RangeEndBound; // illness: ended_at is the first inactive day

export interface DateRange {
  start: string | null; // inclusive first day; null = unbounded-past
  end: string | null; // null = open/ongoing; interpreted per RangeEndBound
}

export function rangeContainsDate(
  range: DateRange,
  date: string,
  endBound: RangeEndBound
): boolean;
```

It is pure list/string math (ISO `YYYY-MM-DD` compares lexicographically), so the pure test
tier, the query layer, and client components can all import it. Pinned by
`lib/__tests__/date-range.test.ts` — the crux case is that the same `end` date is a member
iff the bound is inclusive.

## What the chassis does NOT own: containing-range SELECTION

The chassis owns the **containment test**, not the **strategy for picking which range
contains a date** — and deliberately so, because the two consumers pick differently and
they agree only for non-overlapping data:

- Cycles' `periodOnDate` / `cyclePhaseOnDate` pick the **latest-started period on-or-before
  the date**, then test that one candidate (`lib/cycle.ts`).
- Illness's `getEpisodeRowForDate` **filters to containing rows in SQL, then takes the
  latest start** (`ORDER BY started_at DESC LIMIT 1`).

Unifying those would be a false commonality. Each domain keeps its own iteration/selection;
every one routes the actual containment check through `rangeContainsDate`.

**SQL realizations.** SQL can't call the JS matcher, so the `WHERE` clauses in
`illness-episode-store.ts` (`getEpisodeRowForDate`, `illnessDaysInWindow`) are the SQL
**realization** of the `EXCLUSIVE_END` predicate, kept in step with `rangeContainsDate` by
hand — the same finite-preimage precedent as `biomarkerFamilyKey()` (#394). The one JS
per-day membership loop (`illnessDaysInWindow`) calls `rangeContainsDate` directly.

## Review convention: new containers use the chassis; existing ones stay as-is

- A **NEW** date-ranged container (identity+annotations row, membership derived by date, no
  member FKs) MUST derive membership through `rangeContainsDate` with an explicit bound,
  and document which bound it declares. Add it to the consumer list above.
- The **existing** non-episode/cycle containers — medication courses, protocols
  (`intake_items` course windows), and mesocycles (`lib/mesocycle.ts`) — **stay as-is**.
  Migrating working code is churn; this is a review convention, not a retrofit mandate.
- Reuse the containment test; do **not** try to also share the containing-range selection
  (see above). And never merge the two end-bounds into one "default" — name the bound.
