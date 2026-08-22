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

## What a lens looks for

Five recurring shapes. Each was found the expensive way; each has since caught a
second instance. Aim a lens at the shapes the diff's own construction invites,
not at all five by rote.

- **Can the guard see?** Mutation only. A guard that has never been shown a
  violation is a guard whose reach is unmeasured. Two self-checks defend
  different failures and neither implies the other: a corpus count (the scan
  found N real candidates) proves it reaches the tree; a synthetic offender
  (a hand-written violation comes back flagged) proves the matcher recognizes an
  offence. A scan with only the first can hold a matcher that stopped matching;
  with only the second, it can be pointed at a directory that no longer exists.
- **Blast radius.** Measure the CONSUMERS, not the changed unit, and enumerate
  them in both trees. A shared primitive's edit reaches every mount site; a PR
  that names three of ten has checked three.
- **Premise audit.** Every declarative claim in a comment, a doc, or a PR body
  is a testable assertion. Probe a guard from the branch it does NOT cover, and
  mutate every exemption BOTH ways—an exemption asserted without the premise
  that licenses it outlives its reason silently.
- **Does the declaration reach the screen?** A computed-style assertion measures
  a DECLARATION; the user sees a RENDERED result. #3466 shipped a stepped 16px
  seam whose rendered gap stayed 24px—it collapsed against an unstepped parent
  two files away, and the guard read 16 on that exact element. Measure geometry.
- **Which direction does the assertion point?** An ABSENCE assertion over text
  or DOM FAILS OPEN; a PRESENCE assertion over the same text fails LOUDLY.
  #3494's guard forbade a class on two elements and both were restorable with
  the suite green, because `hasClass(x, "card") === false` is satisfied by any
  text the scan cannot resolve—a bare identifier included. The contrast was
  proved in one file: the presence assertion beside it died naming the identifier
  it could not read. `lib/__tests__/mobile-density-convention.test.ts` carries
  the fail-closed pattern (resolve, or throw). Tracked as #3509.

  The qualifier, because "presence is safe" is not the rule: an assertion is
  only as tight as its MATCHER. A substring match is a presence assertion that
  cannot see corruption which appends to what it looks for. #3501 composed a
  row name onto a menu that already carried one—the accessible name became
  `Actions for Actions for entry from 12 Aug`—and two e2e specs asserting that
  name stayed green, because Playwright matches accessible names by substring
  and the old string survives intact inside the doubled one. Exact match, or a
  full-string comparison, is what makes presence fail loudly.

## Verification hygiene

These are not review taste; each retired a green that meant nothing.

- **Run the control AFTER the restore.** Green -> red -> green. A control taken
  before the mutation proves nothing about the restore, and it is the one
  discipline that catches every spelling below.
- Six ways a harness has lied, all silently, all toward false confidence: a
  `String.replace` string pattern hitting only the first occurrence; an invalid
  vitest reporter flag reporting success with no test run; a `diff | grep` that
  read one side without its pair; a mutant that died of an unrelated re-arm
  rather than the clause under test; a restore point that was the git INDEX
  rather than HEAD; and a symlinked `node_modules` making every mutant "die" on
  a build failure.
- Mutate only against a COMMITTED, `git status`-verified-clean tree. Assert the
  substitution count is exactly what you intended—a zero-substitution mutant is
  a false survivor, not a passing test.
- Never read an exit code through a pipe. `cmd | tail` exits with tail's status.
- **A number is a grep until it has been spot-checked.** This holds for numbers
  you relay as much as numbers you produce, and the relay is the unguarded half.

## Migrations

- Applied migrations are keyed by name; numbered migrations 001–185 are closed.
- Add `YYYYMMDD-slug.ts`, export `{ name, up }`, append it last, and add its hash
  to `manifest.json`. Never edit a shipped migration.
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
- Verify linked issues closed, then clean the worktree and local branch.

## Merge queue

- The checked-in merge-queue ruleset is inactive while the repository is under
  a personal account.
- Until organization transfer, keep the manual serialization and exact-head
  checks above.
- After transfer, apply the ruleset and validate the speculative merge commit
  before retiring manual serialization.
