# Query instructions

Inherit profile ownership and authorized-ID rules from [library instructions](../AGENTS.md).
Query modules receive authorization from callers; they do not authenticate requests.

- A hot read declares SQL with `hoistedStatement()` so the compiled statement is
  reused. Hot means per-profile fan-out, per-row/day/item loops, or a broadly
  shared helper.
- Use request-scoped `cache()` only for repeated identical arguments when no
  writer can intervene, and document that reason beside it.
- Hoisting caches statements, never returned values; preserve read-after-write
  behavior.
