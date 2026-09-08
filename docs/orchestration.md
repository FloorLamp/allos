# Working development on FloorLamp/allos

Status: **living** · process guidance for assigned orchestration sessions

The orchestrator coordinates coding agents, reviews their changes, diagnoses CI,
and merges verified work within the owner's scope. Coding agents own feature
changes; the orchestrator may fix E2E specs it owns. Session instructions and tool
authorization take precedence over repository defaults.

## Procedures

Read the procedure needed for the current task:

- [Change and test policy](change-policy.md): smallest complete changes, existing
  owners and coverage, and when to stop.
- [Dispatch and pipeline](orchestration/dispatch.md): priorities, current issue
  scope, capacity, banking, and the sole landing candidate.
- [Environment and GitHub access](orchestration/environment.md): setup, transports,
  credentials, uncertainty, and write verification.
- [Recovery](orchestration/recovery.md): preserve work, establish live state, and
  reconcile ambiguous outcomes.
- [Queue labels](orchestration/labels.md) and
  [decision classes](orchestration/decision-classes.md): classification and owner
  questions.
- [E2E and CI](orchestration/e2e-ci.md): gate ownership and diagnosis.
- [Review and merge](orchestration/review-merge.md): full-diff and independent
  review, exact-head checks, base movement, and serialized squash merges.
- [Cross-session markers](orchestration/claims.md): issue claims and review markers.
- [Cadence and lifecycle](orchestration/lifecycle.md): the Ladder's recorded scope,
  holds, termination conditions, and wind-down.
- [Orchestrators on one repo](orchestration/multi-orchestrator.md): slices, fences,
  and release-note ownership.

The [orchestration sequence](../.claude/skills/orchestrate/SKILL.md) connects these
procedures for a live session. Start each authorized check-in with:

```bash
scripts/orchestrator-checkin.sh
```

Use its evidence to establish current state; preserve in-flight work after a gap.
An empty roster, green PR, or remaining backlog alone does not establish that the
recorded cycle is complete. Keep rules in their owning procedure and incident
history in git rather than repeating either here.
