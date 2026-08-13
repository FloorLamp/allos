# Stateful affordances and the gated-table write scan

Status: **shipped** (#1892 established the pattern and then applied it to its
own second and third renderers; #1893 added the audit criterion, the workout
offer state, the refill recency line, and this enforcement layer)

A one-tap write affordance is a promise: the label names the write the tap will
perform. This page holds the criterion for deciding when a button owes the user
that promise, and the scan that keeps the promise enforceable even when a
button forgets.

## The criterion

> **Additive writes may stay plain; lifecycle writes render from state.**

An **additive** write adds a fact that did not exist. Logging a weight, adding a
food serving, recording a new activity — there is no prior state to transition
from, tapping twice means two facts, and a plain button is correct. Do not
"upgrade" these; a state-derived label on an additive action invents a
distinction the domain does not have.

A **lifecycle** write transitions existing state: opening or closing a period,
starting or ending an illness episode, starting a live workout session, moving a
supply counter. Here the same tap means different things depending on what is
already true, so the affordance renders a shared **offer state** and the write
**core** enforces the same conditions with typed refusals.

## The two halves, and what each guarantees

The split is deliberate and the two halves are not interchangeable:

- **The scan guarantees no silent corruption.** Where a stateful core exists, no
  other module may reach past it to the table. Every write therefore passes the
  core that enforces the gate and answers with a typed outcome.
- **The audit upgrades refusals into good UX.** No static check can prove a
  button was rendered from state. With the scan in place, the worst a
  state-blind button can do is tap → honest refusal. It can never corrupt.

That is why the enforcement layer is a WRITE scan and not an attempt to lint
JSX: the corruption class is closable mechanically, the ergonomics class is not.

## The registry

`lib/stateful-writes.ts` — `STATEFUL_WRITE_TABLES`, one entry per gated table:

| field         | meaning                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------- |
| `table`       | the SQL table, matched after `INSERT INTO` / `UPDATE` / `DELETE FROM`                               |
| `columns?`    | narrows the gate to the columns that carry the state (a `DELETE` names no column and never matches) |
| `cores`       | the repo-relative module suffixes allowed to hold that DML                                          |
| `gate?`       | the auth-blind write core layered above the store, when the guard logic and the SQL live apart      |
| `offerState?` | the derivation an affordance over this table should render — one place for review to look           |
| `why`         | why the table is gated and what a raw write would break                                             |

Today's entries:

| table                                         | cores                                                                                                                                                                    | gate                 | offer state                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- | --------------------------- |
| `appointments` (`status`)                     | `lib/appointment-status.ts`                                                                                                                                              | —                    | —                           |
| `cycles`                                      | `lib/cycle-store.ts`                                                                                                                                                     | `lib/cycle-write.ts` | `cycleControlState`         |
| `illness_episodes`                            | `lib/illness-episode-store.ts`, `lib/illness-episode-write.ts`                                                                                                           | —                    | —                           |
| `intake_item_logs`                            | `lib/queries/intake/adherence.ts`                                                                                                                                        | —                    | —                           |
| `shared_supplies` (`quantity_on_hand`)        | `lib/queries/intake/refill.ts`, `lib/queries/intake/supply-pool.ts`                                                                                                      | —                    | `refillRecencyLine`         |
| `intake_items` (`quantity_on_hand`, `active`) | `lib/queries/intake/refill.ts`, `lib/queries/intake/supply-pool.ts`, `lib/intake-active-write.ts`, `lib/intake-obligation-write.ts`, `lib/queries/intake/medications.ts` | —                    | `refillRecencyLine`         |
| `protocols` (`end_date`)                      | `lib/protocol-lifecycle.ts`                                                                                                                                              | —                    | `protocolReopenEligibility` |
| `medication_courses`                          | `lib/queries/intake/medications.ts`                                                                                                                                      | —                    | —                           |
| `intake_item_doses` (`retired`)               | `lib/queries/intake/dose-lifecycle.ts`                                                                                                                                   | —                    | —                           |
| `intake_item_side_effects` (`resolved`)       | `lib/queries/intake/medications.ts`                                                                                                                                      | —                    | —                           |
| `routines` (`active`)                         | `lib/routines.ts`                                                                                                                                                        | —                    | —                           |
| `situations` (`active`)                       | `lib/settings/profile-attrs.ts`                                                                                                                                          | —                    | —                           |
| `equipment` (`retired`)                       | `lib/equipment.ts`                                                                                                                                                       | —                    | —                           |
| `integration_backfill_jobs`                   | `lib/integrations/backfill-jobs.ts`                                                                                                                                      | —                    | —                           |

`integration_backfill_jobs` (#2196/#2195) is not column-narrowed because the
table has no non-lifecycle column: `status` decides what the hourly pass resumes
and what boot recovery reaps, and the completed/failed/request/active-seconds
counters are the durable checkpoint a resumed run continues from — which is
exactly what a raw write got wrong, restarting them over imported rows that were
still on disk. The crash-lease reaper in `lib/migrations/boot-tasks.ts` writes
the table too and is out of the scan's scope under the migrations carve-out; it
expires a lease before any request exists rather than serving a user's tap. No
`offerState`: the Strava button renders a count of rides missing details, not the
job's state, so its label does not yet name the write it will perform. It cannot
corrupt — `queueIntegrationBackfill` refuses a running/queued job with a typed
outcome the action renders, and the run claim is a CAS on
`status IN ('queued','paused')` — but that derivation is not extracted.

`cycles` is the only entry today whose guard logic and DML live in different
modules, which is what `gate` exists to record: `lib/cycle-write.ts` owns the
typed refusals and holds no SQL of its own (pinned by a test), reaching the
table only through the store.

## Worked example: one offer state, three renderers (`cycles`)

`cycles` is the entry to read first, because it is the one where the audit's
"name the `offerState`" ambition has been carried through to every surface that
offers the write.

`cycleControlState` (`lib/cycle-plausibility.ts`) says what is TRUE — is a
period open, is it stale, what is the derived state line, may a start or a
reopen be offered. `cycleOffer` turns that state into **at most one** offer, and
the offer carries the label:

| state                                         | offer    | label                |
| --------------------------------------------- | -------- | -------------------- |
| a period is open                              | `end`    | Period ended today   |
| ended within `REOPEN_PERIOD_MAX_AGE_DAYS`     | `reopen` | Still bleeding       |
| no period for `MIN_PLAUSIBLE_PERIOD_GAP_DAYS` | `start`  | Period started today |
| between those two windows                     | —        | (no button)          |

At most one — and sometimes none — is a fact about the constants rather than a
tie-break inside `cycleOffer`: the reopen window (3 days) closes before the
plausible-gap window (10 days) opens. The gap between them is where the honest
answer is silence, and the dated form on the Cycle page owns that exception.

Three surfaces render it and **none of them re-derives it**:

| surface                | component                                         | where the state comes from             |
| ---------------------- | ------------------------------------------------- | -------------------------------------- |
| Cycle page control     | `app/(app)/medical/cycles/PeriodQuickActions.tsx` | the page, once per render              |
| Dashboard phase widget | `components/dashboard/CyclePhaseWidget.tsx`       | the dashboard page, once per render    |
| Quick-log sheet        | `components/quick-entry/QuickCyclePanel.tsx`      | `loadQuickEntry("cycle")`, **on open** |

All three mount `components/cycle/PeriodOfferButton.tsx`, the only caller of
`cycleOffer` in the app. `lib/__tests__/cycle-offer-renderers.test.ts` is the
#221 pin: it fails if a surface reaches for the predicates directly, calls the
derivation itself, hard-codes a verb, or if a fourth server entry point starts
resolving the state.

The sheet gathers on OPEN rather than at layout time deliberately (#1468): a
layout-time snapshot would be exactly as stale as the page it rode in on, and
the verb has to be current. The sheet ROW is a plain menu label ("Log period");
the verb lives on the button one tap in, which is the only place it can be
honest.

Widening the affordance this way is safe precisely because of the split at the
top of this page. The dashboard is the surface most likely to be stale — a tab
open since yesterday — and a stale tap still reaches `lib/cycle-write.ts`, which
re-enforces the same predicates under the write lock and answers with a typed
refusal the caller renders. The worst outcome is an honest message; a double-log
or an invented period is not reachable.

## The scan

`lib/__tests__/stateful-writes.test.ts`, over the shared source scanner in
`lib/__tests__/sql-scan.ts` — the same file walk and `.prepare`/`.exec`
first-argument extraction the profile-scoping guard uses. One scanner, two
questions; a third hand-rolled SQL parser would be the disease this pattern
exists to treat.

Out of scope, each for a stated reason:

- **Migrations** (`lib/migrations/**`) — schema DDL and one-shot data moves by
  construction, frozen by the immutable hash manifest, running before any core
  exists.
- **The DB/action test tiers** — their `INSERT` fixtures seed a starting world;
  forcing them through the cores would make a fixture unable to set up the very
  refusal states the cores are tested against.
- **Interpolated table names.** It is a TEXT scan. The generic undo-delete /
  restore machinery builds `DELETE FROM ${root.table}`, which no text scan can
  see, and no allowlist entry pretends otherwise.

Everything else needs an `ALLOW_WRITE` entry with a justification, on the same
short-and-justified discipline as the profile-scoping allowlist. The scan's own
fixture plants a raw write in a non-core module and asserts it is flagged — a
guard that cannot fail is not a guard.

## Adding an entry

1. The table must carry lifecycle or counter state, not merely be written often.
2. Route every write through the core(s) first; the registry entry lands in the
   same change, next to the code it protects.
3. Name the `offerState` when a shared derivation exists. Leave it out when one
   does not — an honest gap, not a claim.
4. Add a DB-tier assertion if the entry names a column: the pure scan cannot
   tell a real column from a typo, and a typo leaves the guard silently open.

## The audit's standing results (#1893)

#2039 added `intake_item_logs`, the dose ledger the supply counter one entry
below it is driven by. It had a second core: a tri-state twin inside
`app/(app)/nutrition/intake-actions.ts` with its own DELETE/INSERT/UPDATE and
its own supply crossings, which had already drifted — it never refused a paused
item. One core in `lib/queries/intake/adherence.ts` now owns every transition of
the table and the Server Action renders its typed outcome. No `offerState`: the
control renders from the dose's taken/skipped/clear state and each surface gates
it on its own `active && due` read, but that derivation is not extracted.

Already stateful, no action: dose confirms (typed outcomes, #1779), PRN quick
log (the #798 redose-window line), mood (`upsertMoodLog` updates same-day),
preventive done (idempotent per rule+date), the illness front door, cycle
(#1892), practice/protocol buttons. **Weight and food servings are additive by
design and correctly plain** — which is also why the vitals card's "Log reading"
(#1892) is a plain button: it opens the measurements form, and a reading is a
fact added, not a transition.

Appointments were this page's own stale claim: an earlier revision said they
had "no one-tap affordance — completion is form-level", and a lifecycle-machine
audit (#2134) found the Visits list had meanwhile grown icon-only Mark
completed / Cancel buttons and a Reopen, all riding a bare `SET status = ?`
that could not refuse, plus a palette "Mark complete" that toasted success
unconditionally — while the import path compare-and-swapped the very same
transition. `appointments` (`status`) is a registry entry now:
`lib/appointment-status.ts` owns the state-named CAS (typed
`already-scheduled` / `already-completed` / `already-cancelled` / `not-found`
refusals the list and the palette render) and the two complete+link swaps —
"Log this visit" (unlinked-only) and the import auto-complete, whose
scheduled-only guard keeps the machine from overwriting a manual completion or
cancellation.

## The protocol lifecycle (#2135)

`protocols.end_date` is a THREE-state machine — NULL is ongoing, a date inside
`PROTOCOL_REOPEN_WINDOW_DAYS` is resumable, an older one is expired and the
honest move is a new run — and the states were already named once, in the pure
`protocolReopenEligibility` (`lib/protocol-reopen.ts`) that `ProtocolControls`
renders its Resume / Run again offer from. Protocols had got halfway: a good
offer derivation, no core.

`lib/protocol-lifecycle.ts` is the other half, on the `cycles` shape.
`endProtocolCore` and `resumeProtocolCore` re-read the row INSIDE the writeTx
(the `lib/tx.ts` token), compare-and-swap on the expected prior end date, and
answer `already-ended` / `already-ongoing` / `expired` / `invalid` /
`not-found`; the Server Actions map those to words and no longer pre-check the
row, because that read was the window the core exists to close. The protocol's
SITUATION activation is inverted in the same transaction — a protocol reading
"ended" while its situation stays active keeps firing situational supplements
and nudges for a block the user has stopped.

The registry entry is column-narrowed to `end_date`: name, notes, outcome and
practice-link edits are ordinary form writes. Three statements are allowlisted
in the scan — the create INSERT and the run-again INSERT (born rows) and the
edit form's whole-record UPDATE, where the end date is a dated FIELD the user is
correcting rather than a one-tap transition. `protocol-offer-renderers.test.ts`
is the #221 pin: the derivation has exactly three callers (the control, the
core, and `runProtocolAgain`'s expired branch), nothing else re-derives the
window, and every state of the machine is exercised at its boundary day.

Two defects were fixed by #1893:

- **The workout entry points** (`lib/workout-offer.ts`). `openLive()` /
  `openSession()` unconditionally re-stamped `liveStartEpoch = Date.now()`,
  which is exactly the epoch the #921 dock's elapsed timer ticks off — so a
  mid-workout tap reset a running session's clock and dropped its in-flight
  sets. Now one derivation says start-or-resume, four surfaces render its label,
  and both open functions enforce it internally so a stale caller cannot stomp a
  session either.
- **The refill affordance** (`lib/refill-recency.ts`). `refillSupply` was
  already a good core, but the operation is additive and nothing said "you just
  refilled". Treated with the #798 pattern — an informational
  "Refilled just now (+90)" line for a short window, never a gate, because two
  bottles is a legitimate restock.

## The intake lifecycle machines (#2139/#2133/#2132/#2131)

The 2026-08-05 lifecycle-machine audit found four stale-actor defects in the
intake domain and closed them with one shared mechanism plus four entries above.

**The Tx token (`lib/tx.ts`).** `writeTx` hands its callback a `Tx` value only
`lib/db.ts` can mint, and the in-transaction helpers `readForUpdate(tx, stmt, …)`,
`readAllForUpdate(tx, stmt, …)` (the set-shaped guard read, added for #2140's
whole-set rewrite) and `casUpdate(tx, stmt, …)` REQUIRE it — so a guard read or
compare-and-swap written with them cannot typecheck outside the transaction it
protects, which is exactly the defect #2139 found (pending checked outside, insert
inside). The helpers take an already-prepared statement, never a SQL string, so
both source scans still see every statement. The token is evidence, not an async
handle: the callback-synchronous rule is unchanged, and genuinely additive writes
ignore it.

The four machines:

- **`intake_items.active` (#2133)** — Pause/Resume was a read-then-flip; a stale
  tab's "Pause" resumed the item while toasting "Supplement paused". It is now a
  state-named transition: the form posts the state its render promised,
  `setIntakeActive` CASes it (delegating a medication to `setMedicationActive`
  so course history moves in the same transition), and the toast words come from
  the OUTCOME. The same intended-state treatment fixed the side-effect
  `resolved` blind toggle.
- **`medication_courses` (#2132)** — the `active = 1 ⇔ open course` invariant
  was prose in one module and written from three. Every transition now lives in
  `lib/queries/intake/medications.ts` with typed, changes-checked outcomes
  (`stopped` / `already-stopped` / `restarted` / `already-open` / `synced` /
  `not-found`); the actions and cards render refusals instead of confirming
  no-ops, and `synced` repairs a planted desync without minting course history.
- **`intake_item_doses.retired` (#2131)** — the one irreversible retire in an
  app where every sibling reopens. `lib/queries/intake/dose-lifecycle.ts` owns
  retire-or-delete AND the guarded `unretireDose`; both bound dueness through
  appended schedule versions (#1973) so neither transition re-judges a past day,
  and the edit forms render retired rows with "Restore to schedule".
- **`intake_item_suggestions` (#2139)** — not a registry entry (the table has no
  second writer), but the accept now claims `status='pending'` with an
  in-transaction CAS before minting the item, so a double accept mints once.

## The equipment retire machine (#2138)

`equipment.retired` was a lifecycle gate by this registry's own criterion — it
decides pickers, availability summaries, and workout suggestions (#341) — but the
flip returned `void` with no changes check and the actions returned `{ ok: true }`
literals, so a silently-failed retire kept offering sold gear. `setEquipmentRetired`
is now a state-named CAS over the Tx-token helpers with typed outcomes
(`applied` / `already` / `not-found`), `deleteEquipment` is row-count-checked (the
delete itself stays, per the issue's ruling: its confirm names the consequence and
#1610's compatibility clause governs the detaches), and both surfaces render the
refusals — the manager through the shared overflow menu's `MenuActionResult`
plumbing. The registry entry above makes lib/equipment.ts the flag's only writer.

## The lifecycle-hardening batch (#2140) and the outcome-discard guard (#2106)

#2140 registered the two remaining single-active machines and finished the
changes-checked-outcome sweep the intake issues started:

- **`routines.active`** — a real single-active invariant with a de-facto core:
  `activateRoutine` deactivates every sibling and replaces the derived training
  targets in one `writeTx`, and `getActiveRoutine`, the deload cycle, the rotation
  cursor and the workout nudge all assume at most one active row. The registry
  entry makes the convention a chokepoint; `deactivateRoutine` is now a CAS with
  `active = 1` as its expectation (second tap reports `false`).
- **`situations.active`** — the whole-set rewrite (`setActiveSituations`) that
  gates situational supplements, opens/closes illness episodes (#856) and appends
  the dated start/stop event log. Its before-set diff used to be read OUTSIDE the
  transaction; it now runs inside via `readAllForUpdate`, so the event log can only
  ever describe transitions that actually happened.
- **Goal status/archive and care-plan "Mark done"** — the batch's changes-checked
  outcomes. `setStatus`/`setArchived` CAS on (id, profile) and refuse a forged id;
  `markCarePlanItemDone` returns a typed `CarePlanDoneOutcome` (completed /
  already-closed-with-status / not-found) worded once by `carePlanDoneResult`, so a
  repeat tap says "Already marked done" and a tap over someone else's cancellation
  refuses by naming what persists.

#2106 closed the outcome-discard half: the household confirm and the attention
hero declared `outcome-toast` feedback (below) while their actions dropped
`markDoseTaken`'s outcome and returned void. Both now return the shared
`DoseConfirmResult` and render through `components/DoseConfirmButton.tsx` (the
`doseConfirmMessage` wording), the Upcoming row chips render any typed result they
receive, and a source scan in `lib/__tests__/one-tap.test.ts` fails any module that
calls `markDoseTaken`/`markDoseSkipped` as a bare statement — a discarded outcome
is an unconditional confirm waiting to happen.

## The one-tap feedback family (#2041, #2007)

An additive affordance stays plain (above) — but "plain" was never a licence for
each one to answer _"did my tap land?"_ its own way, and by the 2026-08-05 survey
one-tap logging had four unrelated answers and five hand-rolled copies of the
same optimistic-reconcile code. The decision is recorded here and enforced as
data in `lib/one-tap.ts` (`ONE_TAP_AFFORDANCES`), which every surface running the
shared hook must name itself in. Since #2130 the registry has declare-or-argue
teeth in both directions: a source scan
(`lib/__tests__/one-tap-call-sites.test.ts`) fails an entry no component wires
and a call site the registry doesn't know, and the offline queue's
`OFFLINE_QUEUE_COVERAGE` (`lib/offline/queue.ts`) must map every affordance to a
queue flow or an argued exclusion at the type level — an idempotent tap (the
queue's own admission criterion) can no longer ship unqueued-and-unargued. The
same #2130 mechanism gives the quick-log sheet, the palette, and the Telegram
vocabulary a per-domain census over `lib/loggable-domains.ts`.

**The four feedback designs.** A new one-tap surface picks one of these; it does
not invent a fifth.

| design             | when it applies                                                                                           | who uses it                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `optimistic-count` | there is a number beside the tap that can move now and reconcile after (the #748 item 2 pattern)          | food servings, protein grams, mobility moves, symptom severity, mood valence |
| `cooldown`         | no count to move — the figure arrives with the action's revalidation, so the inert window IS the feedback | substance units                                                              |
| `outcome-toast`    | the write can REFUSE, so the tap is answered from its typed outcome and never confirmed unconditionally   | dose confirm/skip, PRN dose, practice session, period offer                  |
| `recency-line`     | additive with a corrupting double-tap: an informational line beside a button that stays enabled (#798)    | mark refilled                                                                |

**How a second tap is classified.** This is what decides whether a confirm may
ever appear, and it is declared per affordance rather than inferred:

- **idempotent** — a second tap changes nothing (mobility's set semantics, dose
  status per (dose, date), preventive done per (rule, date), the mood upsert, the
  one-row-per-date weight quick-add). Layer 1 only.
- **additive** — a second tap writes again _and that is the point_ (food serving,
  protein grams, PRN dose, substance units). Layer 1 only, and it **must never
  confirm**: `expectedInterval: "none"` is stated explicitly on every one of them
  so the confirm cannot leak in by omission.
- **cadenced** — additive with a real expected interval: practice sessions (~a
  day) and mark refilled (a supply cycle, weeks). These get all three layers.

**The three layers** (#2007), in the order a user meets them:

1. **Post-success cooldown** — `POST_SUCCESS_COOLDOWN_MS`, domain-blind, on every
   affordance that runs `useOptimisticLedger`. `useFormStatus` already disables a
   control _during_ its request; this closes the instant _after_ the response,
   when the control re-enables and a queued tap lands a real second write. It is
   a UI debounce, not a gate: nothing is refused, the tap is absorbed, and a
   failed or refused write skips the cooldown entirely so a retry is immediate.
   Whether the window dims the control follows the feedback design — a surface
   with an optimistic count absorbs silently (the count already answered), one
   without disables so the swallowed tap is visible.
2. **The affordance renders today's state** — the practice button reads "Log
   another" and names the day's count once a session exists, so the second tap is
   never byte-identical to the first (the #1893 doctrine applied to an additive
   write).
3. **Cadence-aware confirm** — `shouldConfirmRelog` in `lib/one-tap.ts`, only for
   the two cadenced affordances. Always a confirm, never a block (#798): a
   genuine second sauna and a pharmacy that filled 180 as two bottles are both
   real, so the dialog's default is to proceed. Practice asks when a session is
   already logged today; refill asks inside a window sized from how long a fill
   actually lasts (`daysOfSupplyForItem` over `last_fill_size`), capped at three
   days so an early restock is never nagged.

**Surfaces deliberately not on the hook.** Preventive done, care-plan done, the
mood check-in and the weight quick-add are idempotent AND already single-flight
through a form action or a transition, so a landed repeat is a no-op by
construction. They are classified above; wiring them to the hook would add a
window without closing a hazard.

**A TOGGLE is not a log (#2641).** The ★ save (`components/StarButton.tsx`) is a
tap-shaped write that paints optimistically, and it is deliberately outside this
registry. `ONE_TAP_AFFORDANCES` is the census of one-tap **logging**, and its
`repeat` vocabulary classifies what a second LOG means; a star's second tap is
the UNDO of the first and is meant to land in full. Declaring it would need a
fourth repeat class to stay honest, and the one thing the hook would buy it —
the post-success cooldown that ABSORBS a second tap — is the behaviour a toggle
must not have. It uses `useOptimistic` over the server's `saved` prop directly,
which is what makes the revert structural: the displayed value is not state of
its own, so a refused or thrown write cannot leave a star lit over a save that
did not happen. It also answers `toggleSavedItem`'s typed `FormResult`, which
the plain Server-Action form it replaced discarded. The pair is proven end to
end in `e2e/star-optimistic.spec.ts` by HOLDING the action's response open, so
the paint is shown not to depend on the round-trip rather than merely being
fast.
