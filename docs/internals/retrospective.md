# The annual retrospective (#2179)

Status: **partial (the rendered page shipped; the pointer send, the AI narrative
and the year-native blocks are not built)**

`/retrospective` is a rendered, once-a-year **"year in health"** page. It is a
sibling artifact to the periodic review (#2178), deliberately **not** a fourth
cadence tier of it.

## The ruling this implements

Yearly is not a review rhythm. A profile whose only review arrives every twelve
months has no review, and a year does not fit in a message. So at week scale the
**message is the product**; at year scale the **page is**. That resolves #2166's
send-vs-surface question differently per scale, and it is why the year lives on
the scale axis but not in the cadence picker.

## One engine, four scales, three cadences

`lib/recap-scale.ts` now carries two lists rather than one:

|                 | members                        | what it is                                                       |
| --------------- | ------------------------------ | ---------------------------------------------------------------- |
| `RecapScale`    | week, month, quarter, **year** | the period-arithmetic + line-model axis                          |
| `ReviewCadence` | week, month, quarter           | the **sendable** subset, and the only thing `planRecapSend` sees |

Every registry row declares `cadence`, and `REVIEW_CADENCES` is derived from that
flag. That is what makes "the year never lands in the recap slot" true **by
construction** rather than by a filter each caller has to remember:

- `recapScalesAtOrAbove` cannot return it, so the slot planner cannot pick it.
- `parseRecapScale` reads a stored `year` as `week`, so a hand-edited setting
  cannot turn the review into a twelve-month rhythm.
- The cadence picker and the narrative-kind list iterate `REVIEW_CADENCES`.
- `recapMarkerKey`, `getRecapScale`/`setRecapScale` and `PeriodRecapKind` are all
  typed `ReviewCadence`, so a year value does not compile on the send side.

The year's own arithmetic is the same calendar machinery months and quarters use,
with a twelve-month span: the subject is a calendar year and the comparison is the
whole prior calendar year.

## The one deliberate rule-bend, declared rather than smuggled

The recap contract — _a summary, never a score_ — holds for **reviews** because a
total invites judgment, and `RECAP_LINE_MODEL`'s never-re-total rule is how it is
enforced ("you did 47 workouts" is four weekly lines summed and handed back with
an authority none of them had).

The retrospective is **commemorative, not evaluative**. "214 workouts, 12 PRs" is
the genre's point. So the exemption is scoped, per line, as
`countsAsRecordAt: ["year"]` — the scales at which a line's value is a **raw count
kept as a record**.

**Its price is the other half of the ruling: a count carries no comparison.**
`buildRecap`'s single `push` strips the comparison off any exempt line at an
exempt scale, so "214 workouts, down from 231" cannot be rendered by any surface.
Trajectories carry the comparisons; counts just are.

Two pins hold the shape:

- `lib/__tests__/recap.test.ts` — no **cadence** may ever carry the exemption, and
  a count line may only reach a non-week scale via a declared exemption.
- `lib/__tests__/retrospective.test.ts` — the exemption's price, observed through
  `buildRecap` rather than in the declaration, plus the year's line set.

## What the year says

Nine lines, each with its reason in `RECAP_LINE_MODEL`:

- **Counts as record** (exempt): `workouts`, `prs`, `goals`, `goals-missed`.
- **Long arcs** (comparisons kept): `training-mix`, `weight-trajectory`,
  `sleep-duration`.
- **Context and events**: `recovery` (leads, so the counts are read against what
  the year actually held), `fitness-check`.

Two lines that speak at quarter are deliberately **silent** at year:
`adherence-pattern` (twelve months average away the very drift the line exists to
show) and `sleepRegularity` (a trailing 28-night index is _last month's_ fact and
must not be printed as twelve months of regularity).

Because the gather reads the same declaration, the year window is bounded by the
same registry that decides the content: the per-day dose walk, the per-day
nutrient walk and the cadence-ledger reads all belong to lines the year does not
speak, so none of them runs.

## The honest partial window

A year can be truncated twice at once — data may have **started** inside it, and
it may not have **finished**. `retrospectiveCoverage` reports both, and the page
states them ("Since Mar 3, when your data begins, through Aug 13 — this year is
still running.").

It is a **statement about the period, not a second period**. The engine still
computes over the whole calendar year: a sum over Jan 1 → Dec 31 and a sum over
Mar 3 → Dec 31 are the same number when there is nothing before March 3. Clamping
the window would fork the engine to say something the engine already says
correctly.

## Attention posture

A user-initiated surface, and nothing else. No `Finding`, no dedupe key, no
Upcoming reach, no send, no marker. If this feature ever grows a `notify_`
constant, the posture has changed and that is a decision, not a refactor.

The issue's **pointer send** ("your 2026 year in review is ready") stacks beside
the chosen review cadence, which makes it a contact **increase** — so it needs its
own toggle and its own decision. It is deliberately not built here.

## #2385 — how this feature would learn it should stop

Prose, over data the instance already holds. No telemetry, no score, no registry.

- **Working:** profiles that open a retrospective keep logging at the same rate
  afterwards, and the year's line set is mostly _populated_ — a retrospective
  whose lines are mostly absent is a page about missing data.
- **Wrong:** it reads as a report card — opened once and never again while data
  keeps arriving, or followed by a _drop_ in logging. "I did worse than I thought"
  is exactly the verdict the commemorative exemption exists to avoid producing.
- **Deceptive success:** page opens rising while the population of profiles with a
  _populated_ year shrinks. A retrospective is most compelling to whoever logged
  the most, so it can look increasingly popular while serving fewer people — the
  same shape as food coverage rising while servings-per-window falls. The honest
  local question is how many profiles have a year worth rendering at all.

## Deliberately not built in this slice

Each is a new gather rather than a new arrangement of this one:

- the once-a-year **pointer send** and its Settings → Notifications toggle;
- the **AI narrative** (#421's read-only-at-tick split would apply unchanged);
- **seasonality** (sleep across seasons, summer vs winter activity, illness
  clustering, the Weather & UV tie-in);
- the **annual medical rhythm** (preventive/screening completion, immunizations,
  encounter census);
- **biomarkers year-over-year** and the Longevity optimal-share direction;
- the **child-profile variant** led by growth percentiles;
- the **print/share artifact** treatment (#1849's genre).
