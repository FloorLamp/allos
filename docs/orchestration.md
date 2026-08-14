# Orchestrating development on FloorLamp/allos

Status: **living** · process rules for agent-orchestrated development sessions
(not app behavior)

Rules only, short bullets — the incidents that bought them live in
`docs/orchestration-incidents.md` (cited as _incidents: §section_).

`lib/__tests__/runbook-brevity-scan.test.ts` enforces the shape: move any
narrative to _incidents_ in the same change, never grow a bullet past it.

## Operating contract

The standing directive (restartable anytime via `/loop`):

> orchestrate all development; prioritize P0/P1 bugs over features; delegate to
> opus agents; prefer gh rest over mcp; open prs as ready; max 2 agents working
> on e2e; only you run e2e tests; issues that aren't e2e can parallelize more;
> review all prs

- **You never write feature code** — cluster, dispatch, review, diagnose e2e,
  merge, clean up. Sole exception: e2e spec fixes (you own the only local e2e
  environment).
- **P0/P1 bugs preempt features** (owner, 2026-07-26); P2/P3 are ordinary
  queue members. An audit dump preempts only for its P0/P1 items.
- **Every PR gets a real review**: full diff read (focused reads +
  test-surface verification past ~1,500 lines), posted as a COMMENT review
  via REST.
- **Never submit `REQUEST_CHANGES` or `APPROVE`** — the first is unliftable by
  this session type, the second refused (_incidents: §The REQUEST_CHANGES
  one-way door_). A hold = COMMENT review + `parked` + a plain statement that
  the merge waits.
- **Merges are yours**, squash only, via `mcp__github__merge_pull_request`.
  Draft→ready via MCP `update_pull_request` (REST PATCH can't flip draft). On
  a rate-limit rejection, wait out the reset and batch; never retry in a loop.
- **GraphQL is the scarce bucket** — MCP writes ride a 5,000/h pool; REST
  reads are effectively free. Check `/rate_limit`'s `graphql` resource, not
  `core` (_incidents: §GraphQL is the scarce bucket_).
- **Strategic items wait for the owner** (integrations, mobile shell, IA
  decisions); list them in status reports, never start them.
- **Dispatch is the default state** (owner, 2026-08-12): an idle pipeline with
  work available is an ERROR. Never ask permission to relaunch, resume or
  refill; ask only what the runbook genuinely does not decide.

## Tooling — run the script, don't re-derive the rule

Every rule that can be a script is one, and **running the script IS the
rule**; if they disagree, fix the script (_incidents: §Process drift_).

| Script                                               | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/orchestrator-checkin.sh`                    | The check-in preamble and restart detector — by STATE, not liveness (a canary structurally cannot work; _incidents: §The canary that couldn't_). Compares the disk-persisted boot-id, classifies every worktree LIVE/banked/DONE against `$SCRATCH/.roster`, prints the roster and environment facts. Run it FIRST at every check-in and after any gap in activity.                                                                                                                                                                                                                                                                                                                                                                                       |
| `scripts/orchestration/dispatch-brief.mjs`           | `new --branch <b> [--issues 1,2] [--e2e]` prints a complete brief with the node-24 path, canonical node_modules, and E2E port range **computed** (plus the name-keyed migration convention block); records the dispatch in a JSONL ledger AND the `$SCRATCH/.roster` line the check-in script reads; enforces the 2-agent e2e cap. `list` shows ages against the completed-median stall threshold; `done <branch>` closes AND cleans (worktree located by branch, local branch once its remote is gone; dirty tree refuses; `--keep` skips); `resume <branch>` re-opens a dispatch so the roster sees the agent again; `adopt <branch>` brings a dispatch that skipped the script (an Agent-tool run) under the ledger + roster, located by its worktree. |
| `scripts/orchestration/ci-watch.mjs`                 | The CI watcher. Derives settlement (identical check set across two consecutive polls, zero pending) instead of hardcoding a count, refuses to poll without a token, exits 3 immediately on a conflict-dirty PR. Exit 0 green / 1 settled red / 2 unsettled-re-invoke / 3 blocked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `scripts/orchestration/agent-gates.sh`               | The gate sequence in the mandated order: lint → typecheck → pure tier → DB tier → e2e-hygiene (when `e2e/` changed) → phi-scan → format LAST. Goes in every brief.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `.github/workflows/ci-main.yml`                      | Tests main itself: static analysis + both unit tiers on every push, so a two-green-PRs semantic conflict reds main directly. See **CI tests the merge commit**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `.github/merge-queue-ruleset.json`                   | The main merge-queue ruleset — TRANSFER-READY, not applicable today: GitHub offers merge queue only on org-owned repos, so the apply call 422s on this user-owned repo. Inert until/unless the repo moves to an organization. See **The merge queue**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `scripts/orchestration/dependabot-eval-brief.mjs`    | The major-bump evaluation brief: what changed upstream vs what this repo touches, proven in a worktree at the merge ref; delivers a recommendation comment + a verdict label that closes its own loop (hold parks; adopt = orchestrator merges).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `scripts/orchestration/release-notes-gather.mjs`     | Merged PRs since the newest release-notes day, internal ones flagged (a stated heuristic) — the gathering half of the notes; curation stays prose.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `scripts/orchestration/adversarial-review-brief.mjs` | The second review lane for high-stakes diffs. `<pr> --check` answers "does this PR touch a path where a miss corrupts data, crosses the auth boundary, or silences a safety signal" (the path list is DECLARED in the script); without `--check` it emits the full refuter brief — a separate agent prompted to REFUTE the PR's claims with executed attacks. See **The adversarial review lane**.                                                                                                                                                                                                                                                                                                                                                        |

## Labels — the queue's interface

Every issue: a domain label plus a priority (P0–P3; semantics live in the
label descriptions) or `parked`. `lib`/`ui` are secondary location labels.

- **`needs-human`** — an agent left a SPECIFIC question only a human can
  answer, stated on the issue/PR. Apply the label AND assign the owner.
  Distinct from `parked`: needs-human work is done or in flight, and one
  answer unblocks it.
- Briefs require OPEN QUESTIONS as a labelled list; the orchestrator converts
  it to `needs-human` the same day. Resolution is the
  `.claude/skills/needs-human` skill, run with the owner present; an
  unanswered question keeps its label — silence is not consent.
- **NEVER prompt the owner unprompted** (owner, 2026-08-14) — no
  `AskUserQuestion`, no blocking ask. A human is not always at the terminal, so
  an ask is a stall, not a question. Label, assign, keep working; the skill runs
  when the owner engages.
- **`recommend-adopt` / `recommend-hold`** — an evaluation's verdict, evidence
  in the eval comment; a verdict closes its own loop (owner, 2026-08-13).
  Hold pairs with `parked` (revisit trigger in the comment); adopt = the
  orchestrator merges. `needs-human` only when no verdict was reachable.

## Environment facts (verify before trusting; the volatile ones say so)

| Thing             | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node              | Node 24 required, under `/opt/nvm/versions/node/`. DISCOVER the version — never paste one from a doc (a pinned patch version went stale within days). No node 24 at all: `export NVM_DIR=/opt/nvm && . /opt/nvm/nvm.sh && nvm install 24`. Bare `node` may be v22 — wrong ABI for prebuilt better-sqlite3; verify with `node -e "require('better-sqlite3')"`, fix with `npm rebuild better-sqlite3`.                                                                                                                                                                                                                                                                                |
| node_modules      | ONE canonical tree: the main checkout's, after fresh `npm ci` (a worktree's dies at merge-time cleanup). Every new worktree: `cp -al <canonical>/node_modules <wt>/node_modules`. The brief generator names the actual path.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Worktrees         | All agent work in `git worktree add $SCRATCH/wt-<name> -b <branch> origin/main`; never the main checkout. Remove worktrees + local branches after merge. Name the destination in the brief — an agent left to choose nested a repo copy inside the checkout (_incidents: §The worktree inside the checkout_).                                                                                                                                                                                                                                                                                                                                                                       |
| Shared scratchpad | `$SCRATCH` is shared by every concurrent agent. Every scratch file gets a branch-unique name (`pr-body-2391.md`, never `pr-body.md`), including redirect targets — a generic name WAS clobbered mid-run and a PR opened with another PR's body (_incidents: §The shared-scratchpad clobber_). "Re-read the PR body back from the API after posting" is the check that caught it.                                                                                                                                                                                                                                                                                                    |
| Container load    | Concurrent gate runs push `test:db` to ~6× wall time, and wall-clock-slack assertions break first (#2398). Re-run the file alone before diagnosing; never let an agent chase it as a regression. Same pressure likely causes restarts — hence the ~4-agent cap and sequential gates.                                                                                                                                                                                                                                                                                                                                                                                                |
| GitHub REST       | `TOKEN="${GH_TOKEN:-$GITHUB_TOKEN}"` + curl for EVERYTHING except merges/Actions. Issue read: `GET /repos/OWNER/REPO/issues/N` (+ `/comments`). Open PR: `POST .../pulls`. Reviews: `POST .../pulls/N/reviews` with `event=COMMENT`. If a restart wipes the token, MCP becomes the only working path until `add_repo access:"push"` re-mints it (see Credential loss).                                                                                                                                                                                                                                                                                                              |
| REST write limits | `PUT /pulls/N/merge` 403s ("protected base branch… not permitted for this session type") — merge ONLY via `mcp__github__merge_pull_request` (squash). Same asymmetry for Actions: the rerun API and `workflow_dispatch` 403 while `mcp__github__actions_run_trigger` `rerun_failed_jobs` works (#2390). Rule: **writes against protected refs and Actions go through MCP; everything else REST.** Retrigger CI with an empty commit.                                                                                                                                                                                                                                                |
| Local e2e         | Each Playwright worker boots its own server on `E2E_PORT + <index>`, so each worktree gets a port RANGE at dispatch (the brief generator allocates it; 6000–6099 is refused by Next). Build once (`npm run build`), then `ANTHROPIC_API_KEY= E2E_PORT=<base> npx playwright test <specs> --workers=<N> --repeat-each=3 --retries=0 --reporter=list`. The variable is `E2E_PORT`, never `PORT` (inert — _incidents: §Process drift_). Leftover servers are swept by global-setup via `server.pid`.                                                                                                                                                                                   |
| Raw Playwright    | A hand-rolled debug script launches with `executablePath: "/opt/pw-browsers/chromium-<ver>/chrome-linux/chrome"` (check `ls /opt/pw-browsers`). Kill any manually-booted `next dev` before a suite run — it holds the `.next` lock and its memory counts against the suite.                                                                                                                                                                                                                                                                                                                                                                                                         |
| CI shape          | **RE-READ `.github/workflows/ci.yml` BEFORE TRUSTING THIS ROW** — it has changed five times in three days. As of `ab6dba27`: 18 checks — `check` (static analysis), `test-unit`, `test-db`, `e2e-changed` (changed specs at `--repeat-each=3 --retries=0`), a 12-way sharded `e2e` matrix (full suite, retries=0; the count lives in `matrix.shard` only), `gitleaks` (registers twice). Retries were deliberately dropped (#1160) so a flake cannot hide. Every push costs a full round: batch.                                                                                                                                                                                    |
| Issue auto-close  | GitHub parses `Fixes #N` **one keyword per line**. Slash-separated lists silently close nothing. Verify closure after every merge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| gitleaks          | Runs over ALL refs in the job's checkout, so a secret-shaped literal on ANY branch reds that branch now and the whole repo once merged; the blob must stop existing on the pushed ref (rebase/amend + `--force-with-lease`). The trigger is identifier + entropy + word-shape, and a DIGIT is what flips a word into a token (measured — _incidents: §gitleaks_). Fix by RENAMING to a words+digits value, never by allowlisting. **A red gitleaks is not always a finding**: the job downloads its own binary, and an install failure reds the check having scanned NOTHING — since #2592 that emits a `gitleaks did not run` annotation; read it before treating a red as a leak. |

## Restarts, credentials, and dead-looking agents

Containers restart without warning, killing every background task and agent
call. Detect BY STATE, never liveness (_incidents: §The canary that couldn't_).

- **`scripts/orchestrator-checkin.sh` opens every check-in** — boot-id,
  worktrees vs `$SCRATCH/.roster` (dirty + no live agent = rescue NOW). Keep
  the roster current at dispatch; it is the only in-flight state that
  outlives you.
- **"Was it merged" is never `merge-base --is-ancestor`** under squash-merges
  (it can only answer "no"). The signal: was the branch ever PUSHED.
- **Agents push after every meaningful step** — the gate is a property of the
  REMOTE: the branch exists there at the latest commit. Only pushing survives
  the container.
- **No background-run + poll inside agents** — completion events die with the
  container. Foreground ALL gates; every wait is one blocking Bash call.
- **The restart drill**: assume every agent dead; snapshot each worktree;
  resume each via `SendMessage` with a precise state summary. Resumed agents
  recover cleanly nearly every time.
- **A restore can time-warp your local view** — checkout, `origin/main` and
  task list can revert together (_incidents: §Assorted receipts_). Before
  concluding rollback: `GET /branches/main` on api.github.com.
- **Prove an alarm can still fire** after any change that quiets a monitor:
  create a worktree that deserves it, confirm, delete it.

### The three agent signals you are forbidden to read literally

Read before concluding ANYTHING about a running agent (_incidents: §The three
signals read literally_).

| Signal                                     | What it looks like       | What it actually means                                                                                                    | REQUIRED action                                                                                                                                           |
| ------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"stopped by the user"` on an agent result | The owner killed it      | **NOTHING.** The environment emits this label for its own reclaims. The owner has stated they NEVER stop agents directly. | Treat as a reclaim. Preserve the work, then resume or re-dispatch. Only an explicit in-conversation owner message counts as the owner stopping something. |
| Transcript **mtime** is recent             | The agent is working     | **NOTHING.** A blocked agent is appended to like a working one, and a reclaim's own bookkeeping touches the file.         | Never cite mtime as liveness. Compare transcript BYTES and check the worktree.                                                                            |
| Commits exist in the worktree              | The agent is progressing | **NOTHING on its own.** They can all be from the first ten minutes.                                                       | `git log -1 --pretty=%cr`. Commits older than the last check-in = no progress since.                                                                      |

- Two+ agents dying at once at similar age, no owner message = a reclaim,
  never coincidental stops. Transient API 5xx kills subagents the same way —
  same resume drill.

### The preserve-first drill (BEFORE diagnosing or reporting)

An agent's commits are NOT safe; only pushed refs are. When any agent stops,
is reclaimed, or is suspected stalled:

```
cd $SCRATCH/wt-<x>
git status --porcelain=v1                 # anything uncommitted?
git add -A && git commit -m "WIP checkpoint: ... NOT gate-verified"
git push -u origin HEAD:<its-branch>
```

- Push first, ask questions after. Label an orchestrator-made WIP commit
  **unverified**, and tell whoever resumes that you made it.

### Credential loss — the one-call fix

- A restart can wipe both token vars AND the proxy's push credentials while
  reads keep working (_incidents: §Credential loss_). **The fix is one call**:
  `add_repo access:"push"` — it re-mints even when it answers
  `already_present`. Verify with `git push --dry-run origin <branch>`.

| Symptom                                                   | Meaning                                         |
| --------------------------------------------------------- | ----------------------------------------------- |
| `curl` → 401 `Bad credentials`; unauthenticated → 403     | Both token vars are unset                       |
| `fatal: could not read Username for 'https://github.com'` | Push credentials gone; reads still fine         |
| CI poll prints `(none)` while a PR is demonstrably open   | The poll is unauthenticated, not the repo empty |

- Reads succeeding proves nothing about writes. Never poll CI without
  asserting the token — `ci-watch.mjs` refuses for you.
- **Do NOT hunt for credentials** in the environment or filesystem — there is
  nothing to find, and looking trips security monitoring.
- While broken, keep working: agents commit-don't-push ("report the full PR
  body back"), and bank each finished agent's reasoning as a comment via MCP.

### Stalled agents — "alive" is not "progressing"

`dispatch-brief.mjs list` flags anything past 3× the measured median
(_incidents: §The stalls, measured_). The separating signals:

- **The worktree is missing** — `ls -d $SCRATCH/wt-*` is the highest-value
  check there is.
- **Transcript SIZE, not recency** — 38 KB after 13 h is near-zero work.
- **The branch exists on the remote at the latest commit**:
  `git -C <wt> rev-parse HEAD` vs `git ls-remote --heads origin <branch>`.
- If missing or not grown: `SendMessage` a hard status request — "say what was
  refused, VERBATIM" gets an answer where "are you stuck?" does not.
- Do not rationalise a long runner: past ~3× median is a stall until a
  worktree with fresh commits proves otherwise.

## The pipeline (per unit of work)

1. **Triage.** Sweep open issues, P0/P1 first. Read bodies AND all comments —
   audit issues (root cause + file:line + fix) are the real agent interface.
2. **Cluster.** 2–6 related issues per agent by domain/files, one PR per
   cluster. Check file overlap between clusters and with the owner's edits;
   sequence or fence.
3. **Dispatch** via `dispatch-brief.mjs new` — the ONLY path, Agent-tool runs
   included; an agent running without a ledger entry gets `adopt <branch>` on
   sight (_incidents: §Split-brain dispatch_). Caps: 2 e2e (enforced), ~4
   non-e2e.
   - **Audit-first for issues older than the current wave**: the brief's
     FIRST task is a per-item resolved-by-what / still-open table.
4. **Review** on landing: full diff via `Accept: application/vnd.github.v3.diff`,
   grep-verify claims against main, post a substantive COMMENT review.
5. **CI green → squash merge.** e2e red: YOU reproduce locally, fix on the
   branch, push once, comment the diagnosis. Serialize merges; defer the later
   rebase until the LAST conflicting merge lands.
   - A SEMANTIC conflict with owner main-commits: RESUME the authoring agent
     (merge main, MAIN's structure as base, re-verify at CI parity) — never
     hand re-integrate. Repair a botched hand-merge with `git merge-file`,
     never by editing conflict markers.
6. **After merge**: `dispatch-brief.mjs done <branch>` (removes worktree +
   local branch), confirm linked issues actually closed, update the task list
   and release notes.

## Release notes (owner directive, 2026-07-24; revised 2026-08-13)

`lib/release-notes.json` (#1421), rendered at `/whats-new`;
`release-notes-gather.mjs` lists what merged since the newest entry.

- Orchestrator bookkeeping — feature PRs never touch it.
- At most TWO batches per day: mid-run and wind-down.
- One concise BULLET per change (owner, 2026-08-13): the title is the whole
  entry; the validator refuses a body and titles over 120 chars. Internal
  merges are omitted; upgrade actions go in the day's `operatorNotes`.
- Append-only; `/whats-new` pages it (#2528), and a day split across pages
  carries its `operatorNotes` onto both.

## Dispatch prompt template

- **The template lives in `scripts/orchestration/dispatch-brief.mjs` —
  generate it, never paste it.** A line that must change changes IN THE
  SCRIPT, same change as the lesson. Gate order lives in `agent-gates.sh`.
- Line-by-line receipts are in _incidents_ — read them before editing the
  script, never paste them to an agent.

## E2e discipline (the part that most needs an owner)

> **The sharded `e2e` matrix IS the full-suite authority** — full suite,
> retries=0, fresh runners, every non-docs push. A session cannot dispatch
> `e2e-full.yml` (the API 403s). Local runs are for DIAGNOSIS, not gating.

- **Split ownership**: agents verify their own changed specs at CI parity
  (`--repeat-each=3 --retries=0`, assigned port range); only the orchestrator
  runs FULL suites.
- **An agent MUST run the spec it authored** (#1066, #1115) — an unrun spec is
  a guaranteed CI round-trip.
- **NEVER brief "write the spec, do not run it, I will run it"** — red CI both
  times (#2562, #2584; _incidents: §E2E ownership failures_). Either an e2e
  slot, or no browser spec at all ("prove it in the pure/DB tiers or stop").
- **A new nav entry breaks `TOP_LEVEL_ORDER`** in
  `e2e/nav-consolidation.spec.ts` (#1042) — say so in any brief that may add
  one.
- **Ration your attention, not the runner** (measured 2026-08-13): the mobile
  project is 211 tests in ~8 min at one worker — the DEFAULT orchestrator
  check for shared-chrome changes, not an on-demand ration. Agent caps stay.
- **The merge bar**: CI fully green on the exact head. No separate local
  full-suite gate.
- **Check `mergeable_state` FIRST when CI looks absent** — conflict-dirty runs
  NO checks (`ci-watch.mjs` exit 3). Behind-only refreshes via
  `update_pull_request_branch`; dirty needs a worktree reconcile.
- **A docs/JSON-only PR failing e2e is never the diff** — the breakage is
  main-side or environmental; the bookkeeping PR is the control group.

### Diagnosing a red

- **Reproduce locally before pushing anything** — blind fix-and-rerun costs 12
  min a guess; a local repro + the saved `error-context.md` snapshot usually
  answers in one look. Run failures in failing order; `--workers=1` when
  chasing cross-spec poisoning.
- **Check exit codes explicitly** — `cmd | tail -3` reports the TAIL's status;
  echo `EXIT=$?` on its own line.
- **Mass failure ⇒ memory first** (`kswapd0`; dev servers balloon ~5 GB RSS),
  then rerun failures in ISOLATION: pass alone = starvation, fail alone =
  defect. Never accept "environmental" twice without that isolation step.
- **Local FULL suite (rare)**: build once, then `CI=1` sequential
  `--shard=N/4` invocations, nothing else running.
- **`next dev` differs from CI's `next start`** — a spec must pass both;
  settled interactions (`e2e/helpers.ts`) fix pre-hydration clicks.
- **Reproduce a GLOBAL-state spec's flake ONLY at `--workers=1`** — parallel
  repeat-each on shared config races itself and manufactures FALSE flakes.

### Flake exoneration (retries=0 means green means green)

- Dismiss a CI e2e failure as flake only with BOTH: a 3/3 local CI-parity
  pass of the exact spec(s) AND a stated MECHANISM. Then re-kick with an empty
  commit. A SECOND occurrence of the same spec, any PR, files a census issue
  with both run links.
- **Base-comparison (the workhorse)**: run the spec on CLEAN MAIN at the same
  conditions. Identical failure = pre-existing; 3/3 repro on main = a DEFECT
  (#1400, #1417).
- **Clock-adjacent failures (#1577)**: minutes-apart branch/main A/B is NOT
  conclusive; the conclusive form is a forced-skew A/B with `ALLOS_TEST_NOW`.
- **Distinct one-offs (#1557/#1577)**: N≥3 full runs, each red a DIFFERENT
  spec on an untouched surface with a documented pre-existing class → merge
  with an attribution table. A REPEAT voids this.
- **Known failure classes**: the tell → mechanism → fix catalogue is
  `docs/internals/e2e-hygiene.md` § known CI failure classes — grep it before
  diagnosing any red.

## Review checklist

First, route: `adversarial-review-brief.mjs <pr> --check` — MANDATORY sends
the PR through **The adversarial review lane** too; the merge waits for both.

- Does the fix match the issue's prescription **including comment-thread
  clarifications**, and are deviations argued? Good agents deviate correctly.
- Grep-verify claims: testids, fixture names, helpers, "already imported at
  line N".
- **Exercise the write path when the diff cannot show the defect** — call the
  write core and read what landed (_incidents: §The write path, not the
  diff_).
- **Relay evidence verbatim; conclude only what you re-derived** (_incidents:
  §Relay errors_). Quote the agent's evidence; the stronger claim needs your
  own re-derivation.
- Conventions: profileId scoping, `writeTx` for mutations,
  one-question-one-computation, row-ops side-state, identity functions over
  raw names, auth gates stay in actions.
- Tests at the tier that can SEE the bug (builder input-layer bugs need
  DB-tier fixtures).
- Cross-PR conflicts among in-flight branches (same AGENTS.md line, two
  migrations appending to `versions/index.ts`) — plan merge order and who
  resolves.
- Migration hygiene: append-only, manifest entry in the same diff, new file
  appended LAST (see **Migrations are name-keyed**).
- Has this branch sat while a shared signature moved? See **CI tests the
  merge commit**.
- Flag owner-visible judgment calls in the review so the owner can veto
  cheaply.
- **Read the diffstat for a file git calls `Bin`** — a raw NUL byte hides a
  file from diff, blame AND the text-scan gates (#2547).
- **A claimed count is a measurement with a timestamp** — brief a re-count;
  check the PR reports one (#2528).
- **A curated dataset's diff must show only intended changes** — a stray
  regenerate is visible only through incidental edits (#2544).
- **Verify a PR's claims about pre-existing bugs** — a bug a change introduces
  and then fixes is not a bug it found (#2537).

## The adversarial review lane

- High-stakes diffs get a SECOND lane (_incidents: §Assorted receipts_,
  #2444): `--check` answers MANDATORY from the path list declared in the
  script (data-corrupting, auth-boundary, safety-signal); full mode emits the
  refuter brief — a separate agent that EXECUTES falsifying attacks.
- The merge waits for the report. Every REFUTED claim is fixed or overridden
  with a written reason in the thread; a fully-CONFIRMED report after honest
  attack is the lane working, not a wasted dispatch.

## Migrations are name-keyed — the slot system is retired

Applied migrations live in the `schema_migrations` ledger keyed by NAME;
001–185 is the closed era (_incidents: §Migration-slot incidents_).

- New migration: `versions/YYYYMMDD-slug.ts` exporting `{ name, up }` (no id),
  appended LAST to the `MIGRATIONS` array, sha256 added to `manifest.json` in
  the same diff. Never edit a shipped migration.
- **Merge-order = migration order**: `versions/index.ts` conflicts resolve by
  keeping BOTH sides; whichever lands second appends after the first. Never
  reorder merged entries.
- The generated brief carries the convention — no per-dispatch migration
  facts.
- A dev DB that applied an ABANDONED branch's migration holds an unknown name
  the runner refuses — recreate that dev database. (A merged-late migration is
  handled: the runner applies it in array order.)
- Review checks: shipped files untouched (hash manifest), new file LAST, name
  unique and date-slug shaped, manifest entry in the same diff.

## CI tests the merge commit, not your branch

- A green PR check is a claim about the base that existed when it ran.
  `ci-main.yml` tests main itself on every push (~3.5 min); a red `CI (main)`
  means stop merging, fix main first, then resume.
- The browser tier is NOT in that net, and a sat branch's green is stale:
  **re-merge main and re-verify at merge time on anything that has sat**
  (_incidents: §CI tests the merge commit_).
- Every brief mandates `git merge origin/main && npm run typecheck` before
  opening the PR; the orchestrator repeats that merge itself for any sat PR
  touching a shared signature.
- After rebasing across a merged route restructure, grep the rebased specs
  for stale untyped `page.goto("...")` literals (#1079).

## The merge queue

- The queue would validate every merge's SPECULATIVE commit — the exact bytes
  that will become main, in landing order. `ci.yml`/`gitleaks.yml` already run
  on `merge_group` (cheap tiers + gitleaks).
- **Blocked on account type** (2026-08-13): merge queue is org-only; the
  apply call 422s on this user-owned repo (_incidents: §The merge queue that
  couldn't_).
- The hand-serialization rules STAND: serialize merges, defer the later
  rebase until the LAST conflicting merge lands, re-check mergeability after
  each merge.
- If the repo transfers to an org: apply `.github/merge-queue-ruleset.json`
  (squash, ALLGREEN ≤5, admin bypass), merge via `enable_pr_auto_merge` on
  fully-green PRs (e2e is not re-validated — never queue a red head), and the
  serialization rules retire.

## Cadence & lifecycle

Owner rulings, dated where they were made. Directives, not preferences.

- **Check-ins**: `send_later` one-shot — ARM IT FIRST on every wake — plus a
  backup background `sleep`, every ~20–30 min; NEVER the harness
  ScheduleWakeup (owner, 2026-08-01). Record the fire time in
  `$SCRATCH/.wake`; the check-in script alarms when nothing future is armed.
- They are not redundancy (_incidents: §The wake that wasn't_): `send_later`
  survives restarts; the sleep covers a `send_later` that silently fails.
  Drop either and a whole failure mode has no wake.
- **Every check-in posts a status pulse** (owner, 2026-08-01): in flight,
  merged, queued, parked-awaiting-owner. Silence reads as a stall.
- **Sweep open issues every ~4 hours** (owner, 2026-08-01) — new filings,
  label changes, comment-thread rulings.
- **Post-merge audit sweep, once per session-day**: one agent over the last
  ~24 h of merges, full diffs, prompted to REFUTE each PR's claims. Findings
  file as issues naming the introducing PR (#2444 — _incidents: §Assorted
  receipts_).
- **Dispatch continuously until no viable issue remains** (owner, 2026-08-01);
  "no viable" means blocked/owner-gated/awaiting-dependency — say so in the
  pulse.
- **Parked issues carry the `parked` label** (owner, 2026-08-06); the pulse
  and the label must agree.
- **Dependabot** (owner, 2026-08-13): minors merge on green against CURRENT
  main, same day. A MAJOR gets an eval agent within a day
  (`dependabot-eval-brief.mjs <pr>`); the verdict closes its own loop (see
  Labels). `parked` only AFTER a recommendation exists.
- **Infra issues get a priority label; bottlenecks are P1** (owner,
  2026-07-26). A single latent flake in one spec is P3.
- **Never write into a LIVE agent's worktree without telling it first**
  (2026-08-06) — message and wait for acknowledgement; a clean tree is not a
  done tree.
- **Re-check every open PR's mergeability after each merge** — one `pulls/N`
  read each; a merge invalidates same-file PRs as `mergeable_state: dirty`
  long before CI says anything.
- **`rerun_failed_jobs` CANCELS jobs still in flight** — only rerun a run
  whose jobs have all completed.
- **A job stamped `failure` with every step green** is infrastructure — read
  the STEPS, then rerun.
- Keep a task per cluster (`agent → review → merge`); record each dispatch's
  BRANCH NAME in it.
- Institutionalize every incident into the tooling or this file the same day.
- **Wind-down** = no new dispatches; land in-flight work, clean worktrees and
  stale branches, stop the check-in loop, hand off. WIP-marker contingency
  only for an agent that actually died; say plainly what is unfinished.
- Before deleting a worktree with an uncommitted tree, CHECK whether its
  content is already on main in a later form (_incidents: §Assorted receipts_,
  the superseded draft).

## Deliberately out of scope for agents

- `docs/**` is NOT fenced (owner, 2026-07-29): agents keep matching docs
  current in the same change. AGENTS.md/README get a single self-contained
  clause when factually wrong, never a restructure.
- Strategic/architectural issues the owner hasn't green-lit.
- Anything requiring an owner judgment (IA/nav, tone) — surface, don't
  decide.
