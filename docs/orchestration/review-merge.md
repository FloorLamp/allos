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
- Check the ruling's OWN condition, not the one the implementation makes easy:
  verifying values where they change ≠ rendering the case the ruling names.
- A guard's existence is not its coverage. Ask which widths, states and
  roles it runs at, and say which in the review.
- A REMOVAL is checked against the issue's acceptance criteria: unreachable
  code is debris or an unfinished requirement, and only the issue says which.
- Inspect cross-PR conflicts, stale shared signatures, binary-looking diffs,
  measured-count claims, and unintended generated-data changes.
- Flag owner-visible judgment calls in the COMMENT review.

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
- Two falsifying passes per PR. A THIRD falsification means SIMPLIFY the
  guards, the code, or both — never a third round (owner 2026-09-05; #5203
  took seven). Pass-three prose mismatches are follow-ups unless they leak.
- A PR the owner opens gets a plain non-author review and the standard gates;
  a blocker is fixed as a new commit on the owner's branch, stated on the
  PR — never rebase, amend or force-push it (owner 2026-09-04).

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
  exact-head review run in parallel. `landing-independence.mjs` is path-only
  advice (#5138); the gate refuses an unchecked base-moved head (#5235).
- Its refusal names the `MERGED-TREE-CHECKED` receipt that clears it. A
  release-notes batch landing on `main` forces no re-run of a PR that never
  touches `lib/release-notes.json`: display data read by one page.
- **The exact-head review is INDEPENDENT and pinned to the SHA** (owner
  2026-08-26, #3710): a non-author reviews the candidate commit; the COMMENT
  review states SHA and reviewer — on a shared bot account, also that the
  reviewer did not author the change (#4258). A head change voids it.
- **Run `merge-gate.mjs <pr>` before every merge call** — receipt, green checks,
  no threads, no hold, the mandated pass, this session's own PR (claims.md);
  exit 0 is the precondition. CI mirrors it as the `merge-gate` COMMIT STATUS,
  which check-runs does not list: all-green can still be `unstable`.
- A later conflicting PR rebases only after the last earlier conflict lands.
- Resume the author for semantic conflict resolution; do not hand-integrate
  feature code.
- **Check what a merge would CLOSE**: `closing-keywords.mjs <pr>`, exit 3
  (failure modes). Blind to your squash text: scan it; `Refs` a PHASED issue.
- **Rewrite the PR body in the same push as a rewrite**: the adversarial
  brief serves it as "the claims to attack", so a stale body aims at deleted code.
- Verify linked issues closed, then clean the worktree and local branch.
