# Food regularity

Status: **shipped** (#2380)

Real logging is far more regular than the app assumed. On a 22-day ledger one
profile's morning window held **two food groups and nothing else** — the same
two, nearly every day, tapped 1.4 seconds apart. The ledger held that pattern and
nothing used it.

This document records what "regular" means here, the declared thresholds, the two
things the measure is used for — a one-tap logging shortcut, and the monthly recap's
food-habit observation (#2397) — and the boundaries that are decisions rather than
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
| `FOOD_PERIOD_HABIT_MIN_SHARE`     | 0.25  | the PERIOD measure's threshold (#2397) — roughly weekly across the period, which is where "part of how I eat" starts; below the habitual share on purpose, see below          |

**Under the gate the answer is `null`, and `null` means silence.** Not a hedge,
not a confidence score, not a "not enough data yet" nag. A consumer must read it
as _no expectation_ — never as _habit broken_.

## The same measure over a PERIOD, at day grain (#2397)

"You've eaten fatty fish 12 of the past 30 days" is this module's question asked of a
whole **day** instead of one meal window, over a **period** instead of the fixed
21-day span. Same denominator decision, same gate, same silence:
`foodPeriodRegularity(events, { from, to })` counts a group's days over the days food
was logged **at all**, and answers `null` below `FOOD_REGULARITY_MIN_WINDOW_DAYS`.

An adapter, not a second measure. Two things are genuinely different and both are
declared:

- **Day grain, not the three windows.** A window habit is a rhythm ("fermented, most
  mornings"); a period habit is a diet ("fatty fish about twice a week"). Summing three
  window measures answers neither — a group eaten at lunch on Monday and at dinner on
  Tuesday is two days of one habit, not two half-habits.
- **A lower threshold, for a stated reason.** `FOOD_REGULARITY_HABITUAL_SHARE` (0.6)
  gates an OFFER to write food on one tap, so it must clear "most days, with room to
  miss" before the app pre-fills anything. `FOOD_PERIOD_HABIT_MIN_SHARE` (0.25) gates a
  sentence that only reports back what the ledger already holds, and #2397's own
  example — fatty fish 12 of 30 days — is a real dietary pattern at 0.4 that the offer
  threshold would have called nothing.

`lib/food-habit-observation.ts` turns that measure into the one sentence the monthly
recap states, and it is where the doctrine constraint lives — see below.

## What it is used for: one tap instead of two

The first consumer is the Food tab's log bar: **"Your usual `<window>`"**, a
button that logs one serving of each habitual group the window still has nothing
logged for, on the profile's own today.

That is the whole payoff, and it was chosen over the alternatives on purpose. An
insight card telling someone they are predictable spends attention and returns
nothing; the pattern's actual value is that the next two taps are knowable, so the
right thing to build is the shortcut, not the observation. Nothing renders the
window measure's share, its span or the word "regular" anywhere in the UI.

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
to refuse and asserting the day counter _and_ its ledger events are empty — the
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
`lib/substance-daily-totals-write.ts`), or which carries an active **cap-direction**
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

## The monthly observation may never be joined to a biomarker (#2397)

Two shapes of food-habit observation were on the table, and only one of them is two
facts:

1. _"Fatty fish 12 of 26 logged days, a source of Omega-3."_
2. _"You consistently consume alcohol, and your liver biomarkers are flagged."_

The second is two true statements placed side by side so the reader draws a third the
app has no standing to assert. Flagged liver enzymes have many causes; the app's whole
disclaimer posture exists to avoid exactly this move, and juxtaposition is an assertion
however carefully the sentence is worded. **Curated knowledge may relate a food to a
biomarker — that is #577's and #2377's direction, and it is sourced. Pattern detection
may not diagnose.**

So the boundary is structural rather than editorial, and it is what
`lib/food-habit-observation.ts` exists for:

- An observation carries a group, a day count, a denominator and a nutrient noun.
  There is **no field** for a biomarker, a reading, a flag or a direction, so no
  renderer downstream can pair one with a pattern by choosing to.
- The rationale resolves through the food catalog's own `nutrients` links and the map
  entry's **label**. The same entry carries the biomarker families that nutrient is
  read from, one property access away — so the module's test scans its source for any
  mention of them and censuses its imports.
- A cap-direction group is excluded here too, and the restructured replacement is the
  cadence ledger's own verdict on a target **the user set**: "over the Alcohol cap in
  3 of 4 weeks", silent for a profile that declared no cap
  (`docs/internals/cadence-ledger.md`).
- The sentence says **"of 26 logged days"**, never "of 30 days". A habit line risks
  congratulating diligent record-keeping rather than eating; naming the denominator is
  what keeps someone who eats fish without logging it from reading as worse than
  someone who logs everything.

And it is a **share, never a run** (#1955): "12 of 26" is the shape that survived that
retirement, "12 days in a row" is the shape it removed, and it must not return through
a food door.

## Boundaries — decisions, not gaps

- **Never a target.** `frequency_targets` and the cadence ledger own "how often
  should this happen". Regularity answers "how often does it happen", and a
  detected pattern must never become a duty on its own. No streak, no verdict, no
  right-sizing suggestion.
- **Never contact this measure originates.** Nothing here starts a conversation,
  decorates a nudge, or emits a finding: no `dedupeKey`, no builder, no bus presence.
  The window measure is a logging affordance on a page the user opened (class 3 of the
  attention doctrine's surface taxonomy, `docs/internals/findings.md`), and the period
  measure is one line inside the periodic recap — a send the profile already
  configured, at a cadence it chose, which this adds nothing to. The send count is
  unchanged either way. Eating something different for breakfast is still not an event
  that warrants contact.
- **Never a deviation notice.** A missing usual group produces the offer's
  absence, and nothing else.

## Where it lives

| Piece                                             | File                                                                                                                                                                                                                                                                         |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the measure, the gate, the offer rule             | `lib/food-regularity.ts` (window and period)                                                                                                                                                                                                                                 |
| the monthly observation and its sentence          | `lib/food-habit-observation.ts`                                                                                                                                                                                                                                              |
| the gather, the cap exclusion, the standing offer | `lib/queries/nutrition.ts`                                                                                                                                                                                                                                                   |
| the auth-blind write core                         | `lib/food-usual-write.ts`                                                                                                                                                                                                                                                    |
| the Server Action                                 | `app/(app)/nutrition/actions.ts` (`logUsualFood`)                                                                                                                                                                                                                            |
| the rendered offer                                | `app/(app)/nutrition/FoodLogBar.tsx`                                                                                                                                                                                                                                         |
| the recap line that states it                     | `lib/recap.ts` (`food-habits`), gathered by `lib/notifications/recap-data.ts`                                                                                                                                                                                                |
| tests                                             | `lib/__tests__/food-regularity.test.ts`, `lib/__tests__/food-habit-observation.test.ts`, `lib/__db_tests__/food-regularity.test.ts`, `lib/__db_tests__/recap-targets-and-habits.test.ts`, `lib/__action_tests__/food-usual.actions.test.ts`, `e2e/food-slot-ranking.spec.ts` |
