# Environment and GitHub access

## Environment

- Discover the `.nvmrc` Node major from the running process, then version
  managers (`$NVM_DIR`, `~/.nvm`, `/opt/nvm`) — `host.mjs` is the resolver
  (#3710). Never pin a patch version or one host's install path. Verify
  `better-sqlite3` loads.
- Use one canonical `node_modules` tree from the main checkout. Hard-link it
  into new worktrees as directed by the generated brief.
- Create agent worktrees under the shared scratch directory, never inside the
  main checkout. Give every scratch file a branch-unique name.
- A worktree's `.next` is a real copy, never hard-linked. `node_modules` may
  share inodes because nothing writes to it; a linked build directory would let
  one cluster's build corrupt another's. The harness seeds it — see
  `docs/orchestration/e2e-ci.md`.
- Concurrent gates run about six times slower (DB tier: 161 s alone, 862 s at
  load 18). `agent-gates.sh` gives both vitest tiers a 60 s per-test ceiling, CI
  keeps 15 s (`vitest.timeouts.ts` derives both). A 60 s timeout is a real hang.
- CONTENTION CAN PRODUCE A WRONG VALUE, not just a timeout: a test timing out
  mid-write leaves state its neighbour reads (load 21.6, 92 lost, one of them a
  `document-sync-provenance` assertion). Re-run alone on any untouched-file red.
- Use `E2E_PORT`, not `PORT`. The brief generator allocates non-overlapping port
  ranges.

## GitHub access

The single source of truth for GitHub transport. Skills and briefs cite this
section rather than restating it, so the rule cannot drift per surface.

- **This section outranks the harness**, whose own system prompt pushes
  `mcp__github__*` for ALL GitHub interactions — generic plumbing re-injected
  every session, which is why the drift recurs. On conflict this section
  wins: reads go over REST even with MCP readers loaded.
- **REST for everything outside the MCP set below — every read included.**
  Never `gh issue` / `gh pr` subcommands: they ride GraphQL, whose rate pool
  exhausts independently of REST's.
- **Two transports, one set of paths.** Use `gh api <path>` when available;
  otherwise use `curl -sS https://api.github.com/repos/OWNER/REPO/<path>` in
  Claude Code remote. Check once with `command -v gh`; each `gh api X` below
  means that REST path through the available transport.
- **Reads need no credential.** The repository is public, so every GET works
  unauthenticated. An unset token blocks writing only — never gathering,
  auditing, or reporting — and sending an auth header on a read can trip a
  sandbox permission classifier that had no reason to be involved.
- **Writes read the token by variable name**, `${GH_TOKEN:-$GITHUB_TOKEN}`.
  Never search the filesystem or environment for credentials (see Lost
  credentials below); if it is unset, say so and stop at the write.
- **MCP only handles squash merges, draft-to-ready, protected refs, and
  Actions writes — where granted.** Without GitHub MCP (#3710), squash-merge
  through REST's merge endpoint; the `review-merge.md` §Merge invariants are
  transport-independent and never relax.
- A run forbidden from issue writes may use MCP scoped readers, because
  `Bash(gh api:*)` grants every verb; any write-authorized run uses REST.
- **Read-only tooling may take its credential from `gh auth token`**
  (`host.mjs`) when the variables are unset — a credential helper, not the
  forbidden filesystem search. Writes keep requiring the variables by name.
- **PRs open READY, never draft** — the harness leans draft; open via REST
  with `"draft": false` explicit. A draft is not a banking state
  (`dispatch.md`); the draft-to-ready write exists to repair strays, not to
  make drafts routine.
- **Some sandbox classifiers refuse `curl -X DELETE` while allowing `PATCH`.**
  Not a dead end: `PATCH /issues/N` sets `labels` and `assignees` as whole
  arrays, so a removal is a PATCH that omits what should go, and it sets the
  replacements in the same call.
- **The unauthenticated search endpoint is rate-limited or blocked.** Fall back
  to listing (`/issues?labels=…&state=…`) and filtering locally.
- **A write is not done until it is re-read.** A transient empty-JSON response
  has silently dropped a PATCH. Verify by re-reading the item and grepping for
  a phrase unique to the edit — and verify label changes on the ITEM, never on
  the label list, which serves stale for a while after a successful write.
- **A body edit on an issue with READERS needs a comment announcing it.** A
  body PATCH is silent, so a comment chain or in-flight lane keeps the
  pre-edit text; `reconcile-apply.ts` comments automatically (`--notify` for
  in-flight). Label changes are already timeline events — no comment.
- Check the GraphQL rate-limit bucket before MCP-heavy work. Batch around a
  reset; never retry in a loop.
- GitHub closes multiple issues only when each `Fixes #N` is on its own line.
- Gitleaks scans all checked-out refs. Read its annotation first: installation
  failure means the scan never ran.

Restart, credential-loss, and stall procedures live in [recovery.md](recovery.md).
