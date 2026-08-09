# Food regularity

Status: **shipped** (#2380)

Real logging is far more regular than the app assumed. On a 22-day ledger one
profile's morning window held **two food groups and nothing else** — the same
two, nearly every day, tapped 1.4 seconds apart. The ledger held that pattern and
nothing used it.

This document records what "regular" means here, the declared thresholds, the one
thing the measure is used for, and the boundaries that are decisions rather than
gaps.

## The measure

`lib/food-regularity.ts` is pure — no DB, no clock, no model call. Given events
that already carry a derived window, and a `today`, it answers per window:

| Field          | Meaning                                                              |
| -------------- | -------------------------------------------------------------------- |
| `observedDays` | days in the span on which **anything** was logged in this window     |
| `groups[]`     | each group's distinct days in that window, and `days / observedDays` |

Windows come from `foodEventWindow` (`lib/food-slot-count.ts`), so a habit counts
the same however its window was established — declared on the backfill tab,
captured as an eating time (#2019), or derived from the tap stamp on a legacy row.

### The denominator is the decision

A group's share is over the days the **window** was logged, not over every day in
the span. A morning with nothing logged is no evidence about what this person eats
for breakfast; it is evidence about whether they logged breakfast, which is a
different question with a different feature behind it (#2376). Keeping the two
apart is what makes this measure usable as that feature's gate without absorbing
it: "usually fermented and berries" stays true for someone who skips a morning,
and stays silent for someone with no morning habit at all.

### The declared constants

| Constant                          | Value | Why                                                                                                                                                                           |
| --------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FOOD_REGULARITY_SPAN_DAYS`       | 21    | three **whole weeks**, so a weekday-shaped rhythm is counted the same number of times whichever day the span starts on; strictly inside the ranking's 365-day frecency window |
| `FOOD_REGULARITY_MIN_WINDOW_DAYS` | 7     | **the gate**: a full week of observations of that window before the app will call anything a pattern                                                                          |
| `FOOD_REGULARITY_HABITUAL_SHARE`  | 0.6   | "most days, with room to miss" — five of seven at the gate                                                                                                                    |
| `FOOD_USUAL_MIN_GROUPS`           | 2     | below two the ranked bar is already one tap, so the shortcut would cost more to read than it saves                                                                            |

**Under the gate the answer is `null`, and `null` means silence.** Not a hedge,
not a confidence score, not a "not enough data yet" nag. A consumer must read it
as _no expectation_ — never as _habit broken_.

## What it is used for: one tap instead of two

The single consumer is the Food tab's log bar: **"Your usual `<window>`"**, a
button that logs one serving of each habitual group the window still has nothing
logged for, on the profile's own today.

That is the whole payoff, and it was chosen over the alternatives on purpose. An
insight card telling someone they are predictable spends attention and returns
nothing; the pattern's actual value is that the next two taps are knowable, so the
right thing to build is the shortcut, not the observation. Nothing renders the
share, the span or the word "regular" anywhere in the UI.

**It is an OFFER. The user's tap is the write.** The app never logs food on
anyone's behalf, and there is no path by which this can fire from a schedule, a
nudge, or any surface the user did not open.

### Rendered from state, on both sides

`usualFoodOffer` (pure) takes the habitual keys and what the window already holds,
and returns what a tap would write — or `[]`, which is _no button at all_.

- The **button's label names every group it will write** (`namesPhrase`), so the
  offer cannot promise a write it will not perform.
- The **write core calls the same function again** against fresh server state
  (`logUsualFoodCore`, `lib/food-usual-write.ts`) and writes only the intersection
  with the keys the button named. So a forged, replayed or stale submission can
  never write outside the offer that currently stands, and a page left open while
  breakfast was logged from Telegram lands on a typed `nothing-to-log` refusal
  rather than a second breakfast.
- Undo the servings and **the offer comes back** — it is a pure function of state,
  with no dismissal bookkeeping anywhere.

**The set lands whole or not at all**, and that is a `throw`, not a `return`.
`writeTx` is `db.transaction(fn).immediate()`, and better-sqlite3 **commits on a
normal return** — it rolls back only on a throw. So a mid-loop
`return { kind: "nothing-to-log" }` would commit the servings already written
while telling the caller nothing was, which is worse than a silent partial write:
the bar re-renders from server state, the offer shrinks, and the user is looking
at a breakfast they were just told did not happen. `UsualFoodRefused` is thrown
inside the callback and caught immediately outside it, mapped back to the same
public outcome. The early `toLog.length === 0` return is a plain return **and
only that one is**: nothing has been written at that point, so committing an
empty transaction and reporting "nothing to log" are the same fact.
`lib/__db_tests__/food-regularity.test.ts` pins it by forcing one group of a pair
to refuse and asserting the day counter *and* its ledger events are empty — the
outcome alone would have passed against the defect.

`food_log` is deliberately _not_ a gated `STATEFUL_WRITE_TABLES` member (a second
serving is a second serving, #2037), so this discipline lives in the **offer**
rather than in the counter. Registered in `ONE_TAP_AFFORDANCES` as `food-usual`:
`idempotent` · `outcome-toast`, excluded from the offline queue with the
`period-lifecycle` argument (an additive replay of an expired offer double-logs;
the single-serving taps underneath it still queue, so nothing is unreachable).

### Today only

No date crosses the wire; the core resolves the profile's own `today`. An offer
that could bulk-backfill days nobody remembers would feed its own evidence back
into the ledger it is derived from.

## Cap-direction groups are excluded, not merely neutral

A group whose `food_log` counter **is** a substance ledger (alcohol,
`lib/substance-history-write.ts`), or which carries an active **cap-direction**
frequency target, may be _measured_ — the cadence ledger's own cap reporting is
entitled to the data — and is never _presented back as an expectation_.

Applied naively, regularity here produces _"you usually have alcohol in the
evening"_, which is a sentence this app does not say: #998 already settled that a
cap has no to-go or pace state, and reflecting the pattern back normalises the
thing the cap exists to reduce. Alcohol is excluded **unconditionally** — target
or no target — because whether the user has declared a weekly cap does not change
what saying it would do. The target-driven half selects by `cadenceDirection`
rather than by subtracting a scope kind, so a future inverted scope joins by
declaring its direction (`getCapDirectionFoodGroups`).

**What is not excluded: the catalog's `limit` tier.** #1980 ruled that tier may
label a group and section an overflow but never moves one into or out of a fast
path — a group you log often is a group you need to log fast. Alcohol's exclusion
is about cap _semantics_, not disapproval.

## Boundaries — decisions, not gaps

- **Never a target.** `frequency_targets` and the cadence ledger own "how often
  should this happen". Regularity answers "how often does it happen", and a
  detected pattern must never become a duty on its own. No streak, no verdict, no
  right-sizing suggestion.
- **Never a send.** Nothing here originates contact, decorates a nudge, or emits a
  finding. It has no `dedupeKey`, no builder, no bus presence, because it is not a
  finding — it is a logging affordance on a page the user opened (class 3 of the
  attention doctrine's surface taxonomy, `docs/internals/findings.md`). Eating
  something different for breakfast is not an event that warrants contact.
- **Never a deviation notice.** A missing usual group produces the offer's
  absence, and nothing else.

## Where it lives

| Piece                                             | File                                                                                                                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the measure, the gate, the offer rule             | `lib/food-regularity.ts`                                                                                                                                                |
| the gather, the cap exclusion, the standing offer | `lib/queries/nutrition.ts`                                                                                                                                              |
| the auth-blind write core                         | `lib/food-usual-write.ts`                                                                                                                                               |
| the Server Action                                 | `app/(app)/nutrition/actions.ts` (`logUsualFood`)                                                                                                                       |
| the rendered offer                                | `app/(app)/nutrition/FoodLogBar.tsx`                                                                                                                                    |
| tests                                             | `lib/__tests__/food-regularity.test.ts`, `lib/__db_tests__/food-regularity.test.ts`, `lib/__action_tests__/food-usual.actions.test.ts`, `e2e/food-slot-ranking.spec.ts` |
