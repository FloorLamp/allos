# Orchestrating development on FloorLamp/allos

Status: **living** · process documentation for agent-orchestrated development
sessions (not app behavior)

The operational runbook for a session that orchestrates development on this
repo: triage issues, dispatch coding agents, review every PR, own e2e, merge.
This file states the RULES; the incidents that bought them live in
`docs/orchestration-incidents.md` (cited below as _incidents: §section_).
Nothing here is theory — each rule cost time once, and every session so far has
held zero reverts.

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
- **P0/P1 bugs before features** (owner, 2026-07-26). A P0/P1 bug preempts
  feature work the moment it appears. P2/P3 bugs are ordinary queue members —
  cluster them with adjacent work and schedule them against features on value.
  An audit dump preempts only for its P0/P1 items.
- **Every PR gets a real review** before merge: full diff read (or focused reads
  - test-surface verification for >1,500-line refactors), posted as a COMMENT
    review via REST (APPROVE is rejected for this session type).
- **NEVER submit `REQUEST_CHANGES`. It is a ONE-WAY DOOR for this session type.**
  A changes-requested review blocks the merge until it is APPROVED or DISMISSED,
  and this session can do neither — both come back "not permitted for this
  session type", through MCP and REST alike. `main`'s ruleset makes it
  unrecoverable rather than merely awkward: `required_approving_review_count: 0`
  (so nothing needs approving — the block is purely the outstanding review) and
  `dismiss_stale_reviews_on_push: false` (so it survives every later commit,
  including the one that fixes the finding). The author cannot clear it either.
  Only the human can, by hand, on a PR that is otherwise green and finished.
  Done on #2692 at 12:15Z: the finding was real and the fix landed, and the PR
  still sat unmergeable behind a verdict nobody in the loop could lift. Routing
  around it by flipping the ruleset would be worse — that setting exists to keep
  a genuine blocking review blocking.
  A HOLD is expressed the same way every other one is: post the finding as a
  COMMENT review, apply `parked`, and say plainly at the top that the merge is
  held pending it. That blocks nothing mechanically, which is correct — holding
  is the orchestrator's own action, the same rule `recommend-hold` already
  follows.
- **Merges are yours**, squash only, via `mcp__github__merge_pull_request` —
  and once the merge-queue ruleset is applied, via the queue instead (see
  **The merge queue**). Draft→ready goes through MCP `update_pull_request`
  (REST PATCH can't flip draft). On a rate-limit rejection, wait out the reset
  and batch; never retry in a loop.
- **GraphQL is the scarce bucket, not REST** (measured 2026-08-12). "Prefer
  REST over MCP" is right but names the wrong limit: MCP _writes_ — reviews,
  merges, issue edits, issue comments — are GraphQL, and that pool is **5,000**
  against REST core's **15,000**. A review POST failed mid-session at
  `graphql 0/5000` while `core` sat untouched at `15000/15000`; roughly twenty
  merges plus one sweep's ten issue comments drained it inside an hour. So:
  REST reads are effectively free and agents should use them (briefs already
  do); GraphQL writes are rationed, and a merge run plus bulk issue commenting
  is what exhausts them. Check with
  `curl -sS -H "Authorization: Bearer $TOKEN" https://api.github.com/rate_limit`
  and read the `graphql` resource, not `core` — `core` will look fine.
- **Strategic items wait for the owner** (integrations, mobile shell, IA
  decisions). Never start them unprompted; list them in status reports.
- **An idle pipeline with work available is an ERROR, and dispatch is the
  default state** (owner, 2026-08-12). Never ask permission to relaunch, resume
  or refill — the queue and the caps already encode what may run. Ask only
  about things the runbook genuinely does not decide: a product judgement, an
  owner-authored PR, a scope grown past its brief. At a check-in with nothing
  to review and a free slot, DISPATCH, then report what you dispatched.
  "Nothing to do" is a conclusion the orchestrator is almost never entitled to
  reach while the backlog is non-empty.

## Tooling — run the script, don't re-derive the rule

Prose rules get walked past (_incidents: §The three signals read literally,
§Process drift_), and every documented dispatch-template drift was a hand-fill
error. So every rule in this file that could become a script is one, and when a
rule has a script, **running the script IS the rule**; if prose and script ever
disagree, fix the script in the same change, never work around it.

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

Every issue carries a domain label and a priority (P0–P3; the semantics live in
the label descriptions themselves) or `parked`. `lib`/`ui` are secondary
location labels, never the whole story. Three labels route HUMAN attention:

- **`needs-human`** — an agent left a SPECIFIC question only a human can
  answer, stated on the issue/PR. Apply the label AND assign the owner: the
  assignment reaches their inbox, the label makes the set queryable. Every
  generated brief asks agents to return OPEN QUESTIONS as a labelled list; the
  orchestrator converts that list to `needs-human` the same day. Distinct
  from `parked` (work not started by decision) — needs-human work is done or
  in flight, and one answer unblocks it. The RESOLUTION half is the
  `.claude/skills/needs-human` skill, run in an interactive session with the
  owner: it premise-audits each question against current main, checks
  ripeness, asks in batched recommendation-first questions, records the
  ruling on the issue body (superseded prose struck inline), then un-labels,
  un-assigns, and routes — back to the priority queue, or to merge when the
  answer was a merge gate. An unanswered question keeps its label; silence is
  not consent.
- **`recommend-adopt` / `recommend-hold`** — an evaluation's verdict, with
  the evidence in the eval comment. A verdict closes its own loop (owner,
  2026-08-13): `recommend-hold` pairs with `parked` (revisit trigger in the
  comment), `recommend-adopt` means the orchestrator merges through its normal
  review flow. Neither gets `needs-human` — that pairing is only for an eval
  that cannot reach a verdict, stated as the specific question.

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

Managed containers restart without warning, killing every background task,
poll and in-flight agent call. Detection is BY STATE, never by liveness — a
canary process structurally cannot report the restart that kills it
(_incidents: §The canary that couldn't_). The rules:

- **`scripts/orchestrator-checkin.sh` opens every check-in.** It compares the
  disk-persisted boot-id, classifies worktrees against `$SCRATCH/.roster`
  (dirty + live agent = in progress; dirty + no agent = rescue NOW), and
  restamps last. Keep the roster current at dispatch time — the brief
  generator writes it; it is the only copy of the in-flight roster that
  outlives you.
- **"Was it merged" is never `merge-base --is-ancestor`** under squash-merges —
  the predicate can only answer "no". The signal is whether the branch was
  ever PUSHED (tracking config survives upstream deletion).
- **Agents push after every meaningful step** — the brief states the gate as a
  property of the REMOTE: the branch must exist there at the latest commit.
  Committing survives the agent; only pushing survives the container.
- **No background-run + poll inside agents** — a backgrounded gate's completion
  event dies with the container. Foreground ALL gates; every wait is one
  blocking Bash call.
- **The restart drill:** assume every agent is dead; snapshot each worktree;
  resume each agent via `SendMessage` with a precise state summary; the
  check-in script restamps. Resumed agents recover cleanly nearly every time —
  killing and redispatching is almost never necessary.
- **A restore can time-warp your local view** — checkout, `origin/main` (the
  git proxy serves a stale mirror), and the task list can all revert together,
  reading exactly like a force-push. Before concluding ANY rollback:
  `GET /repos/OWNER/REPO/branches/main` via api.github.com; GitHub is the only
  authoritative view.
- **Prove an alarm can still fire** after any change that makes a monitor
  quieter: create a worktree that deserves the alarm, confirm, delete it.

### The three agent signals you are forbidden to read literally

Read this before concluding ANYTHING about a running agent (_incidents: §The
three signals read literally_ — ~27 agent-hours were lost to reading them).

| Signal                                     | What it looks like       | What it actually means                                                                                                    | REQUIRED action                                                                                                                                           |
| ------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"stopped by the user"` on an agent result | The owner killed it      | **NOTHING.** The environment emits this label for its own reclaims. The owner has stated they NEVER stop agents directly. | Treat as a reclaim. Preserve the work, then resume or re-dispatch. Only an explicit in-conversation owner message counts as the owner stopping something. |
| Transcript **mtime** is recent             | The agent is working     | **NOTHING.** A blocked agent is appended to like a working one, and a reclaim's own bookkeeping touches the file.         | Never cite mtime as liveness. Compare transcript BYTES and check the worktree.                                                                            |
| Commits exist in the worktree              | The agent is progressing | **NOTHING on its own.** They can all be from the first ten minutes.                                                       | `git log -1 --pretty=%cr`. Commits older than the last check-in = no progress since.                                                                      |

Two or more agents dying at once, at a similar age, with no owner message, is a
reclaim — never two coincidental user stops. Transient API errors (529, 5xx)
kill subagents the same way; same resume drill.

### The preserve-first drill (BEFORE diagnosing or reporting)

An agent's commits are **not** safe; only pushed refs are. When any agent
stops, is reclaimed, or is suspected stalled:

```
cd $SCRATCH/wt-<x>
git status --porcelain=v1                 # anything uncommitted?
git add -A && git commit -m "WIP checkpoint: ... NOT gate-verified"
git push -u origin HEAD:<its-branch>
```

Push first, ask questions after. Label an orchestrator-made WIP commit as
**unverified**, and tell whoever resumes that you made it.

### Credential loss — the one-call fix

A restart can wipe `$GH_TOKEN`/`$GITHUB_TOKEN` AND the git proxy's push
credentials while everything else keeps working, and it hides well
(_incidents: §Credential loss_). **The fix is one call**: `add_repo` with
`access: "push"` — it re-mints even when it answers `already_present`. Verify
with `git push --dry-run origin <branch>`.

| Symptom                                                   | Meaning                                         |
| --------------------------------------------------------- | ----------------------------------------------- |
| `curl` → 401 `Bad credentials`; unauthenticated → 403     | Both token vars are unset                       |
| `fatal: could not read Username for 'https://github.com'` | Push credentials gone; reads still fine         |
| CI poll prints `(none)` while a PR is demonstrably open   | The poll is unauthenticated, not the repo empty |

Reads succeeding proves nothing about writes (anonymous fetch works on a
public repo). Never run a CI poll without asserting the token — `ci-watch.mjs`
refuses for you. **Do NOT hunt for credentials** in the environment or
filesystem — there is nothing to find, and looking trips security monitoring;
one `git config --get-regexp` for a proxy rewrite is the limit. While broken,
keep working: agents can do everything except push (inline specs in briefs,
end with "commit, do not push, report the full PR body back") and bank each
finished agent's reasoning as a GitHub comment via MCP.

### Stalled agents — "alive" is not "progressing"

Agents also live and stop moving, which looks identical from outside
(_incidents: §The stalls, measured_ — 12.9 h and 13.7 h against a ~55 min
median). The separating signals, at every check-in via
`dispatch-brief.mjs list` (which flags anything past 3× the measured median):

- **The worktree is missing.** Every healthy agent creates `$SCRATCH/wt-<x>`
  in its first minute; `ls -d $SCRATCH/wt-*` is the highest-value check there
  is.
- **Transcript SIZE, not recency.** 38 KB after 13 h against 300 KB–1.1 MB for
  finished agents is near-zero work.
- **The branch exists on the remote at the latest commit**:
  `git -C <wt> rev-parse HEAD` vs `git ls-remote --heads origin <branch>`.

If a worktree is missing or bytes have not grown, `SendMessage` a hard status
request — ask for the blocker VERBATIM ("say what was refused" gets a usable
answer where "are you stuck?" does not). Do not rationalise a long runner:
`test:db` at 6× contention is ~30 min, not thirteen hours; past ~3× median is
a stall until a worktree with fresh commits proves otherwise. The two stall
species need opposite fixes — denied-and-idle (report-immediately line) and
working-and-unbanked (checkpoint gate) — both already in the generated brief.

## The pipeline (per unit of work)

1. **Triage.** Sweep open issues. P0/P1 first. Read bodies AND all comments —
   this repo's audit issues (root cause + file:line + prescribed fix) are the
   real interface to agents.
2. **Cluster.** 2–6 related issues per agent by domain/files, one PR per
   cluster. Check clusters for file overlap with each other and with anything
   the owner is editing; sequence or fence accordingly.
3. **Dispatch** via `dispatch-brief.mjs new` — the ONLY path, Agent-tool runs
   included (2026-08-13): the tool writes no roster entry, so a tool-dispatched
   agent is invisible to the check-in (it screamed RESCUE NOW at a live one)
   and the roster — the only state that outlives you — goes incomplete by
   construction. An agent already running without a ledger entry gets
   `adopt <branch>` the moment you notice. Caps: max 2 concurrent agents on
   e2e-touching work (enforced by the generator); non-e2e goes wider (4 works).
   **Audit-first for any issue older than the current wave** — at this merge
   rate intervening PRs partially resolve stale issues, so the brief's FIRST
   task is a per-item resolved-by-what / still-open table before any code.
4. **Review** on landing: full diff via `Accept: application/vnd.github.v3.diff`.
   Grep-verify the agent's claims against main. Post a substantive COMMENT
   review.
5. **CI green → squash merge.** If e2e fails, YOU reproduce locally, fix the
   spec on the branch, push once, comment the diagnosis. Serialize merges; when
   several PRs touch one file, defer the later rebase until the LAST
   conflicting merge lands. Repair a botched hand-merge with a mechanical
   3-way (`git merge-file`), never by editing conflict markers. Owner commits
   land on main mid-session, so a PR can grow a SEMANTIC conflict — resolve by
   RESUMING the authoring agent (merge main, take MAIN's structure as base,
   re-integrate its additions, re-verify at CI parity); a hand re-integration
   by the orchestrator is the union-splice mistake at component scale.
6. **After merge:** remove worktree, delete local branch,
   `dispatch-brief.mjs done <branch>`, confirm the linked issues actually
   closed, update the task list and release notes.

## Release notes (owner directive, 2026-07-24; revised 2026-08-05)

`lib/release-notes.json` (#1421), rendered at `/whats-new` (ships with the
image, so `docker compose pull` shows its own notes offline). Curated by the
orchestrator in plain product language; `release-notes-gather.mjs` lists what
merged since the newest entry so a batch starts from a skim, not fifty lookups.

- **Orchestrator bookkeeping**: feature PRs never touch it, so it cannot become
  a merge magnet.
- **At most TWO batches per day** — mid-run and wind-down, not per merge train.
- **One concise BULLET per change** (owner, 2026-08-13): the title is the whole
  entry — the validator refuses a body and a title over 120 chars, so verbosity
  cannot creep back. Purely-internal merges are omitted; upgrade actions go in
  the day's operatorNotes.
- The file stays APPEND-ONLY; `/whats-new` pages it (#2528), and a day split
  across a page boundary carries its `operatorNotes` onto both pages.

## Dispatch prompt template

**The template lives in `scripts/orchestration/dispatch-brief.mjs` — generate
it, never paste it.** The generator computes the volatile values whose
hand-filling was the template's whole incident history, and records the
dispatch in the ledger and roster. A line that needs to change is changed IN
THE SCRIPT, in the same change as whatever taught the lesson — a copy edited
anywhere else forks the template. Gate-order lines live in
`scripts/orchestration/agent-gates.sh`, which every generated brief points at.

Line-by-line receipts (why the template says what it says) are in
_incidents_ — read them before editing the script, never paste them to an
agent. When this runbook already answers something, follow it rather than
improvising (_incidents: §Process drift_).

## E2e discipline (the part that most needs an owner)

> **The sharded `e2e` matrix IS the full-suite authority** — full suite,
> retries=0, fresh runners, every non-docs push. A session cannot dispatch
> `e2e-full.yml` (the API 403s). Local runs are for DIAGNOSIS, not gating.

**Split ownership.** Agents verify their own changed specs at CI parity
(`--repeat-each=3 --retries=0`, their assigned port range); only the
orchestrator runs FULL suites.

- **An agent MUST run the spec it authored** — an unrun spec is a guaranteed CI
  round-trip (#1066, #1115).
- **NEVER brief "write the spec, do not run it, I will run it."** Red CI both
  times it was issued (#2562, #2584; the structural reason and both post-
  mortems: _incidents: §E2E ownership failures_). A cluster that needs a
  browser spec has two honest resolutions: give it an e2e slot, or brief it
  with no browser spec at all ("prove this in the pure and DB tiers; if it
  cannot be proven there, say so and stop"). Never the split.
- **A new nav entry breaks `TOP_LEVEL_ORDER`** in
  `e2e/nav-consolidation.spec.ts` (#1042) — say so in any brief that may add
  one.
- **Ration your attention, not the runner** (measured 2026-08-13): the full
  mobile project is 211 tests in ~8 minutes at one worker — cheap enough to be
  the DEFAULT orchestrator-run check for anything touching shared chrome, not
  an on-demand ration. The agent caps stay; this is about your own runs.
- **The merge bar:** CI fully green on the exact head. No separate local
  full-suite gate.
- **Check `mergeable_state` FIRST when CI looks absent** — a conflict-dirty PR
  runs NO checks at all (`ci-watch.mjs` reports this as exit 3). Behind-only
  refreshes via `update_pull_request_branch`; dirty needs a worktree reconcile.
- **A docs/JSON-only PR failing e2e is never the diff** — the breakage is
  main-side or environmental; the bookkeeping PR is the control group proving
  it.

**Diagnosing a red.**

- **Reproduce locally before pushing anything** — blind fix-and-rerun costs 12
  minutes a guess; a local repro + the saved `error-context.md` aria snapshot
  usually identifies the defect in one look. Run failed specs in the order
  that failed; `--workers=1` when chasing cross-spec poisoning.
- **Check exit codes explicitly** — `cmd | tail -3` reports the TAIL's status.
  Echo `EXIT=$?` on its own line.
- **Mass failure ⇒ check memory first** (dev servers balloon to ~5 GB RSS;
  check `kswapd0`). Then rerun a handful of failures in ISOLATION: passing
  alone = suite-scale starvation; failing alone = real defect. Never accept
  "environmental" for a twice-repeated shape without that isolation step — a
  SPENT box reproduces the same failures deterministically.
- **Local FULL suite (rare): CI-mode, sharded `/4`, alone** — `npm run build`
  once, then `CI=1` as separate sequential `--shard=N/4` invocations, with
  nothing else running (_incidents: §E2E ownership failures_, last bullet).
- **`next dev` differs from CI's `next start`** — a spec must pass both;
  settled interactions (`e2e/helpers.ts`) fix pre-hydration clicks.
- **Reproduce a GLOBAL-state spec's flake ONLY at `--workers=1`** — parallel
  repeat-each on a spec owning shared config races itself and manufactures
  FALSE flakes absent from CI. Parallel repeats stay valid for a spec owning
  its own fixture.

**Flake exoneration protocol** (retries=0 means green means green). A CI e2e
failure may be dismissed as a flake only with BOTH: (1) a 3/3 local CI-parity
pass of the exact spec(s); (2) a stated MECHANISM — why this diff cannot reach
that spec, or what environmental race explains it. Then re-kick with an empty
commit. A SECOND occurrence of the same spec at retries=0, on any PR, files a
census issue with both run links.

- **Base-comparison (the workhorse):** run the failing spec on CLEAN MAIN at
  the same conditions/hour. Identical failure = pre-existing; a "flake" that
  reproduces 3/3 on main is a DEFECT (#1400, #1417).
- **Clock-adjacent failures (#1577):** "branch fails / main passes minutes
  apart" is NOT conclusive — the runs' config-load instants can straddle a
  #1464 nudge boundary. The conclusive form is a forced-skew A/B with
  `ALLOS_TEST_NOW`.
- **Distinct one-offs (#1557/#1577):** a PR green across N≥3 full runs where
  each run's single red is a DIFFERENT spec on an untouched surface, each
  attributable to a documented pre-existing class, merges with an attribution
  table. A REPEAT voids this.

**Known failure classes** — the tell → mechanism → fix catalogue lives in
`docs/internals/e2e-hygiene.md` § "The known CI failure classes", ONE home for
the taxonomy shared by spec authors and the orchestrator. Grep it before
diagnosing any red; every class there recurred at least once.

## Review checklist

First, route: `adversarial-review-brief.mjs <pr> --check` — MANDATORY sends
the PR through **The adversarial review lane** too; the merge waits for both.

- Does the fix match the issue's prescription **including comment-thread
  clarifications**, and are deviations argued? (Good agents deviate correctly —
  reward it, don't reflex-reject.)
- Grep-verify claims: testids, fixture names, helpers, "already imported at
  line N".
- **Exercise the write path when the diff cannot show the defect** (#2720): a
  fixture can insert a row shape the app never produces, passing diff, tests
  and CI — the blocker only appeared by calling the write core and reading
  what landed in the column.
- **Relay evidence verbatim; conclude only what you re-derived** (2026-08-13).
  Three relay errors in one stretch, one shape: an agent's conclusion restated
  with more force than its evidence carries (a dropped column in an issue's
  examples, "inert" amplified to "destructive", a false clause in a recorded
  ruling). Quote the evidence; the stronger claim is yours to make only after
  you re-derived it — #2720's finding held for exactly that reason.
- Conventions: profileId scoping, `writeTx` for mutations,
  one-question-one-computation, row-ops side-state, identity functions over
  raw names, auth gates stay in actions.
- Tests at the tier that can SEE the bug (builder input-layer bugs need
  DB-tier fixtures).
- Cross-PR conflicts among in-flight branches (same AGENTS.md line, two
  migrations appending to `versions/index.ts`) — plan merge order and who
  resolves.
- Migration hygiene: append-only, manifest entry in the same diff, the new
  file appended LAST to the array (see **Migrations are name-keyed**).
- Has this branch sat while a shared signature moved? See **CI tests the merge
  commit**.
- Flag owner-visible judgment calls in the review so the owner can veto
  cheaply.
- **Read the diffstat for a file git calls `Bin`** — a raw NUL byte hides a
  file from diff, blame, AND the text-scan gates (#2547; _incidents:
  §Review-caught shapes_).
- **A claimed count is a measurement with a timestamp** — ask for a re-count
  in the brief; check the PR reports one (#2528).
- **A curated dataset's diff must show only intended changes** — a stray
  regenerate is visible only through incidental edits (#2544).
- **Verify a PR's claims about pre-existing bugs** — a bug a change introduces
  and then fixes is not a bug it found (#2537).

## The adversarial review lane

One review lane reviews a diff against the brief the same orchestrator wrote —
and #2444 is what that misses (_incidents: §Assorted receipts_). So high-stakes
diffs get a SECOND lane: `adversarial-review-brief.mjs <pr> --check` says
whether it is MANDATORY (the path list and the reasoning live in the script:
data-corrupting, auth-boundary, or safety-signal paths), and the full mode
emits the refuter brief — a SEPARATE agent, prompted to construct and EXECUTE
the input that would falsify each of the PR's claims, never to summarize.
Disposition: the merge waits for the report; every REFUTED claim is fixed or
overridden with a written reason in the thread; a fully-CONFIRMED report after
honest attack is the lane working, not a wasted dispatch. The ordinary review
and the post-merge sweep continue unchanged.

## Migrations are name-keyed — the slot system is retired

Migrations stopped being numbered (lib/migrations/runner.ts): the applied set
lives in the `schema_migrations` ledger keyed by NAME, migrations 001–185 are
the closed numbered era, and a new migration is `versions/YYYYMMDD-slug.ts`
appended LAST to the `MIGRATIONS` array with its hash added to
`manifest.json`. There is nothing to reserve, no renumber recipe, and no gap
that can fail the suite — the whole coordination protocol this section used to
carry (slot map, tentative reservations, unhonorable-until-merged, the 6-step
renumber done 3×) existed to manage a contended integer, and the integer is
gone (_incidents: §Migration-slot incidents_ records what it cost).

What remains the orchestrator's job:

- **Merge-order = migration order.** Two PRs adding migrations conflict only in
  `versions/index.ts`; the resolution is keeping BOTH sides (both import
  lines, both array entries) — whichever lands second appends after the first.
  Never reorder already-merged entries.
- **The generated brief carries the convention** (dispatch-brief.mjs prints it
  in every brief); an agent needs no per-dispatch migration facts anymore.
- **A dev database that applied a branch's migration** and then merged main is
  handled by the runner (the missing earlier migration applies late); if a
  branch is ABANDONED, its migration name stays in that dev DB's ledger and the
  runner will refuse it as unknown — recreate the dev database.
- **Review still checks**: shipped files untouched (hash manifest), the new
  file appended LAST, its name unique and date-slug shaped, manifest entry in
  the same diff.

## CI tests the merge commit, not your branch

`ci.yml` is `on: pull_request` only, so every green check is a claim about a
merge ref against the base that existed when it ran. Since `ci-main.yml`,
**main itself is tested** on every push (static analysis + both unit tiers,
~3.5 min): a regression made by the interaction of two green PRs now reds main
directly instead of surfacing on the next innocent PRs. A red `CI (main)` run
means stop merging, fix main first, then resume. The browser tier is NOT in
that net, and a stale green on a sat branch is still stale, so the discipline
stands: **re-merge main and re-verify at merge time, on anything that has
sat.** The three faces of this class — a widening signature outrunning a green
run (#2245), a count-freezing allowlist firing on code the branch never saw,
and a behind-only PR's stale green breaking main for an hour (#1560/#1562) —
are written out in _incidents: §CI tests the merge commit_. After rebasing
across a merged route restructure, also grep the rebased specs for stale
untyped `page.goto("...")` route literals (#1079).

Standing consequences: every generated brief tells the agent to
`git merge origin/main && npm run typecheck` immediately before opening its
PR, and the orchestrator does that merge ITSELF before merging any PR that
touches a shared signature and has sat.

## The merge queue

The structural fix for the class above: the queue validates every merge's
SPECULATIVE commit — the exact bytes that will become main, in landing order —
so a two-green-PRs interaction fails in the queue instead of on main.
`ci.yml`/`gitleaks.yml` run on `merge_group` (cheap tiers + gitleaks only; two
`if:` lines in `ci.yml` extend the bar to the browser tier).

**Blocked on account type (measured 2026-08-13):** GitHub offers merge queue
only on ORGANIZATION-owned repos, so applying the ruleset to this user-owned
repo 422s with `Invalid rule 'merge_queue'` — no JSON shape fixes that. The
`merge_group` triggers and `.github/merge-queue-ruleset.json` stay as the
transfer-ready artifact (inert, zero cost), and the hand-serialization rules
STAND: serialize merges, defer the later rebase until the LAST conflicting
merge lands, re-check every open PR's mergeability after each merge. (A
strict up-to-date required-checks ruleset was considered and rejected: it
re-runs full CI per open PR per landing while buying nothing the protocol
doesn't.)

If the owner transfers the repo to an org:
`gh api repos/<org>/allos/rulesets --method POST --input .github/merge-queue-ruleset.json`
(squash, ALLGREEN groups of ≤5, admin bypass for direct owner pushes, which
`ci-main.yml` keeps covering). Then merging = `enable_pr_auto_merge` on a PR
whose OWN CI is fully green (e2e is not re-validated in the queue — never
queue a red-head PR), and the three hand-serialization rules retire.

## Cadence & lifecycle

Owner rulings, dated where they were made. These are directives, not
preferences.

- **Check-ins: `send_later` one-shot PLUS a backup background `sleep` timer,
  every ~20–30 min. Never the harness ScheduleWakeup tool** (owner,
  2026-08-01 — it silently failed once for 52 minutes). On every wake: run
  `orchestrator-checkin.sh` first, then re-arm the next pair before ending the
  turn. Never poll with foreground sleep.
  **They are not redundancy, and reading them as redundancy is what kills the
  session** (_incidents: §The wake that wasn't_). `send_later` is a SERVER-SIDE
  routine and survives a container restart; a background `sleep` is IN-PROCESS
  and dies with the container, exactly like the canary and for exactly the same
  reason. The sleep covers a `send_later` that silently fails; `send_later`
  covers a restart. Drop it and the DOMINANT failure mode has no wake mechanism
  at all. **`send_later` is primary — arm it FIRST, before any other work on a
  wake, not last.** Record its fire time in `$SCRATCH/.wake` (`<ISO> <trigger
id>`); `orchestrator-checkin.sh` reads it and alarms when nothing future is
  armed, which is the only reason the rule is now enforced rather than merely
  written down.
- **Every check-in posts a status pulse** (owner, 2026-08-01): in flight,
  merged, queued, parked-awaiting-owner. Silence reads as a stall.
- **Sweep open issues every ~4 hours** (owner, 2026-08-01) — new filings,
  label changes, comment-thread rulings; not just the session-start queue.
- **Post-merge audit sweep, once per session-day.** One review agent over the
  last ~24 h of merges to main — full diffs, prompted to REFUTE each PR's
  claims, with the review checklist as its lens. Pre-merge review verifies a
  diff against its claims; the sweep verifies it against the main that
  actually landed, and it is the only thing that has caught a whole class
  (#2444 — _incidents: §Assorted receipts_). Each finding is filed as an issue
  naming the introducing PR, which doubles as the defect-origin record.
- **Dispatch continuously until no viable issue remains** (owner, 2026-08-01).
  An idle slot alongside a viable queue is an orchestration bug; "no viable
  issues" means blocked/owner-gated/awaiting-dependency — say so in the pulse.
- **Parked issues carry the `parked` label** (owner, 2026-08-06); the pulse
  and the label must agree.
- **Dependabot: minors merge, majors get evaluated — parked is not a resting
  state** (owner, 2026-08-13; supersedes the 2026-08-06 form). Minor/patch
  groups merge on green against CURRENT main, same day, review still reading
  the group's contents. A MAJOR gets an evaluation agent within a day of
  arrival (`dependabot-eval-brief.mjs <pr>`): recommendation comment on the
  PR + `recommend-adopt` (orchestrator merges it) or `recommend-hold` +
  `parked` (revisit trigger in the comment) — no `needs-human` unless the eval
  cannot reach a verdict. `parked` is legitimate only AFTER the recommendation
  exists — a major once sat parked 35 days with no evaluation, a decision
  deferred to nobody.
- **File infra issues WITH a priority label, and label bottlenecks P1**
  (owner, 2026-07-26) — a bottleneck taxes every subsequent unit of work; the
  label IS the queue position. A single latent flake in one spec is P3.
- **Never write into a LIVE agent's worktree without telling it first**
  (2026-08-06). Direct fixes are correct AFTER the agent reports completion —
  a clean tree is not a done tree; message and wait for acknowledgement.
- **Re-check every open PR's mergeability after each merge** — a merge
  silently invalidates same-file PRs, visible as `mergeable_state: dirty` long
  before CI says anything. One `pulls/N` read per open PR is the whole fix.
- **`rerun_failed_jobs` CANCELS jobs still in flight** — only rerun a run
  whose jobs have all completed.
- **A job can be stamped `failure` with every step green** — read the STEPS; a
  red with no failing step is infrastructure, and a rerun is the answer.
- Keep a task per cluster (`agent → review → merge`); record each dispatch's
  BRANCH NAME in it.
- Institutionalize every incident into the tooling or this file the same day.
- **Wind-down** = no new dispatches; land everything in flight, clean
  worktrees and stale branches, stop the check-in loop, hand off. A
  still-working agent neither holds the wind-down open indefinitely nor gets
  cut off — invoke the WIP-marker contingency only when an agent has actually
  died, and say plainly what is unfinished. Before deleting a worktree with an
  uncommitted tree, CHECK whether its content is already on main in a later
  form (_incidents: §Assorted receipts_, the superseded draft).

## Deliberately out of scope for agents

- `docs/**` is NOT fenced (owner, 2026-07-29): agents keep matching docs
  current in the same change. AGENTS.md and README stay merge-magnets — a
  single self-contained clause when a change makes one factually wrong, never
  a restructure; fence them explicitly only when the owner says edits are in
  flight.
- Strategic/architectural issues the owner hasn't green-lit.
- Anything requiring an owner judgment (IA/nav decisions, tone choices) —
  surface, don't decide.
