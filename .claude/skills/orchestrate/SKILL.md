---
name: orchestrate
description: Run an agent-orchestrated development session on FloorLamp/allos — check in, triage the queue, cluster issues, dispatch coding agents through the brief tooling, review every diff, merge green heads serially, and keep the pipeline full until the queue is blocked or the owner winds it down. Use when the owner says "orchestrate", "run a session", "work the queue", "dispatch agents", "keep merging", or hands over the repo for autonomous development — and for resuming after a restart or gap. NOT for doing the feature work yourself (the orchestrator never writes feature code) and NOT for one-off issue filing or tracker maintenance (file-issue and reconcile-tracker own those).
allowed-tools: Read, Grep, Glob, Bash, Agent, AskUserQuestion, TaskCreate, TaskUpdate, TaskList, mcp__github__merge_pull_request, mcp__github__pull_request_read, mcp__github__issue_read, mcp__github__update_pull_request, mcp__github__actions_get, mcp__github__actions_list
---

# orchestrate — run the development session

`docs/orchestration.md` and its five procedure files are CANONICAL — this
skill sequences them and carries the posture; it restates nothing it can cite.
Read the entrypoint once per session, then only the procedure the current job
needs. The standing contract in one line: **cluster, dispatch, review,
diagnose, merge, clean up — and never write feature code yourself.** The
orchestrator's output is merged PRs authored by agents, not commits authored
by the orchestrator; the one exception is an E2E spec fix the orchestrator
owns.

**`docs/orchestration/environment.md` §GitHub access governs every read and
write**: REST outside the MCP set, reads unauthenticated, writes on
`${GH_TOKEN:-$GITHUB_TOKEN}`, no write believed until re-read. The MCP set —
squash merges, draft-to-ready, protected-ref and Actions writes — is the
orchestrator's to use and nobody else's. Never submit `REQUEST_CHANGES` or
`APPROVE`; hold with a COMMENT review, `parked`, and a stated reason.

**If a rule can be encoded in tooling, the tooling is the rule.** Every step
below names its script because running the script IS following the procedure;
prose is for the judgment the script cannot make.

**Dry runs arm nothing.** A planning pass — "plan the session", "what would
you dispatch", any run told to stop before dispatching — produces the plan and
DEFERS every effect that outlives it: no agents, no worktrees or branches, no
GitHub writes, and no scheduled wakes, triggers, or reminders. Name each
deferred arming in the plan as a "first live action" instead of performing it.
A LIVE session arms its durable wake at check-in (`lifecycle.md`); a dry one
only says it would. This line was bought, not imagined: a dry run once armed a
real wake trigger that would have fired into somebody's session hours later.

## 0. Check in — first action, every wake

```bash
bash scripts/orchestrator-checkin.sh
```

First action of every check-in and after ANY gap in activity — the script is
a flight recorder, not a formality. It detects restarts by persisted state
(boot-id), never by process liveness, and prints the dispatch ROSTER: which
agents were in flight when the world last ended. After a restart, PRESERVE
BEFORE DIAGNOSING — rescue in-flight work from the roster (remote branches
are the durable checkpoints; agents push after every meaningful step) before
investigating why the restart happened.

Then arm the next check-in (the durable one-shot per
`docs/orchestration/lifecycle.md`) and post a status pulse: in flight,
merged, queued, parked/owner-gated. Treat the script's persisted state as
authoritative over your own memory of the session.

## 1. Triage

- P0/P1 bugs preempt features — always, without being asked.
- Read candidate issues WHOLE: the entire body and every comment, freshly.
  Owner rulings append to body ends and arrive as comments; a truncated read
  drops exactly the binding text (a live run filed against a struck ruling
  this way).
- Older issues get an audit table first: resolved by what, or still open. The
  tracker's measured failure mode is stale premises, not typos — 7 of ~40
  audited issues rested on false ones.
- Label hygiene is machine-checked (`checkLabelHygiene` — exactly one
  priority-slot label, at least one domain label). Repair violations on the
  spot; they are yours to fix, not to report.
- `needs-human` items: apply the label + assign the owner the same day a
  question is flagged, then WORK ELSEWHERE. Never prompt the owner uninvited;
  the needs-human skill drains that queue when the owner shows up.
- `design` issues split on one test: does the body RECORD the decision, or
  still CONTAIN the question? A recorded owner decision (#2701's dated
  Decision section + acceptance criteria) or a direction with falsifiers
  (#2641's "what would show it working / wrong") dispatches like any P2; an
  issue still carrying the design question is owner-gated, and an agent never
  explores it — IA, navigation and tone judgments are owner territory
  (`lifecycle.md` §Out of scope), and `docs/internals/design-doctrine.md` is
  applied by agents, amended only by the owner.
- Sweep the open queue about every four hours for new filings, label drift,
  and comment rulings (`docs/orchestration/lifecycle.md` owns the cadence).

## 2. Cluster

Two to six related issues per agent, clustered by domain label and by FILES.
File overlap between concurrent clusters is the thing to avoid — sequence
work that cannot be fenced. Caps, which are load limits rather than
preferences: at most TWO agents in the E2E lane, ordinary concurrent work at
FIVE (`dispatch.md` §Dispatch carries the current number and what reverts it).
Only the orchestrator runs full E2E suites.

The cap is a proxy for gate cost, not for cleverness. Every agent pays the same
lint + typecheck + pure + DB bill regardless of domain, so raising it without
first scoping those tiers buys contention rather than throughput — and
contention here is not merely slow, it is MISLEADING: a starved tier fails in
code the agent never touched and reads as a regression.

## 3. Dispatch

```bash
node scripts/orchestration/dispatch-brief.mjs new --branch <branch> \
  [--worktree wt-x] [--issues 1,2] [--task "..."] [--e2e] [--port-base N]
```

Every agent goes through this — Agent-tool runs included — and any live
dispatch found unrecorded is ADOPTED immediately (`dispatch-brief.mjs` has
`adopt`), because the roster is what makes a restart survivable. Every brief
uses the generated template and the gate order from
`scripts/orchestration/agent-gates.sh`. Record the branch in the task list at
dispatch time. Require agents to merge current `origin/main` before gates,
and to push after every meaningful step.

Never edit a live agent's worktree without messaging it and receiving an
acknowledgement — two writers on one tree is how work disappears.

## 4. Review — every PR, no exceptions

`docs/orchestration/review-merge.md` §Review is the checklist; the posture
that makes it work:

- Read the FULL diff and verify its claims against the repository — searches
  and focused reads, exercising the write path when the diff cannot
  demonstrate the behavior. Relay evidence exactly; conclude only what you
  independently derived.
- The recurring defect classes get explicit checks: profile scoping, write
  transactions, authorization boundaries, identity handling, and shared
  one-question-one-computation models. Require tests at the tier that can
  observe the defect.
- Post it as a COMMENT review. Flag owner-visible judgment calls in it.
- Run `adversarial-review-brief.mjs <pr> --check` for every PR (exit 0
  MANDATORY / 3 CONSULT — you decide, from the claims it quotes / 1 ordinary /
  2 could not read the PR). High-stakes paths (data integrity, auth, safety
  signals) get a separate falsifying agent, and the merge WAITS for that
  report. A blocking finding fixed by changing the MECHANISM earns a fresh
  pass — see review-merge.md §Adversarial lane.
- E2E reds: diagnose locally, send code corrections back to the AUTHOR unless
  the fix is an orchestrator-owned E2E spec. `ci-watch.mjs` waits for settled
  CI (exit 0 green / 1 red / 2 unsettled / 3 conflict-blocked) — use it
  instead of polling.

## 5. Merge

Squash merge through MCP, only a GREEN EXACT HEAD, serially. After each
merge, recheck every open PR's mergeability; a later conflicting PR rebases
only after the last earlier conflict lands, and semantic conflicts go back to
their author — the orchestrator does not hand-integrate feature code.
Migration conflicts have their own rule (`review-merge.md` §Migrations):
merge order defines migration order, keep both `versions/index.ts` entries
with the later merge appended last, never edit a shipped migration.

## 6. Close out, then refill

```bash
node scripts/orchestration/dispatch-brief.mjs done <branch>
```

Verify linked issues actually closed (a merge that "closes" nothing is a
tracker leak), remove the worktree and branch, update release notes when the
change is user-visible (`lib/release-notes.json`, one batch per day max,
title-only bullets). Then REFILL: dispatch continuously while viable work
exists, without asking permission to resume. The session's honest terminal
state is "every remaining issue is blocked, owner-gated, or
dependency-bound" — reach it and say so explicitly, with the list.

## Standing cadence (once per session-day)

- One adversarial audit over the previous day of merges; file findings
  against the introducing PR.
- Dependabot: merge minors on green current main; majors through
  `dependabot-eval-brief.mjs` within a day (verdicts land as
  `recommend-adopt` / `recommend-hold` + `parked`).
- Institutionalize lessons THE SAME DAY: encode in tooling or the focused
  runbook file; narrative and receipts go to
  `docs/orchestration-incidents.md`. A lesson that lives only in the session
  transcript dies with the container.

## Wind-down

`docs/orchestration/lifecycle.md` §Wind-down, in order: stop dispatching,
land or clearly bank in-flight work (an unverified WIP marker only when an
agent actually died — and before deleting dirty work, check whether the
content already landed on main in another form), clean worktrees and stale
branches, stop check-ins, hand off remaining state in the final pulse.

## What is never yours

- Feature code, strategic/architectural work, information-architecture and
  tone judgments — owner territory (`lifecycle.md` §Out of scope).
- Approving or requesting changes on PRs (COMMENT reviews only).
- Answering `needs-human` questions on the owner's behalf — silence is not
  consent.
- Restructuring top-level guidance incidentally. Agents keep docs current;
  reshaping the doctrine is a decision, not a side effect.
