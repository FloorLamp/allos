# Orchestrating development on FloorLamp/allos

Status: **living** · process documentation for agent-orchestrated development sessions (not app behavior)

An operational runbook for an agent session that orchestrates development on this
repo: triage issues, dispatch coding agents, review every PR, own e2e, merge.
Distilled from a session that merged 98 PRs / closed ~215 issues with zero reverts.

## Operating contract

The standing directive (restartable anytime via `/loop`):

> orchestrate all development; prioritize bugs over features; delegate to opus
> agents; prefer gh rest over mcp; open prs as ready; max 2 agents working on
> e2e; only you run e2e tests; issues that aren't e2e can parallelize more;
> review all prs

What that means in practice:

- **You never write feature code.** You cluster, dispatch, review, diagnose e2e,
  merge, and clean up. The only code you write directly is e2e spec fixes —
  because you own the only local e2e environment.
- **Bugs before features, always.** A new audit dump preempts feature work.
- **Every PR gets a real review** before merge: full diff read (or focused reads
  - test-surface verification for >1,500-line refactors), posted as a COMMENT
    review via REST (APPROVE is rejected for this session type).
- **Merges are yours**, squash only, via `mcp__github__merge_pull_request`.
- **Strategic items wait for the owner** (integrations, mobile shell, IA
  decisions). Never start them unprompted; list them in status reports.

## Environment facts (hard-won — trust these)

| Thing            | Fact                                                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node             | `export PATH=/opt/node24/bin:$PATH`. **nvm is broken** (exit 3) — never use it.                                                                                                                               |
| node_modules     | Keep ONE canonical worktree (e.g. `wt-408`) with installed deps. Every new worktree: `cp -al $SCRATCH/wt-408/node_modules <wt>/node_modules` (hardlinks, ~instant).                                           |
| Worktrees        | All agent work in `git worktree add $SCRATCH/wt-<name> -b <branch> origin/main`. Never let an agent touch the main checkout. Remove worktrees + delete local branches after merge; disk is a fixed allowance. |
| GitHub REST      | `TOKEN="${GH_TOKEN:-$GITHUB_TOKEN}"` + curl. Reviews: `POST /repos/OWNER/REPO/pulls/N/reviews` with `event=COMMENT`.                                                                                          |
| Actions rerun    | The rerun API 403s for this token. Retrigger CI with an empty commit instead.                                                                                                                                 |
| Local e2e        | Always unique `E2E_PORT`/`E2E_DEMO_PORT` per run (this session used 3100–3260). `ALLOS_DB_PATH` isolation is handled by the Playwright config.                                                                |
| CI shape         | Two jobs per PR: `check` (~4 min) and `e2e` (~10–12 min, Playwright against `next start`). Every push costs a full round — batch fixes before pushing.                                                        |
| Issue auto-close | GitHub only parses `Fixes #N` **one keyword per line** in the PR body. Slash-separated lists silently don't close anything. Verify closure after every merge.                                                 |

## The pipeline (per unit of work)

1. **Triage.** Sweep open issues. Bugs first. Read the bodies **and all issue
   comments** — clarifications, scope changes, and owner decisions get buried in
   comment threads, and a fix that honors the body but misses a comment is wrong.
   This repo's audit issues are excellent (root cause + file:line + prescribed
   fix) and are the real interface to agents.
2. **Cluster.** Group 2–6 related issues per agent by domain/files. One PR per
   cluster. Check clusters for file overlap with each other and with anything
   the owner is editing (ask/observe); sequence or fence accordingly.
3. **Dispatch** (Opus agent, isolated worktree) using the template below.
   Respect the caps: max 2 concurrent agents doing e2e-touching work; non-e2e
   clusters can go wider (4 concurrent worked well).
4. **Review** when the PR lands: full diff via
   `Accept: application/vnd.github.v3.diff`. Verify the agent's _claims_ with
   cheap greps against main (does that testid exist? is that fixture id
   established? does that helper exist?). Post a substantive COMMENT review.
5. **CI green → squash merge.** If e2e fails, YOU reproduce locally (see e2e
   discipline), fix the spec on the branch, verify locally, push once, comment
   the diagnosis on the PR.
6. **After merge:** remove worktree, delete local branch, confirm the linked
   issues actually closed (close manually with a comment if not), update the
   task list.

## Dispatch prompt template

Every agent prompt must contain, verbatim where marked:

```
- Worktree setup: git fetch origin main && git worktree add $SCRATCH/wt-<x> -b <branch> origin/main
- cp -al $SCRATCH/wt-408/node_modules $SCRATCH/wt-<x>/node_modules
- export PATH=/opt/node24/bin:$PATH   (nvm is BROKEN — do not use)
- FETCH AND READ ALL ISSUE BODIES AND ALL ISSUE COMMENTS FIRST
  (GET /repos/OWNER/REPO/issues/N and /issues/N/comments) — clarifications and
  scope changes hide in comment threads; a comment overrides the body when they
  conflict. Trust symbol names over line numbers.
- Checks: npm run format && npm run lint && npm run typecheck && npm test && npm run test:db
  — run format LAST before committing (a late edit after formatting is a known CI breaker)
- Do NOT run Playwright locally — the orchestrator runs e2e centrally; author specs only
- Migrations: announce the number you take (check current max first); collisions
  resolve by whoever lands second renumbering + regenerating manifest.json
- PR body: closing keywords each ON THEIR OWN LINE (Fixes #N — GitHub parses one per line)
- Commit trailers EXACTLY:
    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
    Claude-Session: <session URL>
- No model identifiers in commits/PR/code
- Open the PR READY (not draft) via REST, base main
- Return: PR number/URL, per-issue fix summary, test summary, surprises
```

Add per-dispatch: the issue list with one-line titles, domain context pointers
(which lib/ modules, which conventions bear — quote the relevant AGENTS.md
convention names), any files currently fenced off (e.g. "the owner is editing
AGENTS.md/docs/ — do not touch; note needed README lines in the PR body
instead"), and e2e expectations (extend existing specs, stable testids, beware
fixture blast radius, dedicated fixture profile if in doubt).

Mid-flight scope changes: `SendMessage` to the agent works and agents handle it
well (including reverting already-made edits) — use it instead of killing/redispatching.

## E2e discipline (the part that most needs an owner)

- **Only the orchestrator runs local e2e.** One run at a time, unique ports.
- **Reproduce every CI e2e failure locally before pushing anything.** Blind
  fix-and-rerun loops waste 12 minutes per guess; a local repro plus the saved
  `error-context.md` aria snapshot usually identifies the defect in one look.
- Run new/changed specs locally _in the order that failed_ (serially with
  `--workers=1` when diagnosing cross-spec poisoning).
- Local `next dev` differs from CI's `next start`: local catches hydration-window
  races CI masks, and vice versa. A spec must pass both — retry-click patterns
  (`expect(async () => {...}).toPass()`) are the fix for pre-hydration clicks.

**Known failure classes** (every one recurred at least once):

1. **Fixture blast radius** — the #1 class. All specs share one seeded DB.
   A spec acting on a shared surface (an offer list, a dose list, a review
   inbox) must only act on rows it created; `.first()` on a shared surface is
   almost always a bug. Self-cleanup goes in `beforeAll` AND `afterAll`.
   Non-DB state (e.g. `data/logs/*.jsonl`) is NOT reset between runs — seed it
   with write, never append.
2. **Strict-mode collisions** — scope `getByText`/`getByRole` to a container;
   anchor cards on their own heading, not `hasText` (watch cards / pacing cards
   often repeat the same string earlier in the DOM).
3. **Autosave races** — wait for the Saved indicator before any reload.
4. **Collapsed `<details>`** — click the summary before asserting contents.
5. **Component variants** — a testid may cover multiple visual variants
   (pill vs circle); target the variant under test (`data-variant` hooks).
6. **Cross-row pairing** — never pair two `.first()` locators and assert their
   spatial relationship; scope both to one parent.

## Review checklist

- Does the fix match the issue's prescription **including any clarifications in
  the issue's comment thread**, and are deviations argued?
  (Good agents deviate correctly — e.g. matching an existing accounting
  contract over the issue's looser wording. Reward that; don't reflex-reject.)
- Grep-verify claims: testids, fixture names, helper functions, "already
  imported at line N" assertions.
- Conventions: profileId scoping, `writeTx` for mutations, one-question-one-
  computation (no forked second engines), row-ops side-state, identity
  functions over raw names, auth gates stay in actions.
- Tests at the tier that can SEE the bug (builder input-layer bugs need DB-tier
  fixtures; pure tests can't see them).
- Cross-PR conflicts among in-flight branches (same AGENTS.md line, same
  migration number) — plan the merge order and who resolves.
- Migration hygiene: append-only, manifest regenerated, number announced.
- Flag owner-visible judgment calls in the review (tone unifications, behavior
  loosenings) so the owner can veto cheaply.

## Cadence & lifecycle

- Agent completion notifications are the primary wake signal; `ScheduleWakeup`
  ~300s while work is in flight, 1200–1800s idle. Never poll with sleep.
- Keep a task per cluster (`agent → review → merge`) and update it at each stage.
- Institutionalize every incident into the next dispatch prompt the same day —
  the error rate drops measurably wave over wave.
- **Wind-down** = no new dispatches; land everything in flight (review, fix
  specs, merge), cancel queued waves, clean worktrees, write a handoff listing:
  merged work, deliberately-open items, owner decisions pending, and any
  environment state worth keeping (the canonical node_modules worktree).

## Deliberately out of scope for agents

- AGENTS.md / README / docs while the owner has edits in flight (fence it in
  every prompt; collect needed doc lines in PR bodies instead).
- Strategic/architectural issues the owner hasn't green-lit.
- Anything requiring an owner judgment (IA/nav decisions, tone choices) —
  surface, don't decide.
