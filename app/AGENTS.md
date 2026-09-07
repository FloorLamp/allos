# App Router instructions

These instructions apply to request boundaries under `app/`.

## Authentication and scope

- Node request code must call `requireSession()`, `requireAdmin()`, or the
  appropriate write-access gate. Middleware only checks for cookie presence.
- Keep session-free paths centralized in `lib/public-paths.ts`.
- Resolve the active profile at the auth boundary and pass `profileId` into
  single-profile business functions as their first argument.
- Cross-profile pages call `requireScope()` once and pass the resulting
  `ProfileScope` down as data. It does not replace write authorization.

## Actions and routes

- Server Actions own request validation, authorization, unit conversion, writes,
  and cache revalidation.
- Validate authorization again at the write boundary; never trust a profile ID,
  row ID, or scope supplied by the client.
- Route handlers must use the shared response, time, storage, and integration
  helpers for their domain.
- Settings navigation comes from `lib/settings-groups.ts`. `adminOnly` controls
  navigation visibility, not authorization.
- Keep API and Server Action behavior compatible with deployment skew where the
  relevant internal design document requires it.

- For write/revalidation changes, read `docs/internals/server-action-refresh.md`.
  For imports, use `import-actions.md`; for client/server compatibility across
  deployments, `deploy-skew.md`; for deletion/undo, `undo-contract.md`.
  These documents live in `docs/internals/`.
