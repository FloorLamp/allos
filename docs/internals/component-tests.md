# Component / render tests: the decided stance

Status: shipped (decision recorded; no component tier added)

Issue #1210 asked two things. The first — focused negative tests for the
security-sensitive boundary code (`middleware.ts`'s public-path allowlist and the
token-authed public route handlers) — shipped as pure + DB-tier tests (see below).
The second was a _decision_, framed like #449's findings-tiering: does a minimal
`*.test.tsx` component tier (testing-library + jsdom, scoped to a handful of
high-logic client components) pay for itself, or does the official stance stay
"e2e + source-scan guards only"? Either outcome was acceptable; the point was to
make it a **decided policy**, not an accident of tooling.

## Decision: no component (`*.test.tsx`) tier.

The official stance stays: client components are verified by **Playwright e2e**
(behavior, over the seeded fixtures) plus the **pure source-scan guards**
(`<NotesText>`, the e2e-hygiene guard, the responsive-surface convention, …), and
**high-logic is extracted into pure `lib/` functions that carry unit tests**. We do
not add jsdom + testing-library.

### Why

- **The load-bearing logic is already extractable — and the convention is to
  extract it.** The repo's rule is "tests are pure logic only; logic you want to
  test is extracted into a pure `lib/` function." A component's tricky state
  (ActivityForm autosave/recovery, dose-state derivation, SRI/sleep formatting)
  belongs in `lib/` where the pure tier already covers it. A component tier would
  invite leaving that logic _in_ the component, weakening the extraction discipline.
- **A jsdom tier is a new, permanently-carried cost** — another runner, another
  config, another CI gate, a `happy-dom`/`jsdom` + testing-library dependency
  surface, and a class of brittle "render this component with these props" tests
  that drift from the real Next Server/Client boundary (Server Components, Server
  Actions, `next/*` mocks). Playwright already renders the _real_ tree against the
  _real_ app, which is the higher-fidelity signal for "does this component paint."
- **The gap #1210 actually cared about was the boundary code, not components.**
  "Security-sensitive boundary code has no focused negative tests" is the
  higher-value half, and it's addressed directly (below) in the tier where a
  cross-profile leak or an allowlist typo actually shows up.

### What we did instead of a component tier

- **Boundary negative tests (the higher-value half of #1210):**
  - `lib/__tests__/public-paths.test.ts` — the middleware public-path allowlist is a
    pure `isPublicPath()` in `lib/public-paths.ts`; the test pins that a protected
    route (or the Strava callback) is **not** public, so an allowlist typo is a red
    test, not a silent page exposure.
  - `lib/__db_tests__/telegram-webhook-route.test.ts` — the inbound webhook rejects a
    missing / wrong / wrong-length secret with a uniform 401 and no oracle, and the
    per-client rate limit trips **before** the auth check.
  - `lib/__db_tests__/medical-file-route.test.ts` — the PHI file-serve route 401s with
    no session, 404s another profile's file by id (cross-profile scope), 404s a
    stored_path that escapes the upload root (path-containment), and 410s a missing
    file — with the happy-path serve pinning the audit write.
  - `lib/__db_tests__/health-connect-ingest-auth.test.ts` — the push-ingest write
    endpoint 401s a missing / wrong / expired bearer identically (no oracle), and a
    matched token still writes (so the 401s are the gate, not a dead route).
  - `lib/__db_tests__/calendar-feed.test.ts` (pre-existing) — a bad/disabled calendar
    token 404s with a generic body, and a feed is cross-profile isolated.
- **Mock/real auth drift** is bounded in the DB tier: `lib/__db_tests__/auth.test.ts`
  drives the **real** `accessForProfile` / `canAccessProfile` (a read grant reads
  `read`, an ungranted profile is unreachable) — the exact functions the action-tier
  auth mock (`lib/__action_tests__/setup.ts`) re-implements — so the mock can't drift
  from prod unnoticed.

If a future component grows genuinely component-only edge logic that can't be
extracted and can't be reached by an e2e path, revisit this — but add the tier
deliberately, with the same reasoning, not as a side effect of one hard component.
