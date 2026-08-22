# Component / render tests: the decided stance

Status: shipped — a narrow DOM tier over `components/**` exists (#3446). It
supersedes the "no component tier" decision recorded for #1210, which is kept
below because its reasoning still governs what belongs in the tier.

## Where a component's behaviour is tested

| Altitude                    | Tier                                | Use it for                                                                  |
| --------------------------- | ----------------------------------- | --------------------------------------------------------------------------- |
| Pure logic                  | `lib/__tests__` (`npm test`)        | Anything extractable. Still the first choice, and still most of the answer. |
| A hook or a component's DOM | `components/__tests__` (`npm test`) | Behaviour that only exists once something is mounted or a document exists.  |
| The real app                | `e2e/` (`npm run test:e2e`)         | Does the page paint, over the seeded fixtures, in a real browser.           |

The component tier is the third vitest project in `vitest.config.ts`. It runs
under `npm test` with the two `lib/**` projects — no separate command, no
separate CI job — so CI's `test-unit` job, `CI (main)`, and
`scripts/orchestration/agent-gates.sh` all run it with no further wiring.

## What the tier is for, and what it is not for

**Reach for it when a guard cannot be extracted into `lib/` and can only
otherwise be pinned by a browser.** The two first customers are the shape:

- `components/__tests__/dirty-form-registry.test.ts` —
  `pageDeclaresUnrecoverableWork()`'s DOM scan. The predicate it applies is pure
  and lives in `lib/dirty-forms.ts` with its own tests; the scan that feeds it —
  which elements are visited, what is read off them, whether the loop keeps
  going — is a `querySelectorAll` over a real document and has nowhere else to
  live.
- `components/__tests__/auto-update-reload.test.ts` — `takeUpdate`'s post-await
  re-check. The window it guards opens between an `await` resolving and a
  navigation being dispatched. No surface in the tree can open that window on
  purpose, so a browser spec could only fake it; a test that supplies the awaited
  callback opens it exactly.

- `components/__tests__/imported-name-offer.test.tsx` — the #3480 offer's own
  DOM. This one sits closest to the "does this page paint" line below, so the
  distinction is worth stating: the claim is not that a page renders, it is that
  **one client component's markup carries a specific guarantee** — the document's
  wording, a control that accepts a replacement, and the kept label afterwards.
  The component is `"use client"` with no Server/Client boundary inside it, so
  jsdom renders what a browser renders; the server-tier render test beside it can
  only see the element's props, and three deletions inside the component passed
  every tier before this file existed.

**Do not reach for it to test logic that could have been a pure function.** The
#1210 reasoning below is why: a component tier invites leaving load-bearing logic
_in_ the component, and the extraction discipline is worth more than the
convenience. If a test here is really about a calculation, the calculation is in
the wrong file.

**Do not reach for it for "does this page paint".** Playwright renders the real
tree against the real app and the real Server/Client boundary. A jsdom render
that drifts from that is a test of a fiction.

## The choices, and what would change them

- **Same config as `lib/**`, folded into `npm test`.** The split this repo
  already makes is _purity_, not environment: `vitest.db.config.ts` is separate
  because its tests open real SQLite handles, need a global setup and mock the
  auth boundary. A jsdom test is still pure in that sense, so it lands on the
  pure side of the boundary already drawn — and folding it in makes it impossible
  to forget to invoke, which is the failure #3446 exists to end. It earns its own
  config and CI job the day it needs a global setup, a non-hermetic resource, or
  a coverage denominator of its own.
- **jsdom, not happy-dom.** happy-dom constructs faster, and if this tier grows
  to hundreds of files that per-file cost is what would change the answer. Today
  the whole tier is ~2s. jsdom's divergences from a browser are loud — it throws
  "not implemented" — where happy-dom's are more often a quiet difference in
  result, and a tier whose purpose is to stop silent false greens cannot rest on
  an environment that fails quietly.
- **`@testing-library/react` for mounting.** `renderHook` and `act` are the
  ecosystem's documented answer for React 19's rendering and flushing rules, and
  a hand-rolled harness would be a private convention every future author has to
  learn before writing their first test.

## Writing a test here

- Files live in `components/__tests__/` and are named `*.test.ts` / `*.test.tsx`.
- `components/__tests__/setup.ts` unmounts, clears `document.body` and clears
  both storages after every test. Each file also resets whatever module-level
  registry it drives (`resetUnsavedWork`, `resetUpdateReloadChannel`, …).
- **Pair every absence assertion with a control.** "No reload happened" is also
  what a harness that never reached the reload would report; the control is the
  identical mount that _does_ reach it.
- **Prefer a settled sequence to a polled one.** Awaiting one macrotask turn
  drains the microtasks a flush chain queued, which is deterministic. A retrying
  `waitFor` around an absence can pass by asking before the bug had a chance.

### One hazard to know about

The `__tests__` directory name is what keeps this tier out of the ~74 source-scan
guards in `lib/__tests__` that walk `components/`. Forty-five of them exclude any
path containing `__tests__`; **29 do not** (measured 2026-08-21) and are silent
today only because these two files happen not to match their patterns. A future
component test that builds a fixture out of realistic markup can trip one, and
the failure will name the scanner rather than the test. The fix in that case is
to add the exclusion the other 45 already have, not to reshape the fixture.

---

## The earlier decision (#1210), superseded 2026-08-21

Recorded in full because it is the reasoning that still bounds what belongs in
the tier, and because "we decided this once already" is worth being able to read.

Issue #1210 asked two things. The first — focused negative tests for the
security-sensitive boundary code (`middleware.ts`'s public-path allowlist and
the token-authed public route handlers) — shipped as pure + DB-tier tests (see
below). The second was a _decision_, framed like #449's findings-tiering: does a
minimal `*.test.tsx` component tier (testing-library + jsdom, scoped to a
handful of high-logic client components) pay for itself, or does the official
stance stay "e2e + source-scan guards only"? Either outcome was acceptable; the
point was to make it a **decided policy**, not an accident of tooling.

**The decision then: no component tier.** Its three reasons, and where each
stands now:

- **The load-bearing logic is already extractable — and the convention is to
  extract it.** _Still true, and still the rule._ A component's tricky state
  (ActivityForm autosave/recovery, dose-state derivation, SRI/sleep formatting)
  belongs in `lib/` where the pure tier covers it. The tier is scoped so that it
  cannot become the easy way out of extracting.
- **A jsdom tier is a new, permanently-carried cost.** _Still true, and now
  paid deliberately._ What changed is the other side of the ledger: #3371 put a
  silent-data-loss gate into `components/` where no tier could see it, shipped it
  with both its OR sites deletable and the whole suite green, and pinning it
  afterwards took two e2e tests driving a real service-worker update. That is the
  price of not having the tier, charged once, and #3502's arc had four more guards
  queued behind the same choice.
- **The gap #1210 actually cared about was the boundary code, not components.**
  _Still true._ That half shipped then and is unaffected; it is listed below.

The escape clause that decision wrote for itself — "if a future component grows
genuinely component-only edge logic that can't be extracted and can't be reached
by an e2e path, revisit this — but add the tier deliberately, with the same
reasoning, not as a side effect of one hard component" — is the clause #3446
exercised.

### What #1210 shipped instead, all of it still live

- **Boundary negative tests (the higher-value half of #1210):**
  - `lib/__tests__/public-paths.test.ts` — the middleware public-path allowlist
    is a pure `isPublicPath()` in `lib/public-paths.ts`; the test pins that a
    protected route (or the Strava callback) is **not** public, so an allowlist
    typo is a red test, not a silent page exposure.
  - `lib/__db_tests__/telegram-webhook-route.test.ts` — the inbound webhook
    rejects a missing / wrong / wrong-length secret with a uniform 401 and no
    oracle, and the per-client rate limit trips **before** the auth check.
  - `lib/__db_tests__/medical-file-route.test.ts` — the PHI file-serve route
    401s with no session, 404s another profile's file by id (cross-profile
    scope), 404s a stored_path that escapes the upload root (path-containment),
    and 410s a missing file — with the happy-path serve pinning the audit write.
  - `lib/__db_tests__/health-connect-ingest-auth.test.ts` — the push-ingest
    write endpoint 401s a missing / wrong / expired bearer identically (no
    oracle), and a matched token still writes (so the 401s are the gate, not a
    dead route).
  - `lib/__db_tests__/calendar-feed.test.ts` (pre-existing) — a bad/disabled
    calendar token 404s with a generic body, and a feed is cross-profile
    isolated.
- **Mock/real auth drift** is bounded in the DB tier:
  `lib/__db_tests__/auth.test.ts` drives the **real** `accessForProfile` /
  `canAccessProfile` (a read grant reads `read`, an ungranted profile is
  unreachable) — the exact functions the action-tier auth mock
  (`lib/__action_tests__/setup.ts`) re-implements — so the mock can't drift from
  prod unnoticed.
