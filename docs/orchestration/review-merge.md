# Review and merge

## Review

- Read the full diff and the issue's complete comment thread.
- Verify repository claims with searches and focused reads. Exercise the write
  path when the diff cannot demonstrate the behavior.
- Relay evidence exactly and make only conclusions you independently derived.
- Check profile scoping, write transactions, authorization boundaries, identity
  handling, and shared one-question-one-computation models.
- Require tests at the tier that can observe the defect.
- A REMOVAL is checked against the issue's acceptance criteria before it is
  accepted. An unreachable export can be debris or an unfinished requirement,
  and the code cannot tell you which — only the issue can. Delete it once the
  issue does not ask for it; wire it up when the issue does.
- Inspect cross-PR conflicts, stale shared signatures, binary-looking diffs,
  measured-count claims, and unintended generated-data changes.
- Flag owner-visible judgment calls in the COMMENT review.

## Adversarial lane

- Run `adversarial-review-brief.mjs <pr> --check` for every PR. Exit 0 dispatches
  the lane, 3 is CONSULT and you decide, 1 is ordinary, 2 could not read the PR.
- Never treat 2 or 3 as a no.
- High-stakes paths—data integrity, auth boundaries, and safety signals—require
  a separate agent to execute falsifying attacks.
- On CONSULT, read the quoted claims it prints, not the matched terms. Dispatch
  when a claim is the safety-relevant value or gate; otherwise say so in the
  thread.
- The merge waits for that report. Fix each refuted claim or record a reasoned
  override in the thread.
- A blocking finding fixed by changing the MECHANISM, not the value, earns a
  fresh pass. The test: does the fix create a surface the last pass could not
  have attacked? A new store, key, lifetime, or owning row is yes; a corrected
  constant or bound is no.
- #3011 is the worked example: three passes, and passes 2 and 3 each found a real
  defect in what the previous fix had just built—a memory that expired with the
  runs, then a memory attached to a row that was not a document.

## What a lens looks for, and how verification lies

`docs/internals/verification-failure-modes.md` carries both, each with the
instance that bought it. Read it before writing a guard or dispatching a lens.

## Migrations

- Applied migrations are keyed by name; numbered migrations 001–185 are closed.
- Add `YYYYMMDD-slug.ts`, export `{ name, up }`, append it last, and add its hash
  to `manifest.json` via `npm run gen:migration-manifest`. Never edit a shipped
  migration, and never type a hash in by hand.
- The generator refuses to rehash or drop a migration that is on main, and exits
  non-zero in `--check` too. `--allow-rehash` records shipped bytes restored, or
  a migration reverted off main; anything else needs a new migration.
- Merge order defines migration order. Resolve `versions/index.ts` conflicts by
  keeping both entries and appending the later merge last.
- Recreate development databases containing abandoned, unknown migration names.

## Merge

- Squash merge through MCP only after CI is green on the exact head. Re-read
  `head.sha` in the same breath as the merge call: a lane can push between the
  check and the merge, and GitHub merges the head it finds, not the one you read.
- Serialize merges. After each merge, recheck every open PR's mergeability and
  refresh or reconcile affected branches.
- A later conflicting PR rebases only after the last earlier conflict lands.
- Resume the author for semantic conflict resolution; do not hand-integrate
  feature code.
- **Check what a merge would CLOSE, with the full keyword set.** Run
  `node scripts/orchestration/closing-keywords.mjs <pr>`; exit 3 means something
  closes. It reads all ten keywords from the body AND every commit — the natural
  three miss the rest, and a missed keyword reads as safe (failure modes).
- **Require the PR body rewritten in the same push as a rewrite.**
  `adversarial-review-brief.mjs` serves it as "the claims to attack", so a stale
  body aims the next lens at deleted code (failure modes).
- Verify linked issues closed, then clean the worktree and local branch.

## Merge queue

- The checked-in merge-queue ruleset is inactive while the repository is under
  a personal account.
- Until organization transfer, keep the manual serialization and exact-head
  checks above.
- After transfer, apply the ruleset and validate the speculative merge commit
  before retiring manual serialization.
