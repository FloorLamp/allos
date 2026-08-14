# Query instructions

- Query modules do not own request authentication. They receive authorized
  profile IDs from their caller.
- Single-profile readers take `profileId` first. Cross-profile readers take
  authorized `ids: number[]` first and use `profileIdsIn(ids)`.
- Every query touching profile-owned data scopes it by `profile_id`, directly or
  through the owning parent.
- A hot read declares SQL with `hoistedStatement()` so the compiled statement is
  reused. Hot means per-profile fan-out, per-row/day/item loops, or a broadly
  shared helper.
- Use request-scoped `cache()` only for repeated identical arguments when no
  writer can intervene, and document that reason beside it.
- Hoisting caches statements, never returned values; preserve read-after-write
  behavior.
