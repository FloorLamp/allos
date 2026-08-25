# Dispatch and pipeline

## Queue labels

Two axes are load-bearing, and `reconcile-tracker` flags violations of both
(`checkLabelHygiene`, 2026-08-15):

- **Exactly one priority-slot label**: `P0`–`P3` or `parked`. Never two — a
  `P2` + `parked` issue is in no queue and every queue at once.
- **At least one domain label.** Cross-cutting design/UX work takes `design` —
  it is a real domain, not a missing one.
- Priority is operative on its own: every ready P0/P1 preempts feature and
  presentation work, whether or not it also carries `bug`. `bug` is the only
  type label dispatch reads; `feat`/`refactor` are optional color, and `ui`
  optionally marks screen-heavy
  — therefore e2e-heavy — work (the two-agent cap).
- `enhancement`, `cleanup`, `javascript`, and `lib` are retired (2026-08-15)
  and deleted repo-side; a hygiene finding flags any reappearance. `lib` routed
  nothing — business logic living in `lib/` is the repo's own rule.
- `needs-human` means one specific owner answer is required. Apply it, assign
  the owner, and keep working elsewhere; never prompt the owner uninvited.
- Evaluations end with `recommend-adopt` or `recommend-hold`. A hold also gets
  `parked`; an adopt is merged by the orchestrator.

## Dispatch

- Use `scripts/orchestration/dispatch-brief.mjs new` for every agent, including
  Agent-tool runs. Adopt any unrecorded live dispatch immediately.
- Cluster two to six related issues by domain and files. Avoid file overlap;
  sequence work when overlap cannot be fenced.
- A `design` issue is dispatchable only when its body records the owner
  decision (the #2701 shape) or a direction with stated falsifiers (#2641).
  One still carrying the design question is owner-gated; agents never explore.
- Older issues start with an audit table: resolved by what, or still open.
- Cap E2E work at two agents and ordinary concurrent work at five agents (four
  until #2964 scoped the DB tier; raised on trial 2026-08-16).
- Revert on a DISCRIMINATING signal: a misread red actually shipped, or the
  ledger's median dispatch duration degrades. "Agents hit the ten-minute tool
  cap" is not one — it fired at four agents and at five, so it cannot tell them
  apart. Measured at five: median 90 min against a 86-min cap-four baseline.
- That cap counts agents RUNNING — a machine limit. The queue that jams first
  is PRs awaiting REVIEW, which is serial and cannot be parallelised. Hold
  dispatch at roughly three unreviewed PRs however few agents are running.
- While ready P1s exist, reserve two implementation lanes for user/data P1s and
  one for the highest-risk ready P2. Run at most one presentation/guard lane.
  A P1 operator bottleneck may use that fourth lane; it does not displace the
  two user/data lanes. Recompute this allocation whenever an issue is filed or
  a lane frees, not only at the start of a dispatch wave.
- STAGGER starts. Durations cluster tightly (seven of the first ten inside
  85±5 min), so simultaneous starts are simultaneous arrivals — and
  simultaneous GATES: five at once drove load to 17.7 on 4 cores.
- A red in code the diff did not touch is contention until proven otherwise —
  an ASSERTION failure included, not only a timeout (#3436).
- `dispatch-brief.mjs new` warns when a sibling started within 25 minutes and
  projects both arrivals; it never refuses, because a P0 preempts.
- A refuted PR re-enters the review queue, so arrival is not one-shot. Count
  rework when judging depth.
- Every brief uses the generated template and the gate order from
  `scripts/orchestration/agent-gates.sh`.
- Agents push after every meaningful step. The remote branch is the durable
  checkpoint. A branch that is not next in the landing train stays a branch:
  do not open its PR merely to obtain CI that an earlier merge will invalidate.
- A census meant to be EXHAUSTIVE passes ripgrep's `--binary` (`-a`). Several
  source files carry a deliberate NUL separator, so rg calls them binary and
  skips them — a plain `rg` reports a clean sweep it never took.
  `lib/__tests__/nul-byte-census.test.ts` names them.

## Per-unit pipeline

1. Read the issue body and every comment.
2. Generate the dispatch brief and record the branch in the task list.
3. Require the agent to merge current `origin/main` and run the assigned gates.
   Promote only the next landing candidate to a PR; keep later verified branches
   banked until the preceding merge lands, then rebase once.
4. Read the full diff, verify claims, and post a substantive COMMENT review.
5. Diagnose E2E reds locally; send code corrections back to the author unless
   the change is an orchestrator-owned E2E fix.
6. Merge only a green exact head. Serialize conflicting merges.
7. Close the dispatch, remove its worktree and branch, and verify linked issues
   actually closed.

## Landing train

- Parallelise implementation and independent review; serialize PR creation,
  exact-head CI, and merge. At most one branch from a shared base is the active
  landing candidate.
- Later lanes push durable branch checkpoints but do not open a PR for CI. Once
  the preceding candidate merges, promote the next branch in the ledger, rebase
  it, resolve semantic conflicts with its author, rewrite its body, open or
  refresh the PR, then obtain review against the exact pushed PR head.
- CI on an older base is diagnostic only. It is not merge evidence after an
  earlier overlapping or shared-substrate PR lands, so avoid paying for that
  run in advance.
- An urgent P0/P1 can move to the front. Say which candidate it displaced; do
  not run both full matrices and pretend both are next.
- Record candidate/banked state, priority, and lane in the dispatch ledger. Use
  `dispatch-brief.mjs promote <branch>` for every handoff or displacement so a
  restart reconstructs the same landing train.

## Tooling

- `dispatch-brief.mjs`: create, list, resume, adopt, and close dispatches.
  It also promotes the one landing candidate and updates validated priority/lane
  allocation in the append-only ledger; deliver every emitted role update to
  the affected running agents.
  `list` flags a dispatch that has not MOVED — newest of branch tip and
  worktree write — in 3x the median, not one that is merely old; a dispatch
  with no worktree and no branch at all is flagged separately.
- `agent-gates.sh`: lint, typecheck, unit, DB, E2E hygiene, PHI scan, format.
  The DB and E2E-hygiene gates run only when the diff touches what they cover.
  A format rewrite re-verifies the directive-reading gates it can invalidate.
  Both vitest gates carry a 60 s per-test ceiling here; CI keeps 15 s.
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
