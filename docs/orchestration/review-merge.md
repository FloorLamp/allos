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

- **A guard over a boundary should DERIVE its numbers from the boundary.** A
  spec that hard-codes 639 and 768 stays green after the boundary moves — green
  about the wrong number, which is worse than red. #3538's card-mode spec
  computes its widths from `CARD_MODE_BREAKPOINT_PX`, so moving the constant
  moves the spec. The same shape applies to any guard whose subject is a named
  constant: read the constant, do not restate it. This is also what makes a
  boundary worth naming — a number with one home can be inherited; a number
  spelled out in fourteen consumers can only be re-agreed.

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
- **COMMIT THE REAL EDIT BEFORE MUTATING IT.** The `git checkout --` trap is
  sharper when the mutation and the work live in the SAME FILE: restoring the
  mutation and destroying the edit are then the same command, and the run that
  just went red is exactly what makes you reach for it. Seven sightings this
  session; the last one took out a just-verified fix, and the mutations before it
  in the same run were safe only because that work happened to be committed
  already.
- Never read an exit code through a pipe. `cmd | tail` exits with tail's status.
- **A number is a grep until it has been spot-checked.** This holds for numbers
  you relay as much as numbers you produce, and the relay is the unguarded half.
  **An issue body's own counts are the least-checked numbers in the pipeline**,
  because they arrive already written and read as findings rather than as
  measurements. Twice in one session a lane re-derived one and it was wrong:
  a "31 references" count whose 31st was a ZIP code in `lib/zip-centroids.json`,
  and #3457's "5 more applying `table-cards` directly", which is 0 — the utility
  is applied in exactly one place, and the five counted were companion utilities
  riding on it. Both would have sized the work wrongly. Instruct every lane to
  re-derive the counts its issue states, and to report the derivation.
- **The dangerous check is the one that fails toward a plausible correction of
  work that was already right.** A check saying "you did not do the thing" gets
  acted on; a check saying "you did something impossible" gets investigated. Four
  times in one session a grep over a just-edited file reported an edit missing,
  because the window was reading the author's own comment EXPLAINING the edit and
  quoting what it removed. The defence is not skepticism about the number—it is
  asking what the check was matching on, and opening the file.
- **A comment can generate a real rule.** Tailwind's content scanner reads source
  as text, so a class name in an English sentence compiles to CSS: `.min-h-9`
  shipped because a comment mentioned it (#3523), and deleting the sentence
  deleted the rule. The asymmetry is usable—the scanner can only ADD from prose,
  never remove—so a claim over the compiled sheet should REQUIRE the rules it
  expects rather than FORBID rules it does not. The presence form is immune to
  this; the absence form is not.

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
- **Check what a merge would CLOSE, with the full keyword set.** GitHub honours
  ten: close, closes, closed, fix, fixes, fixed, resolve, resolves, resolved —
  in the PR body AND in every commit message. Typed from memory the natural
  three are `fixes|closes|resolves`, and that set silently misses the rest.
  `node scripts/orchestration/closing-keywords.mjs <pr>` reads all of them from
  both places; exit 3 means something closes. It exists because the three-keyword
  version reported "nothing closes" on a PR whose body said `closed #3486`, and
  #3486 — explicitly unfinished, with three open parts — was closed by the merge
  one minute before the owner commented listing what was still open on it. The
  failure direction is why it earned a file: a missed keyword reads as safe.
- Verify linked issues closed, then clean the worktree and local branch.

## Merge queue

- The checked-in merge-queue ruleset is inactive while the repository is under
  a personal account.
- Until organization transfer, keep the manual serialization and exact-head
  checks above.
- After transfer, apply the ruleset and validate the speculative merge commit
  before retiring manual serialization.
