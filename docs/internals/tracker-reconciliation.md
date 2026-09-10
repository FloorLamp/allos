# Tracker reconciliation

Status: partial. Gathering, patching, and run summaries are shipped; the weekly
schedule remains unwired under the condition below.

Reconciliation checks tracker claims against the current repository. It may
refresh factual status markers, cross-references, paths, symbols, and permitted
labels. The scripts never change scope or decisions, and their one close is the
stale-P3 rule below. The agent may fold and sequence issues under the
reconciliation protocol's separate closure bounds, introduced in
[#5382](https://github.com/FloorLamp/allos/pull/5382). Preserve owner rulings and
flag judgments that the evidence cannot settle.

Use the [reconciliation protocol](../../.claude/skills/reconcile-tracker/SKILL.md)
for the ordered run procedure and the [change and test policy](../change-policy.md)
for implementation scope.

## Owners and commands

| Owner                                                                              | Responsibility                                                              |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [reconcile-tracker-core.ts](../../scripts/orchestration/reconcile-tracker-core.ts) | Pure evidence gathering, label decisions, report and summary calculations.  |
| [reconcile-tracker.ts](../../scripts/orchestration/reconcile-tracker.ts)           | Read-only entrypoint: GitHub reads, repository files, clock, and watermark. |
| [reconcile-repo-index.ts](../../scripts/orchestration/reconcile-repo-index.ts)     | Shared tracked-file index and lazy source reads.                            |
| [reconcile-patch.ts](../../scripts/orchestration/reconcile-patch.ts)               | Exact-anchor patch validation and application.                              |
| [reconcile-apply.ts](../../scripts/orchestration/reconcile-apply.ts)               | Issue-body writes, change notices, patch outcomes, and the stale-P3 close.  |
| [reconcile-labels.ts](../../scripts/orchestration/reconcile-labels.ts)             | Retired-label removals, ruled priorities, and planned domain additions.     |
| [reconcile-watermark.ts](../../scripts/orchestration/reconcile-watermark.ts)       | Read or advance the tracker-owned sweep watermark.                          |
| [reconcile-run-summary.ts](../../scripts/orchestration/reconcile-run-summary.ts)   | Record one dated run summary on #865.                                       |

```bash
npm run reconcile
npm run reconcile -- --json evidence.json --out report.md
npm run reconcile -- --issue 2603,2589
npm run reconcile:apply -- plan.json --outcome outcome.json
npm run reconcile:apply -- --evidence evidence.json
npm run reconcile:summary -- --evidence evidence.json --outcome outcome.json
npm run reconcile:watermark
npm run reconcile:watermark -- stamp --evidence evidence.json
```

The writer commands above default to dry runs; `--apply` performs their writes.
Read the report and review proposed changes before applying them. Keep evidence
and outcomes from the same run together.

## Evidence and its limits

The deterministic scan checks citations, paths, symbols, issue dependencies,
merged-PR references, documentation status, and label findings. It supplies a
reading list for the judgment pass; a clean report does not establish that an
issue's premise or proposed fix remains correct.

Read the owning code when deciding whether behavior exists, a proposed fix can
work, or a partially shipped issue still has unmet requirements. Existence checks
cannot detect the inverse claim: an issue saying something is absent when it
has since shipped. Reconcile that claim against the implementation rather than
assuming a detector covers it.

Path and symbol findings use these distinctions:

- A bare basename may resolve to a tracked file elsewhere in the tree. A path
  containing directories must resolve as that path; do not discard its directories
  and substitute a basename match.
- A missing citation rooted in a real repository directory is actionable evidence.
  Unrooted missing citations may describe another project and remain unverifiable.
- A line anchor must be specific enough to locate. More than
  `MAX_ANCHOR_OCCURRENCES` matches is diffuse; a small number of matches selects
  the occurrence nearest the cited line.
- Missing symbols in bug reports are stronger premise evidence than proposed
  names in feature requests. `symbolConfidence` owns that distinction.

Read the report's denominators as well as its findings: citations parsed, paths
resolved, anchors testable, references followed, and documents examined. An empty
report with little examined is not evidence of a healthy tracker. Watch the ratio
of testable anchors to line citations; a bare line number without a named anchor
cannot establish that the cited claim remains true.

The gatherer refuses a truncated open-issue sweep. A truncated merged-PR sweep
can still produce evidence, but marks `prsTruncated` and reports its examined
count as a lower bound. Never treat that count as complete coverage.

## Applying factual changes

A patch names the exact text it expects. Missing or repeated anchors refuse;
there is no fuzzy fallback. The patcher admits four kinds:

| Kind             | Allowed change                                                    |
| ---------------- | ----------------------------------------------------------------- |
| `status-marker`  | Replace one supported marker with another.                        |
| `cross-ref`      | Append a bounded issue-reference parenthetical to the anchor.     |
| `path-refresh`   | Replace a path citation with another path-shaped citation.        |
| `symbol-refresh` | Replace a backticked identifier with another verified identifier. |

A symbol refresh requires the shared repository resolver: the replacement must
exist and the old name must no longer resolve. A rename discussed in ordinary
prose is not a backticked symbol anchor. If the same anchor appears in a ruling
and elsewhere in the body, ambiguity refuses the patch rather than selecting one.

The applier rereads the live issue body and skips issues that have closed since
gathering. It writes only the issue's `body` field. When an edited issue already
has comments, or is named by `--notify`, it also posts a change notice so existing
readers can distinguish the current body from earlier discussion.

The label writer removes retired labels, resets priority to an unambiguous ruling
in the issue's body, and accepts planned domain additions. It refuses removals
that would strand an issue and contested priority slots. A domain addition must
fill an empty domain slot on an open issue; existing labels and additions earlier
in the same plan both count as occupied. Reclassification is outside this routine. Use the core's label
decisions instead of recreating them in a writer.

The applier's `--evidence` pass closes the gather's `staleP3` findings — an open
`P3` filed 30 or more days ago with no dispatch-ledger claim, assignee, or open
PR referencing it, and neither `needs-human` nor `parked` (ruled 2026-09-09,
#5671) — as `not_planned` with one fixed comment, after re-reading the issue and
re-running the same rule. The close payload is a literal; nothing else in the
toolchain closes an issue. The watermark writer is confined to its fixed-title
carrier issue. The summary writer posts to the issue named by `RUN_SUMMARY_ISSUE`.
Preserve these boundaries when changing payloads or allowed tools.

## Watermark and run summaries

The issue titled `Reconcile watermark (machine state)` stores the previous run's
instant. It belongs in the tracker, independently of a checkout, container, or
dispatch ledger. Without a watermark, the merged-PR sweep starts without a lower
bound and can reach the page cap.

The gather reads the watermark and records both ends of its window. After
reviewing the run, advance the carrier from that evidence's `watermark.current`,
not from the time stamping happens. The writer refuses to rewind it.

Each run's durable summary is one comment on #865, keyed by the gather timestamp.
The writer refuses a duplicate run stamp. The line includes the swept commit,
window, applied and flagged counts, and merged PRs examined. It describes the run,
not the correctness of every tracker claim.

`patched` comes from the applier's outcome file. `flagged` is the sum of unapplied
patch candidates, unverifiable findings, documentation findings, and label
findings. An outcome claiming more applied patches than the evidence proposed is
rejected. A report-only or dry-run pass must not count previews as applied work.

`boring: yes` requires zero flagged findings and an untruncated PR sweep. A clipped
sweep reports `boring: not established`, even with zero findings. These decisions
live in `summarizeRun` and `boringVerdict`; consumers should not recalculate them.

## Scheduling and prevention

Run on demand after substantial tracker changes. The weekly cron remains unwired
under the [recorded decision on #865](https://github.com/FloorLamp/allos/issues/865).
Three consecutive boring run summaries unblock it; the change wiring the schedule
must cite those comments.

Use a standalone `Depends-on: #123, #456` line for dependencies. Free-text forms
remain supported, but the structured form is unambiguous. When a PR completes part
of a checklist issue, verify the shipped artifact and update its matching box;
a title claiming completion is not enough evidence.
