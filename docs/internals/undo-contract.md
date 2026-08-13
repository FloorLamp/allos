# Undo as a contract

Status: partial (the substrate plus the dose confirm; #2642)

Top-tier interaction grammar is **act, then offer undo** — almost never
ask-then-act. The app has had one undo lifecycle since #30, but only for
DELETES. This is that half made shared, plus its first non-delete tenant.

## Where the pieces live

| Concern                         | Owner                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Window, refusal words, the rule | `lib/undo-offer.ts` — pure: `UNDO_TOAST_MS`, `UndoRefusal`/`UndoOutcome`, `undoRefusalText`, `undoToastPlan`                   |
| The one client wiring           | `components/useUndoableAction.ts` — toast + "Undo" + rendering the inverse's typed outcome                                     |
| Delete adapter                  | `components/useUndoableDelete.ts` over the hook; the token shape and `restoreDeletedRow` are unchanged                         |
| Dose-confirm adapter            | `lib/dose-outcome-text.ts` (`doseConfirmUndoable`, `doseUndoOutcome`) + `undoDoseConfirm` in `lib/queries/intake/adherence.ts` |

There is exactly ONE undo window, ONE "Undo" label and ONE set of refusal
sentences. Before #2642 `15000` appeared as a local constant in four client
modules; a fifth copy is now a review finding, not a shrug.

## When a write may offer an undo

The inverse must be **complete**, **local** and **re-derived**.

- **Complete** — running it puts the world back, children and side-state
  included. An undo that restores the row but not its children is a
  data-integrity defect wearing a UX improvement (the row-op completeness rule
  in AGENTS.md).
- **Local** — nothing left the machine. An act that SENT, PUBLISHED or DELIVERED
  something is not undoable by deleting a row: the message is already read. The
  Telegram dose tap is the concrete case — it edits a chat message on the way in,
  so it is out of scope for this contract and stays as it is.
- **Re-derived** — the inverse re-checks validity server-side before writing,
  exactly as `logUsualFoodCore` re-derives its offer. An inverse that trusts the
  client's memory of the prior state is not an undo, it is a second unvalidated
  write.

Two structural consequences, both enforced rather than remembered:

- `undoToastPlan` refuses to attach an Undo to an ERROR toast. A refusal wrote
  nothing, so there is nothing to take back.
- The **offer gate is per outcome, not per action**. `doseConfirmUndoable` is
  deliberately one member narrower than `doseResolved`: an `already-taken` answer
  resolves the dose but that tap WROTE NOTHING, and its "undo" would erase an
  earlier tap's write.

## Undo is not a substitute for a confirm

A consequence-stating confirm on a hard-to-reverse or safety-relevant transition
is **doctrine, not friction**, and shipping an undo elsewhere never earns the
right to remove one. These stay confirm-first:

| Confirm                               | Why it stays                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Obligation demotion (`must` → lower)  | AGENTS.md requires an explicit consequence-stating confirm; the consequence is losing escalation.  |
| Retiring a dose that has logs         | The row is kept precisely because deleting would cascade its taken history away.                   |
| Ending / closing an episode           | A lifecycle close reconciles symptom logs, stopped meds and encounter links.                       |
| Stopping a medication course (#2574)  | A course stop moves `intake_items.active` and course history together.                             |
| Anything sent, published or delivered | The inverse cannot un-send. Undo has nothing to offer here and pretending otherwise is the defect. |

## The dose confirm, concretely

`undoDoseConfirm(profileId, doseId, date)` is the inverse. It is NOT
`setDoseStatusCore(…, "clear")`:

- the tri-state check-off states an intent about the DAY and is right to
  overwrite whatever stands;
- an undo claims only "the row I wrote a moment ago should not exist", so it
  probes the day's ledger under the write lock (`readAllForUpdate`, which demands
  the `writeTx` token) and proceeds only while exactly one taken row stands.

`intake_item_logs` is a registered stateful-write table whose one core is
`lib/queries/intake/adherence.ts`, and the clear still goes through
`applyDoseStatusCore` there — ownership re-check, paused-item refusal, supply
hand-back. The nested `writeTx` is a SAVEPOINT under the outer IMMEDIATE lock, so
probe-then-clear is atomic against the notify sidecar.

Its four answers: `undone`, `not-taken`, `changed`, `stale-dose`. `changed`
matters most — the core's clear is a `DELETE … WHERE dose_id = ? AND date = ?`,
so an undo that skipped the probe would take a PRN administration logged in the
meantime with it.

Surfaces wired: the dashboard attention hero (`markAttentionDose` /
`undoAttentionDose`) and the household member card (`confirmDoseAction` /
`undoConfirmDoseAction`), both through `components/DoseConfirmButton.tsx`. The
household undo re-runs the CARD's gate — `requireProfileWriteAccess` on the
profile the form names — so a read-only caregiver can no more un-log a dose than
log one.

## Not yet wired

Deliberate gaps, not oversights:

- the Upcoming page's dose chip, which posts through the shared `RowAction`
  descriptor system — extending that contract is its own change;
- the quick-entry overlay's dose list, which drops rows into local client state
  an undo would have to put back;
- finding dismiss / snooze (which would also make #2386's dismissal-fatigue
  counting more honest: an undone dismissal was not an answer);
- quick-log serving / protein / substance ticks, already ledger-backed by
  `dayCounterLedger`;
- preventive mark-done, star and watch toggles.

Each is a candidate BECAUSE its inverse is complete and local. None of them is a
confirm being removed.

## How this would learn it should stop (#2385)

- **Working** — fewer flows abandoned mid-way, and fewer
  confirmed-then-immediately-redone writes.
- **Wrong** — undos rising over time, or destructive taps taken and NOT undone at
  a higher rate than before. The second one means a confirm was load-bearing and
  this replaced a question with a shrug.
- **Deceptive success** — taps-per-task falls and every flow feels quicker while
  accidental writes rise: the undo affordance is counted as used, while the
  accident it was supposed to catch is what produced the tap.

Local queries over data the instance already holds. No telemetry, no
user-facing score, no registry.
