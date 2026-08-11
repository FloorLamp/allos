# Design doctrine

Status: shipped (the doctrine index; per-section gaps tracked under #2085)

This document records, as **default shapes**, the design lessons the codebase
paid for one bug class at a time — chiefly through the #1997 reading-model arc
(phases 1–2), the substrate extractions (#2034–#2044), and the registries that
grew teeth after their namespace produced a defect (#1931, #2036, #2038). It is
an **index into decided history**, not a proposal: every claim below cites the
module that embodies it and the issue where the lesson was learned.

Use it two ways: a new domain or surface starts from these shapes, and existing
code converges toward them when touched. It is not a rewrite mandate — the
explicit conclusion of the rebuild analysis behind #2085 is that
convergence-by-consolidation beats replacement, and that the accumulated
rulings and guards are the repository's most valuable asset.

## 1. Five substrates; domains are vocabulary and policy, not tables

New data is an instance of an existing shape before it is a new table:

- **Reading** — a dated quantity above minute grain, identity-keyed.
  `lib/reading-model.ts` (shape and mapping), `lib/reading-placement.ts` (the
  write core decides physical placement), `lib/queries/readings.ts` (series).
  See `docs/internals/reading-model.md` for the full contract, including the
  grain boundary (`hr_minutes` stays outside) and the parked phase 3 (§8).
- **Event ledger** — additive day-counted events with bump/unbump/drop-at-zero
  (`lib/day-counter-ledger.ts`, #2037), one-tap client feedback from the named
  family in `lib/one-tap.ts` (#2041/#2007), undo through `UNDO_KINDS`
  (#30/#2038), and a correction-path history (#1934's class; the shared
  history-table component is #1491).
- **Session** — a dated bounded activity with amount/duration, notes,
  edit/delete, and a weekly model. Today a _convention_, not a shared module:
  workout sessions and practice sessions are parallel implementations, and
  `practice_logs` recorded its exception to the store-reuse rule in migration 099. A third session-shaped domain should extract the shared shape rather
  than add a third copy.
- **Target with declared direction** — `lib/queries/cadence-ledger.ts` (#2034):
  a weekly target declares `direction: "floor" | "cap"` and joins the one
  reader; a cap's verdict vocabulary has no "N to go" state (#998/#1259, the
  anti-nudge ruling). A new target picks a direction; it never forks a module.
- **Document** — imported clinical material through the import footprint's
  single entry point (`persistDocumentImport`, #453/#422); every table it
  writes stays represented in imported-row cleanup, reassignment, and
  extracted-count accounting.

Membership boundaries are decisions, and the argued exclusions matter as much
as the memberships: symptom logs are observation-shaped (#860/#944), mood is
its own write core (#992 — a 1–5 self-rating has no canonical identity), and
muscle volume bands stay off the cadence ledger because `bandVerdict`'s
`untrained` state (#719) and the ledger's pacing cannot merge without faking
one or the other. A genuinely new shape needs its argument written down the way
those were.

## 2. Identity is the spine; knowledge attaches to identity, not location

The deepest lesson in the tracker (#1996): clinical knowledge was filed under a
canonical _name_ while the readings it should judge streamed into a different
_table_, and nothing connected them. The repair generalizes: every judged
quantity resolves through one identity function and one knowledge lookup —
`biomarkerFamily`/`readingIdentity` (#482), `metricJudgment`, and the
total-with-reasons `METRIC_KNOWLEDGE` registry, where every entry declares its
knowledge system or an argued `none`.

Doctrine: a new metric or quantity ships with a declared knowledge source or an
argued exclusion — absence is a build failure, not an audit finding. The
identity functions themselves are indexed in
`docs/internals/identity-registry.md`, whose census test keeps the doc honest.
The known gap — completeness is currently guarded only over `TrendMetricSlug` —
is #2086 (VO₂ max is its acceptance case, ruled to earn a surface).

## 3. One side-state grammar

Stars, dismissals, edit locks, tombstones, undo captures, and send markers are
one concept: state _about_ a row, keyed by a registered grammar, de-orphaned by
a named sweep. Every retrofit in this family (#1931 dismissals, #2036 send
markers, #2038 undo parity) was the cost of not saying so up front.

`lib/side-state.ts` is the census: every family names its store, its registry
symbol, its key grammar, its sweep, and its guard test.
`lib/__tests__/side-state.test.ts` enforces the census and scans for
stateful-shaped key literals invented outside it. Doctrine: new side-state
joins an existing registry (or extends the grammar and registers the family);
the registry's scan is part of the definition of done.

## 4. Provenance and sync are a layer

Source stamp, natural key, and edit lock are uniform row facts, not
per-importer habits. All pull ingest goes through the one runner
(`lib/integrations/pull-sync.ts`, #2040) and every ingest path sits on the
observation substrate — `isEditLocked`, `classifyUpsert`/`tallyUpsert`,
`latestByGroup` (#944), enforced by `lib/__tests__/observation-substrate.test.ts`.
"Never overwrite a manual correction" is a property of the layer, pinned
behaviorally by `lib/__db_tests__/import-edit-lock.test.ts` (#2091): every
importer-written table either refuses to clobber a hand-edited row or is
declared source-owned with the reason.

The layer's known gap is clock skew: provider UTC-offset errors are still
rescued case by case (#2011/#2055); the one canonicalization primitive is
#2088.

## 5. Attention is one scheduler

The reach policy (care findings may reach Upcoming, attention surfaces, and
notifications; coaching findings stay in calm, hideable surfaces), the
suppression bus and shared `dedupeKey`, undismissable safety signals,
obligation (`must`/`should`/`may`), and the contact-consent rule — the system
may reduce contact unilaterally, never increase it — live in
`docs/internals/findings.md` and are not restated here.

What this doctrine adds: one-tap feedback comes from the named
`ONE_TAP_AFFORDANCES` family in `lib/one-tap.ts` (#2041) — optimistic-count,
cooldown, outcome-toast, or recency-line — never a per-surface invention; and
nudge cadence rides `planNudgeCadence` (#2036) unless the family's exemption is
declared (#2089 tracks making that membership total).

## 6. One time model

A measured fraction of the bug history is time arithmetic re-derived per
surface: #1909 (two "7-day averages"), #2043 (diverging lens anchors), #2051
(the pre-midnight false-red band), #2055/#2056/#2063 (UTC-offset duplicate
splits). Each repair produced a single-sourced helper; this section is the
index the next surface greps for, so it finds the helper instead of
`Math.ceil(days / 7)`:

| Question                                | Owner                                               |
| --------------------------------------- | --------------------------------------------------- |
| Trailing average over a dated series    | `lib/trailing-average.ts` (`basis` is declared)     |
| A trends lens's window and anchor       | `lensWindow` in `lib/trends.ts`                     |
| Week start / week mode / week windows   | the week-window helpers (per-profile `week_start`)  |
| Laying dated counts on a 7×N grid       | `lib/day-grid.ts`                                   |
| How far back a log write may be dated   | `lib/dose-log-window.ts` (and its cited siblings)   |
| "Now" in a request or notification tick | the profile's stored timezone, never server local   |
| Future-date guards                      | the app clock ruling (#2051)                        |
| Age of a person for a judgment          | `ageFromBirthdate`/`ageMonthsFrom` in `lib/date.ts` |

Two standing rules with guards:

- A surface computing its own week arithmetic, window anchor, or grid layout is
  a review flag; the helpers above are the one computation.
- **Age is evaluated as of the reading's date, never today** (#150; restated in
  `lib/queries/metric-judgment.ts`). A call that passes a today-shaped date is
  either a genuine current-age question — registered, with its reason, in
  `lib/__tests__/age-as-of-scan.test.ts` — or a bug the scan now catches.

Elapsed-duration math ("3 years ago", biological-age day counts) is not age-of-
a-person math and stays where it is.

## 7. What stays, on purpose

Doctrine argues both directions. These are decided and correct; incremental
work must not erode them:

- Synchronous `better-sqlite3`, inline SQL through `db.prepare(...)`, `writeTx`
  / `readTx` — no ORM, no repository layer.
- The login/profile split (`lib/auth.ts`): a login authenticates, a profile is
  the data subject; every profile-owned statement filters by `profile_id`.
- Coarse Edge middleware plus real authorization at the Node boundary.
- The three test tiers (pure / DB-and-action / browser) with their coverage
  gates, seeded-frozen-clock e2e harness, and settled-interaction hygiene.
- The registry-plus-reflection-test culture — conventions with CI teeth — which
  is what made this quarter's consolidations safe to land in days. When a
  convention matters, its scan is part of shipping it.

## 8. The one rebuild delta that stays parked: the physical readings merge

Phase 3 of #1997 — one tall `readings` table — is **deliberately deferred**
(`docs/internals/reading-model.md`). Nothing reads or writes the stores
directly anymore, so the collapse would be a data move, but `medical_records`
is the highest-stakes table in the app and the correctness payoff already
landed with phases 1–2. The recorded triggers for revisiting:

1. Long-window or aggregate features make the JS-side two-half series fold a
   **measured** performance problem.
2. New stream metrics make wide-row `body_metrics` migrations a recurring tax —
   for this trigger alone, the right-sized response is a **partial** merge of
   the two stream stores, `medical_records` untouched.
3. Read-time dedupe produces an incident a storage constraint would have
   prevented.

Absent one of those, "not started" is the correct state.
