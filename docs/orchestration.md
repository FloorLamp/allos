# Orchestrating development on FloorLamp/allos

Status: **living** · process documentation for agent-orchestrated development
sessions (not app behavior)

An operational runbook for an agent session that orchestrates development on
this repo: triage issues, dispatch coding agents, review every PR, own e2e,
merge. Distilled across several such sessions — the first merged 98 PRs and
closed ~215 issues with zero reverts; later ones added the migration-slot
protocol (098–108), the #1392/#1417 census root-causes and the release-notes
pipeline, the `parked`/dependabot rulings and the check-in cadence, and the
merge-commit discipline below. Migration slots are past 165 and every session
so far has held zero reverts. Nothing here is theory: each rule is an incident
that cost time once.

## Operating contract

The standing directive (restartable anytime via `/loop`):

> orchestrate all development; prioritize P0/P1 bugs over features; delegate to
> opus agents; prefer gh rest over mcp; open prs as ready; max 2 agents working
> on e2e; only you run e2e tests; issues that aren't e2e can parallelize more;
> review all prs

What that means in practice:

- **You never write feature code.** You cluster, dispatch, review, diagnose e2e,
  merge, and clean up. The only code you write directly is e2e spec fixes —
  because you own the only local e2e environment.
- **P0/P1 bugs before features** (owner, 2026-07-26). A P0/P1 bug preempts feature work the moment it appears. P2/P3 bugs
  are ordinary queue members — cluster them with adjacent work and schedule them
  against features on value, not reflexively ahead. An audit dump preempts only
  for its P0/P1 items.
- **Every PR gets a real review** before merge: full diff read (or focused reads
  - test-surface verification for >1,500-line refactors), posted as a COMMENT
    review via REST (APPROVE is rejected for this session type).
- **Merges are yours**, squash only, via `mcp__github__merge_pull_request`. MCP
  rides the owner's account rate limit — subagent briefs point agents at `curl`
  REST for issue reads (`GET /repos/OWNER/REPO/issues/N` + `/comments`) so a
  fleet can't drain the quota. On a rate-limit rejection, don't retry in a loop:
  wait out the reset and batch the pending calls. Draft→ready goes through MCP
  `update_pull_request` (REST PATCH can't flip draft; GraphQL is proxy-blocked).
- **Strategic items wait for the owner** (integrations, mobile shell, IA
  decisions). Never start them unprompted; list them in status reports.
- **An idle pipeline with work available is an ERROR, and dispatch is the
  default state.** Never ask permission to relaunch, resume or refill — not
  after a restart killed the agents, not after a wave lands, not at a check-in
  that finds nothing to review. Owner ruling, 2026-08-12, after the orchestrator
  finished a rescue and then asked whether to relaunch the three clusters it had
  just rescued. The queue and the caps already encode what may run; asking again
  adds a human round-trip to a decision the runbook has already made. Ask only
  about things the runbook genuinely does not decide — a product judgement, an
  owner-authored PR, a scope that has grown past its brief.
  The corollary at a check-in: if there is nothing to review and a slot is free,
  DISPATCH, then report what you dispatched. "Nothing to do" is a conclusion the
  orchestrator is almost never entitled to reach while the backlog is non-empty.

## Environment facts (hard-won — trust these)

| Thing             | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node              | Node 24 required. It lives under `/opt/nvm/versions/node/`. DISCOVER the version, never paste one from here — `ls /opt/nvm/versions/node/`, then `export PATH=/opt/nvm/versions/node/<version>/bin:$PATH`. A pinned patch version in this table went stale within days and every copy-paste of it pointed at a directory that did not exist. Some images ship no node 24 at all — install it: `export NVM_DIR=/opt/nvm && . /opt/nvm/nvm.sh && nvm install 24` (~30s, survives for the session). The bare `node` on PATH may be v22 — wrong ABI for prebuilt better-sqlite3. Verify with `node -e "require('better-sqlite3')"` before dispatching; `npm rebuild better-sqlite3` fixes a wrong-ABI worktree.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| node_modules      | Keep ONE canonical tree with installed deps. The main checkout (`/home/user/allos/node_modules`, after a fresh `npm ci`) is the durable choice — a worktree is not, because it is removed at merge and takes the canonical tree with it. Every new worktree: `cp -al <canonical>/node_modules <wt>/node_modules` (hardlinks, ~instant). Name the ACTUAL canonical path in each dispatch; a worktree name written down here outlives the worktree.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Worktrees         | All agent work in `git worktree add $SCRATCH/wt-<name> -b <branch> origin/main`. Never let an agent touch the main checkout. Remove worktrees + delete local branches after merge; disk is a fixed allowance. **Name the destination in the brief.** An agent left to choose put its worktree at `.claude/worktrees/<branch>` — a whole second copy of the repo, untracked, _inside_ the first one. Nothing broke, but it reads as uncommitted work to anything watching the tree and is one `git add -A` from being committed into itself. `/.claude/worktrees/` is now gitignored as a backstop; the brief saying `$SCRATCH` is still the fix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Shared scratchpad | `$SCRATCH` is **shared by every concurrent agent**, not session-private. A generically-named scratch file WILL be clobbered mid-run: one agent wrote `pr-body.md`, a sibling overwrote it between the write and the POST, and the PR was opened carrying **another PR's body**. Mandate a branch-unique name for every scratch file in each brief (`pr-body-2391.md`, never `pr-body.md`), including anything a `>` redirect targets. This is why "re-read the PR body back from the API after posting" is in the dispatch template — it is the check that caught it, and it is load-bearing rather than ceremony.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Container load    | Several worktrees running gates at once push `npm run test:db` to roughly **6× normal wall time** (~200s → ~1280s), and wall-clock-slack assertions are the first thing to break under it — `lib/__db_tests__/auth.test.ts` asserts a cookie and a DB expiry land within 1000 ms and measured 1027 ms (#2398). Expect it, re-run the file alone before diagnosing, and do not let an agent chase it as a regression. The same pressure is the suspected cause of container restarts, hence the ~4-agent cap and SEQUENTIAL gates in every brief.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| GitHub REST       | `TOKEN="${GH_TOKEN:-$GITHUB_TOKEN}"` + curl for EVERYTHING except merge. Issue read: `GET /repos/OWNER/REPO/issues/N` (+ `/comments`). Open PR: `POST /repos/OWNER/REPO/pulls` (`{title,head,base,body}`). Reviews: `POST /pulls/N/reviews` with `event=COMMENT`. Check-runs/status: `GET /commits/SHA/check-runs`. Do NOT reach for `mcp__github__create_pull_request`/`issue_read`/`list_issues` — MCP is merge-only WHILE THE TOKEN EXISTS. If a restart wipes it, curl 401s and MCP becomes the only working path (see "Credential loss after a restart"); the fix is `add_repo` with `access: "push"`, after which curl is preferred again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Actions rerun     | The rerun API 403s for this token, and so does `workflow_dispatch` — a session cannot dispatch `e2e-full.yml`, and does not need to: the PR's own sharded matrix already runs the whole suite at retries=0 on fresh runners. Retrigger CI with an empty commit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Local e2e         | Each Playwright WORKER boots its own server on `E2E_PORT + <worker index>`, so assign each WORKTREE a port RANGE at dispatch (base + at least the worker count: 5400–5410, 5600–5610, …). AVOID 6000–6099: Next.js refuses X11-reserved ports (an agent lost a round discovering port 6000 won't boot). DB/uploads/log isolation is handled by the harness (`e2e/worker-env.ts`). The per-worker servers are `next start`, so build once — `npm run build` — then `ANTHROPIC_API_KEY= E2E_PORT=<base> npx playwright test <specs> --workers=<N> --repeat-each=3 --retries=0 --reporter=list` (global-setup rebuilds by itself when a build input is newer; `E2E_SKIP_BUILD=1` to forbid it). `--workers>1` is honest (no shared DB) and is the point of the range; leave `CI=1` off unless you want CI's one-worker shape. A leftover server from a `kill -9`'d run is swept by global-setup via `e2e/.data/worker-*/server.pid`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Raw Playwright    | A hand-rolled debug script (`chromium.launch()` outside the test runner) may want a headless-shell version the container doesn't have — launch with `executablePath: "/opt/pw-browsers/chromium-<ver>/chrome-linux/chrome"` (check `ls /opt/pw-browsers`). Kill any manually-booted `next dev` before a suite run: it holds the `.next` dev-server lock for that worktree AND its memory counts against the suite (see below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| REST merge        | `PUT /pulls/N/merge` 403s through the agent proxy — merge ONLY via `mcp__github__merge_pull_request` (squash). The refusal is explicit: _"Merging into a protected base branch is not permitted for this session type."_ **The same asymmetry covers CI re-runs**: `POST /actions/runs/N/rerun-failed-jobs` 403s while `mcp__github__actions_run_trigger` with `method: "rerun_failed_jobs"` returns 201 (measured, #2390). So the rule is not "MCP is merge-only" — it is that **write operations against protected refs and Actions go through MCP; everything else uses REST** to spare the owner's rate limit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| CI shape          | **RE-READ `.github/workflows/ci.yml` BEFORE TRUSTING THIS ROW** — it changed four times on 2026-08-10 alone (#2428 4→6 shards, #2429 split `check`, #2432, #2434 6→8). As of `f8a075f4`: **14 checks** — `check` (static analysis: audit, PHI scan, format, lint, typecheck), `test-unit`, `test-db` (the three that #2429 split out of the old single `check`), `e2e-changed` (the PR's changed specs at `--repeat-each=3 --retries=0`; skips when no spec changed — infra blast radius is the matrix's job), an **8-way** sharded `e2e` matrix (full suite, retries=0, fresh runner + fresh servers per shard), and `gitleaks` (which registers twice). The retry safety-net was deliberately dropped (#1160) so a flaky spec cannot hide — that is what makes the flake-exoneration protocol meaningful. Every push costs a full round: batch fixes before pushing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| CI watchers       | **Never hardcode the expected check count — DERIVE it, or the threshold rots into a false-green machine.** A watcher written when the count was 8 silently accepts a 14-check repo the moment 9 have registered. Prefer "zero pending AND zero failed", and treat a low registered count as _not yet settled_ rather than as green. A watcher MUST require the full check count registered (currently **14**, was 8 — see the CI shape row) before concluding GREEN — a fresh push registers `gitleaks` first and alone for a window, and a watcher sampling then declares a false green. And a CONFLICT-DIRTY PR starts NO CI at all (the `pull_request` runs need the merge ref GitHub can't build) — a watcher stuck at "1–2 runs registered" for many polls means check `mergeable` on the PR, not wait longer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Issue auto-close  | GitHub only parses `Fixes #N` **one keyword per line** in the PR body. Slash-separated lists silently don't close anything. Verify closure after every merge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| gitleaks          | CI's gitleaks runs `git --log-opts="--all"` over the refs **in that job's checkout** — its own branch plus `main`. MEASURED (#2409): a finding on one feature branch left every other open PR's gitleaks GREEN. So the blast radius is one branch _until it merges_; the moment the blob reaches `main` it is in every checkout and reds the repo, and the only remaining fix is rewriting published `main` history. Treat it as urgent-before-merge, not as a fire in progress — and check the other PRs before telling anyone the repo is on fire. Either way the blob must STOP EXISTING on the pushed ref: rebase/amend it away + `--force-with-lease`; a clean commit on top is NOT enough. Triggers: an identifier `generic-api-key` recognizes, plus an entropy threshold, plus a word-shape filter — and **entropy alone does not predict it**. The identifier is not only `TOKEN`/`SECRET`/`PASSWORD`: a JSON field literally named `key` counts. Measured on the three sibling values in the same file: `omega3-anticoagulant` 3.522 **FIRED**, `fish-oil-anticoagulant` 3.573 clean, `dairy-levothyroxine` 3.722 clean. All three clear ~3.5; the two that read as plain words are filtered as prose and the one carrying a DIGIT is not. So the predictor is "does this look like a token rather than words", and a digit is what flips it. Fix by RENAMING the value (drop the digit; keep it word-shaped), never by adding a gitleaks allowlist — an allowlist is permanent and a rename costs nothing. Briefs still mandate low-entropy fixture values (`e2e-hc-token-test-value-1`, words+digits, never random hex). |

## Container-restart resilience (the dominant failure mode)

Managed containers restart without warning, killing every background task, poll
and in-flight agent call. Everything here was learned by losing work to it.

- **A CANARY CANNOT DETECT A RESTART. Do not build one.** The obvious design — a
  long-lived background process whose DEATH signals the restart — is
  structurally incapable of working, because the restart kills the harness that
  would deliver the death notification along with the canary. It is a smoke
  alarm wired to the same fuse as the house. One ran for a whole session on
  2026-08-12, died at 14:08, and said nothing.
  The same restart also killed **both check-in timers** (they are `sleep` loops
  in the same process tree), so the boot-id comparison that DOES work never ran
  again. The full chain: restart → canary dies unheard → timers die → nothing
  polls → the orchestrator keeps merging as though nothing happened. A human
  asking "container died?" is what surfaced it, and only by luck at minute one.
  **Detect by STATE, not by liveness**, which means: disk-persisted (survives),
  pull not push (needs no surviving process), and self-describing (says what was
  running, because the in-flight roster is the OTHER thing a restart destroys —
  knowing a restart happened is useless without knowing which agents to rescue).
  `scripts/orchestrator-checkin.sh` is that check: run it as the first action of
  every check-in and after any gap in activity. Keep `$SCRATCH/.roster` current
  at dispatch time — it is the only copy of the roster that outlives you. And
  note that the script itself lives in the REPO, not in scratch: the first
  version was written to `$SCRATCH` and would have died in the next restart,
  which is the same mistake one level up.
- **Agents commit AND push after every meaningful step** — in every dispatch. A
  restart then costs at most one uncommitted edit set. Worktrees survive
  restarts; uncommitted gate-run state does not.
- **No background-run + poll inside agents.** An agent that backgrounds its e2e
  resumes into waiting for a completion event that died with the container. Same
  for one that backgrounds a gate and ENDS ITS TURN expecting a wake. Brief line:
  **"Foreground ALL gates; never `run_in_background` for builds/tests; every wait
  is one blocking Bash call."**
- **Liveness = process evidence, never file evidence.** A transcript's mtime is
  touched by the restart's own bookkeeping and reads as "alive". Check the main
  process start time (`ps`) against the last known-good time; a young main PID
  means everything before it is dead.
- **The restart drill:** assume every agent is dead; snapshot each worktree
  (`git log --oneline -3`, `git status`, local-vs-origin); resume each agent via
  `SendMessage` with a precise state summary; restamp the boot-id; restart the
  canary. Resumed agents recover cleanly nearly every time — killing and
  redispatching is almost never necessary.
- **Transient API errors (529, 5xx) kill subagents the same way**, and a kill
  labelled **"stopped by user" is NOT evidence the owner stopped it** — the
  environment emits that label for its own reclaims, and the owner has stated
  they never stop agents directly. Same resume drill; absent an explicit owner
  message, resume. **See the forbidden-signals table at the top of this file** —
  this exact rule was in this bullet on 2026-08-10 and was still read literally,
  which is why it now also exists as a table entry with a required action.
- **A restore can time-warp your LOCAL view — GitHub's REST API is the only
  authoritative one.** The checkout, the `origin/main` ref (the container's git
  proxy serves a stale mirror) and the task list can all revert together, which
  reads exactly like "main was force-pushed back N merges". Before concluding ANY
  rollback: `GET /repos/OWNER/REPO/branches/main` via api.github.com. If GitHub
  disagrees, the container is the stale party — recover with `git fetch` +
  `git checkout -B <branch> <api-verified-sha>`, then re-verify any "completed"
  work the reverted task list claims is pending before redoing it.
- **Detection:** a canary background task (`while true; do sleep 3600; done`)
  whose death fires the harness notification, plus a **boot-id stamp**
  (`/proc/sys/kernel/random/boot_id` → `$SCRATCH/.boot_id`) compared at EVERY
  check-in. On mismatch: restamp, restart the canary, run the resume drill.

### Credential loss after a restart — and the one-call fix

A restart can wipe `$GH_TOKEN`/`$GITHUB_TOKEN` **and** the git proxy's push
credentials while leaving everything else working. This cost most of a session
before the fix was found, entirely because of how well it hides.

**The fix, first, because it is one call:** `add_repo` for the repo with
`access: "push"` (the claude-code-remote MCP tool). It re-mints push credentials
even when it answers `already_present` — the answer is not "nothing happened".
Then push normally; no re-clone, no new session, no bundle. Verify with
`git push --dry-run origin <branch>` before concluding anything.

**How it hides — three traps, all of which fooled me:**

- **`git fetch` and `git ls-remote` still succeed anonymously** on a public repo.
  Reads working is NOT evidence writes work. I reported "git still works, agents
  can still push" in a check-in on exactly this evidence, and it was wrong.
- **A bash CI poll silently reports `(none)`** for open PRs, because the curl
  401s and the JSON parse yields nothing. That reads as "no PRs open" — a lie in
  the reassuring direction. **Never run a bash CI poll without asserting the
  token is present**; prefer `mcp__github__pull_request_read` / `list_pull_requests`.
- **MCP GitHub tools keep their own auth** and go on working. So issue comments,
  filing and merging all succeed while `curl` 401s, which makes the failure look
  narrower than it is.

**Symptom → meaning:**

| Symptom                                                   | Meaning                                         |
| --------------------------------------------------------- | ----------------------------------------------- |
| `curl` → 401 `Bad credentials`; unauthenticated → 403     | Both token vars are unset                       |
| `fatal: could not read Username for 'https://github.com'` | Push credentials gone; reads still fine         |
| CI poll prints `(none)` while a PR is demonstrably open   | The poll is unauthenticated, not the repo empty |

**Do NOT hunt for credentials** — not in the environment, the filesystem,
`~/.git-credentials`, or `~/.config/gh`. There is nothing to find, and looking
trips security monitoring even when the usage is sanctioned. One
`git config --get-regexp` to check for a proxy rewrite is the limit; an agent hit
the permission classifier doing exactly that and correctly stopped.

**Before reaching for a workaround, check what you actually still have.** Agents
that commit after every step leave clean worktrees, so the recovery order is:
(1) confirm everything is committed — it usually already is, which means nothing
depends on a working tree surviving; (2) `add_repo` with `access: "push"`;
(3) only then consider `push_files` / `create_or_update_file`, or
`git bundle create` + `SendUserFile`. Pushing branch CONTENTS through MCP is a
poor last resort: one 407KB amendment is ~115k tokens, so it does not scale past
a branch or two.

**While it is broken, keep working.** Agents can still do everything except push:
inline the full spec in the brief (they cannot read issues), drop every `curl`
step, and end with _"commit properly, do not push, do not open a PR, report the
full PR body back."_ Then write each finished agent's reasoning into a GitHub
comment via MCP — if the container dies, the work is reconstructible from those
comments plus the branches instead of only from the orchestrator's context.

## STOP — the three agent signals you are forbidden to read literally

**Read this before concluding ANYTHING about a running agent.** Every rule below
already existed elsewhere in this file on 2026-08-10, in prose, and was walked
past anyway — three times in one session, twice within ten minutes. Prose in a
list did not work. This is the mechanical version, at the top, because the cost
was ~27 agent-hours and two near-losses of finished work.

| Signal                                     | What it looks like       | What it actually means                                                                                                    | REQUIRED action                                                                                                                                                                                               |
| ------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"stopped by the user"` on an agent result | The owner killed it      | **NOTHING.** The environment emits this label for its own reclaims. The owner has stated they NEVER stop agents directly. | Treat as a reclaim. Preserve the work (below), then resume or re-dispatch. Do NOT report it as cancelled. Only an explicit message from the owner in the conversation counts as the owner stopping something. |
| Transcript **mtime** is recent             | The agent is working     | **NOTHING.** A blocked agent is appended to like a working one, AND a reclaim's own bookkeeping touches the file.         | Never cite mtime as liveness. Use the progress checks below.                                                                                                                                                  |
| Commits exist in the worktree              | The agent is progressing | **NOTHING on its own.** Commits can all be from the first ten minutes.                                                    | Check `git log -1 --pretty=%cr`. Commits older than the last check-in = no progress since.                                                                                                                    |

**Two or more agents dying at once, at a similar age, with no owner message, is a
reclaim.** It is never two coincidental user stops. That pattern alone settles it.

### The preserve-first drill (do this BEFORE diagnosing or reporting)

An agent's commits are **not** safe. Only pushed refs are. When any agent stops,
is reclaimed, or is suspected stalled:

```
cd $SCRATCH/wt-<x>
git status --porcelain=v1                 # anything uncommitted?
git add -A && git commit -m "WIP checkpoint: ... NOT gate-verified"
git push -u origin HEAD:<its-branch>
```

Push first, ask questions after. A branch that fails CI is worth infinitely more
than a worktree that vanishes. Label an orchestrator-made WIP commit as
**unverified** in its message, and tell whoever resumes that you made it — they
must not mistake it for the agent's own tested work.

**In dispatch briefs the rule is PUSH, not commit.** "Commit as you go" was in
the template for months and still produced 50 finished files in a dirty worktree
and, separately, four commits stranded unpushed for three hours. Committing
survives the agent; only pushing survives the container.

## Stalled agents — "alive" is not "progressing"

The restart drill above assumes agents DIE. The other failure is that they live
and stop moving, and the two look identical from outside. MEASURED, 2026-08-10:
two agents ran **12.9 h** and **13.7 h** against a same-day median of **~55 min**
(46/50/57/66). Neither had restarted. Both were writing to their transcripts
minutes before I checked. Neither had a PR.

**mtime proves nothing.** A blocked agent's transcript is appended to like a
working one's. The two signals that actually separate them:

- **The worktree is missing.** Every healthy agent creates `$SCRATCH/wt-<x>` in
  its first minute. `ls -d $SCRATCH/wt-*` is one command and is the highest-value
  check there is. One of the two above had NO worktree after thirteen hours —
  visible from minute five, if anyone had looked.
- **Transcript SIZE, not recency.** 38 KB after 13 h against 300 KB–1.1 MB for
  finished agents is near-zero work. Compare bytes, not timestamps.

**Two distinct stalls, both real, needing opposite fixes:**

1. **Denied-and-idle.** A tool call refused by the permission system stops an
   agent dead. A well-behaved one does NOT retry (correctly — the contract says
   don't), and then just sits. `git worktree add` and `cp -al` were both refused
   for one agent while its siblings' identical commands succeeded, so this is
   transient and NOT reproducible by inspecting the brief. Cost: 13 h, four tool
   calls, nothing to salvage. Fix is in the brief — see the two lines added to
   the template.
2. **Working-and-unbanked.** The opposite: real work, no commits. Fifty files,
   lint + typecheck + full pure tier green, **zero commits, nothing pushed**, all
   of it in a dirty worktree an ephemeral container could erase at any moment.
   The template has said "COMMIT AND PUSH after every meaningful step" for
   months; it was not enough, because an agent deep in a large change reads that
   as advice about restarts rather than a hard gate on its own progress.
3. **Committed-and-unpushed**, the variant that survives every rewording of the
   above. Agents on this repo commit reliably and then forget the push; three
   separate agents needed a nudge in one session. The commit feels like the
   banking step, so "commit and push" reads as one act that was performed. State
   the gate as a property of the REMOTE — _your branch must exist on the remote
   at your latest commit_ — because that is the thing a check-in can verify:
   `git -C <wt> rev-parse HEAD` against `git ls-remote --heads origin <branch>`,
   which is now part of the check-in rule below.

**The check-in rule.** At every check-in, for every running agent older than ~2×
the session's observed median: `ls -d $SCRATCH/wt-*` and compare transcript
bytes. If a worktree is missing, or bytes have not grown since the last check-in,
`SendMessage` a hard status request — what are you doing right now, what exists,
what was refused, is anything worth preserving. Ask for the blocker verbatim;
"say what was refused" gets a usable answer where "are you stuck?" does not.

**Do not rationalise a long runner.** The instinct to explain 13 h as "gates are
slow under contention" is wrong and was wrong here: `test:db` at 6× contention is
~30 min, not thirteen hours. Anything past ~3× the median is a stall until proven
otherwise, and the proof is a worktree with commits in it.

**Under-scoping causes the second kind.** The 13.7 h agent was not thrashing —
its brief said "add a slug to `TREND_METRIC_SLUGS`" and the honest implementation
turned out to drag **fifteen files** of import plumbing behind it, because the
slug had to earn its `METRIC_DOCUMENT_REACH` declaration with a real projector
plus a migration moving rows already on disk. When a brief's true footprint is
unknown, say so in the brief and require a checkpoint push before the work
compounds — the agent cannot re-scope a task it was told was small.

## The pipeline (per unit of work)

1. **Triage.** Sweep open issues. P0/P1 bugs first; lower ones rank with
   features. Read the bodies **and all comments**. This repo's audit issues (root
   cause + file:line + prescribed fix) are the real interface to agents.
2. **Cluster.** 2–6 related issues per agent by domain/files, one PR per cluster.
   Check clusters for file overlap with each other and with anything the owner is
   editing; sequence or fence accordingly.
3. **Dispatch** into an isolated worktree using the template below. Caps: max 2
   concurrent agents on e2e-touching work; non-e2e clusters go wider (4 works).
   **Audit-first for any issue older than the current wave** — at a high merge
   rate, intervening PRs partially resolve stale issues, so the brief's FIRST
   task is a per-item table (resolved-by-what / still-open) before any code. This
   closed one issue with zero code and halved two builds; without it those agents
   would have re-implemented merged work.
4. **Review** on landing: full diff via `Accept: application/vnd.github.v3.diff`.
   Verify the agent's _claims_ with cheap greps against main (does that testid
   exist? that fixture id? that helper?). Post a substantive COMMENT review.
5. **CI green → squash merge.** If e2e fails, YOU reproduce locally, fix the spec
   on the branch, push once, comment the diagnosis. Serialize merges; when
   several open PRs touch one file, defer the later rebase until the LAST
   conflicting merge lands. Repair a botched hand-merge with a mechanical 3-way
   (`git merge-file`), never by editing conflict markers. **Owner commits land on
   main mid-session**, including direct non-PR pushes, so a PR can grow a SEMANTIC
   conflict (a redesigned component vs an agent's additions) rather than a text
   splice — resolve by RESUMING the authoring agent via `SendMessage`: merge main,
   take MAIN's structure as the base, re-integrate its own additions into the new
   layout, re-verify at CI parity. A hand re-integration by the orchestrator is
   the union-splice mistake at component scale. Code re-integration re-triggers
   the full local suite; the rebase waiver does not apply.
6. **After merge:** remove worktree, delete local branch, confirm the linked
   issues actually closed (close manually with a comment if not), update the task
   list, and update the release notes.

## Release notes (owner directive, 2026-07-24; revised 2026-08-05)

`lib/release-notes.json` (#1421), checked in and rendered at `/whats-new` (it ships WITH
the image, so `docker compose pull` shows its own notes offline). Curated by the
orchestrator in plain product language — what the user or operator sees, never
internal jargon.

- **ORCHESTRATOR BOOKKEEPING**, like the slot map: feature PRs never touch it, so
  it cannot become a merge magnet.
- **At most TWO batches per day** — accumulate and ship mid-run and at wind-down,
  not per merge train.
- **A sentence or two per entry**: what changed and why the user cares.
- Purely-internal merges (spec fixes, CI plumbing) are OMITTED. Operator-facing
  notes (auto-applying migrations, behavior a self-hoster must know) go in the
  entry body.
- The file stays APPEND-ONLY; `/whats-new` pages it (#2528). The page renders
  `WHATS_NEW_PAGE_ENTRIES` entries at a time — the newest day or two, which is the
  question the page answers — with `?page=` walking back through the archive. A day
  split across a page boundary carries its `operatorNotes` onto both pages, so an
  upgrade action can never hide behind the pager. The bundled JSON itself still
  ships whole, so trimming the file remains a separate release-process decision.

## Dispatch prompt template

The fenced block below goes into every agent prompt VERBATIM. Keep it that way:
it is instructions, not explanations. The incidents each line was bought with
live in **Why those lines are there**, immediately after — read them before
writing a brief, and never paste them to an agent.

```
- Worktree setup: git fetch origin main && git worktree add $SCRATCH/wt-<x> -b <branch> origin/main
- cp -al <canonical node_modules — usually /home/user/allos/node_modules>/. $SCRATCH/wt-<x>/node_modules
- export PATH=<node-24 bin dir>:$PATH in EVERY shell (verify better-sqlite3 loads)
- npm ci in the worktree if better-sqlite3 fails to load — the parent checkout drifts
- FIRST ACTION is the worktree + node_modules link, BEFORE reading any source. If it
  fails you must know before spending context.
- If a tool call is DENIED by the permission system, or fails for an environment
  reason you cannot fix in ONE retry, STOP AND REPORT IMMEDIATELY — quote what was
  refused, verbatim. Do not sit on it. (An agent refused its first `git worktree add`
  idled 12.9h having changed nothing; reporting in minute one costs nothing.)
- Your branch must EXIST ON THE REMOTE at your latest commit, at all times.
  Committing is not enough — your worktree is NOT backed up and container restarts
  are frequent. This is a HARD GATE, not restart advice: if you have touched more
  than ~10 files, or worked more than ~45 minutes, since your last PUSH, commit and
  push NOW, even mid-task and even if gates have not run. (An agent held 50 finished
  files with zero commits for 13.7h.)
- If the work turns out materially bigger than this brief implies, SAY SO and push a
  checkpoint before continuing — do not silently absorb a 15-file footprint that was
  briefed as a one-line registry edit.
- Foreground ALL gates; never run_in_background for builds/tests; every wait is one
  blocking Bash call, chunked under the 10-minute tool cap. Pass an EXPLICIT
  `timeout` (e.g. 600000) to `npm test`, `npm run test:db` and `npm run build` —
  foreground Bash caps at ~2 minutes by default whatever the tool's stated maximum,
  so a slow tier reports as a failure it did not have.
- FETCH AND READ ALL ISSUE BODIES AND ALL ISSUE COMMENTS FIRST
  (GET /repos/OWNER/REPO/issues/N and /issues/N/comments) — a comment overrides the
  body when they conflict. Trust symbol names over line numbers.
- Migration slot: <"your slot is N; M and M-1 are already on main" | "you have NONE —
  if you conclude you need one, STOP and report rather than taking a number">
- Immediately before opening the PR: git merge origin/main && npm run typecheck.
  A signature that widened while you worked is not a textual conflict.
- Checks: npm run lint && npm run typecheck && npm test && npm run test:db && npm run format
  — format LAST (a late edit after formatting is a known CI breaker)
- After ANY e2e spec edit — including one added after your gate run — re-run
  `npx vitest run lib/__tests__/e2e-hygiene.test.ts` before pushing
- Run YOUR changed e2e specs at CI parity on your assigned port range:
  E2E_PORT=<base> ... --repeat-each=3 --retries=0. The variable is E2E_PORT, never PORT.
  Do NOT run the full suite — the orchestrator owns full-suite runs.
- Any e2e fixture whose feature groups by profile-LOCAL date/time MUST build instants
  via zonedWallTimeToUtc(getTimezone(profileId), day, "HH:MM") — never naive
  `${day}THH:MM` strings — the seed pins a ROTATING per-run instance timezone
  (`e2e/pinned-timezone.ts`), so naive strings parse host-UTC (#1417)
- npm run phi-scan before the final push — the pre-commit hook does NOT fire in worktrees
- NO high-entropy random-looking string literals in tests/fixtures (synthetic tokens
  included) — use low-entropy words+digits values
- Use the GitHub token by its NAME — $GH_TOKEN (fallback $GITHUB_TOKEN) — in every curl;
  never "search the environment for credentials"
- Use curl REST for GitHub reads, not the MCP tools (MCP rides the owner's rate limit)
- PR body: closing keywords each ON THEIR OWN LINE (Fixes #N — GitHub parses one per line)
- Commit trailers EXACTLY (copy the Co-Authored-By line from your own environment's
  commit instructions — the model name varies by session; do not hardcode one here):
    Co-Authored-By: Claude <model> <noreply@anthropic.com>
    Claude-Session: <session URL>
- No model identifiers in commits/PR/code
- Open the PR READY (not draft) via REST, base main
- Return: PR number/URL, per-issue fix summary, VERBATIM gate results (say plainly if
  something failed — never report a green you did not see), surprises
```

### Why those lines are there

Orchestrator-facing. Each is an incident, not a preference. Do not paste these.

- **Foreground all gates / commit and push** — see Container-restart resilience.
  The worktree is not backed up: one restart killed three live agents with ~2,300
  uncommitted lines that existed only under `/tmp`. When an agent dies, RESCUE
  ITS TREE FIRST — commit it as an explicitly-labelled WIP stating no gate has
  been run — before anything else. A resumed agent verifies what it inherited
  rather than trusting it.
- **Read all issue comments** — clarifications and owner decisions get buried
  there, and a fix honoring the body but missing a comment is wrong.
- **The slot line, always, including "you have none"** — see Migration slots. A
  prompt silent on slots delegates the choice.
- **Merge main and typecheck before opening the PR** — see CI tests the merge
  commit. One minute; catches the whole class.
- **format LAST, and re-run e2e-hygiene after any spec edit** — two consecutive
  waves shipped a late spec commit that tripped the hygiene scan in CI
  (`Date.now()` without `clock-ok`; `.first()` with its marker on the wrong line
  — the scan requires SAME-LINE markers). The scan is 2 seconds; a CI round trip
  is 25 minutes.
- **`E2E_PORT`, never `PORT`** — `playwright.config.ts` reads
  `PORT_BASE = Number(process.env.E2E_PORT ?? 3100)`, so `PORT=6900` is INERT:
  that agent runs on base 3100 like everyone else, and two concurrent agents then
  share ports and manufacture exactly the flaky results the orchestrator spends
  the day diagnosing.
- **Low-entropy fixture values** — CI gitleaks runs over ALL refs, so one
  secret-shaped literal on ANY branch reds EVERY open PR repo-wide.
- **Verbatim gate results** — agents are honest, but their gates ran against
  their branch, not the merge. "All green" is true and insufficient; the numbers
  tell you which tier actually ran.
- **Token by NAME** — generic credential-hunting trips security monitoring and
  costs an audit even when the usage is sanctioned.

**When this runbook already answers something, follow it rather than
improvising.** Twice on 2026-08-06 the orchestrator drifted from a rule written
here — reviews through the GraphQL MCP path instead of the documented REST one,
and dispatch prompts saying `PORT=` where the Local e2e row says `E2E_PORT=`.
Both were caught by someone else.

## E2e discipline (the part that most needs an owner)

> **The sharded `e2e` matrix IS the full-suite authority** — full suite, retries=0,
> fresh runners, every non-docs push. A session cannot dispatch `e2e-full.yml`
> (the API 403s). Local runs are for DIAGNOSIS, not gating.

**Split ownership.** Agents verify their own changed specs at CI parity
(`--repeat-each=3 --retries=0`, their assigned port range); only the orchestrator
runs FULL suites. The repeat-each lane is the highest-value gate in the pipeline
— it keeps catching real defects retries would mask (a debounced-autosave orphan
row poisoning the next repeat; a live-mode finish seam remounting the form).

- **An agent MUST run the spec it authored.** "Only you run e2e" means the
  orchestrator owns FULL suites; it never excused an author from its one new
  spec. #1066 and #1115 both shipped brand-new specs that failed on first push
  because nobody ran them. An unrun spec is a guaranteed CI round-trip.
- **A new nav entry breaks `TOP_LEVEL_ORDER`** in
  `e2e/nav-consolidation.spec.ts` (#1042) — say so in any brief that may add one.
- **The merge bar:** CI fully green on the exact head. No separate local
  full-suite gate.
- **Check `mergeable_state` FIRST when CI looks absent** — a conflict-dirty PR
  runs NO `pull_request` checks at all, which reads as "CI is stuck" but isn't.
  Behind-only refreshes via `update_pull_request_branch`; dirty needs a worktree
  reconcile.
- **A docs/JSON-only PR failing e2e is never the diff** — the breakage is
  main-side or environmental; treat the bookkeeping PR as the control group
  proving it. Retrigger with an empty commit (the rerun API 403s).

**Diagnosing a red.**

- **Reproduce locally before pushing anything.** Blind fix-and-rerun costs 12
  minutes a guess; a local repro plus the saved `error-context.md` aria snapshot
  usually identifies the defect in one look. Run the failed specs _in the order
  that failed_, `--workers=1` when chasing cross-spec poisoning.
- **Check exit codes explicitly** — `cmd | tail -3 && echo OK` reports the TAIL's
  status and masks the failure. Echo `EXIT=$?` on its own line.
- **Mass failure ⇒ check memory first.** Dev-mode servers balloon to ~5 GB RSS
  and swap the box; mass "element(s) not found" across unrelated specs is
  memory, not flakes (check `kswapd0` CPU). Then rerun a handful of failures in
  ISOLATION: passing alone means suite-scale starvation, failing alone means a
  real defect. Never accept "environmental" for a twice-repeated shape without
  that isolation step — a SPENT box reproduces the same failure set
  deterministically, so "same failures twice" proves nothing unless the box was
  settled.
- **Local FULL suite (rare): CI-mode, sharded `/4`, alone.** `npm run build`
  once, then `CI=1` shards as SEPARATE sequential `--shard=N/4` invocations (`/3`
  still degraded; `/4` holds). Nothing else runs during it — no CI polls, no
  agent builds. A whole night of "container degradation" was once a background
  poll loop starving the servers.
- **`next dev` differs from CI's `next start`** — local catches hydration-window
  races CI masks, and vice versa. A spec must pass both; settled interactions
  (`e2e/helpers.ts`) are the fix for pre-hydration clicks.
- **Reproduce a GLOBAL-state spec's flake ONLY at `--workers=1`** (#1188 era).
  Parallel `--repeat-each` on a spec owning shared config (SMTP/public-URL relay,
  Telegram bot config, audit retention, AI tiers, the shared seeded profile)
  races itself and manufactures FALSE flakes absent from CI. CI runs
  `--workers=1`; that is the only honest local signal for these. Parallel repeats
  stay valid for a spec owning its own fixture.

**Flake exoneration protocol** (retries=0 means green means green). A CI e2e
failure may be dismissed as a flake only with BOTH: (1) a 3/3 local CI-parity
pass of the exact spec(s); (2) a stated MECHANISM — why this diff cannot reach
that spec, or what environmental race explains it. A shrug is not an
exoneration. Then re-kick with an empty commit. A SECOND occurrence of the same
spec at retries=0, on any PR, files a census issue with both run links — three
specs earned one this way and two were real races.

- **Base-comparison (the workhorse form):** run the failing spec on CLEAN MAIN at
  the same conditions/hour. An identical failure proves the red pre-existing, and
  the PR merges with those artifacts. A "flake" that reproduces 3/3 on main is a
  DEFECT — that is how #1400 and #1417 both fell in one day.
- **Caution when the failure is CLOCK-ADJACENT (#1577):** "branch fails / main
  passes minutes apart" is NOT conclusive — the two runs' config-load instants
  can straddle a #1464 nudge boundary, making the CLOCK the discriminant while it
  wears the branch's face. The conclusive form is a forced-skew A/B: both
  branches with `ALLOS_TEST_NOW` skewed into the hypothesized hazard.
- **Distinct one-offs (#1557/#1577):** a PR green across N≥3 full runs where each
  run's single red is a DIFFERENT spec on an untouched surface, each attributable
  to a documented pre-existing class, and NO spec reds twice — merges with a
  run-by-run attribution table. A REPEAT voids this and demands root-cause.

### Known failure classes

Every one recurred at least once. Format: **tell** — mechanism — fix.

1. **`.first()` on a shared surface; a spec's count drifts.** All specs share one
   seeded DB (#868). A spec must only act on rows it created; self-cleanup in
   `beforeAll` AND `afterAll`. Non-DB state (`data/logs/*.jsonl`) is not reset —
   seed with write, never append.
2. **Cryptic `text.replace is not a function` from the selector generator.** A
   page CONSOLIDATION made a neighbour spec's page-wide `getByRole` ambiguous
   (the #1042 specialty fold). Scope selectors to a container; anchor cards on
   their own heading. When gating a consolidation, re-run any spec that drove the
   folded-in pages — it is the folding orchestrator's lane.
3. **Autosave races** — wait for the Saved indicator before any reload.
4. **Collapsed `<details>`** — click the summary before asserting contents.
5. **Component variants** — a testid may cover several visual variants; target
   the one under test via `data-variant`.
6. **Cross-row pairing** — never pair two `.first()` locators and assert their
   spatial relationship; scope both to one parent.
7. **A fixture seeds a dead legacy write path.** When a PR moves where state
   lives, a fixture still seeding the OLD mechanism silently stops feeding the
   surface — a migration's legacy-copy acts at migration time and the e2e seed
   runs after. Fixtures seed through the REAL write core (`writeTx(setX(...))`),
   never by hand-writing storage. Reviewers: a PR relocating state must grep
   `e2e/seed-events.ts` and `scripts/seed.ts`.
8. **Red only in a wall-clock window** (rare since #1103). Base-comparison above
   identifies it; the two root causes are a CLIENT relative-age off the browser
   clock, which cannot see `ALLOS_TEST_NOW` (fix with #1028's server `nowIso`
   thread), or a DB fixture deriving date and time from TWO instants.
9. **Persisted channel config turns event-driven dispatches into marker
   pollution.** The delivery-health marker is GLOBAL. A spec persisting
   notification-channel config needs its OWN fixture profile (HA webhook) or
   login/profile pair (Telegram chat id) — since #1025 leaked config turns any
   crossing-temperature log elsewhere into a real failed send that overwrites the
   fixture marker. Reviewers: a PR adding an event-driven send path must grep the
   specs for persisted channel config on shared profiles.
10. **Passes locally, red in CI, around a conditional branch.** `if (await
x.isVisible().catch(() => false))` right after `goto` races the render. Wait
    for a stable section anchor first; for accept-if-present flows also assert
    the element UNMOUNTS (`toHaveCount(0)`) so the mutation committed.
11. **A failure that worsens over months; deterministic on a slow container**
    (#1392/#1412). A page rendering a row PER FIXTURE ENTITY degrades as every
    spec adds a login — the real root cause behind the long #830/#1111
    "createLoginViaFamily flake" census — `/settings/family` hit 91×91 ≈ 8,281 controls / 5.16 MB.
    Fixes in order: product (render O(entities) at rest), then fixture budget
    (seed enrichment fixtures as PROFILES WITHOUT LOGINS). Timeout bumps measurably
    did NOT help.
12. **A run that STRADDLES real 00:00 UTC** (#1534) fails date-keyed specs — SQL
    `date('now')` can't be frozen by the JS freeze. Check the run's timestamps;
    retrigger clear of the boundary. If the rerun fails clear of midnight the
    explanation is FALSIFIED and it gets a real root-cause (that falsification
    found #13).
13. **"Passed for weeks", then fails every run for a whole day.** Fixture dates
    must be RELATIVE to today or DEEP-PAST (`2026-01-*`), never fixed
    near-present: `scripts/seed.ts` writes ~3 weeks of rolling relative rows, so a
    fixed near-present date gets landed on eventually. Corollary: an assertion on
    a SHARED-WORLD AGGREGATE is the same violation one level up — scope it to the
    spec's own rows.
14. **`"/route" is not assignable to AppRoute` after merging main into a
    worktree.** Next's typedRoutes `.d.ts` under `.next/` is stale, not the code.
    Re-run `npm run typecheck` before believing it — since #2293 that regenerates
    the route types itself (`next typegen`, ~1s) rather than needing a full
    `npm run build`. Never widen the type.
15. **Where fixtures live (post-#1511).** Per-domain modules — `e2e/seed/<domain>.ts`
    - `e2e/logins/<domain>.ts` — composed by the thin entrypoints
      (`seed-events.ts` / `fixture-logins.ts`), whose CALL ORDER is
      load-bearing (row ids follow insertion order). Agents add to the domain
      module, never the composer.
16. **A count/dueness flip, red only in late-UTC-evening runs** (#1577). A fixture
    row falling to SQL's `datetime('now')` DEFAULT anchors on REAL UTC while every
    consumer reads the FROZEN clock; they agree except in the ~30-min band where
    #1464's nudge puts frozen date at D+1. Fix at the fixture (stamp from the
    frozen clock). Grep vector: intake/dose/metric INSERTs in `e2e/seed/**`
    omitting `created_at`.
17. **One test dropping to a default-5s expectation under shard load** (#1556 —
    the dominant residual class). A Server-Action write + RSC refresh round-trip
    loses the default budget. Fix: a DECLARED 15–30s budget on the SERVER-TRUTH
    signal (the row that only renders after the write committed), with a comment
    citing the measured overrun; at retries=0 a budget masks nothing. On
    dashboard-class surfaces with bystander POST traffic `settledClick` is the
    WRONG tool (its any-POST wait resolves on a bystander) — widen the
    server-truth window. Watch for BUDGET ASYMMETRY inside one spec. Every new
    one-off goes on the #1556 census.

**Two spec-authoring hazards worth their own note.**

- **Adding a new spec FILE reshuffles the shard split** and surfaces LATENT
  interference in specs that previously happened to shard apart. Confirm it is
  pre-existing by running the accused specs TOGETHER on the PR branch AND on
  clean main; if both fail, harden the fragile specs to own their fixtures — it
  is not the new spec's doing.
- **The controlled-input pre-hydration fill-revert** (#1188). A `.fill()` before
  React hydrates a CONTROLLED input sets the DOM (a naive `toHaveValue` passes)
  but never fires `onChange`, so hydration reverts the field and a Save persists
  the empty value SILENTLY. Use `settledFill` / `settledCheck`. Related self-race
  (#1400): a retry loop that bare-clicks a write-bearing control then immediately
  reloads ABORTS its own Server-Action POST, so the loop spins while the DB never
  changes. Settle write-bearing taps before any reload inside a retry loop;
  client-only toggles stay bare clicks.

## Review checklist

- Does the fix match the issue's prescription **including any clarifications in
  the issue's comment thread**, and are deviations argued? (Good agents deviate
  correctly — e.g. matching an existing accounting contract over the issue's
  looser wording. Reward that; don't reflex-reject.)
- Grep-verify claims: testids, fixture names, helper functions, "already
  imported at line N" assertions.
- Conventions: profileId scoping, `writeTx` for mutations, one-question-one-
  computation (no forked second engines), row-ops side-state, identity functions
  over raw names, auth gates stay in actions.
- Tests at the tier that can SEE the bug (builder input-layer bugs need DB-tier
  fixtures; pure tests can't see them).
- Cross-PR conflicts among in-flight branches (same AGENTS.md line, same
  migration number) — plan the merge order and who resolves.
- Migration hygiene: append-only, manifest regenerated, number announced (see
  **Migration slots**).
- Has this branch sat while a shared signature moved? See **CI tests the merge
  commit** — a green run is a claim about the base it ran on.
- Flag owner-visible judgment calls in the review (tone unifications, behavior
  loosenings) so the owner can veto cheaply.
- **Read the diffstat for a file git calls `Bin`.** A new `.ts` shipped as
  `Bin 0 -> 7407 bytes` (#2547) because its key separator was three RAW NUL bytes
  rather than an escape sequence. The runtime intent was correct, but a file
  containing a NUL has no diff, no blame and no line comments — and this repo's
  PHI and secret gates are TEXT scans, so a green `phi-scan` over a file it may
  not have read as text is not the reassurance it looks like. The fix is the
  escape sequence, which is byte-identical at runtime.
- **A claimed count is a measurement with a timestamp.** At this merge rate the
  numbers in an issue title drift before an agent reads them: #2528 said 274
  entries and the agent's own base had 278. Ask for a re-count in the brief and
  check the PR reports one.
- **A curated dataset's diff must show only intended changes.** #2544 carried four
  `1.0`→`1` edits in `canonical-biomarkers.json` from a `JSON.parse`/`stringify`
  round-trip. Semantically nothing, and Prettier is NOT responsible (it leaves
  JSON numbers alone — check before believing that story). It matters because a
  regenerate is invisible whenever it happens to preserve key order and lose no
  precision, so those four lines were the only evidence it occurred at all.
- **Verify a PR's claims about pre-existing bugs, not just its code.** #2537's body
  said the rename "caught two real bugs"; both were correct on main and broke only
  transiently inside the branch. A bug a change introduces and then fixes is not a
  bug it found, and a PR body is read back later as fact.

## Migration slots

One orchestrator owns a slot MAP. Everything about slots is here; do not
re-derive it in a brief.

**Reserving.** Check main's current max, reserve the next free number in the
brief AND the task entry, and treat every reservation as TENTATIVE — whoever
merges second renumbers. State it in EVERY brief, including the negative case:

> "Your slot is N. M and M−1 are already on main." — or —
> "You have NO slot. If you conclude you need one, STOP and report rather than
> taking a number."

Say what is already ON MAIN, not only what the agent holds: those are different
facts and the agent needs both. A prompt silent on slots is not neutral — two
agents both wrote `165-*.ts` because one brief never mentioned migrations, and a
correctly-briefed agent still burned a round building a contingency for a gap
that had already been filled.

**A gap is not a migration-test failure — it is a total failure.**
`assertContiguousIds` runs inside `runMigrations` → `createDb()`, so a gap fails
EVERY DB test file and every browser shard at import. Say so when reserving a
non-next slot, or an agent expecting a few red tests will read a wall of them as
its own bug.

**A later slot is unhonorable until the earlier one MERGES** — same mechanism.
An agent holding N+1 must BUILD on N and renumber only after N lands (or take N
itself if that reservation dissolves). Say the dependency explicitly and message
the agent the moment N's fate is known.

**Owner PRs preempt reservations** — an owner branch lands with the slot it
shipped with, and every reserved in-flight slot shifts up one. Message each
affected agent rather than letting them find it in CI.

**Another Claude session may hold a slot you think is free.** A branch appeared
carrying a different `Claude-Session:` trailer and claiming 167 — the slot this
map recorded as free. The map is authoritative only over agents THIS
orchestrator dispatched. Check `git ls-remote --heads origin` for branches you
did not create, and read the trailer on any you do not recognise rather than
assuming it is a dead agent of yours.

**Renumber recipe** (merging N migration PRs cut from the same main; done 3× on
the #1059/#1061/#1062 train). One at a time, each after the first renumbering:

1. `git merge origin/main`;
2. `git mv NNN-slug.ts MMM-slug.ts`, bump its `id:` + `name:` + the inline
   `Migration NNN` comment;
3. fix `lib/migrations/versions/index.ts` — the import conflict resolves to
   MAIN's import PLUS yours; append `mMMM` to the array;
4. `prettier --write` the renamed file, `sha256sum` it, put that hash under the
   new filename key in `manifest.json` (keep main's entries);
5. grep the OLD number in TEST files — `migration-NNN-*.test.ts`, its import
   path, and the profile-scoping allowlist's PRAGMA entry;
6. validate with the cheap tier before the full gate: `migration-immutability` +
   db-tier `migrate`/`runner` + `typecheck` (always typecheck after a
   hand-resolved conflict — a dropped boundary line surfaces as a bare
   `',' expected`).

## CI tests the merge commit, not your branch

`ci.yml` is `on: pull_request` only — **main is never tested**. So a regression
made by the interaction of two green PRs lands silently and surfaces on the NEXT
PRs, pointing at branches that did nothing wrong. One fact, three faces, one fix:
**re-merge main and re-verify at merge time, on anything that has sat.**

- **A widening signature outruns a green run.** `zonedWallTimeToUtc` gaining a
  `null` return (#2245) broke two branches (#2250, #2252) in both directions in
  one afternoon:
  one was green against a base predating the new call sites, the other wrote
  fixtures against the old signature while the change was landing. Both agents
  reported green honestly. A widened signature is NOT a textual conflict, so
  `git merge-tree` and `mergeable_state` both say clean while the merged tree
  fails to typecheck. Every EXISTING call site is in the diff; every one added
  while the agent worked is not.
- **A count-freezing allowlist goes stale when parallel work merges.** A scan
  freezing per-file counts (#2205's instant-writer scan) fires on code the branch
  has never seen, because CI scans the MERGE commit. That is the ratchet working
  — reconcile at merge time (re-merge, re-verify, raise the counts WITH reasons)
  and expect it whenever such a scan sits behind other landings.
- **A behind-only PR's green can be stale** (broke main for ~1h). `behind` with
  green checks is safe only if nothing merged since those checks RAN on adjacent
  surfaces. #1560's green predated #1562's merge; textually conflict-free,
  semantically incompatible (one added a chart kind, the other had just made a
  prop mandatory for every chart kind), and the squash landed a main red on `tsc`
  and `npm test`. Compare the check-suite timestamp against main's latest merge;
  if a CODE merge landed in between, `update_pull_request_branch` and let CI
  re-run. A docs/JSON-only intervening merge doesn't require it.

**Rebasing across a merged route restructure** hides one more (2026-07-22, #1079):
a spec's `page.goto("/old#anchor")` strings are not typed, so the AppRoute sweep
will not flag them — grep the rebased spec for stale route literals and re-run its
e2e. The other half of that hazard is FIXED: a bare post-rebase `typecheck` used to
LIE about new routes until `npm run build` regenerated `.next/types`, but
`npm run typecheck` runs `next typegen` first now (#2293), so it sees the current
route tree.

Standing consequences: every dispatch tells the agent to
`git merge origin/main && npm run typecheck` immediately before opening its PR,
and the orchestrator does that merge ITSELF before merging any PR that touches a
shared signature and has sat.

## Cadence & lifecycle

Owner rulings, dated where they were made. These are directives, not preferences.

- **Check-ins: `send_later` one-shot PLUS a backup background `sleep` timer, every
  ~20–30 min. Never the harness ScheduleWakeup tool** (owner, 2026-08-01) — a
  scheduled wakeup silently failed to fire and produced a 52-minute dead gap the
  owner had to notice. On every wake: check the boot-id first, then re-arm the
  next pair before ending the turn. Never poll with foreground sleep.
- **Every check-in posts a status pulse** (owner, 2026-08-01): what's in flight
  (agent, branch, state), what merged, what's queued, what's parked awaiting the
  owner. Silence reads as a stall.
- **Sweep open issues every ~4 hours** (owner, 2026-08-01) — new filings, label
  changes, and comment-thread rulings on existing issues, not just the queue
  built at session start.
- **Dispatch continuously until no viable issue remains** (owner, 2026-08-01). An
  idle slot alongside a viable queue is an orchestration bug. "No viable issues"
  means everything left is blocked, owner-gated, or awaiting an in-flight
  dependency — say so in the pulse rather than going quiet.
- **Parked issues carry the `parked` label** (owner, 2026-08-06). The pulse's
  "parked awaiting owner" list and the label must agree; an unlabeled parked
  issue is a bookkeeping bug.
- **Dependabot minor/patch groups merge on green; majors stay owner-gated**
  (owner, 2026-08-06). Two conditions on the merge: the green must be against
  CURRENT main (a stale base has proved itself against code that is no longer
  there), and the review still reads the group's contents — a "minor" governing
  the test harness is worth naming even when it needs no action.
- **File infra issues WITH a priority label, and label bottlenecks P1** (owner,
  2026-07-26). Anything costing pipeline throughput is filed immediately and
  labeled by its REAL cost: resolving a bottleneck taxes every subsequent unit of
  work, so it is almost always P1, not the reflexive P2 an "infra chore" reads
  as. A single latent flake in one spec is P3. The label IS the queue position.
  (#1511 and #1534 both went out as P2 by habit; both were bottleneck-class.)
- **Never write into a LIVE agent's worktree without telling it first**
  (2026-08-06). Fixing a small defect directly is correct AFTER the agent has
  reported completion and stopped — not while it is alive. "The tree is clean
  right now" does not mean it is done: an agent waiting on a blocker still owns
  its worktree, and a `git add -A` from a second writer sweeps its in-flight work
  into someone else's commit. If a fix is urgent, message the agent and wait for
  an acknowledgement.
- **Re-check every open PR's mergeability after each merge.** A merge silently
  invalidates any open PR touching the same files, and GitHub reports it as
  `mergeable_state: dirty` long before CI says anything. One PR sat in the CI
  queue three hours against a base that no longer existed AND a conflict; nothing
  surfaced it because only check status was being watched. One `pulls/N` read per
  open PR after every merge is the whole fix.
- **`rerun_failed_jobs` CANCELS jobs still in flight** — only rerun a run whose
  jobs have all completed, or the in-progress shards land as `cancelled` and look
  like fresh failures.
- **A job can be stamped `failure` with every step green.** Read the STEPS before
  believing the conclusion — a red with no failing step is infrastructure, and
  re-running it is the answer rather than diagnosing the branch.
- Keep a task per cluster (`agent → review → merge`); record each dispatch's
  BRANCH NAME in it (reconstructing it later from the issue number is guesswork).
- Institutionalize every incident into the next dispatch prompt the same day.
- **Wind-down** = no new dispatches; land everything in flight, clean worktrees
  and stale local branches, stop the check-in loop, and hand off merged work,
  deliberately-open items and pending owner decisions. Two rules keep it honest:
  a still-working agent is not a reason to hold the wind-down open indefinitely,
  but neither is it a reason to cut it off — invoke the WIP-marker contingency
  only when an agent has actually died, and say plainly what is unfinished rather
  than reporting it complete. And before deleting a worktree with an uncommitted
  tree, CHECK whether its content is already on main in a later form; one held
  ~330 lines that looked like lost work and was a superseded draft. Deleting is
  irreversible; checking is two greps.

## Deliberately out of scope for agents

- `docs/**` is NOT fenced (owner, 2026-07-29): agents keep matching docs current
  in the same change, per AGENTS.md hygiene. AGENTS.md and README stay
  merge-magnets — a single self-contained clause when a change makes one
  factually wrong, never a restructure; fence them explicitly only when the
  owner says edits are in flight.
- Strategic/architectural issues the owner hasn't green-lit.
- Anything requiring an owner judgment (IA/nav decisions, tone choices) —
  surface, don't decide.
