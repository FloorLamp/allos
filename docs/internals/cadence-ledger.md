# The cadence ledger

Status: shipped (#2034 — one read model over `frequency_targets`; no schema
change, no write path)

`frequency_targets` is one physical table with one identity (`target.id`). Before
#2034 four separately-maintained read models answered the same question about it —
"how did this target do in week W?" — and none of them keyed on that identity
uniformly.

| reader                            | what it answered              | how it dispatched                 |
| --------------------------------- | ----------------------------- | --------------------------------- |
| `getFrequencyTargetProgress`      | the current, in-progress week | a six-branch `if` chain           |
| `getFrequencyTargetWeeklyHistory` | the N completed weeks before  | **the same chain, inlined again** |
| `getSubstanceWeekState`           | this week's substance units   | its own per-substance branch      |
| `getSubstanceWeeklyTrend`         | the trailing substance weeks  | its own per-substance branch      |

Plus a third dispatcher in `lib/queries/protocols.ts` over a subset of the scopes,
which fell through to `{kind: "none"}` for any scope kind it had not been taught —
a protocol that silently reported zero usage forever.

The two frequency readers were ~250 lines of structurally identical
gather-and-bucket code that had to be edited in lockstep, and the substance
readers existed at all only because those two filtered `scope_kind !== "substance"`
out. Adding an eighth scope kind meant editing three dispatchers and hoping four
answers still agreed.

## The axes (`lib/cadence.ts`, pure)

What dispatch used to encode as branches is now declared:

1. **Source and grain** — which event ledger a scope counts and whether a week is
   distinct days or a sum. `CADENCE_SCOPES` is `Record<FrequencyScopeKind, …>`, so
   it is total by construction: an eighth scope kind is a compile error here, not a
   silent fall-through in three places. Each entry carries the reason it counts the
   way it does.
2. **Direction** — `floor` (a target to reach) vs `cap` (a limit to stay under).
   The same move `trailingAverage` made for #1909 with `basis`.
3. **Whether the in-progress week is included** — a reader option, not a scope fact.

## What ONE session advances (#2503)

The ledger answers "how many this week". `sessionAdvancesScope(scope, facts)`
answers "did THIS session put one of them on the board" — the same membership rule
as `cadenceCounts`, asked of a single activity instead of a window, over the two
facts an activity row carries: its own `type` plus its components' types, and the
regions its logged sets map to.

`SESSION_ADVANCE_RULES` is `Record<FrequencyScopeKind, rule | null>`, total by the
same construction as `CADENCE_SCOPES`. A `null` is a DECLARATION, not a "no": it
says the question is unanswerable from an activity row — mobility reads a recovery
session's moves (#840), food and practice count their own ledgers, and a `cap` is
never advanced at all (#998; asking would be asking for a to-go number on alcohol).
`SESSION_ADVANCEABLE_SCOPE_KINDS` derives the workout-affectable set from those
rules, so a consumer's narrowing cannot drift from the rule.

It exists because a surface that congratulates a session must not read the week's
rollup as if the session had produced it. The post-workout recap did exactly that:
a 1.42 km walk was told "Chest — 1 of 2 this week, one more to go" about a barbell
session earlier in the week. `getSessionCadenceFacts(profileId, activityId)` is the
gather (a missing or cross-profile row answers empty, which advances nothing).

## The reader (`lib/queries/cadence-ledger.ts`)

`getCadenceLedger(profileId, { weeks, includeCurrent, direction, asOf? })` returns
one `CadenceWeek[]` per target: window, `isCurrent`, `elapsedDays`, `count`,
`verdict`. It walks the **profile's own** week windows (calendar or rolling, in the
profile's stored timezone), issues **one gather per event source** over the whole
span and buckets in JS — never one query per week, and never a second query for a
source two scopes share.

Every former reader is a thin adapter over it:

| reader                            | ledger call                                           |
| --------------------------------- | ----------------------------------------------------- |
| `getFrequencyTargetProgress`      | `weeks: 1, includeCurrent: true, direction: "floor"`  |
| `getFrequencyTargetWeeklyHistory` | `weeks: N, includeCurrent: false, direction: "floor"` |
| `getSubstanceWeekState`           | `weeks: 1, includeCurrent: true, direction: "cap"`    |
| `getSubstanceWeeklyTrend`         | `weeks: N, includeCurrent: true, direction: "cap"`    |
| `getCadenceWeekVerdicts`          | `weeks: 1, includeCurrent: true`, **both** directions |
| `getCadenceCapWeeks`              | `weeks: N, includeCurrent: true, direction: "cap"`    |

`getPracticeTrends` and `getProtocolAdherence` were already formatters over the
first two and keep working unchanged — which is the proof the layering holds.

The last two rows are the periodic recap's reads (#2395/#2397). The daily digest
reported a weekly target's PACE while the message that CLOSES the week never
mentioned the targets that week is defined over; the recap reads the verdict here
rather than computing one, and `cadenceWeekVerdictLine` (`lib/cadence.ts`) words it
in the same rollup grammar `weeklyTargetPaceLine` words pace in.

Two things about them are worth copying rather than re-deciding:

- **They anchor on the period's LAST DAY.** A caller that already knows which week it
  means passes that week's end date and reads the anchor's own window — the calendar
  week containing it, or the trailing seven days ending on it. Stepping the anchor
  forward to "the day after the week" instead would shift a rolling profile's whole
  window by a day.
- **A read that wants both directions asks twice, by name.**
  `getCadenceWeekVerdicts` reads floors and caps in two calls and keeps the answers
  distinguishable all the way into the sentence. That is what lets a cap tenant reach
  the recap line at all without the floor vocabulary ever touching it: reported as
  within or over, never with a figure to go.

Both apply the cold-start exclusion — a target the user declared part-way through a
week is left out rather than scored (#1670) — and `getCadenceCapWeeks` applies it per
week, so a cap declared mid-period is reported over the weeks it actually existed for
and stays silent below `CAP_PERIOD_MIN_WEEKS`.

## Substance is a tenant, not a fork

The substance exclusion was deliberate and correct: a floor-semantics reader
renders "2 of 7 — 5 to go" on alcohol, nudging toward MORE consumption
(#998/#1259). That safety argument survives, but it argues for direction being
**declared**, not for a fourth module. Owner ruling, 2026-08-05: substance is the
`direction: "cap"` tenant of this ledger.

The anti-nudge rule moved from module separation into the verdict vocabulary:

- a `cap` target's verdict set (`under-cap` / `at-cap` / `over-cap`) has no "N to
  go" and no pace state at all;
- its **under-cap weeks are its success state** (#1670), so `cadenceWeekMet` is
  true there;
- `cadenceToGo` returns `null` for the cap direction, structurally — a cap surface
  cannot ask the question and get a number back;
- `lib/__tests__/cadence.test.ts` pins that no cap verdict or label carries
  pace-toward-more language.

Types enforce what keeping the code apart used to.

## Selecting by direction, not by subtraction

Every reader that used to filter `scope_kind !== "substance"` now selects a
`direction`. A new inverted scope joins the right readers by declaring itself,
rather than by someone remembering to add it to three exclusion lists — the same
failure mode #2017 hit with the workout nudge's "not cardio" filter.

`PROTOCOL_USAGE_LEDGER` in `lib/queries/protocols.ts` is the third dispatcher
rebased on the registry. It stays its own table (protocol usage counts EVENT ROWS
in a date window, not weekly totals), but it is exhaustive over `CadenceSource`, so
a new source is a compile error there too.

## Behavior notes

Two of the four readers already clamped the current week at the anchor day; two did
not, so a log dated in the FUTURE could fill this week's count — marking a floor met
and silencing its nudge, or inflating a cap. The ledger clamps uniformly. That is
the one intentional behavior delta of the consolidation.

Related: #1997/#2032 (the pattern), #1909 (the `basis` precedent), #998/#1259 (the
floor-vs-cap ruling), #1670 (under-cap is success), #748 (the floor pace), #2009
(the substance surfaces).
