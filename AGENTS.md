# AGENTS.md

Hi, this is a project for regular people to track health. Health is complex,
this app shouldn't be.

Keep things simple. Write concisely. No "editorial-policy language" to users.

## Project

Allos is a multi-user, login-gated health tracking and coaching app built with
Next.js 16 App Router, Server Actions, and synchronous `better-sqlite3`.

Node 24 is required and pinned in `.nvmrc`.

## Commands

```bash
npm run dev
npm run build
npm run lint
npm run typecheck
npm test
npm run test:db
npm run test:e2e
npm run format:check
```

Run the narrowest relevant checks while developing, then expand verification in
proportion to the change.

## Universal rules

- A profile is a data subject; a login is an authentication identity. Do not
  conflate them.
- Every profile-owned read and write must be scoped by `profile_id`. Resolve the
  active profile and authorization at the request boundary.
- Business logic belongs in `lib/`; pages, route handlers, and Server Actions in
  `app/`; shared UI in `components/`.
- Reuse existing models and shared substrates. Do not create a parallel concept
  for the same question.
- Canonical storage uses kilograms, kilometers, and documented time units.
  Convert at input and display boundaries.
- Preserve the distinction between an instant and a profile-local day.
- Missing credentials and optional integrations must degrade gracefully.
- Keep changes focused. Do not edit shipped migrations or unrelated user work.
- Add or update tests for behavior changes.

- More specific instructions live in nested `AGENTS.md` files.
- Domain design and history live in `docs/internals/`; read the relevant
  document before changing a shared domain model.
