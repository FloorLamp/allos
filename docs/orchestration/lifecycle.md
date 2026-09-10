# Cadence and lifecycle

This guide owns the recorded cycle, cadence, status, and termination. Follow
[dispatch](dispatch.md) for priorities and capacity,
[review and merge](review-merge.md) for landing, and the
[change and test policy](../change-policy.md) for scope and verification.

## Recorded cycle and holds

Read the pinned Ladder issue at each check-in: authorized scope, outcomes,
bounded or continuous termination, rung order, assigned slice, and prerequisites.
Missing or conflicting scope goes through [owner-question handling](labels.md).
Continue clear, unheld work; when none remains, bank and report a blocked handoff.
The remaining backlog does not authorize broader dispatch.

Record owner holds in `$SCRATCH/.holds`, one per line:
`<scope> :: <release condition> :: <what it gates>`. Check each release condition
at every wake. A hold stops only its named work; it neither accepts an outcome nor
widens scope. Preserve this owner-provided state during recovery.

A bounded cycle completes only when every recorded outcome is accepted.
Continuous exhaustion requires every eligible in-scope remainder to be accounted
for as blocked, owner-gated, or dependency-bound. A blocker can stop active work
without satisfying either completion condition.

## Cadence

For an authorized live session:

- Arrange the next durable one-shot check-in at each wake and record its next fire
  time. Wake prompts carry stable constraints and point to tooling for current
  state; avoid embedding a stale PR-status inventory.
- Read the check-in and `dispatch-brief.mjs list` before acting. Confirm actual
  agent/process state through [recovery](recovery.md) when a restart or stop is
  suspected. A persisted roster alone is not a liveness check.
- Sweep open issues about every four hours for new filings, labels, and comment
  rulings. Reassess partial deliveries by remaining impact; the PM audits open
  P1s each watch.
- Run one adversarial audit of the previous day's merges per session-day. Attach
  verified findings to the introducing mechanism under the filing bar below.
- After a UI-affecting merge, run the seeded post-merge census while its context is
  fresh. The [walkthrough guide](../../.agents/skills/ux-walkthrough/SKILL.md)
  owns the command, coverage limits, and evidence review.
- Evaluate Dependabot minors under the normal green-head merge requirements;
  send majors through `dependabot-eval-brief.mjs` within a day.
- Diagnose and rerun CI under [E2E and CI](e2e-ci.md).

## Filing bar

A finding earns its own issue when it is user-reachable, breaks main or a merge,
has a measured reproduction no open issue covers, or removes a parallel concept.
Otherwise attach it to the existing mechanism or owning task: scan gaps to their
adopter, harness details to the harness issue, and flakes to their cause. A P3
nobody claims, takes or opens a PR for within 30 days closes `not_planned` in
the reconcile pass, so file at P3 only work worth doing this month.

Lanes return findings rather than filing. The orchestrator checks current scope,
duplicates, and [filing instructions](../../.agents/skills/file-issue/SKILL.md)
before any authorized tracker write. Keep `parked` and status reports consistent.

## Status pulse

Open the pulse with the check-in's census line, for example:
`e2e 2/2 · ord 3/5 · slot #4764 green · banked 2 · blocked #4218`.
Follow it with exceptions that change the next action: red main, blockers, owner
questions, or a merge. State uncertainty as uncertainty and keep updates concise.

Use the session's communication channels and cadence. Durable findings belong in
the relevant review, issue, or ledger when those writes are authorized; avoid
copying the same narrative into each. The PM owns `pm-digest.sh` and the owner's
catch-up summary.

## Wind-down

Stop new dispatches, land or clearly bank in-flight work, clean verified redundant
worktrees and branches, stop check-ins, and hand off the remaining state. Use an
unverified WIP marker only for work from an agent confirmed stopped.

Before deletion, compare branch content with `main` and record what established
redundancy. For a suspected successor merge, use a direct file comparison such as
`git diff main <branch> -- <file>`; PR status or a merge-base diff alone cannot
settle whether the work landed. Follow recovery's ambiguous-merge procedure.

Name the terminal state: bounded completion, continuous exhaustion, or a blocked
handoff listing unmet outcomes and the next required action.

## Out of scope

Strategic or architectural changes and owner judgments about information
architecture, navigation, or tone require that scope from the owner. Keep relevant
documentation current, but do not restructure top-level guidance incidentally.
