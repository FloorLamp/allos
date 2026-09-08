# Environment and GitHub access

Use the [change and test policy](../change-policy.md) to keep work and verification
focused. These are repository defaults within the session's instructions,
authorization, and available tools.

## Environment

- Resolve the `.nvmrc` Node major with
  [host.mjs](../../scripts/orchestration/host.mjs), using the running process or
  installed version managers. Avoid pinned host paths and verify that
  `better-sqlite3` loads.
- Follow the generated [dispatch setup](../../scripts/orchestration/dispatch-brief.mjs)
  for worktrees, dependencies, pinned base, and ports. Worktrees belong in shared
  scratch space outside the main checkout; scratch files and logs need unique
  names. Use the assigned `E2E_PORT` for Playwright.
- Dependency sharing uses a hardlink copy, not a directory symlink. Recreate
  writable caches locally and install compatible dependencies when required.
  Keep `.next` local to each worktree; never hardlink build output. See
  [E2E setup](e2e-ci.md).
- Check the check-in's `tooling:` comparison before trusting orchestration
  verdicts. A checkout can run older scripts than `origin/main`; resolve a
  `DIFFER` or `UNCOMPARED` result before relying on affected tooling.
- A helper that cannot answer must name the failed read and its uncertainty.
  `UNMEASURED`, `UNASKED`, `UNCOMPARED`, or `ABSENT` describe missing evidence;
  use `MISSING` only when absence was established. Never turn an unknown into a
  guessed value or a clean result.
- Diagnose timeouts through the [Vitest guide](../internals/test-tier-timeouts.md).
  Wall time alone cannot distinguish a hang, contention, or shared-state leakage.
  For untouched-file failures, use [dispatch's attribution procedure](dispatch.md)
  before blaming the change or the machine.
- Wait on a captured process/tool handle. For recorded gates, use
  [run-gates-recorded.sh](../../scripts/orchestration/run-gates-recorded.sh) and its
  recorded PID/exit status. A script-name process search can match other lanes or
  the waiter itself. An observation timeout does not prove the work stopped.

## GitHub access

This section owns transport defaults; skills and briefs link here. It does not
expand tool grants or override session instructions or an approval rejection.

- Use REST for reads and ordinary writes: `gh api <path>`, or the same endpoint
  through `curl` when `gh` is unavailable. Avoid the GraphQL-based `gh issue` and
  `gh pr` workflows in orchestration sessions.
- Granted GitHub MCP tools handle squash merges, draft-to-ready, protected refs,
  and Actions writes. REST's merge endpoint is the fallback when MCP is absent;
  [review and merge](review-merge.md) owns the merge requirements.
- A narrowly granted maintenance role may use scoped MCP readers and its confined
  writers, as specified by that role. Do not replace a restricted grant with
  general shell access.
- Public repository reads can often run unauthenticated. Missing write credentials
  do not by themselves block gathering. Report endpoint refusals and rate limits;
  if search is unavailable, list the relevant collection and filter locally.
- Writers use the named `GH_TOKEN` or `GITHUB_TOKEN` variables. Read-only tooling
  may use `host.mjs`'s `gh auth token` fallback. Never print tokens or search the
  filesystem or environment for credentials. Follow [recovery](recovery.md) when
  authorized access is unavailable.
- Respect sandbox and approval refusals. Follow the session's escalation process;
  do not switch verbs or transports to evade a denial.
- Open the sole landing candidate ready for review (`"draft": false`). Keep
  banked work branch-only under [dispatch](dispatch.md); draft-to-ready repairs an
  existing draft, it is not a second banking workflow.
- Re-read every written item to verify the result. Check labels on the issue
  itself and exact text in a changed body. An ambiguous response is not evidence
  that a write either succeeded or failed; reconcile state before retrying.
- When authorized to edit and notify an issue's readers, announce body changes on
  its comment thread. `reconcile-apply.ts` does this for issues with comments;
  `--notify` includes quiet issues assigned to live lanes. Label changes already
  create timeline events.
- Use one closing keyword per intended issue, on separate lines for readability.
  A partial umbrella delivery uses a reference and updates only verified completed
  boxes. Check the intended closures through the merge procedure.
- Inspect Gitleaks annotations and scan scope. An installation failure means the
  scan did not run; a green result establishes only what that invocation scanned.
