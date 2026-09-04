# Dispatch and pipeline

Queue labels live in [labels.md](labels.md) — the two label axes, the
closed taxonomy, and `needs-human` handling.

## Dispatch

- Use `scripts/orchestration/dispatch-brief.mjs new` for every agent; adopt any
  unrecorded live dispatch. Its setup prints `PINNED_BASE_SHA`; keep it and use
  that exact SHA—not moving `origin/main`—for any reset or history rewrite.
- Cluster two to six related issues by domain and files. Avoid file overlap;
  sequence work when overlap cannot be fenced. `claims <path>` names the active
  lane holding a path; CANNOT TELL is NOT clear — answer before the lane edits.
- Claim before dispatch: a `Dispatched:` note on each issue, and a fence
  check against any other orchestrator's branches (`multi-orchestrator.md`).
  The note outlives the container, so it applies with one orchestrator too.
- A `design` issue is dispatchable only when its body records the owner
  decision (the #2701 shape) or a direction with stated falsifiers (#2641).
  One still carrying the design question is owner-gated; agents never explore.
- Older issues start with an audit table: resolved by what, or still open.
- Cap E2E work at two agents — `dispatch-brief.mjs` refuses a third `--e2e`
  lane on every path (new/resume/adopt) and warns past the machine cap.
  Ordinary concurrency is min(harness slots, machine cap) — five on the
  4-core container (#2964); a harness exposing fewer slots caps there (#3710).
- Revert the cap on a DISCRIMINATING signal only: a misread red shipped, or
  the ledger's median dispatch duration degrades. "Agents hit the tool cap"
  fired at four and at five alike, so it is not one.
- The cap counts agents RUNNING. The queue that jams first is PRs awaiting
  REVIEW, which is serial: hold dispatch at about three unreviewed PRs.
- With ready P1s, reserve two user/data lanes and select the highest-risk ready
  P2; cap presentation/guard at one. Recompute when issues arrive or lanes free.
- **Self-filed work joins the BACK of its queue.** An issue you or a lane
  filed defaults to P3, sourced OLDEST FIRST only when no owner-filed work of
  equal or higher priority is ready. Sole exception: a DEMONSTRATED P0/P1
  regression a merge just introduced.
- Lanes never file issues. Findings ride the return summary; the orchestrator
  decides what becomes an issue — a filed observation displaces real work.
- An urgent P0/P1 displaces the candidate via `promote`; run only its matrix.
- STAGGER starts: durations cluster (85±5 min), so simultaneous starts are
  simultaneous gates — five at once hit load 17.7. `new` warns within 25
  minutes; it never refuses, a P0 preempts.
- A red in code the diff did not touch is contention until proven otherwise —
  an ASSERTION failure included, not only a timeout (#3436).
- Every brief uses the generated template and the gate order from
  `scripts/orchestration/agent-gates.sh`.
- Push meaningful checkpoints. A branch that has not passed its gates stays
  branch-only — no PR, and a draft is not a banking state. A verified branch
  opens READY at once (environment.md §GitHub access); CI and review run in
  parallel across PRs, and only the merge itself is serial.
- A census meant to be EXHAUSTIVE passes ripgrep's `--binary` (`-a`). Several
  source files carry a deliberate NUL separator, so rg calls them binary and
  skips them — a plain `rg` reports a clean sweep it never took.
  `lib/__tests__/nul-byte-census.test.ts` names them.

## Per-unit pipeline

1. Read each issue whole via `issue-read.mjs`; `new` refuses a closed one.
2. Generate the dispatch brief and record the branch in the task list.
3. Require the agent to merge current `origin/main` and run the assigned gates.
   Open the PR as soon as the gates pass (title imperative, one clause, 72
   chars max, it is the commit subject; only a `(#N …)` tail); after another
   merge lands, run `landing-independence.mjs` before deciding to rebase.
4. Read the full diff, verify claims, and post a substantive COMMENT review.
5. Diagnose E2E reds locally; send code corrections back to the author unless
   the change is an orchestrator-owned E2E fix.
6. Merge only a green exact head. Serialize conflicting merges.
7. Close the dispatch, remove its worktree and branch, and verify linked issues
   actually closed.

## Tooling

- Every entry script answers `-h`/`--help` with its header and exits before
  any side effect (`script-help.test.ts` pins it) — probing is always safe.
- `dispatch-brief.mjs`: manage dispatches, the sole landing candidate, and
  validated priority/lane state; deliver every emitted role update. `list`
  flags 3x-median idleness or a dispatch with no worktree and no branch.
- `agent-gates.sh`: lint, typecheck, unit, DB, E2E hygiene, PHI scan, format.
  DB and E2E-hygiene run only when the diff touches them; a format rewrite
  re-verifies the directive-reading gates. 60 s per-test ceiling here; CI 15 s.
- `ci-watch.mjs`: wait for settled CI; exit 0 green, 1 red, 2 unsettled, 3
  conflict-blocked.
- `pm-digest.sh`: the owner's catch-up — shipped for people, incidents and
  the workflow changes they caused, progress. The PM runs it, not an orchestrator.
- `dependabot-eval-brief.mjs`: evaluate major dependency updates.
- `queue-snapshot.mjs`: the dispatchable queue in `$SCRATCH/.queue`, refreshed
  4-hourly, `[lane:B]` on rows the ledger holds. A "thin" claim answers it.
- `session-metrics.mjs`: the trend pulse — throughput, review depth, queue
  shape, needs-human aging; denominators first. Argue caps from its numbers.
- `release-notes-gather.mjs`: gather merged user-visible changes.
- `adversarial-review-brief.mjs`: route and brief high-stakes second reviews.

## Release notes

- Orchestrator bookkeeping in `lib/release-notes.json`: one batch a day at
  most, entries append-only, upgrade actions in the day's `operatorNotes`.
- One bullet per user-visible change: ≤80 characters, product words, and a
  `category` from `RELEASE_NOTE_CATEGORIES` — `lib/release-notes.ts` validates
  both; the app groups each day by category, most visible first.
- `release-notes-gather.mjs --check` prints the uncovered lag; non-zero = due.
