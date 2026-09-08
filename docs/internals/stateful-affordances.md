# Stateful affordances and one-tap feedback

A button’s label names the write it offers. Render lifecycle actions from current
state, enforce their conditions in the write core, and display the actual outcome.
Use the [change and test policy](../change-policy.md) for scope and verification;
this page describes the domain contract.

## Additive writes and lifecycle transitions

An additive write records another fact, such as a food serving or an activity.
A plain “Log” button is appropriate. Whether a repeated log adds, replaces, or
leaves a fact unchanged depends on the domain’s write semantics.

A lifecycle write changes existing state: closing a period, pausing an intake
item, or resuming a workout. Derive its available action and label from shared
**offer state**. Post the intended transition, such as “pause,” rather than asking
the server to invert whatever state it finds. A stale tab’s Pause must not Resume.
Supply counters also need a shared write owner to preserve concurrent adjustments.

The UI snapshot can become stale. The core must recheck the relevant state inside
the transaction and return a typed outcome when the transition no longer applies.
Render that outcome; do not turn a refusal or no-op into unconditional success.

## Transaction boundary

Resolve authorization and the active profile at the request boundary. Pass the
profile into the shared write core and scope its reads and writes accordingly.

For transitions with an expected prior state, use `writeTx` from
[lib/db.ts](../../lib/db.ts). Read the state, check eligibility, and write with the
expectation in the SQL `WHERE` inside the same synchronous transaction. Related
changes belong there too: medication activation and course history, for example,
must move together.

[lib/tx.ts](../../lib/tx.ts) provides `readForUpdate`, `readAllForUpdate`, and
`casUpdate`. These take the transaction’s `Tx` token and an already-prepared SQL
statement. The exported `db` type omits `transaction`; request code uses `writeTx`
or `readTx`. `rawDb` explicitly exposes the full handle for boot/test adapters and
the AI-tier store, which owns its own IMMEDIATE transaction. That escape hatch is
not a guarantee about arbitrary SQL or independently opened connections.

`casUpdate` reports `applied` or `stale`; the core maps that result to
its domain outcome. Keep the callback synchronous and keep SQL visible at its
prepare site. These helpers are for guarded transitions; an ordinary additive
write does not need an artificial compare-and-swap.

## Existing owners

Start with [STATEFUL_WRITE_TABLES](../../lib/stateful-writes.ts) for the current
write owners and offer derivations. Keep that inventory in code.

For a complete example, [cycleControlState and cycleOffer](../../lib/cycle-plausibility.ts)
derive the period state and at most one start, end, or reopen offer.
[PeriodOfferButton](../../components/cycle/PeriodOfferButton.tsx) renders it for
the Cycle page and quick-log sheet. The sheet loads state when opened; the
[cycle write core](../../lib/cycle-write.ts) still rechecks eligibility under the
write lock. Window constants and predicates belong in the shared derivation.

[protocolReopenEligibility](../../lib/protocol-reopen.ts) distinguishes ongoing,
resumable, and expired runs. The [protocol lifecycle core](../../lib/protocol-lifecycle.ts)
checks the stored end date again and reconciles the linked situation in the same
transaction. Follow the relevant domain owner for other transitions rather than
copying a surface’s current labels or predicates.

## What the write scan checks

The [gated-table scan](../../lib/__tests__/stateful-writes.test.ts) uses the shared
[SQL scanner](../../lib/__tests__/sql-scan.ts) to inspect supported `.prepare` and
`.exec` arguments. It reports matching SQL outside registered core modules unless
a file-specific `ALLOW_WRITE` entry permits it.

Registry fields have distinct roles:

| Field         | Meaning                                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `table`       | Literal table name matched after an INSERT, UPDATE, or DELETE.                                                                      |
| `columns?`    | Narrows matching to SQL that also mentions a listed column, including in a predicate. It does not parse which columns are assigned. |
| `cores`       | Repository-relative module suffixes allowed to contain the matching SQL.                                                            |
| `gate?`       | Write core above a separate SQL store; metadata for review, not another scan permission.                                            |
| `offerState?` | Existing shared derivation for the UI, when one has been extracted.                                                                 |
| `why`         | The invariant that bypassing the owner could break.                                                                                 |

This is a source check, not proof that every write is safe. It excludes migrations
and test fixtures, cannot resolve arbitrary computed SQL or interpolated table
names, and does not prove authorization, transaction correctness, typed-outcome
handling, or UI behavior. Generic restore and bulk-delete paths using dynamic
table names require separate review. Column narrowing checks mentions anywhere
in the SQL, so DELETE can match when its predicate mentions a gated column.

When extending the registry, identify an actual lifecycle or counter invariant
and route its writes through the existing owner first. Keep exceptions narrow
and explain why they preserve that invariant. Name an offer derivation only when
it exists. Check column names against the schema and inspect existing DB coverage;
add a focused case only for a meaningful uncovered failure. A registry entry alone
does not establish the core’s correctness.

## One-tap feedback

[ONE_TAP_AFFORDANCES](../../lib/one-tap.ts) declares each logging affordance’s
feedback, repeat semantics, and expected interval. Reuse its existing designs:

| Feedback           | Use                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------- |
| `optimistic-count` | Move a displayed value immediately, then reconcile with the server.                   |
| `cooldown`         | Show a brief disabled state when there is no optimistic count to communicate success. |
| `outcome-toast`    | Answer from the write’s typed result, including refusals.                             |
| `recency-line`     | Show a recent additive write beside the button without prohibiting another.           |

[useOptimisticLedger](../../components/useOptimisticLedger.ts) owns the shared
write phase, rollback, reconciliation, and cooldown timer. The surface retains
its displayed state and supplies the pre-tap value, optimistic value, commit
callback, and result settlement. Adopt authoritative totals on success. Map
refusals to rollback so retry is immediate; a thrown write rolls back unless the
caller handles it, such as by successfully capturing an offline write.

The hook absorbs taps while writing and during `POST_SUCCESS_COOLDOWN_MS` after
success. This is a UI debounce, not a persistence gate. Surfaces with an optimistic
count can absorb silently; those without one can disable through `blocked()`.
Use separate write keys for independent actions, including an undo beside a log.
When several actions change one displayed value, give their taps the same
`valueKey`; the pipeline groups its projected value automatically. Rollback uses
the last accepted
or queued value, rather than an earlier tap's snapshot. Different symptoms or days
need distinct value keys. The baseline refreshes from the surface only while that
value has no writes in flight.

Repeat semantics determine whether a cadence confirmation applies:

- **Idempotent:** another tap has no further effect. No cadence confirmation.
- **Additive:** another log is intentional. Declare `expectedInterval: "none"`.
- **Cadenced:** another log is allowed, but its expected interval makes an
  accidental repeat worth confirming. Show the existing state and use
  `shouldConfirmRelog`; allow the user to proceed.

The cadence helper compares profile-local dates for daily logs and elapsed time
for supply cycles. Refill confirmation uses the fill duration when known, with a
bounded window. Keep those calculations and constants in `lib/one-tap.ts`.
An already idempotent, single-flight form does not need the hook merely to appear
in the registry. Toggles such as [StarButton](../../components/StarButton.tsx)
are different: their second tap undoes the first and must remain possible.

## Coverage boundaries

The [one-tap call-site scan](../../lib/__tests__/one-tap-call-sites.test.ts) checks
hook declarations against the registry. The offline queue’s
[OFFLINE_QUEUE_COVERAGE](../../lib/offline/queue.ts) maps affordances to queue flows
or explained exclusions. Neither substitutes for checking the actual write and
its feedback.

The quick-log, palette, and Telegram domain coverage records share
[LOGGABLE_DOMAINS](../../lib/loggable-domains.ts). A domain missing from that axis
is invisible to all of those records; type completeness only covers declared
members. Update the existing owners when adding a domain, without maintaining a
second census in prose.
