---
name: orchestrate
description: Run an agent-orchestrated development session on FloorLamp/allos — check in, read the owner-recorded cycle scope, triage and dispatch within it, review every diff, merge green heads serially, and reach bounded completion or scoped continuous exhaustion. Use when the owner says "orchestrate", "run a session", "work the queue", "dispatch agents", "keep merging", or hands over the repo for autonomous development — and for resuming after a restart or gap. NOT for doing the feature work yourself (the orchestrator never writes feature code) and NOT for one-off issue filing or tracker maintenance (file-issue and reconcile-tracker own those).
---

# Run a development session

Use this sequence for an assigned orchestrator role. The
[orchestration entrypoint](../../../docs/orchestration.md) owns the standing
contract; read only the linked procedure needed for the current step. Follow the
[change and test policy](../../../docs/change-policy.md): brief the smallest
complete change, reuse existing owners and coverage, and stop expanding a task
when its behavior and relevant checks pass. Keep reports to evidence and exceptions;
incident history belongs in git.

The orchestrator dispatches, reviews, diagnoses, merges, and cleans up. Coding
agents own feature changes; the orchestrator may fix E2E specs it owns. Do not
start agents, send messages, or schedule wakes outside the session's authorization.
Map these operations through the current host's
[agent tools](../../../docs/orchestration/environment.md#agent-tools), not another
provider's tool names or session IDs.
A planning-only pass defers agents, worktrees, branches, GitHub writes, and wakes;
list these as first live actions.

## 1. Check in and recover

```bash
bash scripts/orchestrator-checkin.sh
```

Run at each live wake and after a gap. Read its persisted state and dispatch
roster, including the tooling version, before acting on remembered status. After a
restart, preserve in-flight branches before diagnosing the interruption.

Read the pinned Ladder issue for recorded scope, outcomes, termination, slice,
order, and prerequisites. Follow [lifecycle](../../../docs/orchestration/lifecycle.md)
for holds, the next authorized check-in, and the status pulse. The PM owns the
catch-up digest. Missing scope does not authorize a broader queue.

## 2. Triage and cluster

Use [dispatch](../../../docs/orchestration/dispatch.md) for priority, current-state
blocks, capacity, and queue backpressure; use
[labels](../../../docs/orchestration/labels.md) for the closed taxonomy and owner
questions. Read candidate bodies and all comments freshly. Verify remaining
acceptance criteria against code, especially after a partial merge.

Group related issues by domain and files. Sequence overlaps that cannot be fenced.
A design question needs an owner decision or stated direction with falsifiers
before dispatch. Continue clear, unheld work while owner decisions are pending.
Agent findings return in the task summary; the orchestrator decides whether they
belong on an existing issue or meet the bar for a new one.

## 3. Dispatch and bank

Claim issues before briefing, following
[claims](../../../docs/orchestration/claims.md). Generate every brief:

```bash
node scripts/orchestration/dispatch-brief.mjs new --branch <branch> \
  [--worktree wt-x] [--issues 1,2] [--task "..."] [--e2e] [--port-base N]
```

Record the branch in the task list. Adopt unrecorded live dispatches through the
same tool. Use its generated setup, pinned base, file fences, and assigned gate
order; push meaningful checkpoints. Never edit a live agent's worktree without
its acknowledgement.

Bank validated branches until they become the session's sole landing candidate.
Only that candidate opens a ready PR and consumes final remote review and CI.
[Multi-orchestrator coordination](../../../docs/orchestration/multi-orchestrator.md)
owns cross-session slices and merge serialization.

## 4. Review and diagnose

Follow the full [review procedure](../../../docs/orchestration/review-merge.md),
including independent verification of repository claims, new abstractions, test
value, and production/test line deltas. Review the full diff against the issue's
remaining requirements. A changed head needs renewed review.

Run `adversarial-review-brief.mjs <pr> --check`; the review procedure owns its exit
codes and when a separate falsifying pass is required. Do not treat unreadable or
consult results as clearance. Diagnose CI through `ci-watch.mjs` and
[E2E guidance](../../../docs/orchestration/e2e-ci.md); use captured process handles
for local waits. Return feature corrections to the author and rerun checks that
establish the fix. A passing retry alone does not resolve a flake.

## 5. Merge and close out

Use [GitHub access](../../../docs/orchestration/environment.md#github-access) for
transport and write verification, and the
[merge procedure](../../../docs/orchestration/review-merge.md#merge) for exact-head
CI, review, base movement, holds, closing keywords, and squash merges. Session
instructions take precedence over repository defaults; tool access alone does not
authorize a write. Never substitute a remembered green status for current evidence.

After a merge, recheck affected PRs and verify intended issue closures or remaining
umbrella boxes. Then finish the dispatch:

```bash
node scripts/orchestration/dispatch-brief.mjs done <branch>
```

Compare branch content before deleting worktrees or branches. The PM owns the
release-note batch. Follow lifecycle's audits, queue sweep, metrics, dependency
updates, and wind-down cadence without duplicating those schedules here.

## 6. Follow the recorded termination condition

Bounded completion requires every recorded outcome to be accepted. Continuous
exhaustion requires every eligible in-scope remainder to be accounted for. An
owner hold or blocker is a blocked handoff with unmet outcomes, not completion.
On wind-down, stop dispatching, land or bank work, clean verified redundant state,
stop scheduled check-ins, and report the terminal state and next action.
