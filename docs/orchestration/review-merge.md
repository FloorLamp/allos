# Review and merge

## Review

- Read the full diff and the issue's complete comment thread.
- Verify repository claims with searches and focused reads. Exercise the write
  path when the diff cannot demonstrate the behavior.
- Relay evidence exactly and make only conclusions you independently derived.
- Check profile scoping, write transactions, authorization boundaries, identity
  handling, and shared one-question-one-computation models.
- Require tests at the tier that can observe the defect.
- Convergence is production-NEGATIVE or it is a third way (owner 2026-08-27).
- Reject any scanner, registry, allowlist, variant, or compatibility layer.
- Prefer TYPES over guards (owner 2026-08-31): an invariant a type can make
  unrepresentable goes back when policed at runtime — simplify, extract,
  unify, and ask what the real goal costs in less code.
- Weigh line cost; compact proofs before doubting coverage that found a defect.
- Check the ruling's OWN condition, not the one the implementation makes easy:
  verifying values where they change ≠ rendering the case the ruling names.
- A guard's existence is not its coverage. Ask which widths, states and
  roles it runs at, and say which in the review.
- A REMOVAL is checked against the issue's acceptance criteria: an unreachable
  export can be debris or an unfinished requirement, and only the issue can
  say which. Delete when the issue doesn't ask; wire up when it does.
- Inspect cross-PR conflicts, stale shared signatures, binary-looking diffs,
  measured-count claims, and unintended generated-data changes.
- Flag owner-visible judgment calls in the COMMENT review.

## Adversarial lane

- Run `adversarial-review-brief.mjs <pr> --check` for every PR. Exit 0
  dispatches
  the lane, 3 is CONSULT and you decide, 1 is ordinary, 2 could not read the PR.
- Never treat 2 or 3 as a no.
- MANDATORY is read from the DIFF (#4842): a high-stakes path, a moved
  authorization gate, a dropped `profile_id` predicate. Those need a separate
  agent to execute falsifying attacks; prose alone only ever reaches CONSULT.
- On CONSULT, read the file and hunk it quotes, not the matched terms; dispatch
  when it moves what a shared surface shows about another profile.
- The merge waits for that report. Fix each refuted claim or record a reasoned
  override in the thread.
- A blocking finding fixed by changing the MECHANISM, not the value, earns a
  fresh pass. The test: does the fix create a surface the last pass could not
  have attacked? A new store, key, lifetime, or owning row is yes; a corrected
  constant or bound is no.
- After two blocking rounds against one mechanism, stop patching examples.
  Re-open the premise around a shared substrate, restrictive invariant, or
  direct behavior evidence; record why the replacement closes the defect class.

## What a lens looks for, and how verification lies

`docs/internals/verification-failure-modes.md` carries both, each with the
instance that bought it. Read it before writing a guard or dispatching a lens.

## Migrations

- Applied migrations are keyed by name; numbered migrations 001–185 are closed.
- Add `YYYYMMDD-slug.ts`, export `{ name, up }`, append it last, then run
  `npm run gen:migration-manifest` for its hash. Never edit a shipped migration.
- Merge order defines migration order. An APPEND-ONLY file (`versions/index.ts`,
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
- Merges are serial; PRs are not. Every branch that passed its gates opens
  READY at once (never draft — environment.md §GitHub access), so CI and the
  exact-head review run in parallel. After a merge, the next green head merges
  without a re-run when `landing-independence.mjs <pr>` exits 0; else rebase.
- **The exact-head review is INDEPENDENT and pinned to the SHA** (owner
  2026-08-26, #3710): a non-author reviews the candidate commit; the COMMENT
  review states SHA and reviewer — on a shared bot account, also that the
  reviewer did not author the change (#4258). A head change voids it.
- **Run `scripts/orchestration/merge-gate.mjs <pr>` before every merge
  call** — receipt on current head, checks green, no unresolved threads;
  exit 0 is the precondition. CI mirrors it as the `merge-gate` COMMIT
  STATUS, which check-runs does not list: all-green can still be `unstable`.
- A later conflicting PR rebases only after the last earlier conflict lands.
- Resume the author for semantic conflict resolution; do not hand-integrate
  feature code.
- **Check what a merge would CLOSE**: `closing-keywords.mjs <pr>`, exit 3
  (failure modes). Blind to your squash text: scan it; `Refs` a PHASED issue.
- **Require the PR body rewritten in the same push as a rewrite.**
  `adversarial-review-brief.mjs` serves it as "the claims to attack", so a stale
  body aims the next lens at deleted code (failure modes).
- Verify linked issues closed, then clean the worktree and local branch.

- Merge queue: the checked-in ruleset is inactive under a personal account;
  keep manual serialization until organization transfer, then validate it.
