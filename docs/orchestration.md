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

| Thing            | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node             | Node 24 required, but the path varies by container image: newer images `export PATH=/opt/nvm/versions/node/v24.18.0/bin:$PATH` (check `ls /opt/nvm/versions/node/`), older images `/opt/node24/bin`. The bare `node` on PATH may be v22 — wrong ABI for prebuilt better-sqlite3. Verify with `node -e "require('better-sqlite3')"` before dispatching; `npm rebuild better-sqlite3` fixes a wrong-ABI worktree.                                                                                                                                                                                                                                                                              |
| node_modules     | Keep ONE canonical worktree (e.g. `wt-408`) with installed deps. Every new worktree: `cp -al $SCRATCH/wt-408/node_modules <wt>/node_modules` (hardlinks, ~instant).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Worktrees        | All agent work in `git worktree add $SCRATCH/wt-<name> -b <branch> origin/main`. Never let an agent touch the main checkout. Remove worktrees + delete local branches after merge; disk is a fixed allowance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| GitHub REST      | `TOKEN="${GH_TOKEN:-$GITHUB_TOKEN}"` + curl. Reviews: `POST /repos/OWNER/REPO/pulls/N/reviews` with `event=COMMENT`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Actions rerun    | The rerun API 403s for this token. Retrigger CI with an empty commit instead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Local e2e        | Assign each WORKTREE a fixed port PAIR (`E2E_PORT`/`E2E_DEMO_PORT`: 5400/5401, 5600/5601, 5800/5801, …) at dispatch — zero collisions since adopting pairs. `ALLOS_DB_PATH` isolation is handled by the Playwright config. In some containers local `next dev` boot TIMES OUT — run CI-parity instead: `rm -rf .next && npm run build` once, then `CI=1 ANTHROPIC_API_KEY= E2E_PORT=<p> E2E_DEMO_PORT=<p+1> npx playwright test e2e/auth.setup.ts <specs> --repeat-each=3 --retries=0 --reporter=list`, with `rm -rf e2e/.data` + `lsof -ti :<p> -ti :<p+1> \| xargs -r kill` first. **FULL suites: always CI-mode** (see e2e discipline — dev-mode full suites swap the box and mass-fail). |
| Raw Playwright   | A hand-rolled debug script (`chromium.launch()` outside the test runner) may want a headless-shell version the container doesn't have — launch with `executablePath: "/opt/pw-browsers/chromium-<ver>/chrome-linux/chrome"` (check `ls /opt/pw-browsers`). Kill any manually-booted `next dev` before a suite run: it holds the `.next` dev-server lock for that worktree AND its memory counts against the suite (see below).                                                                                                                                                                                                                                                               |
| REST merge       | `PUT /pulls/N/merge` can 403 through the agent proxy — merge ONLY via `mcp__github__merge_pull_request` (squash).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| CI shape         | Per PR (since 2026-07-21): `check` (~4 min), `e2e-changed` (the PR's changed specs/infra at retries=0), and a 4-way sharded `e2e` matrix (full suite at retries=1, fresh runner + fresh servers per shard). Every push costs a full round — batch fixes before pushing. On-demand full-suite gate for ANY branch: dispatch `.github/workflows/e2e-full.yml` (fresh runners, defaults retries=0; `repeat_each` up to 3). Each full-suite shard posts a pass-on-retry flake report to its job summary — read it after green runs; those are confirmed flakes to file.                                                                                                                          |
| Issue auto-close | GitHub only parses `Fixes #N` **one keyword per line** in the PR body. Slash-separated lists silently don't close anything. Verify closure after every merge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

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
- **Transient API errors (529 Overloaded, 5xx) kill subagents the same way** —
  the failure notification names the API error, the work is NOT lost, and the
  same resume drill applies: `SendMessage` with "this was a server-side kill,
  not a cancellation; re-orient with git status/log, commit coherent
  uncommitted work, continue from <last reported step>".
- **A kill labeled "stopped by user" is NOT evidence the owner stopped it.**
  The environment emits that label for its own reclaims/interrupts too; the
  owner has stated they never stop agents directly. Do not treat it as a
  cancellation or a scope signal — apply the normal resume drill. (If a stop
  ever IS deliberate, the owner will say so in a message; absent one, resume.)
- **A restore can time-warp your LOCAL view — GitHub's REST API is the only
  authoritative one.** After a restart, the local checkout, the local
  `origin/main` ref (the container's git proxy serves a stale mirror until
  re-fetched), and even the task list can all revert to an earlier snapshot —
  which reads exactly like "main was force-pushed back N merges" and once
  triggered a data-loss scare mid-wind-down. Before concluding ANY rollback:
  `GET /repos/OWNER/REPO/branches/main` (and a `GET /commits/<sha>` for a
  supposedly-vanished merge) via api.github.com. If GitHub disagrees with the
  local refs, the container is the stale party — recover with `git fetch` +
  `git checkout -B <branch> <api-verified-sha>`, and re-verify any "completed"
  work the reverted task list claims is still pending before redoing it.

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
   **Owner commits land on main mid-session** — including direct non-PR pushes
   from the owner's other tools — so a PR built before one can grow a SEMANTIC
   conflict (a redesigned component vs. an agent's additions to it), not a text
   splice. Resolve those by RESUMING the authoring agent via `SendMessage` with
   precise instructions: merge origin/main, take MAIN's structure as the base,
   re-integrate its own self-contained additions into the new layout (restyled
   to the new conventions), and re-verify its specs at CI parity — the agent
   knows its code; a hand re-integration by the orchestrator is the union-splice
   mistake at component scale. A code re-integration (unlike a text-only rebase
   delta) re-triggers the FULL local suite before merge — the rebase waiver does
   not apply.
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
- npm run phi-scan before the final push — the pre-commit staged-files hook does
  NOT fire in agent worktrees, and CI's whole-tree scan will red a PR for a
  pattern-shaped literal (a SHA-256 golden's digit substring once formed a
  Luhn-valid NPI; the fix is the scanner's own same-line `phi-scan-ok` marker
  with a justification)
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

> **2026-07-21 update — full-suite gates moved to GitHub runners.** The sharded
> `e2e` matrix in PR CI now runs the FULL suite on every push (fresh runner +
> fresh servers per shard), and `.github/workflows/e2e-full.yml`
> (workflow_dispatch) runs the whole suite against any branch at `--retries=0`
> on demand. Use the dispatch workflow where this section previously required a
> LOCAL CI-parity full-suite run (migration PRs, big UI merges) — it is the
> "CI on a fresh runner is the ultimate authority" conclusion below,
> institutionalized. The local-run guidance that follows (memory bounds,
> sharding, degradation triage) is retained for the rare case a local full run
> is still needed (e.g. no pushable branch yet).

- **Split ownership: agents verify their own changed specs (CI-parity,
  `--repeat-each=3 --retries=0`, their assigned port pair); only the
  orchestrator runs FULL suites.** The repeat-each lane keeps catching real
  product defects that retries would have masked (a debounced-autosave orphan
  row poisoning the next repeat; a live-mode finish seam remounting the form) —
  it is the single highest-value gate in the pipeline.
- **Double-green before merging a UI/migration PR:** CI green (check + e2e,
  including CI's changed-specs repeat lane) AND a local CI-parity full-suite
  run. Lib/docs-only PRs merge on CI green alone. **Relaxed bar for contained
  diffs (owner-approved 2026-07-20):** a low-blast-radius PR (a lib fix, a
  bug cluster that changed a handful of specs) merges on CI green + typecheck
  - pure + db + the PR's OWN changed-spec lane — SKIP the full local suite.
    The full-suite gate is reserved for MIGRATION PRs and BIG UI merges (a nav
    consolidation, a multi-page feature) — and since 2026-07-21 it is a dispatch
    of `e2e-full.yml` against the branch (fresh runners, retries=0), not a local
    run; PR CI's sharded `e2e` matrix already gives every push a full-suite pass
    at retries=1 on top of that. **Rebase waiver:** when a
    rebase's delta is text-only (README/docs conflict resolution), CI's full e2e
  * changed-specs lane on the exact rebased tip, plus the pre-rebase local full
    suite, is sufficient — don't burn a second local full run.
    **Branch-cut waiver:** a branch cut before a spec-fix merged to main will
    re-fail that spec in the local full suite (the fix isn't on the branch; the
    post-merge tree has it). With CI green on the head and the failure matching
    the main-fixed flake, that failure doesn't block the merge — note the
    branch's cut point before interpreting local full-suite results.
- **Local FULL suites are memory-bound — run them in CI-mode, serialized.**
  A dev-mode (`next dev`) server balloons to ~5 GB RSS as the suite touches
  every route; the suite runs TWO (app + demo) plus Chromium, which pushes the
  container into swap mid-run — from there every spec times out ("element(s)
  not found" across 80–90 UNRELATED specs, 2× runtime). This masquerades as
  "flaky environment" but is deterministic memory exhaustion: check
  `ps aux --sort=-%cpu` for `kswapd0`/`kcompactd0` CPU time before blaming
  specs. The fix: full suites run the CI recipe (`npm run build` once, then
  `CI=1 E2E_PORT=<p> E2E_DEMO_PORT=<p+1> npm run test:e2e`) — production
  `next start` is lean AND is the mode that actually gates. Never run a full
  suite while any agent is building or a second suite is running; one full
  suite on the machine at a time.
- **SHARD the full local suite — a single 460-spec `next start` process
  degrades even solo on a quiet box (2026-07-20).** A lean single-worker CI-mode
  run of the WHOLE suite in one process climbs to ~50 min and starts failing
  60+ UNRELATED specs with server-death timeouts (`element(s) not found`,
  `toBeVisible` timeouts) partway through — the long-lived app+demo servers
  degrade cumulatively, NOT a memory-at-start problem (14 GB free, no swap; the
  memory sample stays flat while it dies). The fix is to run `--shard=N/M`:
  each shard is a fresh `npx playwright test` invocation → fresh servers → each
  chunk finishes in 3-6 min clean. **Use `/4` (≈115 specs/shard), not `/3`** —
  the third of three still degraded in testing; four holds. Run the shards as
  SEPARATE sequential invocations (not chained in one shell after a heavy
  pure+db+build run — that shell's accumulated RSS pushes the last shard over).
  A shard that fails wide with server-death timeouts is **transient container
  degradation, not a regression**: re-run THAT shard fresh on a settled box; a
  clean re-run is the authority. Do NOT chase it as a code bug (a real
  infinite-loop poison is deterministic — it fails the same shard every time,
  including a `--max-failures=1` probe; degradation passes on a settled re-run).
  This cost hours on the #1047-#1062 train before the pattern was clear.
- **The #1 cause of "degradation" is YOUR OWN concurrent poll loops — never run a
  background CI-poll while a local e2e gate runs (2026-07-21).** A whole night's
  worth of "container degradation" (90s server-death timeouts, 11-min 6-spec
  runs) turned out to be self-inflicted: a `for i in seq…; do sleep 30; curl…;
python… ; done` CI-poll loop running in the background was starving the
  `next start` servers of CPU. The box was never exhausted — `ps` showed zero
  leaked processes and 14 GB free RAM the whole time. Kill the polls (or don't
  start them) and the SAME specs run clean in ~48 s. Discipline: while a local
  e2e run is in flight, run NOTHING else — no CI polls, no second gate, no agent
  build. Check `ps -eo comm | grep -cE 'next-server|chromium|curl'` and
  `free -g` before blaming the container; leaked-process-count 0 + free RAM ⇒
  it's contention (yours) or the single-process heavy-shard limit, not exhaustion.
  A container restart doesn't fix contention — stopping the competing work does.
- **Don't chain full gates — an exhausted container makes even the "re-run
  fresh" remedy lie (2026-07-20, #1045).** After ~65 min of continuous e2e (two
  back-to-back full 4-shard gates + an isolation re-run) the box degraded so far
  that a 40-test isolation run took **15 min** (~5× normal) and REPRODUCED the
  exact same ~18 failures — because under severe starvation the failure set is
  NOT random: the heaviest-rendering specs (chart pages, multi-section `/records`,
  detail pages) blow the 5 s `toBeVisible` timeout FIRST and DETERMINISTICALLY.
  So "same failures twice" is NOT proof of a real bug when the container is spent
  — the `--max-failures=1`/isolation heuristic above assumes a SETTLED box, and a
  chained-gate box is not settled. Two defenses: (a) never run gates back-to-back
  — let the box idle, or better, don't re-gate locally at all once you have a
  clean fresh-runner signal; (b) **CI on a fresh GitHub runner is the ultimate
  authority.** Bonus: a PR that touches shared e2e infra (`e2e/seed-events.ts`,
  `e2e/fixture-logins.ts`, `e2e/helpers.ts`) makes CI run the WHOLE suite (not
  the changed-spec lane), so its green IS a full-suite pass on a clean box — trust
  it over a local run on your degraded container. Before calling a wide local
  failure a regression, confirm the diff could even reach those specs (a purely
  additive fixture that only creates NEW profiles cannot break records/qualitative/
  protocols specs that read OTHER profiles — that's degradation, full stop).
- **Mass-failure triage drill** (when a local full suite fails wide): (1) check
  memory pressure first (above); (2) rerun a handful of the failed specs in
  isolation — passing alone means suite-scale starvation, failing alone means a
  real defect; (3) for a suspected write/read bug, interrogate the leftover
  `e2e/.data` DB directly and boot the app against it — a committed write that
  a fresh page load renders correctly proves the in-test failure was a
  re-render race, not a regression. Do NOT accept "environmental" (or
  "regression") for a twice-repeated failure shape without the isolation step.
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
   often repeat the same string earlier in the DOM). **A page CONSOLIDATION/FOLD
   retroactively breaks OTHER specs' unscoped selectors**: when a merge moves N
   section forms onto one page (the #1042 specialty fold put Vision/Dental/Skin/
   Mental-health forms onto `/records`), a neighbor spec's page-wide
   `getByRole("button",{name:"Save"})` that was unique becomes a strict-mode
   violation (its symptom is a cryptic `text.replace is not a function` from
   Playwright's selector-generator, not a plain "resolved to N elements"). This
   is a REAL fold-introduced failure (proves out: passes on main, fails on the
   fold branch), and the fix is a spec-selector scope (anchor Save to the edit
   `<form>`) — the folding orchestrator's lane, not the product author's. When
   reviewing/gating a consolidation, expect exactly this and re-run any spec that
   drove the folded-in pages.
3. **Autosave races** — wait for the Saved indicator before any reload.
4. **Collapsed `<details>`** — click the summary before asserting contents.
5. **Component variants** — a testid may cover multiple visual variants
   (pill vs circle); target the variant under test (`data-variant` hooks).
6. **Cross-row pairing** — never pair two `.first()` locators and assert their
   spatial relationship; scope both to one parent.
7. **Fixture seeds a dead legacy write path** — when a PR moves where state
   lives (settings keys → a table, a column → a row), a fixture that still
   seeds the OLD mechanism silently stops feeding the surface: a migration's
   legacy-copy only acts at migration time, and the e2e seed runs AFTER
   migrations. Fixtures seed through the feature's REAL write core
   (`writeTx(setX(...))`), never by hand-writing its storage — then a storage
   move can't strand them. (This was a CI-red on the notify-lifecycle PR: the
   seed still wrote `notify_last_error*` settings keys the reader no longer
   consulted.) Reviewers: a PR that relocates state must grep
   `e2e/seed-events.ts` and `scripts/seed.ts` for the old mechanism.
8. **The midnight-UTC window (~23:30–00:15 UTC)** — a gate that fails only in
   this window is almost never the PR. Before blaming the diff, read the run's
   wall-clock timestamps. Two subclasses, both hit on the #1047 gates:
   (a) a CLIENT component computing a relative age ("2 hrs ago") from the
   browser's real clock, which cannot see `ALLOS_TEST_NOW` — a fixture reading
   stamped 00:05 flips to "(Yesterday)" as real time nears midnight. The pure
   formatters (`formatRelativeTime`, `readingClockWithRelativeAge`) already
   take an injectable `now`; the fix is always the #1028 pattern — thread a
   server-computed `nowIso` prop across the "use client" boundary, never a
   client-side `new Date()`. (b) a DB-tier fixture pairing `today(profileId)`
   with a wall clock derived from a SHIFTED real instant (`now - 20min` →
   `getUTCHours`): just after UTC midnight the hh:mm belongs to yesterday, so
   date+time reconstructs an instant ~24h in the FUTURE (workout-presence-gate
   failed exactly so at 00:14 UTC). Discipline: derive a fixture row's date
   AND time from ONE instant. Sweep hook: `grep getUTCHours lib/__db_tests__`.
   The GENERAL form is the **morning-UTC band** (issue #1048): rows the suite
   writes at runtime get REAL timestamps (SQL `datetime('now')` defaults),
   while assertions run on the frozen `ALLOS_TEST_NOW` = today 12:00 — from
   00:00 to ~11:00 UTC real time LAGS frozen time by hours, and every
   liveness/recency window reads a just-written row as stale (afternoon runs
   survive only because future-instant tolerance is built in; morning runs
   had simply never happened before 2026-07-20). Triage drill for ANY gate
   failure in that band: reproduce the failed specs on plain MAIN at the same
   hour — an identical failure proves the band, not the PR; then rerun the
   gate after ~12:05 UTC (real ≥ frozen, the proven regime) and merge on that
   green. Do not patch specs to tolerate the band; the structural fix is
   #1048's design pass.
   **The band is BROAD, not two specs (2026-07-21, ~03:00 UTC).** It was first
   seen as `workout-presence` + `temperature-unit`, but a night gate showed
   ~10 recency/liveness-gated specs failing identically on plain main:
   `protocol-reach` (×4 — the "ongoing protocol" annotations + biomarker
   outcome options), `protein-adequacy`, `profile-switch-toasts` ("no ghost
   toasts on first poll"), `qualitative-chart` (×3), plus the original two —
   all rendering only the app shell (main content data-gated-out), no server
   error logged, seed clean. So a night full-suite gate ALWAYS carries ~10
   rotating false-failures, which is indistinguishable at a glance from
   (a) a real regression or (b) single-process whole-suite degradation — and
   tonight all three got confused on one gate. Discipline: (1) at night, the
   ONLY authoritative full green is a post-12:05-UTC rerun; (2) to clear a
   specific PR before then, the bisect is decisive — run the SAME failing
   specs on the PR's BASE commit (pre-change main) at the SAME hour; identical
   failures ⇒ band, and the PR's own changed spec passing + a green check job
   is enough to merge on the carve-out (this is how food-nudge #1097 merged).
   (3) A `BUILD=1` when checking out an OLDER commit in a reused worktree is
   usually the downgrade guard (`user_version` newer than the old code's max
   migration) — `rm data/allos.db*` and rebuild, it is NOT a real build break.
9. **Persisted channel config turns event-driven dispatches into marker
   pollution** — the delivery-health marker is GLOBAL (one `notify_lifecycle`
   row), and `notify-delivery-error.spec.ts` asserts the seeded fixture
   marker. Any spec that PERSISTS notification-channel config (an HA webhook
   URL, a Telegram chat id) must run on its OWN fixture profile that no other
   spec triggers sends for — since the #1025 write-path dispatch, a config
   leaked onto a shared profile turns any crossing-temperature log elsewhere
   in the suite into a real failed send that overwrites the fixture marker
   (home-assistant-notify leaked exactly this on profile 1 for months; it was
   inert only because nothing dispatched during e2e before #1025). Reviewers:
   a PR that adds an event-driven send path must grep the e2e specs for
   persisted channel config on shared profiles; a spec that configures a
   channel gets a dedicated fixture login.

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

**Migration-train renumber recipe (the orchestrator, merging N migration PRs in
sequence — done 3× on the #1059/#1061/#1062 train):** when several in-flight
branches each claimed the same slot (all cut from the same main), merge them one
at a time; each after the first renumbers to the next free number. Per PR: (1)
`git merge origin/main`; (2) `git mv NNN-slug.ts MMM-slug.ts` for each colliding
migration and bump its `id:` + `name:` + the `Migration NNN` comment inside; (3)
fix `versions/index.ts` — the import conflict resolves to MAIN's slot import PLUS
your renamed import, and append your `mMMM` to the array; (4) `prettier --write`
the renamed migration file, `sha256sum` it, and put that hash under the new
filename key in `manifest.json` (keep main's entries); (5) grep for the OLD
number in TEST files — a `migration-NNN-*.test.ts` name and its import path, and
the profile-scoping allowlist's `NNN-slug.ts` PRAGMA entry, all need the new
number; (6) validate BEFORE the full gate with the cheap deterministic tier:
`migration-immutability` (hashes match) + db-tier `migrate`/`runner` (contiguous
chain applies) + `typecheck`. **Append-append conflict hazard:** resolving
fixture files (`seed-events.ts`, `fixture-logins.ts`) by concatenating ours+theirs
can drop a shared boundary line — a `console.log(...` whose closing `);` sat on
the other side of the `=======` — so ALWAYS `typecheck` after; the error is a
bare `',' expected` at the seam.

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
