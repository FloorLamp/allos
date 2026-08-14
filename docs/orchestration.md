# Orchestrating development on FloorLamp/allos

Status: **living** · process rules for agent-orchestrated development sessions

This is the entrypoint. Read only the procedure needed for the current job:

- [Dispatch and pipeline](orchestration/dispatch.md)
- [Environment and recovery](orchestration/environment.md)
- [E2E and CI](orchestration/e2e-ci.md)
- [Review and merge](orchestration/review-merge.md)
- [Cadence and lifecycle](orchestration/lifecycle.md)
- [Incident history](orchestration-incidents.md)

## Standing contract

> Orchestrate all development; prioritize P0/P1 bugs over features; delegate to
> opus agents; GitHub REST for ALL READS + MOST WRITES; open PRs as ready; allow at most two
> agents working on E2E; only the orchestrator runs full E2E suites; parallelize
> non-E2E work; review every PR, adversarial when needed

- Do not write feature code. Cluster, dispatch, review, diagnose E2E, merge,
  and clean up. The orchestrator may fix E2E specs it owns.
- P0/P1 bugs preempt features. Strategic work waits for the owner.
- Every PR gets a full diff review posted as a COMMENT review.
- Never submit `REQUEST_CHANGES` or `APPROVE`. Hold with a COMMENT, `parked`,
  and an explicit reason.
- The orchestrator owns squash merges. Use MCP for protected-ref and Actions
  writes; prefer REST for reads and ordinary writes.
- Dispatch continuously while viable work exists. Do not ask permission to
  resume or refill the pipeline.

## Start every check-in

```bash
scripts/orchestrator-checkin.sh
```

- Treat its persisted state as authoritative. After any restart or gap, preserve
  work before diagnosing it.
- Use `scripts/orchestration/dispatch-brief.mjs` for every dispatch. If a rule
  can be encoded in tooling, the tooling is the rule.

## Pipeline

1. Triage open issues, including comments. P0/P1 first.
2. Cluster related, non-overlapping work into branches.
3. Dispatch through `dispatch-brief.mjs new`.
4. Review the full diff and verify claims against the repository.
5. Require green CI on the exact head, then squash merge serially.
6. Run `dispatch-brief.mjs done <branch>`, confirm issue closure, and update
   release notes when appropriate.

Rules stay concise here. The receipts that justify them belong in
`docs/orchestration-incidents.md`.
