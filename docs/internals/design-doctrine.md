# Architecture guide

Use existing domain shapes when adding behavior. This guide owns architectural
choices; [design system](design-system.md) owns visual primitives and layout.
[Change and test policy](../change-policy.md) owns implementation scope and
verification. A documented convention does not automatically warrant a scanner.

## Shared substrates

| Shape           | Owner and boundary                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reading         | `lib/reading-model.ts`, `lib/reading-placement.ts`, `lib/queries/readings.ts`: identity-keyed dated quantities above minute grain. See [reading model](reading-model.md).                        |
| Event ledger    | `lib/day-counter-ledger.ts`: additive day counts, bump/unbump/drop-at-zero. Use the shared undo and history contracts.                                                                           |
| Session         | Bounded activity with amount/duration, notes, edit/delete, and a weekly model. Workout and practice sessions are currently parallel conventions; a third domain should extract the shared shape. |
| Directed target | `lib/queries/cadence-ledger.ts`: declare `floor` or `cap`. Caps have no “N to go” verdict. See [cadence](cadence-ledger.md).                                                                     |
| Document        | `persistDocumentImport`: every written table participates in cleanup, reassignment, and extracted-count accounting. See [import actions](import-actions.md).                                     |

Symptom logs use the observation substrate. Mood keeps its own write core: a
self-rating has no canonical quantity identity. Muscle volume bands retain
`bandVerdict` and its `untrained` state; do not force them into cadence pacing.
A new shape needs a concrete reason existing substrates cannot represent it.

## Identity and side state

Attach knowledge to identity, independently of physical storage. Resolve judged
quantities through `biomarkerFamily`/`readingIdentity`, `metricJudgment`, and
`METRIC_KNOWLEDGE`. Declare a knowledge source or a reasoned `none`; consult the
[identity registry](identity-registry.md) for the owning functions. Do not assume
that the current `TrendMetricSlug` completeness check covers every quantity.

Stars, dismissals, edit locks, tombstones, undo captures, and send markers use
registered key grammars. `lib/side-state.ts` names each family's store, registry,
sweep, and existing guard. Join that owner when extending side state so cleanup
can find the new keys.

## Ingest and attention

[Sync](integrations-sync.md) owns provenance, natural keys, edit locks, and
provider time handling. Pull ingest uses `lib/integrations/pull-sync.ts` and the
observation substrate; manual corrections survive reimport unless the table is
explicitly source-owned.

[Findings](findings.md) owns care/coaching reach, obligation, suppression,
safety signals, and contact consent. [Notifications](notifications.md) owns
routing and delivery. Use `planNudgeCadence` unless the family declares an
exemption. [Stateful affordances](stateful-affordances.md) owns lifecycle writes
and the `ONE_TAP_AFFORDANCES` feedback family; surfaces do not invent another.

## Time and bounded reads

[Time model](time-model.md) owns instants and profile-local days. Use these
shared computations rather than repeating arithmetic in a caller:

| Question                 | Owner                                                                       |
| ------------------------ | --------------------------------------------------------------------------- |
| Trailing average         | `lib/trailing-average.ts`; declare `basis`                                  |
| Metric movement verdict  | `lib/movement.ts`; name the question, declare the tolerance                 |
| Trends window and anchor | `lensWindow` in `lib/trends.ts`                                             |
| Week windows             | Shared week-window helpers using profile `week_start`                       |
| Dated count grid         | `lib/day-grid.ts`                                                           |
| Backdated dose log       | `lib/dose-log-window.ts`                                                    |
| Current time             | `lib/clock.ts` and the profile's stored timezone                            |
| Age for a judgment       | `ageFromBirthdate`/`ageMonthsFrom` in `lib/date.ts`, as of the reading date |

Current-age questions are explicit exceptions to reading-date age. Elapsed
duration is a different quantity and must not substitute for age.

There is no parental access control (#3067). The profile's birthdate, through
the life-stage model (#494), decides what applies: adult-population statistical
models (VO2 percentiles, strength standing, fitness age, PhenoAge, eGFR) use
`isAdultForClinical` and hide on unknown age; logging of every activity type,
timeline, search, export, and equipment are age-neutral; anything else declares
a life-stage line or "age-neutral" explicitly. A global minimum-age setting is
not restored.

Apply a promised read window in SQL, before loading rows. A range selector that
allows “all time” does not itself bound query cost. When adding a bound, update
all callers that promise it. Paged reads use `lib/pagination.ts`
(`HISTORY_PAGE_SIZE`, `clampPage`, `pageOffset`, `pageCount`) and
`components/PaginationControls.tsx`; order by a stable tie-breaker such as `id`
before applying `OFFSET`.

Cross-source deduplication elects a source per represented thing. Use
`pickRowsOneSourcePerDay` for daily quantities and
`pickRowsOneSourcePerWindow` for events such as sleep sessions
(`lib/metric-sources.ts`). Sharing a date does not make two events duplicates.

## Storage decisions

Keep synchronous `better-sqlite3`, inline SQL, and `writeTx`/`readTx`; no ORM or
repository layer. Authorization and profile ownership follow the root and
[`lib/AGENTS.md`](../../lib/AGENTS.md), with request-boundary details in
[`app/AGENTS.md`](../../app/AGENTS.md).

The physical merge into one tall readings table remains deferred. Revisit only
for measured series-fold performance, recurring stream-schema migration cost,
or a deduplication defect that a storage constraint would prevent. Stream-schema
cost alone warrants considering a partial merge of stream stores, leaving
`medical_records` intact. The [reading model](reading-model.md) owns that decision.
