# Verification failure modes

Use this reference when a change's construction suggests a specific coverage gap.
It is not a checklist to run for every PR. The [change and test policy](../change-policy.md)
owns scope and test value; [review and merge](../orchestration/review-merge.md)
owns review requirements and landing. Keep incident narratives in PRs and git history.

## What a lens looks for

### Can the check observe the defect?

Prefer a type for internal contracts, an existing ESLint rule for syntax, and a
source scan only when neither can express the fact. Follow the shared policy
before adding or converting a guard.

A guard that lists a union's members does not track the union. Both `T[]` and
`as const satisfies readonly T[]` accept a subset. Use a registry keyed on the
actual union, such as `satisfies Record<T, Entry>`, when every member needs an
entry. Probe an omission or union addition locally and confirm the compiler
rejects it; an annotation that looks exhaustive is not evidence by itself.

The #5351 examples are [notification settings](../../lib/notifications/kinds.ts)
and [cadence ownership](../../lib/notifications/cadence-registry.ts). Their mapped
types require a decision for each `NotificationKind` and constrain safety-kind
configuration. Types cover membership and row shape; behavior tests still cover
meaningful facts about values, such as two controls sharing one saved field.
Do not keep a runtime census of facts the type already proves.

Before reconstructing call paths with a scanner, check whether the boundary can
require the value it needs. [StampedFormData](../../lib/logged-via.ts) connects
surface stamping to action parameters, including calls through props or sibling
actions that an import walk can miss. Brands do not replace runtime validation
of external input or authorization.

For an authorized source scan, test discovery and recognition together: plant a
real offender in the scanned corpus and run the actual scan, alongside a benign
case. A matcher fed a string does not exercise its walker; a nonzero candidate
count does not prove recognition. Check relevant syntax and directory boundaries,
including dynamic SQL when that is the subject. Reuse [sql-scan](../../lib/__tests__/sql-scan.ts)
where its extraction scope fits; prepared statements and all SQL literals are
different surfaces. Unreadable input must not become a reassuring empty result.

### Does the fixture reach the failure?

- To test one rejection clause, satisfy the other predicates. A cross-profile row
  in the wrong document can be rejected before profile scoping is exercised.
  When practical, remove only the target clause and confirm the case fails.
- Reach the operation's completion before asserting that an effect is absent.
  Include a positive control showing that the effect can occur in this harness.
  For transient defects, observe the relevant window rather than polling past it.
- Set operations need interacting members. Exercise overlapping batches or windows
  when another member can overwrite, delete, or reintroduce a vetoed item.
- Derive boundary samples from the owning constant and exercise the meaningful
  sides. A copied breakpoint can leave a test checking yesterday's boundary.
- Use exact matching when extra text is the defect. A substring assertion still
  passes when an accessible name is accidentally repeated.

### Does the change preserve its consumers' contracts?

Find affected consumers in both the base and candidate trees. Shared primitives
can reach surfaces whose tests never mention the primitive's name.

Before rewriting a stored value, inspect every writer and the matchers, joins,
filters, and name-keyed state that read it. Read fallback order: code-first
matching is different from name-first matching. Equality across one operation
says nothing about another writer. A captured source label can remain valid
provenance while becoming an incorrect description of the current row.

Check interacting effects. Reducing deletion can preserve a row while allowing
duplicates that the deletion previously prevented. A veto on one batch member
may leave another member free to delete the same stored row.

Review the resulting screen after combined edits. Removing copy and changing a
control can jointly remove the explanation each edit assumed would remain.
Check explanatory copy again after the action it describes has changed state.

For layout, name the measured box and the usability question. Computed styles do
not prove rendered spacing; a border box does not measure content gutters created
by padding. Wait for real content and measure related geometry together. Follow
[E2E assertion guidance](e2e-hygiene.md#assertions-and-css) rather than adding
class or spacing pins for a CSS edit.

## Verification hygiene

Diagnostic mutations are temporary evidence, not a reason to add a permanent
harness or more tests for facts already covered.

1. Establish a passing control and record the candidate commit and working state.
2. Preserve the exact edited files before mutating, or use a disposable checkout
   of a committed candidate. Never restore from HEAD or the index over uncommitted
   work you intend to keep.
3. Check the intended substitution count and diff. A zero-match replacement has
   not tested anything; an unrelated build failure has not detected the defect.
4. Run the focused check and inspect its actual failure, test count, and exit code.
5. Restore the candidate, verify its diff, rebuild affected artifacts when needed,
   and run the control again: green, relevant red, green.

Do not lose the command's exit status in a pipeline such as `cmd | tail`. Preserve
it explicitly or capture output first. Follow [E2E diagnosis](e2e-diagnosis.md)
for stale builds, timing, and shard-dependent failures. A test that changes verdict
with its neighbors needs investigation of shared state; repeated green runs do
not explain it. [Component tests](component-tests.md) have their own setup and
cleanup requirements; jsdom is not proof of browser layout or pseudo-class behavior.

Re-derive material counts and spot-check the matches, including counts supplied
by issues and reviews. Define the measured set before computing its delta. Source
searches can match comments quoting removed code; content scanners can also turn
class names in comments into real CSS. Inspect what the instrument reads.

Follow names cited by comments to their definitions and confirm the execution
path reaches them. Apply later rulings to earlier quoted instructions. A proposed
fix, including one supplied by a reviewer, remains a hypothesis to check against
the required behavior.

After suspected environment rollback, compare local history with the live remote;
a remote-tracking ref may have rolled back too. Process uptime or boot identity
does not establish which source tree is present.

## Vitest passing is not a type verdict

The Vitest tiers transpile TypeScript; passing unit, component, DB, or action tests
does not prove their files typecheck. Run `npm run typecheck`, which runs Next's
type generation and the project TypeScript check. CI's `check` job and
[agent gates](../../scripts/orchestration/agent-gates.sh) run it separately.
Do not duplicate it in each test tier or limit it to changed files: a shared type
can break an unchanged consumer or fixture.

Two branches can each typecheck and fail when combined. Evidence must identify
the tree checked. When base movement affects the candidate, verify the combined
tree using the [merge procedure](../orchestration/review-merge.md#merge); a passing
check on either old branch alone does not establish compatibility.

## Merge-time failure modes

Keep the PR body aligned with the final implementation so review targets code
that still exists. Record commands, outcomes, and the candidate SHA accurately.
A changed head invalidates evidence about the prior head.

Check unintended issue closures with
[closing-keywords.mjs](../../scripts/orchestration/closing-keywords.mjs), which
reads the PR body and commit messages. Also inspect the proposed squash message.
Use references for partial work rather than closing an unfinished umbrella issue.

Review receipts, base movement, and merge authorization belong to the
[merge runbook](../orchestration/review-merge.md#merge). Do not maintain a second
copy of the receipt grammar here; a syntactically accepted receipt is evidence of
what was reported, not proof that the commands cover the change.
