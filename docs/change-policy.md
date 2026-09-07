# Change and test policy

This is the shared policy for coding, dispatch, and review. Keep task-specific
requirements in the task; use the [development guide](development.md) to find
relevant code and checks.

## Scope and code

- Implement the smallest complete change that satisfies the requested behavior.
  Confirm the problem still exists and find the current owner before editing.
- Reuse that owner. Avoid speculative abstractions, configuration, compatibility
  layers, parallel implementations, and unrelated cleanup.
- Prefer types that make invalid internal states unrepresentable. Keep runtime
  validation at external-input and authorization boundaries.
- A conversion removes the implementation it replaces. Design convergence must
  delete more production lines than it adds; ordinary behavior fixes may grow
  in proportion to the behavior they implement.
- New registries, scanners, allowlists, or variants of existing helpers are not
  routine fixes. First try removing the cause or using the existing type/model.
  A source scan is a last resort after types and an existing ESLint rule; it
  needs an explicitly scoped task and a named defect it would catch.
- Comments explain reasoning the code cannot express. Update current docs in
  place when their contract changes; put incident narratives in the PR or git
  history. Do not append a new policy for each bug.
- Once the requested behavior and relevant checks pass, stop. Report unrelated
  findings briefly; do not turn them into implementation or tracker work.

## Tests that earn their cost

- Name the failure a test catches and inspect existing coverage first. Extend an
  existing test where practical; add a file only for a distinct subject or setup.
- Use the cheapest tier that observes the failure. A second tier must cover a
  distinct integration risk, not repeat the same input/output cases.
- Use tables when cases differ only in inputs and expected outputs. Reuse a
  fixture rather than copying setup. Assert meaningful outcomes rather than
  enumerating incidental details.
- CSS-only changes do not automatically require new tests or changed assertions.
  Do not change an expectation just to match the new implementation. If a test
  fails, determine whether the requested behavior or the implementation is wrong.
- Do not test exact source wording, class strings, retired symbols that cannot
  return, or guarantees already proved by types. Browser geometry checks must
  prove usability, such as clipping or usable touch targets.
- Test absence only after reaching the state where the unwanted effect could
  occur. Use a positive control when an inactive harness could otherwise pass.
- For a bug regression, show that the focused test detects the original defect
  when practical. For an explicitly requested scanner, exercise its actual
  discovery path with an offender and a benign case.
- A passing rerun does not fix a flaky test. Diagnose and fix its mechanism, or
  remove it with a stated coverage rationale. Targeted diagnostic repeats are
  appropriate; rerunning until green is not verification.
- Delete obsolete tests when retiring their behavior. Explain what they protected
  and what, if anything, protects the remaining behavior.

## Development configuration

Do not add tests or guards asserting on ESLint/Vitest/TypeScript configuration,
`package.json`, `.nvmrc`, workflow definitions, gate trigger/skip sets, or Node
flags. Run the configuration instead of maintaining a second copy in assertions.

The only existing dev-config exceptions are the `ci-skip-set` and
`db-gate-trigger-set` count ratchets. Their limits may only decrease in the change
that removes an entry. Keep them as counts, with no per-file list or import graph;
they detect growth, not incorrect existing entries. Product-code ratchets are
outside these two exceptions and still need to meet the test-value rules above.

## Review

For each new abstraction or test file, explain the concrete gap existing code or
coverage cannot cover. Report production and test additions/deletions separately;
use the counts to scrutinize growth, not to reward compressed code or lost coverage.
Verification cleanup is subtractive first, neutral next, and additive only for a
named defect or security gap. A conversion that deletes nothing is unfinished.
