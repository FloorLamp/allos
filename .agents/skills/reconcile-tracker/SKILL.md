---
name: reconcile-tracker
description: Reconcile the issue tracker and roadmap against main — verify each issue's citations, dependencies and status claims, patch the factual drift, and close, sequence or group issues so the queue shrinks. Use for a scheduled or on-demand tracker maintenance pass, never as a CI gate.
---

# Tracker reconciliation

Verify tracker claims against current `main`, apply factual corrections, and
reduce duplicate work. The [tool reference](../../../docs/internals/tracker-reconciliation.md)
owns evidence fields, patch validation, writer boundaries, watermark semantics,
and summary arithmetic. This guide owns the judgment and run sequence. Apply the
[change and test policy](../../../docs/change-policy.md): concise findings, existing
owners and coverage, no new detector or test merely to restate documentation.

## Boundaries

Under the [recorded consolidation change](https://github.com/FloorLamp/allos/pull/5382),
the agent may close, sequence, and group issues within these limits:

- A fold names the absorbing issue and carries every ruling there as a dated
  block. Preserve scope and decisions whole; flag a fold that would strand them.
- Fold an owner-filed, owner-directed, or owner-ruled issue only on the owner's
  word. Otherwise propose its home without closing it.
- Never close an issue claimed by a live lane underneath that lane.
- Before closing, comment with the absorbing issue, then use the host's separately
  authorized issue writer with `not_planned` for a fold. These actions
  require the session's write and communication authorization.
- The scripts remain confined factual writers with no issue-close operation.
  Keep closure authority separate from their body, label, watermark, and summary
  payloads. Do not bypass a writer refusal with a hand edit or broader shell grant.

Coordinate with the orchestrator before writes; do not overlap another
reconciliation or triage sweep. Tool availability is not permission to post or
close. Follow [GitHub access](../../../docs/orchestration/environment.md#github-access)
within the granted tools. Use the confined scripts for factual patches; closure
is a separate authorized action. A Claude entrypoint's tool metadata is not a
portable permission grant, and another host must respect its own restrictions.

## 1. Gather the delta

Use the repository's required Node major, resolved as described in
[environment](../../../docs/orchestration/environment.md#environment).

```bash
npx tsx scripts/orchestration/reconcile-tracker.ts \
  --json /tmp/reconcile-evidence.json --out /tmp/reconcile-report.md
```

Use run-specific filenames when multiple sessions share scratch space. The
tracker-owned watermark supplies the lower bound; `--since <iso>` overrides it.
Gathering does not advance it. Read **What was examined** first, including
truncation and unresolved citations. Zero findings with little examined does not
establish a clean tracker.

## 2. Verify PR claims and umbrella boxes

Read issues and all comments, including later rulings. For merged PRs claiming
part of an umbrella, inspect the claimed artifact on `main` before ticking its
box. Use a verified `status-marker` patch; report unmet criteria or uncertain
claims. Titles and successful merges alone do not prove completion.

## 3. Sweep issues and consolidate

Use path, symbol, line, and dependency findings as a reading list. Verify behavior
claims too: resolving every citation cannot establish that a proposed fix still
works or that allegedly missing behavior is absent.

Apply the boundaries above when folding duplicate mechanisms. Sequence remaining
work with `Depends-on: #123, #456`; preserve each issue's unmet requirements.
Keep closures, folds, and sequencing counts in the manual pass report. The
script-generated run summary does not count these operations.

## 4. Refresh meta-issues and labels

Verify `Meta:` status markers and critical paths against code; report a no-op when
none exist. Use [label policy](../../../docs/orchestration/labels.md) and the label
writer's worksheet:

- Remove retired labels and reconcile a priority with an unambiguous ruling in
  that issue's body. Respect `would-strand` and `slot-contested` refusals.
- For an empty domain slot, read the issue and use citation scores as evidence,
  then supply a domain plan. Split evidence needs an owner decision; cross-cutting
  work may belong to `design`. Do not reclassify an occupied domain slot.

```bash
npx tsx scripts/orchestration/reconcile-labels.ts
npx tsx scripts/orchestration/reconcile-labels.ts --plan domains.json
```

A domain plan maps issue numbers to arrays of `{ "label": "wellness", "reason":
"protocols and pillars" }`. Preview first; add `--apply` only for authorized writes.
The writer rereads open issues before changing labels.

## 5. Check documentation contracts

Compare `docs/` status lines and README navigation with shipped behavior. Record
mismatches; a mechanical correction can become a focused reviewed change. Do not
turn the pass into a new scanner project.

Remove contracts that `main` has superseded, naming in the PR what each removed
section protected. There is no numeric prune target; `npm run docs:check` holds
the total steady, and this pass is where superseded text leaves.

## 6. Review the report and apply

Keep the generated report's order: run window, **What was examined**, **Patch
candidates** by kind, **Couldn't verify** with attempted checks, and **Verified
clean**. Include manual findings without presenting a scoped pass as a full sweep.

```bash
npx tsx scripts/orchestration/reconcile-apply.ts plan.json
npx tsx scripts/orchestration/reconcile-apply.ts plan.json --apply \
  --outcome /tmp/reconcile-outcome.json [--notify 123,456]
```

The plan maps issue numbers to arrays of `AnchoredPatch`. Use only `status-marker`,
`cross-ref`, `path-refresh`, and `symbol-refresh`; consult the tool reference for
accepted replacements. Symbol anchors and replacements include their backticks.
Missing or ambiguous anchors are findings, not invitations to widen an anchor.

Dry-run first. The applier announces body edits when comments already exist;
`--notify` adds quiet issues with in-flight readers. Preview those comments as part
of the authorized write. Never apply the same plan twice: a replacement can contain
its own anchor. Gather fresh evidence before another plan.

## Finish and schedule

```bash
npx tsx scripts/orchestration/reconcile-watermark.ts stamp \
  --evidence /tmp/reconcile-evidence.json
npx tsx scripts/orchestration/reconcile-run-summary.ts \
  --evidence /tmp/reconcile-evidence.json --outcome /tmp/reconcile-outcome.json
```

Both default to dry runs. After reviewing the sweep and actual outcomes, add
`--apply` to stamp the gather's timestamp and record one summary on #865. Keep the
same run's files together; previews are not applied patches. Do not replay a
summary or present a manual scoped report as a qualifying automated run.

Run on demand or at the agreed maintenance cadence. The weekly cron remains
unwired until three consecutive qualifying boring summaries; the
[tool reference](../../../docs/internals/tracker-reconciliation.md#scheduling-and-prevention)
owns that condition. Scheduling or sending a future run requires authorization.
