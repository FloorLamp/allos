# Recovery

Preserve work and verify current state before restarting, retrying, or deleting.
Use the [environment guide](environment.md) for setup and access, and the
[change and test policy](../change-policy.md) for scope. Recovery remains within
the session's authorization.

## Restarts

- Run `scripts/orchestrator-checkin.sh` after a restart or activity gap. Its roster,
  persisted state, worktrees, and pushed refs identify work to inspect; they do
  not by themselves prove whether an agent is currently running.
- Consult the harness's live-agent status and any captured process handles before
  relaunching or writing into an agent's worktree. A timeout while observing a
  process is not a terminal result. Do not restart work solely because observation
  expired, and honor an explicit user stop.
- Preserve a stopped agent's uncommitted work before investigating the failure.
  Check ownership and content, then checkpoint it on its branch as explicitly
  unverified WIP when necessary. Push through available authorized access. Do not
  overwrite a live agent or unrelated user changes.
- The check-in's restart marker, `$SCRATCH/.agents_dead`, persists until
  `orchestrator-checkin.sh --relaunched` clears it. Clear it after recovery and any
  necessary relaunches, not merely because the marker was read. A marker alone is
  not relaunch authorization.
- Resume with a precise state summary: branch/head, saved work, completed checks,
  remaining requirements, and blocker. Give background work durable state to read;
  do not depend on an ephemeral completion event.
- Return to the Ladder's recorded cycle and its [lifecycle](lifecycle.md). An empty
  roster alone establishes neither completion nor continuous exhaustion.

## Lost credentials

Credential loss can leave reads working while pushes fail. Reauthorize through
the session's approved credential mechanism and verify push access with a dry run.
Never search for secrets. Continue useful authorized work and checkpoint locally
while writes are unavailable; report which results remain unpushed.

An approval rejection is different from missing credentials. Do not switch
transports or use an indirect write to bypass it.

## Stall test

Use `dispatch-brief.mjs list` to identify work past three times its measured
completion median. Inspect the worktree, current commit, last pushed checkpoint,
live agent/process status, and exact refusal or blocker. File or transcript growth
can help diagnose activity; neither liveness nor an old timestamp proves progress
or completion. Resolve the cause before starting a replacement.

## A merge that half-landed

An error response from a merge request can leave its result uncertain. Before
retrying, read the PR state, remote target branch, and relevant commits. Compare
what actually landed with the intended files and behavior; a matching title or
surviving source branch is insufficient evidence.

If the content landed while the PR record remains open, reconcile that record
within the authorized workflow. Retire the dispatch with `--keep` when its normal
cleanup cannot verify the surviving refs, documenting the content comparison.
Never delete branch work solely because the PR is closed, and do not treat a
closed-but-unmerged record as proof that its changes are absent from `main`.
