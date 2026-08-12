# The curated limit direction (#2377)

Status: shipped

"Which foods should I eat more of?" has been answered from a LOW-flagged biomarker
since #577, and its high-side twin — which foods a HIGH flag says to limit — has
existed since #775 as `meta.reduceEntries` in the curated nutrient-food map. Four
entries, each with a plain-language evidence line and a public source:

| key        | families                        | groups it names                                 |
| ---------- | ------------------------------- | ----------------------------------------------- |
| `ldl-apob` | LDL Cholesterol, ApoB           | `fried_food`, `processed_meat`                   |
| `glucose`  | Glucose, Hemoglobin A1c         | `added_sugar`, `sugary_drinks`, `refined_grains` |
| `urate`    | Uric Acid                       | `alcohol`, `sugary_drinks`                       |
| `sodium`   | Sodium                          | `processed_meat`                                 |

The map is deliberately small. An uncovered family simply has no limit answer, and
that is measurable rather than hidden — the same posture #2378 took for the curated
supplement route. Nothing here is generated: the engine is
`suggestFoods` (`lib/food-suggest.ts`), the curated table is committed and
human-reviewable, and there is no AI path on the limit direction at all.

What #2377 adds is **reach, not knowledge**. The limit direction rendered only on the
biomarker detail page and the coaching tab — surfaces you visit when thinking about
labs, not when deciding what to eat. It now also reaches the **log tap** and the
**morning digest**.

## The modules

- `lib/food-limit-note.ts` — pure. Owns every rule, every gate and every string.
- `lib/queries/food-limit.ts` — the gather. Declares no knowledge of its own; it
  assembles the pure function's inputs from three existing readers
  (`getFoodSuggestions`, `foodDrugEventFindingsFor`, `getCapDirectionFoodGroups`)
  plus the shared suppression bus.

## The rule that keeps this apart from #2572

#2397/#2572 forbid one specific move: the app observing YOUR pattern, observing YOUR
result, and placing them side by side so the reader draws a third statement the app has
no standing to assert. `lib/food-habit-observation.ts` keeps that rule structurally, and
its guard test is file-scoped — it does not reach this module.

This is a different act. A curated, general statement ("published guidance for a high
LDL/ApoB lists fried food among the foods to limit") is a **lookup** in a human-reviewed
table with a cited source. It is true of everyone with that result and asserts nothing
about this person's diet. That is the shape #577 has shipped for years, pointed the
other way. A **correlation the app invents** from two of one person's own data series is
the forbidden thing.

The border is drawn structurally, in the same idiom as the incumbent guard:

> A biomarker may be named beside a **single act**. It may never be named beside a
> **count over days**.

- `FoodLimitTapNote` answers ONE serving the user just logged. It names the marker,
  because the marker is what selected the guidance. There is no count, no share, no
  trend and no run in it.
- `FoodLimitDayObservation` is pattern-shaped, so it has **no field** for a biomarker,
  a flag, a reading, a value or a direction, and the digest line never names one. A
  renderer downstream cannot cross the line by choosing to, because it is never handed
  a result.

Pinned by `lib/__tests__/food-limit-note.test.ts` (a source scan, an import census, a
structural key check and an assertion that no reduce entry's biomarker name can reach
the digest head) and by a DB fixture with both halves of the forbidden sentence on file.

## Frequency discipline, with no stored marker

A note on every tap becomes wallpaper within a week. Two gates, both **derived** from
the log the app already keeps — no new table, no marker to sweep, nothing that can rot:

1. **At most one note per group per day.** The tap must be the day's first serving of
   that group.
2. **The dietary note speaks once per activation.** It must also be the first serving of
   the group logged on or since the day the flagged reading was collected. A note shown
   and not acted on is not re-shown by logging again; a new result re-arms it once.

The interaction note is per-**day** rather than per-activation, matching the granularity
its own dedupe key already declares (`foodDrugEventKey(item, rule, date)` — "a second
course is a second signal"), which is the right cadence for a safety-adjacent rule.

When both fire, the interaction wins the single slot and the dietary claim is **not**
re-queued: by tomorrow the group has been logged since the flag. The ceiling is one note
per group per day and the dietary claim's justification is timeliness.

## Two sources, two voices

A food–drug interaction is a hard, sourced rule with a named mechanism. A
biomarker-motivated dietary limit is softer and sometimes contested. Rendering them
identically either inflates the dietary advice or deflates the interaction, and the
second failure is the dangerous one. So:

- the interaction note is the existing care-tier finding's **own words**
  (`foodDrugEventTitle` / `foodDrugEventDetail`) — one computation moved to the moment,
  not a second sentence about the same fact;
- it always outranks the dietary note;
- it carries `hold: true`, and the log bar keeps it up until the reader dismisses it
  while a dietary note takes the ordinary timer. Prominence, not tone: an error tone on
  a tap that succeeded reads as "your tap failed" (#2296).

## #998: a limit is a cap

Where a group already carries cap semantics — alcohol, whose `food_log` counter IS the
substance ledger, or any group under an active cap-direction target — the cap vocabulary
owns the message and the **dietary** half stays silent. Two systems saying "limit
alcohol" in two vocabularies is worse than one saying it well.

The refusal does **not** extend to the interaction. Alcohol + metronidazole is the live
case the whole food–drug ledger was built for (#2021); silencing it because alcohol
carries a cap would delete the feature's reason to exist.

Nothing anywhere in the vocabulary reports a streak, a run, a pace, a to-go or a day
spent "under" a limit.

## Reach

- **Log tap** — class 3, user-initiated: the note exists only because the user just
  acted, and it is the tap's own answer. It runs strictly **after** the write and can
  only produce text, so #559 ("context gates order, never what can be logged") holds
  structurally rather than by review.
- **Digest** — a **ride-along**, appended only to a Yesterday section that already has
  content, so it can neither cause a send nor be one. Same posture as the digest time
  suggestion (#2217) and the same contact-consent reason: the system may reduce contact
  unilaterally, never increase it, and nobody declared "message me when I eat fried
  food." The gate lives in `buildDigest`, which is the code that knows whether the
  section exists.
- **Suppression** — both surfaces read the shared bus under the `normal` policy, so a
  `food-reduce:` family dismissed on the biomarker page or the coaching tab cannot be
  resurrected by a log tap. It is emphatically not `safety-ungated`; that carve-out
  belongs to dose reminders and missed-dose escalations.

## How this would learn it should stop (#2385)

Prose, in the issue and in the module header. No registry, no scoring engine, no
telemetry.

- **What would show it working** — for profiles that received a note, that group's
  servings per **logged day** falls over the following weeks while the number of days
  they log food at all holds steady.
- **What would show it wrong** — food logging thins out after a note, or the profile
  stops logging that ONE group while continuing to log everything else. Either means the
  note taught people to hide the serving rather than reconsider it, and an honest log is
  worth more than a nudged one.
- **The deceptive success** — "servings of the limited group went down" is exactly the
  number that improves in the harm case, because a group that stopped being LOGGED and a
  group that stopped being EATEN are indistinguishable in it. It may never be read
  without the denominator beside it.
