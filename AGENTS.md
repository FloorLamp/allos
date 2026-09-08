# AGENTS.md

Hi, this is a project for regular people to track health. Health is complex,
this app shouldn't be. Keep things simple. Write concisely. No
"editorial-policy language" to users.

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
- Simplify, extract, unify. Types over guards; adding complexity means rethink.
- Canonical storage uses kilograms, kilometers, and documented time units.
  Convert at input and display boundaries.
- Preserve the distinction between an instant and a profile-local day.
- Missing credentials and optional integrations must degrade gracefully.
- Keep changes focused. Do not edit shipped migrations or unrelated user work.
- Verify behavior changes with existing coverage first; add or update a focused
  test when a meaningful failure is not covered. CSS-only changes do not
  automatically require new tests or changed assertions.
- Do not write redundant assertions or defensive assert checks for conditions
  already proven by types or prior control flow.

- More specific instructions live in nested `AGENTS.md` files.
- [Development guide](docs/development.md) maps tasks to code, documents, and
  checks. Read the matching contract before changing a shared domain model.
- [Change and test policy](docs/change-policy.md) governs scope, new code, and
  test value. Implement the smallest complete change, then stop when the
  requested behavior and relevant checks pass.

## Skills

Shared workflows live in [.agents/skills](.agents/skills): `pm`, `orchestrate`,
`needs-human`, `file-issue`, `reconcile-tracker`, and `ux-walkthrough`. Read the
matching `SKILL.md` when assigned that role, even if the host does not discover
skills automatically. `.claude/skills` contains thin Claude Code entrypoints to
the same procedures. [Agent tools](docs/orchestration/environment.md#agent-tools)
explains how to use the current host's capabilities without changing the workflow.
