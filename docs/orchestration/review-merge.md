# Review and merge

## Review

- Orchestrator reviews use `COMMENT`, never `APPROVE` or `REQUEST_CHANGES`.
  State blockers explicitly in the comment and mark held work `parked`.
- Read the full diff and the issue's complete comment thread.
- Verify repository claims with searches and focused reads. Exercise the write
  path when the diff cannot demonstrate the behavior.
- Check a consumer table with `npx tsx scripts/reach.ts <module> <symbol>`: the
  terminals it prints are the rows the table must name, never the nearest one.
  The merge gate prints that reach as a NOTE row for a PR whose diff changes a
  shared `lib/` derivation, naming the terminals the table omits and the tree
  it walked; a declaration moved verbatim between files prints no row.
- Relay evidence exactly and make only conclusions you independently derived.
- Check profile scoping, write transactions, authorization boundaries, identity
  handling, and shared one-question-one-computation models.
- Apply [the change and test policy](../change-policy.md): inspect new abstractions,
  unique test value, and production/test line deltas.
- A product file over 1,500 non-comment lines that the diff edits leaves shorter
  than it arrived (`git diff --stat`); moved code counts only when it gains an
  owner named in the development guide. Exempt: a P0/P1 fix stated in the PR, or
  a branch dispatched before 2026-09-09 20:49 UTC ([policy](../change-policy.md#review)).
- A guard's existence is not its coverage. Ask which widths, states and
  roles it runs at, and say which in the review.
- A REMOVAL is checked against the issue's acceptance criteria: unreachable
  code is debris or an unfinished requirement, and only the issue says which.
- Inspect cross-PR conflicts, stale shared signatures, binary-looking diffs,
  measured-count claims, and unintended generated-data changes.
- Flag owner-visible judgment calls in the COMMENT review.
- Consult [verification failure modes](../internals/verification-failure-modes.md)
  before writing a guard or dispatching a lens.

## Adversarial lane

- Run `adversarial-review-brief.mjs <pr> --check` for every PR. Exit 0
  dispatches the lane, 3 is CONSULT, 1 is ordinary, 2 could not read the PR.
- Never treat 2 or 3 as a no.
- MANDATORY is read from the DIFF (#4842): a high-stakes path, a moved
  authorization gate, a dropped `profile_id` predicate. Those need a separate
  agent to execute falsifying attacks; prose alone only ever reaches CONSULT.
- On CONSULT, read the file and hunk it quotes, not the matched terms; dispatch
  when it moves what a shared surface shows about another profile.
- The merge waits for that report — a MARKER the gate reads (claims.md). Fix
  each refuted claim or record a reasoned override in the thread.
- A blocking finding fixed by changing the MECHANISM, not the value, earns a
  fresh pass. The test: does the fix create a surface the last pass could not
  have attacked? A new store, key, lifetime, or owning row is yes; a corrected
  constant or bound is no.
- Keep the two-falsifying-pass ceiling: after two blocking rounds, stop patching
  and bank the PR, even when the findings concern different defects. Before
  another implementation round,
  write the revised ownership model, what mechanism retires, and the concrete
  attack it must survive; have a non-author review that design. A smaller guard
  or a new exception alone is not a redesign. Non-leaking prose mismatches
  remain follow-ups.
- A PR the owner opens gets a plain non-author review and the standard gates;
  a blocker is fixed as a new commit on the owner's branch, stated on the
  PR — never rebase, amend or force-push it (owner 2026-09-04).

## Migrations

- [Migration instructions](../../lib/migrations/AGENTS.md) own the procedure.
  Merge order defines migration order. An APPEND-ONLY file (`versions/index.ts`,
  a barrel like `lib/queries.ts`) conflicts whenever two lanes append: keep BOTH
  entries, later merge last, never pick a side. Re-run the generator for
  `manifest.json` hashes rather than hand-resolving them.
- Recreate development databases containing abandoned, unknown migration names.

## Merge

- Squash merge only a green EXACT HEAD, through the transport this host
  grants (MCP, else REST `PUT /pulls/N/merge` squash). Re-read `head.sha` in
  the same breath as the merge call: GitHub merges the head it finds.
- Serialize merges. After each merge, recheck every open PR's mergeability and
  refresh or reconcile affected branches.
- A green exact head merges in the TURN that finds it green. An unrelated
  `e2e-main` run on `main` is not a reason to hold it; a red `main` is.
- A banked branch is reported as green on the local tiers (no browser tier runs
  before promotion); a branch whose diff changes a rendered string or a selector
  runs its own affected e2e specs once locally before it is called banked.
- The merge gate checks base movement; its refusal names the `MERGED-TREE-CHECKED`
  receipt that clears it, base-bound as a pass is head-bound: run it and merge in
  one pass. A notes batch moves every open PR's base: `lib/release-notes.json` is
  type-bearing under `/^lib\//`.
- **The exact-head review is INDEPENDENT and pinned to the SHA** (owner
  2026-08-26, #3710): a non-author reviews the candidate commit; the COMMENT
  review states SHA and reviewer — on a shared bot account, also that the
  reviewer did not author the change (#4258). A head change voids it.
- **Run `merge-gate.mjs <pr>` before every merge call** — receipt, green checks,
  no threads, no hold, the mandated pass, this session's own PR (claims.md);
  exit 0 is the precondition. It refuses on any failing COMMIT STATUS, naming it
  — except `merge-gate`, its own answer, recomputed not read back (#5022).
- A later conflicting PR rebases only after the last earlier conflict lands.
- Resume the author for semantic conflict resolution; do not hand-integrate
  feature code.
- **Check what a merge would CLOSE**: `closing-keywords.mjs <pr>`, exit 3
  (failure modes). Blind to your squash text: scan it; `Refs` a PHASED issue.
- **Rewrite the PR body in the same push as a rewrite**: the adversarial
  brief serves it as "the claims to attack", so a stale body aims at deleted code.
- Verify linked issues closed, then clean the worktree and local branch.
