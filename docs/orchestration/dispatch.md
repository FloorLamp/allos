# Dispatch and pipeline

## Queue labels

- Every issue has a domain label and P0–P3 priority, or `parked`. `lib` and
  `ui` are secondary location labels.
- `needs-human` means one specific owner answer is required. Apply it, assign
  the owner, and keep working elsewhere; never prompt the owner uninvited.
- Evaluations end with `recommend-adopt` or `recommend-hold`. A hold also gets
  `parked`; an adopt is merged by the orchestrator.

## Dispatch

- Use `scripts/orchestration/dispatch-brief.mjs new` for every agent, including
  Agent-tool runs. Adopt any unrecorded live dispatch immediately.
- Cluster two to six related issues by domain and files. Avoid file overlap;
  sequence work when overlap cannot be fenced.
- Older issues start with an audit table: resolved by what, or still open.
- Cap E2E work at two agents and ordinary concurrent work near four agents.
- Every brief uses the generated template and the gate order from
  `scripts/orchestration/agent-gates.sh`.
- Agents push after every meaningful step. The remote branch is the durable
  checkpoint.

## Per-unit pipeline

1. Read the issue body and every comment.
2. Generate the dispatch brief and record the branch in the task list.
3. Require the agent to merge current `origin/main` and run the assigned gates.
4. Read the full diff, verify claims, and post a substantive COMMENT review.
5. Diagnose E2E reds locally; send code corrections back to the author unless
   the change is an orchestrator-owned E2E fix.
6. Merge only a green exact head. Serialize conflicting merges.
7. Close the dispatch, remove its worktree and branch, and verify linked issues
   actually closed.

## Tooling

- `dispatch-brief.mjs`: create, list, resume, adopt, and close dispatches.
- `agent-gates.sh`: lint, typecheck, unit, DB, E2E hygiene, PHI scan, format.
- `ci-watch.mjs`: wait for settled CI; exit 0 green, 1 red, 2 unsettled, 3
  conflict-blocked.
- `dependabot-eval-brief.mjs`: evaluate major dependency updates.
- `release-notes-gather.mjs`: gather merged user-visible changes.
- `adversarial-review-brief.mjs`: route and brief high-stakes second reviews.

## Release notes

- Release notes are orchestrator bookkeeping in `lib/release-notes.json`.
- Make at most one batch per day. Use one concise title-only bullet per
  user-visible change; omit internal work.
- Keep entries append-only. Put upgrade actions in that day's `operatorNotes`.
