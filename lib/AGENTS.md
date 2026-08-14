# Library instructions

These instructions apply to business logic and data access under `lib/`.

## Profile ownership

- Single-profile business functions take `profileId` as their first argument.
- Every SQL statement touching a profile-owned table filters by `profile_id`;
  child tables scope through a join to their parent.
- Cross-profile readers take already-authorized `ids: number[]` first and do not
  import `lib/auth`. Use `profileIdsIn(ids)` in a registered cross-profile SQL
  module.
- Add new profile-owned tables to `lib/owned-tables.ts`.

## Shared models

- New dated readings reuse `symptom_logs`, `metric_samples`, `body_metrics`, or
  `medical_records`. Use the observation substrate for ingest and latest reads.
- Treat readings as quantities, not tables. Use `Reading`, `placeReading()`, and
  the shared reading write path.
- Use the cadence ledger for weekly frequency questions and `lib/cadence.ts` for
  its vocabulary.
- Use shared freshness, dormancy, day-grid, trend-window, and history helpers.
  Do not rederive their decisions in callers.
- Use `lib/date.ts`, `lib/clock.ts`, `lib/source-time.ts`, and
  `lib/row-instants.ts` for temporal writes, ingest, and reads.
- Use branded `Kg` and `Km` values at canonical storage write boundaries. Mint
  them only through `toKg` and `toKm`; do not cast.

## Settings and integrations

- Respect the three setting scopes: server-wide `settings`, person/device
  `login_settings`, and data-subject `profile_settings`.
- Missing integration credentials must degrade gracefully.
- AI events include login/profile context when available and go through the
  established logging path.

- Read the relevant domain document in `docs/internals/` before changing a
  shared model. The reading, time, cadence, freshness, notification, integration,
  food, and supplement documents are the detailed design context.
