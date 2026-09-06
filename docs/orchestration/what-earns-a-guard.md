# What earns a guard, a scan, or a spec

Standing owner direction, 2026-09-06: reduce guards, scans, and low-value or
flaky e2e specs. Every rule below serves that.

## The bar

- **Subtraction beats addition.** Where a finding could be answered by a new
  guard or by removing what made the defect expressible, take the removal. A
  lane that ends with one fewer scan and the same coverage has done the work.
- **A source-text scan is the LAST resort**: a type that makes the fact
  unstateable, then an ESLint rule on the parse ESLint already runs (#5347),
  then a scan. Adding one needs a named defect it would have caught, not a
  class it might.
- **An e2e spec covers a user journey no cheaper tier can.** One asserting a
  formatter, a class name or a pixel is a unit test wearing a browser: move it
  down a tier or delete it.
- **A flaky spec is fixed or deleted, never re-run.** "Flake" names a mechanism
  to remove, not a verdict to record; shard packing, worker state and
  poll-versus-assert races are mechanisms.
- **Deleting a dead guard or spec needs no issue of its own.** The PR states
  what it protected, what protects it now, and how the deletion was measured —
  the same bar as adding one.

## Dev config

- **A TEST OR GUARD ON DEV CONFIG IS STRICTLY FORBIDDEN** (owner, 2026-09-06).
  Nothing asserts on `eslint.config.mjs`, `vitest.config*`, `vitest.timeouts`,
  `tsconfig`, `package.json`, `.nvmrc`, `.github/workflows/**`, the gate
  scripts' trigger and skip sets, or Node flags.
- No exception, no allowlist. A wrong config fails the first time it runs; a
  guard restating it is a second copy that can disagree with it. Existing ones
  are deleted, not converted — that outranks the conversion work in #5346.
- The cost is accepted with open eyes: a wrong CI skip-set or gate-trigger
  entry now fails silently rather than red.

## The two ratchets

- `ci-skip-set` and `db-gate-trigger-set` survive (owner, 2026-09-06): a
  silently growing skip set stops CI running for whole diffs.
- A ratchet is `expect(entries.length).toBeLessThanOrEqual(N)` — one number, no
  allowlist, no per-file registry, no import graph, about 20 lines. A list of
  names is how a ratchet becomes the second copy of a config.
- **N may only be LOWERED**, in the PR that removes the entry. What a ratchet
  no longer catches, stated: a WRONG entry, as opposed to a new one.

## Ranking the queue

- The verification slice ranks by NET LINES (owner, 2026-09-06): subtractive
  first, neutral next, additive last and only for a named defect or a security
  gap. A conversion PR states its own `+/-` and is net ≤ 0, or says why not.
- **A conversion that does not delete has not converted.** #5392 moved fifty
  import scanners onto ESLint at **+306**, adding a 302-line test guarding the
  ESLint config it had just written; #5414 made the export guard a type at
  **+149**, deleting nothing.
