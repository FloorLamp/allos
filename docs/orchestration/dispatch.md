# Dispatch and pipeline

Queue labels live in [labels.md](labels.md) — the two label axes, the
closed taxonomy, and `needs-human` handling.

## Dispatch

- Use `scripts/orchestration/dispatch-brief.mjs new` for every agent; adopt any
  unrecorded live dispatch. Its setup prints `PINNED_BASE_SHA`; keep it and use
  that exact SHA—not moving `origin/main`—for any reset or history rewrite.
- Cluster two to six related issues by domain and files. Avoid file overlap;
  sequence work when overlap cannot be fenced.
- A `design` issue is dispatchable only when its body records the owner
  decision (the #2701 shape) or a direction with stated falsifiers (#2641).
  One still carrying the design question is owner-gated; agents never explore.
- Older issues start with an audit table: resolved by what, or still open.
- Cap E2E work at two agents — `dispatch-brief.mjs` refuses a third `--e2e`
  lane on every path (new/resume/adopt) and warns past the machine cap.
  Ordinary concurrency is min(harness slots, machine cap) — five on the
  4-core container (#2964); a harness exposing fewer slots caps there (#3710).
- Revert on a DISCRIMINATING signal: a misread red actually shipped, or the
  ledger's median dispatch duration degrades. "Agents hit the ten-minute tool
  cap" is not one — it fired at four agents and at five, so it cannot tell them
  apart. Measured at five: median 90 min against a 86-min cap-four baseline.
- That cap counts agents RUNNING — a machine limit. The queue that jams first
  is PRs awaiting REVIEW, which is serial and cannot be parallelised. Hold
  dispatch at roughly three unreviewed PRs however few agents are running.
- With ready P1s, reserve two user/data lanes and select the highest-risk ready
  P2; cap presentation/guard at one. Recompute when issues arrive or lanes free.
- **Self-filed work joins the BACK of its queue.** An issue you or a lane
  filed defaults to P3, sourced OLDEST FIRST only when no owner-filed work of
  equal or higher priority is ready. Sole exception: a DEMONSTRATED P0/P1
  regression a merge just introduced.
- Lanes never file issues. Findings ride the return summary; the orchestrator
  decides what becomes an issue — a filed observation displaces real work.
- An urgent P0/P1 displaces the candidate via `promote`; run only its matrix.
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
- Push meaningful checkpoints. A branch not next to land stays branch-only —
  no PR at all, and a draft is not a banking state. The candidate's PR opens
  READY (environment.md §GitHub access), never for CI a pending merge will
  invalidate.
- Parallelize banked implementation/local pre-review; serialize the sole
  candidate's remote review, CI, and merge.
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

## Tooling

- Every entry script answers `-h`/`--help` with its own header and exits
  before any side effect (`script-help.test.ts` pins it) — probing an
  unfamiliar script is always safe.
- `dispatch-brief.mjs`: manage dispatches, the sole landing candidate, and
  validated priority/lane state; deliver every emitted role update. `list`
  flags 3x-median idleness or a dispatch with no worktree and no branch.
- `agent-gates.sh`: lint, typecheck, unit, DB, E2E hygiene, PHI scan, format.
  The DB and E2E-hygiene gates run only when the diff touches what they cover.
  A format rewrite re-verifies the directive-reading gates it can invalidate.
  Both vitest gates carry a 60 s per-test ceiling here; CI keeps 15 s.
- `ci-watch.mjs`: wait for settled CI; exit 0 green, 1 red, 2 unsettled, 3
  conflict-blocked.
- `catchup-digest.sh`: the since-last-looked digest; the check-in runs it once
  its anchor is 4h stale, so it needs no remembering; `--peek` any time.
- `dependabot-eval-brief.mjs`: evaluate major dependency updates.
- `session-metrics.mjs`: the trend pulse — throughput, review depth, queue
  shape, needs-human aging; denominators first. Argue caps from its numbers.
- `release-notes-gather.mjs`: gather merged user-visible changes.
- `adversarial-review-brief.mjs`: route and brief high-stakes second reviews.

## Release notes

- Release notes are orchestrator bookkeeping in `lib/release-notes.json`.
- Make at most one batch per day. Use one concise title-only bullet per
  user-visible change; omit internal work.
- Keep entries append-only. Put upgrade actions in that day's `operatorNotes`.
