# Review and merge

## Review

- Read the full diff and the issue's complete comment thread.
- Verify repository claims with searches and focused reads. Exercise the write
  path when the diff cannot demonstrate the behavior.
- Relay evidence exactly and make only conclusions you independently derived.
- Check profile scoping, write transactions, authorization boundaries, identity
  handling, and shared one-question-one-computation models.
- Require tests at the tier that can observe the defect.
- Convergence is production-NEGATIVE or it is a third way of doing the thing.
- Reject any scanner, registry, allowlist, variant, or compatibility layer.
- Weigh line cost; compact proofs before doubting coverage that found a defect.
- Check the ruling's OWN condition, not the one the implementation makes
  easy. Verifying values where they change is a different question from
  rendering the case the ruling names.
- A guard's existence is not its coverage. Ask which widths, states and
  roles it runs at, and say which in the review.
- Receipts for both: incidents, "The review that checked the arithmetic".
- A REMOVAL is checked against the issue's acceptance criteria before it is
  accepted. An unreachable export can be debris or an unfinished requirement,
  and the code cannot tell you which — only the issue can. Delete it once the
  issue does not ask for it; wire it up when the issue does.
- Inspect cross-PR conflicts, stale shared signatures, binary-looking diffs,
  measured-count claims, and unintended generated-data changes.
- Flag owner-visible judgment calls in the COMMENT review.

## Adversarial lane

- Run `adversarial-review-brief.mjs <pr> --check` for every PR. Exit 0
  dispatches
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
- After two blocking rounds against one mechanism, stop patching examples.
  Re-open the premise around a shared substrate, restrictive invariant, or
  direct behavior evidence; record why the replacement closes the defect class.
- #3011 is the worked example: three passes, and passes 2 and 3 each found a
  real defect in what the previous fix had just built (_incidents_).

## What a lens looks for, and how verification lies

`docs/internals/verification-failure-modes.md` carries both, each with the
instance that bought it. Read it before writing a guard or dispatching a lens.

## Migrations

- Applied migrations are keyed by name; numbered migrations 001–185 are closed.
- Add `YYYYMMDD-slug.ts`, export `{ name, up }`, append it last, then run
  `npm run gen:migration-manifest` for its hash. Never edit a shipped migration.
- Merge order defines migration order. Resolve `versions/index.ts` conflicts by
  keeping both entries and appending the later merge last; re-run the generator
  for `manifest.json` conflicts rather than hand-resolving hash lines.
- Recreate development databases containing abandoned, unknown migration names.

## Merge

- Squash merge only a green EXACT HEAD, through the transport this host
  grants (MCP, else REST `PUT /pulls/N/merge` squash) — the invariants here
  are transport-independent. Re-read `head.sha` in the same breath as the
  merge call: GitHub merges the head it finds, not the one you read.
- Serialize merges. After each merge, recheck every open PR's mergeability and
  refresh or reconcile affected branches.
- One landing candidate gets final rebase, PR opened or refreshed READY
  (never draft — environment.md §GitHub access), remote exact-head
  COMMENT/adversarial review, and full CI, in order. Local pre-review does not
  replace it; bank later branches until the candidate lands.
- **The exact-head review is INDEPENDENT and pinned to the SHA** (owner
  2026-08-26, #3710): a non-author reviews the exact candidate commit; the
  COMMENT review states the reviewed SHA and reviewer — the receipt. Any head
  change voids it; merge needs that SHA green with zero unresolved findings.
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

- The checked-in ruleset is inactive under a personal account. Keep the
  manual serialization and exact-head checks until organization transfer;
  then apply it, validating the speculative merge commit first.
