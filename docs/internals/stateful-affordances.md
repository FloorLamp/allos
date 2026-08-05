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

| table                                  | cores                                                               | gate                 | offer state         |
| -------------------------------------- | ------------------------------------------------------------------- | -------------------- | ------------------- |
| `cycles`                               | `lib/cycle-store.ts`                                                | `lib/cycle-write.ts` | `cycleControlState` |
| `illness_episodes`                     | `lib/illness-episode-store.ts`, `lib/illness-episode-write.ts`      | —                    | —                   |
| `intake_item_logs`                     | `lib/queries/intake/adherence.ts`                                   | —                    | —                   |
| `shared_supplies` (`quantity_on_hand`) | `lib/queries/intake/refill.ts`, `lib/queries/intake/supply-pool.ts` | —                    | `refillRecencyLine` |
| `intake_items` (`quantity_on_hand`)    | `lib/queries/intake/refill.ts`, `lib/queries/intake/supply-pool.ts` | —                    | `refillRecencyLine` |

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
`app/(app)/nutrition/supplement-actions.ts` with its own DELETE/INSERT/UPDATE and
its own supply crossings, which had already drifted — it never refused a paused
item. One core in `lib/queries/intake/adherence.ts` now owns every transition of
the table and the Server Action renders its typed outcome. No `offerState`: the
control renders from the dose's taken/skipped/clear state and each surface gates
it on its own `active && due` read, but that derivation is not extracted.

Already stateful, no action: dose confirms (typed outcomes, #1779), PRN quick
log (the #798 redose-window line), mood (`upsertMoodLog` updates same-day),
preventive done (idempotent per rule+date), the illness front door, cycle
(#1892), practice/protocol buttons. Appointments have no one-tap affordance —
completion is form-level. **Weight and food servings are additive by design and
correctly plain** — which is also why the vitals card's "Log reading" (#1892) is
a plain button: it opens the measurements form, and a reading is a fact added,
not a transition.

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
