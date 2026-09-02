# Recovery

## Restarts

- Run `scripts/work-checkin.sh` after every restart or activity gap.
- Detect recovery needs from persisted state, worktrees, and pushed refs—not
  process liveness, transcript mtime, or old commits.
- A reported “stopped by the user” is an environment reclaim unless the owner
  explicitly said they stopped it.
- Compare transcript byte growth and commit age when diagnosing a stall.
- Before reporting or debugging a stopped agent, commit dirty work as an
  explicitly unverified WIP and push its branch.
- The restart verdict is STICKY and survives being re-read: a detected restart
  raises `$SCRATCH/.agents_dead`, every later run keeps reporting the fleet as
  dead, and only `work-checkin.sh --relaunched` clears it. Clear it
  after the rescues and the relaunches, never before.
- The verdict authorises the RESCUE, never the RELAUNCH: a snapshot resume
  changes both ids while the process tree survives. Confirm with `ListAgents`
  before relaunching — rescuing a live tree costs a junk commit, relaunching
  onto one puts two writers on a worktree.
- Resume agents with a precise state summary. Never run background work that
  depends on an ephemeral completion event.
- Recovery ends with a REFILL, not a report: once every rescue and relaunch is
  done, triage and dispatch. An empty roster after a restart is a to-do.

## Lost credentials

- Credential loss can leave reads working while pushes fail. Reauthorize push
  access through the connector; verify with a push dry-run. Never search the
  filesystem or environment for credentials. While writes are down, keep
  agents working and bank completed reasoning through connector writes.

## Stall test

- Use `dispatch-brief.mjs list`; investigate work past three times the measured
  completion median.
- Check that the worktree exists and that its current commit is pushed.
- Ask for the exact refusal or blocker. Do not infer progress from liveness.
