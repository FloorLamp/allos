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

  **The synthetic offender must be PLANTED IN THE SCANNED CORPUS, not handed to
  the matcher.** #3539's guard passed its offender list as string literals
  straight to the regex, so the corpus walker was never exercised by it at all —
  and the walker was where the holes were: it skipped every file under
  `lib/migrations/`, and the matcher was literal-only while this tree's
  prevailing idiom is `DELETE FROM ${table}` (16 such sites outside the test
  tiers). Both self-checks appeared present. Neither reached the defect. Plant
  the offender as a real file, run the real scan, and delete it after.

- **Blast radius.** Measure the CONSUMERS, not the changed unit, and enumerate
  them in both trees. A shared primitive's edit reaches every mount site; a PR
  that names three of ten has checked three.
- **The boot-id answers "did my process die", never "is this the tree I left".**
  A rollback restores an old working copy while the remote keeps every pushed
  commit — so it can present as boot-id UNCHANGED with a session restart, which
  reads as the reassuring case. On 2026-08-22 that misdiagnosis stood until
  `git log` was read by hand and not recognised. The signature is
  LOCAL BEHIND REMOTE, and it must be tested with `git ls-remote`, not the
  remote-tracking ref: a rollback rewinds `.git/` too, so `origin/<branch>` is
  rolled back alongside everything else and comparing against it reports that the
  tree agrees with itself. `scripts/orchestrator-checkin.sh` now asks this.

- **Copy that explains a mechanism can be falsified by the action it explains.**
  #3537 put _"Any warnings on this med follow its name — a new name can change
  them"_ above a button whose entire effect is to write an authoritative
  `rxcui` — taking the row from name-fallback to code-first, and making the
  sentence false for that row the moment it is pressed. It was accidentally true
  beforehand only because imported rows land with a NULL code. When a diff adds
  explanatory copy at a control, ask what the control DOES to the thing the copy
  asserts, and check the copy again on the after state.

  Its sibling, and the reason the claim survived review: **"keys on X and Y" is
  not a symmetric statement.** Five of that tree's ten warning surfaces match
  "on name plus rxcui" — with the code tested FIRST and `continue`d, so the name
  is the FALLBACK. The PR body's supporting sentence was literally true and
  meant the opposite of what it was offered for. Read the order, not the list.

- **A fixture carrying ONE item cannot see a defect that needs two.** When a
  mechanism operates on a SET, a test with a single member proves nothing about
  how members interact. #3438's round-7 guard pushed one day-bucket and passed
  through ten rounds; the real rolling window carries the previous day's bucket
  too, and THAT one — carrying the same push stamp and overlapping by the zone
  offset — destroyed a stored reading whose own replacement a veto had refused.
  The predicate honoured the veto for the vetoed row and not for the row it was
  replacing, which is the same sentence as: **a per-item veto does not compose
  into a per-set veto.** When a diff vetoes, suppresses or excludes an item, ask
  what the REST of the batch can still justify on its own.

- **Two individually-correct changes can combine into a regression, and a
  change-by-change review cannot see it.** #3550 cut an over-long intro (the
  issue asked for exactly that) and hid a column heading for a column that no
  longer existed (true, and commented as such). Together they removed every
  visible cue from a destructive bulk control: at phone width four sweep boxes
  ended up at the same left edge, size, font and colour as the ordinary routing
  chips below them, and one tap turned off twelve message kinds with no label,
  no confirm and no undo. Each half was right. Review the RESULTING SURFACE, not
  the diff — and when a change removes explanatory copy, ask what else on that
  screen was carrying the explanation.

- **A guard that lists a union's members does not track the union.** In
  TypeScript, `const inks: CellInk[] = ["live", "ghost", "off"]` accepts a
  SUBSET, so widening `CellInk` leaves the array, the guard and `typecheck` all
  green — while the comment above it claimed a new member could not be added to
  one function and forgotten in another. That is precisely what a fourth member
  did, on a file in the mandatory tier. Make a new member a TYPE ERROR:
  `as const satisfies readonly T[]` with an exhaustiveness assertion, or drive
  the cases from a `Record<T, …>`. Then add a member locally and watch it fail,
  because the annotation is exactly the thing that reads as proof and is not.

- **Is the invariant pinned against the RIGHT event?** A proof that a change is
  safe "across operation X" is worthless if X is not the only operation that
  touches the state. #3537's fix made a nutrient matcher read
  `source_name ?? name`, and the proof was exact: the whole reading — keys,
  amounts, compound, UL, RDA — is byte-identical before and after ADOPTION.
  True, and the wrong event. `updateIntakeItem` writes `name` and never writes
  `source_name`, so an adopted row's evidence froze at the document label and
  every later rename went unseen: a firing upper-limit warning went silent at
  12.5x the limit, and a calcium warning fired naming `Lisinopril 10 mg`, which
  contains none. Enumerate every writer of BOTH fields before accepting an
  equality argument, and ask which other events can move either side.

  The sibling shape: **a field written once and never overwritten becomes a
  stale CLAIM the moment anything else moves.** `source_name`'s `COALESCE` was
  presented as a virtue — "the document's label is recorded once and never
  overwritten" — and it is, as a record of what the document said. It stops
  being true as a description of the row.

- **What KEYS on the field you are rewriting?** A stored string is rarely only
  display. #3537 standardised imported medication names — an offer the person
  accepts — and silenced three FIRING upper-limit warnings: vitamin D at 250
  against a UL of 100, niacin 1000 against 35, iron 325 against 45. `lib/dri.ts`
  matches nutrients by NAME SUBSTRING and has no code path at all, so replacing
  `"VITAMIN D3"` with `"Cholecalciferol"` removed the only signal it could use.
  The cruel part is that the same write attaches an `rxcui` — the PR's own
  comment said "a name somebody standardized is exactly the moment the safety
  matchers can start keying on a code instead of a string", which was true of the
  interaction engine that reads codes and false of the limit engine that does
  not. Two passes missed it because both asked "can this write reach the wrong
  row" and neither asked "who else reads this column". Before a diff rewrites a
  stored value, enumerate every matcher, join and filter that keys on it — and
  check the ones that key on it WEAKLY (a substring, a LIKE, a name) first,
  because those fail silently and leave no error to find.
- **Premise audit.** Every declarative claim in a comment, a doc, or a PR body
  is a testable assertion. Probe a guard from the branch it does NOT cover, and
  mutate every exemption BOTH ways—an exemption asserted without the premise
  that licenses it outlives its reason silently.
- **A constraint documented on one branch is not a constraint on the
  predicate.** #3537's name predicate had two branches: two shouted words, or
  one shouted word carrying most of the letters. Its comment said the two-word
  floor "is the reason the predicate does not need an allow-list of acronyms."
  It was not: a bare acronym is the WHOLE name, so its share is 1.0 and the
  second branch admits it regardless of the floor. 17 of 19 ordinary supplement
  names fired (`NAC`, `MSM`, `DHEA`, `BCAA`, `5-HTP`…) while every Tall Man
  rendering — `amLODIPine Besylate 5 MG tablet`, standard Epic/Cerner output and
  the exact register the feature targeted — stayed quiet. Read every threshold
  justification against ALL branches, and test a predicate on the names it will
  actually meet rather than on the ones its author had in hand.
- **Does the declaration reach the screen?** A computed-style assertion measures
  a DECLARATION; the user sees a RENDERED result. #3466 shipped a stepped 16px
  seam whose rendered gap stayed 24px—it collapsed against an unstepped parent
  two files away, and the guard read 16 on that exact element. Measure geometry.
- **Does the attack REACH the clause it is named for?** When several predicates
  guard one write, the FIRST one to reject an attack row absorbs it, and every
  later clause is unobserved no matter what the test is called. #3537's write
  was scoped by profile, document, source and kind; `profile_id` and
  `kind` were both removable with the guard file 12/12 green, because the test
  named "cannot rename another profile's medication" passed a row in a DIFFERENT
  DOCUMENT and `document_id` rejected it first. The tell is the naming: a test
  named for a clause it never reaches reads as coverage in every review. An
  attack row must be identical on every predicate but the one under test — and
  the only way to know it is is to mutate that clause alone and watch the test
  go red. Two of the four halves there DID go red, which is what made the other
  two invisible: the file was not weak, it was uneven.

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
- **When a brief relays TWO rulings, the later one's deletions apply to what you
  quote from the earlier.** Restating an old instruction inside a brief for a new
  ruling silently resurrects it, and the lane cannot tell a deliberate carry-over
  from an oversight. On #3438 round 10 I handed a lane two items marked "take
  these as given" — a `pushed_at IS ?` guard and a plan-validity argument — both
  quoted from a ruling the NEXT ruling had explicitly deleted ("no longer needed
  and should go; the lock is the guard"). The lane noticed and followed the later
  one, on a PR whose entire problem was accumulated dead clauses. Before quoting
  an earlier ruling, diff it against the later one and say which survives.

- **YOUR proposed fix is a hypothesis, not a specification.** A lane implements
  an orchestrator's suggestion faithfully and without the scepticism it applies
  to its own ideas — so a fix named in a review comment arrives with LESS
  scrutiny than one the lane invented, not more. I proposed the one-line
  `COALESCE(source_name, name)` that produced the defect above, and the lane
  built exactly it, correctly, with a mutation-pinned guard. Put a proposed fix
  in front of the same lens as everything else, and say in the brief that it is
  a starting point to be attacked rather than an instruction.

- **"We do strictly less of X" is only safe when X has one consequence.** I
  scoped a P1 fix on the argument that narrowing a destructive sweep "strictly
  reduces what is deleted, so it cannot lose a row today's code preserves,
  therefore it is correct under any later ruling." The premise was true and the
  conclusion was false: the sweep's deletions were what PREVENTED a different
  bug (#608's duplicate rows), so narrowing it traded data loss for data
  duplication — 295 of 552 ordered zone pairs regressed, against 0 before.
  Before reducing a destructive operation, ask what the destruction was load-
  bearing FOR. A monotone-safety argument reads as airtight precisely because
  it only looks at one axis.

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
- **A stale PR body aims the next lens at deleted code.**
  `adversarial-review-brief.mjs` serves the PR body verbatim as "the claims to
  attack", so a body describing a construction a later round removed sends the
  reviewer hunting constructs that no longer exist. #3438 reached round 10 with
  round 9's body naming four deleted symbols. Require the body rewritten in the
  same push as the rewrite, not after review.
- Verify linked issues closed, then clean the worktree and local branch.

## Merge queue

- The checked-in merge-queue ruleset is inactive while the repository is under
  a personal account.
- Until organization transfer, keep the manual serialization and exact-head
  checks above.
- After transfer, apply the ruleset and validate the speculative merge commit
  before retiring manual serialization.
