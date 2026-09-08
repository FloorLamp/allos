# Dispatch and pipeline

This guide owns queue selection, capacity, and branch promotion. Use
[lifecycle](lifecycle.md) for authorized scope and termination,
[labels](labels.md) for classification, and the
[change and test policy](../change-policy.md) for the smallest complete task and
useful verification. Session instructions take precedence over these defaults.

## Dispatch

Read each candidate's whole body and comment thread through `issue-read.mjs`.
An older issue starts with a current-state block: shipped PRs, unmet acceptance
criteria, latest owner ruling, and the next bounded action. Refresh it after a
partial merge. A design task needs a recorded owner decision or direction with
stated falsifiers; an unanswered design question remains owner-gated.

Prioritize remaining impact:

- Ready P0/P1 defects preempt features. Compare confirmed safety, stored-record
  integrity, delivery, and recovery failures before cleanup. An old title or past
  incident does not preserve priority after the relevant defect is fixed.
- Infrastructure priorities follow demonstrated impact: a red main or blocked
  landing queue can be P1; an isolated latent flake is P3. Priority elevation
  needs the owner, a demonstrated main regression, or an owner-authorized audit.
  Record that evidence and reassess residual work after partial fixes.
- Agent-discovered work defaults to P3 and joins the back of its queue. Take it
  oldest first only when no owner-filed work of equal or higher priority is ready.
  A demonstrated new P0/P1 regression or authorized priority audit can override
  that ordering. Lanes return findings; the orchestrator decides how to track them
  under [lifecycle's filing bar](lifecycle.md).

Capacity applies to running agents, including separate review agents:

- Cap E2E lanes at two. Ordinary concurrency is the smaller of harness slots and
  machine capacity; the generator warns at five active dispatches, the current
  four-core baseline. A larger harness is not evidence of more machine capacity.
- After a session rate-limit rejection, inspect current agent state and preserve
  branches. Cap total agents at four, or the lower applicable limit, until a
  five-hour window passes without another rejection. Do not assume all agents
  stopped or discard banked work.
- With ready P1s, reserve two user/data lanes and select the highest-risk ready P2
  within available capacity; cap presentation/guard work at one. Recompute when
  issues arrive or agents finish.
- Pause dispatch around three unreviewed PRs across the shared review queue.
  Banking frees agent capacity, not review capacity. Stagger starts to avoid gate
  contention; the generator warns about starts within 25 minutes. A P0 preempts.

Cluster related issues by domain and files, usually two to six when their scope
fits one bounded task. Resolve `claims <path>` before editing; an unreadable claim
is not clearance. Sequence overlaps that cannot be fenced. Use
[cross-session coordination](multi-orchestrator.md) for other sessions' branches.

## Per-unit pipeline

1. Claim each issue, naming the branch, under [claims](claims.md) before generating
   its brief. Use `dispatch-brief.mjs new` for every agent; adopt unrecorded live
   dispatches through the same tool. Record the branch in the task list.
2. Keep the generated `PINNED_BASE_SHA` for any authorized reset or history
   rewrite. Follow its setup, file fences, and assigned gate order. Push meaningful
   checkpoints and update from current `origin/main` before the assigned gates.
3. Bank a validated branch without a PR until it is the session's sole landing
   candidate. Only the candidate opens or refreshes a ready PR and consumes final
   remote review and CI. An urgent P0/P1 can displace it through `promote`.
4. Give the PR an imperative, one-clause title of at most 72 characters; only an
   issue-reference tail may follow. Follow [review and merge](review-merge.md) for
   the full review, exact-head checks, changed bases, and serialized squash merge.
   `landing-independence.mjs` supplies path-based advice, not a merge verdict.
5. Verify intended issue closures and umbrella boxes. Finish the dispatch and
   clean redundant work through [recovery](recovery.md) and
   [lifecycle](lifecycle.md); compare content before deleting branches or worktrees.

Parallelize banked implementation and local review when authorized. Serialize the
landing candidate's final remote review, CI, and merge. Do not edit a live agent's
worktree without acknowledgement. Production replay, backfill, snapshot access,
and migration execution remain owner operations outside a normal coding lane.

A decision-held branch is banked work, not a landing candidate. Preserve its head
and exact release condition, then give available workers the highest ready work
in the authorized slice. Pending owner answers do not require workers to wait or
the PM to approve routine queue advancement. Respect actual file, machine, and
review limits; report a blocked handoff only after no eligible work remains.

## Tooling

Use the relevant script's `--help` before unfamiliar operations; check its declared
behavior rather than assuming every executable is free of side effects.

| Tool                           | Responsibility                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `dispatch-brief.mjs`           | Dispatches, claims, ports, validated state, and candidate promotion; deliver emitted role updates |
| `agent-gates.sh`               | Assigned local checks in order; environment and gate triggers determine what runs                 |
| `run-gates-recorded.sh`        | Captured PID and exit status; `--wait` resumes observation                                        |
| `ci-watch.mjs`                 | Settled check runs and commit statuses: 0 green, 1 red, 2 unsettled, 3 blocked                    |
| `queue-snapshot.mjs`           | Dispatchable queue snapshot and held-lane markers                                                 |
| `session-metrics.mjs`          | Throughput, review depth, queue shape, and `needs-human` issue age with denominators              |
| `adversarial-review-brief.mjs` | High-stakes review routing; review policy owns the response                                       |
| `dependabot-eval-brief.mjs`    | Major dependency evaluation                                                                       |

For an untouched-file failure, inspect preceding timeouts and shared state,
reproduce the focused case, and compare it on the pinned base before attribution.
Use [E2E diagnosis](e2e-ci.md) and [timeout diagnosis](../internals/test-tier-timeouts.md).
A cancelled or unmeasured run is no verdict. Exhaustive source searches use `rg -a`
so deliberate NUL bytes do not hide files from the result.

## Release notes

The PM owns the day's batch, as described in
[bookkeeping](multi-orchestrator.md#bookkeeping). Keep entries in
`lib/release-notes.json` append-only, batch at most once a day, and put upgrade
actions in `operatorNotes`.

Use one product-language bullet per user-visible change, at most 80 characters,
with a category from [RELEASE_NOTE_CATEGORIES](../../lib/release-notes.ts). A `perf`
entry needs measured time on a surface people wait for; fewer internal operations
alone do not establish faster UX.

`release-notes-gather.mjs --check` prints uncovered candidate counts and exits 0
on a successful check even when the count is positive. Read the output, including
fetch failures and clipped-history limits. Its path-based candidates require
curation; `pm-digest.sh` supplies the PM's catch-up, not an additional author list.
