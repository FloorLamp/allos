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

| Thing            | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node             | Node 24 required, but the path varies by container image: newer images `export PATH=/opt/nvm/versions/node/v24.18.0/bin:$PATH` (check `ls /opt/nvm/versions/node/`), older images `/opt/node24/bin`. The bare `node` on PATH may be v22 — wrong ABI for prebuilt better-sqlite3. Verify with `node -e "require('better-sqlite3')"` before dispatching; `npm rebuild better-sqlite3` fixes a wrong-ABI worktree.                                                                                                                                                                      |
| node_modules     | Keep ONE canonical worktree (e.g. `wt-408`) with installed deps. Every new worktree: `cp -al $SCRATCH/wt-408/node_modules <wt>/node_modules` (hardlinks, ~instant).                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Worktrees        | All agent work in `git worktree add $SCRATCH/wt-<name> -b <branch> origin/main`. Never let an agent touch the main checkout. Remove worktrees + delete local branches after merge; disk is a fixed allowance.                                                                                                                                                                                                                                                                                                                                                                        |
| GitHub REST      | `TOKEN="${GH_TOKEN:-$GITHUB_TOKEN}"` + curl. Reviews: `POST /repos/OWNER/REPO/pulls/N/reviews` with `event=COMMENT`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Actions rerun    | The rerun API 403s for this token. Retrigger CI with an empty commit instead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Local e2e        | Assign each WORKTREE a fixed port PAIR (`E2E_PORT`/`E2E_DEMO_PORT`: 5400/5401, 5600/5601, 5800/5801, …) at dispatch — zero collisions since adopting pairs. `ALLOS_DB_PATH` isolation is handled by the Playwright config. In some containers local `next dev` boot TIMES OUT — run CI-parity instead: `rm -rf .next && npm run build` once, then `CI=1 ANTHROPIC_API_KEY= E2E_PORT=<p> E2E_DEMO_PORT=<p+1> npx playwright test e2e/auth.setup.ts <specs> --repeat-each=3 --retries=0 --reporter=list`, with `rm -rf e2e/.data` + `lsof -ti :<p> -ti :<p+1> \| xargs -r kill` first. |
| REST merge       | `PUT /pulls/N/merge` can 403 through the agent proxy — merge ONLY via `mcp__github__merge_pull_request` (squash).                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| CI shape         | Two jobs per PR: `check` (~4 min) and `e2e` (~10–12 min, Playwright against `next start`). Every push costs a full round — batch fixes before pushing.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Issue auto-close | GitHub only parses `Fixes #N` **one keyword per line** in the PR body. Slash-separated lists silently don't close anything. Verify closure after every merge.                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Container-restart resilience (the dominant failure mode)

Managed containers restart frequently and without warning, killing every
background task, poll, and in-flight agent bash call. Everything below was
learned by losing work to it:

- **Agents commit AND push after every meaningful step** — put it in every
  dispatch prompt. A restart then costs at most one uncommitted edit set.
- **No background-run + monitor/poll pattern inside agents.** An agent that
  backgrounds its e2e and waits on a monitor resumes into waiting for a
  completion event that died with the container — the observed stall is
  "I'll wait for the monitor" forever. Long verification runs go in ONE
  foreground bash call.
- **Liveness = process evidence, never file evidence.** A subagent transcript's
  mtime is touched by the restart's own bookkeeping and reads as "alive". The
  reliable check is the main process start time (`ps` start column) versus the
  last known-good time; a young main PID means everything before it is dead.
- **The restart drill** (run it on every restart notification): assume every
  agent is dead; snapshot each worktree (`git log --oneline -3`, `git status`,
  local-vs-origin rev); resume each agent via `SendMessage` with a precise
  state summary (what survived, what's left); restart your own CI polls
  (they die too — and relaunch them with ABSOLUTE script paths; a
  cwd-inherited relative path 127s).
- Agents resumed from transcript with a good state summary recover cleanly
  every time — killing/redispatching is almost never necessary.

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
   **Merge-collision management:** at a high merge rate, same-file conflicts
   are the norm — README feature bullets and `e2e/seed-events.ts` are the
   recurring magnets (three consecutive PRs once collided on one README line).
   Serialize merges through the orchestrator; when several open PRs touch the
   same file, defer the later PR's rebase until the LAST conflicting merge has
   landed (one rebase instead of two). To repair a botched hand-merge, redo the
   file with a mechanical 3-way (`git merge-file merged base theirs`) rather
   than editing conflict markers — hand union-splicing produced this pattern's
   only self-inflicted breakages (leftover markers, fused declarations). Keep
   README edits to one self-contained clause and seed blocks uniquely anchored
   so splices stay one-line operations.
6. **After merge:** remove worktree, delete local branch, confirm the linked
   issues actually closed (close manually with a comment if not), update the
   task list.

## Dispatch prompt template

Every agent prompt must contain, verbatim where marked:

```
- Worktree setup: git fetch origin main && git worktree add $SCRATCH/wt-<x> -b <branch> origin/main
- cp -al $SCRATCH/wt-408/node_modules $SCRATCH/wt-<x>/node_modules
- export PATH=<node-24 bin dir>:$PATH in EVERY shell (see Environment facts; verify better-sqlite3 loads)
- COMMIT AND PUSH after every meaningful step — container restarts are frequent
- Long runs (e2e, builds) in ONE foreground bash call — never background + monitor/poll (dies with restarts)
- FETCH AND READ ALL ISSUE BODIES AND ALL ISSUE COMMENTS FIRST
  (GET /repos/OWNER/REPO/issues/N and /issues/N/comments) — clarifications and
  scope changes hide in comment threads; a comment overrides the body when they
  conflict. Trust symbol names over line numbers.
- Checks: npm run format && npm run lint && npm run typecheck && npm test && npm run test:db
  — run format LAST before committing (a late edit after formatting is a known CI breaker)
- Run YOUR changed e2e specs locally at CI parity on your assigned port pair:
  --repeat-each=3 --retries=0 (retry-masking must not land a flaky spec).
  Do NOT run the full suite — the orchestrator owns full-suite runs.
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

**Broadcast seams between sibling agents.** When a PR that will merge first
creates an interface a sibling agent should consume (a generalized registry, a
new helper, a renamed store), message the sibling immediately with the seam's
name and shape — before its own PR exists. This turns a post-merge rework
cycle into a proactive integration (e.g. a notification-kind registry
generalized by one PR was consumed by the in-flight sibling the same hour).
Record each dispatch's BRANCH NAME in the task/tracking entry — reconstructing
it later from the issue number is guesswork.

## E2e discipline (the part that most needs an owner)

- **Split ownership: agents verify their own changed specs (CI-parity,
  `--repeat-each=3 --retries=0`, their assigned port pair); only the
  orchestrator runs FULL suites.** The repeat-each lane keeps catching real
  product defects that retries would have masked (a debounced-autosave orphan
  row poisoning the next repeat; a live-mode finish seam remounting the form) —
  it is the single highest-value gate in the pipeline.
- **Double-green before merging a UI/migration PR:** CI green (check + e2e,
  including CI's changed-specs repeat lane) AND a local CI-parity full-suite
  run. Lib/docs-only PRs merge on CI green alone. **Rebase waiver:** when a
  rebase's delta is text-only (README/docs conflict resolution), CI's full e2e
  - changed-specs lane on the exact rebased tip, plus the pre-rebase local full
    suite, is sufficient — don't burn a second local full run.
- **Check exit codes explicitly** — `cmd 2>&1 | tail -3 && echo OK` reports the
  TAIL's exit status and masks the failure; echo `EXIT=$?` on its own line.
- **Reproduce every CI e2e failure locally before pushing anything.** Blind
  fix-and-rerun loops waste 12 minutes per guess; a local repro plus the saved
  `error-context.md` aria snapshot usually identifies the defect in one look.
- Run new/changed specs locally _in the order that failed_ (serially with
  `--workers=1` when diagnosing cross-spec poisoning).
- Local `next dev` differs from CI's `next start`: local catches hydration-window
  races CI masks, and vice versa. A spec must pass both — settled interactions
  through `e2e/helpers.ts` (`settledClick`/`followLink`) are the fix for
  pre-hydration clicks. In containers where `next dev` boot times out, run the
  CI-parity form (build + `CI=1`) exclusively — it is the mode that gates.

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
