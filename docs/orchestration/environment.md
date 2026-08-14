# Environment and recovery

## Environment

- Discover the installed Node 24 version under `/opt/nvm/versions/node/`; do not
  copy a patch version from documentation. Verify `better-sqlite3` loads.
- Use one canonical `node_modules` tree from the main checkout. Hard-link it
  into new worktrees as directed by the generated brief.
- Create agent worktrees under the shared scratch directory, never inside the
  main checkout. Give every scratch file a branch-unique name.
- A worktree's `.next` is a real copy, never hard-linked. `node_modules` can share
  inodes because nothing writes to it; a build directory is written to constantly,
  and a linked one would let a cluster's build corrupt another's. The e2e harness
  seeds it automatically — see `docs/orchestration/e2e-ci.md`.
- Concurrent DB gates can run about six times slower. Re-run a timing failure
  alone before treating it as a regression.
- Use `E2E_PORT`, not `PORT`. The brief generator allocates non-overlapping port
  ranges.

## GitHub access

- Prefer REST for reads and ordinary writes. Use MCP for squash merges,
  draft-to-ready changes, protected-ref writes, and Actions writes.
- Check the GraphQL rate-limit bucket before MCP-heavy work. Batch around a
  reset; never retry in a loop.
- GitHub closes multiple issues only when each `Fixes #N` is on its own line.
- Gitleaks scans all checked-out refs. Read its annotation first: installation
  failure means the scan never ran.

## Restarts

- Run `scripts/orchestrator-checkin.sh` after every restart or activity gap.
- Detect recovery needs from persisted state, worktrees, and pushed refs—not
  process liveness, transcript mtime, or old commits.
- A reported “stopped by the user” is an environment reclaim unless the owner
  explicitly said they stopped it.
- Compare transcript byte growth and commit age when diagnosing a stall.
- Before reporting or debugging a stopped agent, commit dirty work as an
  explicitly unverified WIP and push its branch.
- Resume agents with a precise state summary. Never run background work that
  depends on an ephemeral completion event.

## Lost credentials

- Credential loss can leave reads working while pushes and authenticated REST
  fail. Reauthorize repository push access through the connector, then verify
  with a push dry-run.
- Do not search the filesystem or environment for credentials.
- While writes are unavailable, keep agents working and bank completed reasoning
  through available connector writes.

## Stall test

- Use `dispatch-brief.mjs list`; investigate work past three times the measured
  completion median.
- Check that the worktree exists and that its current commit is pushed.
- Ask for the exact refusal or blocker. Do not infer progress from liveness.

See `docs/orchestration-incidents.md` for recovery receipts and failure history.
