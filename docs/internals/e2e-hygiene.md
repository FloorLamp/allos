# E2E suite hygiene — fixtures, settled interactions, retries=0 lane

Status: **partial** (infrastructure shipped — helpers module, hygiene guard, changed-spec CI lane; suite-wide migration of grandfathered offenders is a follow-up, per #868)

Maintainer documentation for the Playwright suite's reliability discipline (issue
#868). The user-facing "how to run e2e" note lives in AGENTS.md's browser-e2e
bullet; this doc is the deep-dive on WHY the suite flakes and the conventions that
stop it.

## The four failure classes (from a day of orchestrated verification)

The suite is the right size (~340 specs, ~7m CI) and is **not** classically
order-dependent. The recurring reds fall into four classes:

1. **Shared mutable world + exact-value assertions (the root disease).** One
   seeded DB and one shared logged-in session (`auth.setup.ts` storageState), and
   specs assert EXACT state on shared fixtures — "2 today", "≥ 2 episode rows",
   "profile 1 stays sick". Any spec — or a RETRY of the same spec re-running
   against its own side effects — that mutates the shared world breaks a neighbor.
   Observed: the prn "3 today" cascade; a fresh-profile hijack of the shared
   session cascading into illness/prn specs; a spec that dared not end the seeded
   episode because siblings depended on it.

2. **Cross-ownership anatomy assertions.** Specs pin ANOTHER feature's DOM anatomy
   (med-card-parity pinning the refill-badge text, food-drug-interactions pinning
   list-card layout, smoke pinning an explainer). Every UI rework then breaks 1–3
   neighbor specs the author didn't know existed.

3. **Settling is reinvented per spec.** A Server-Action POST + trailing
   `router.refresh()` detaches elements mid-interaction; a pre-hydration click gets
   dropped (#730/#830 — one was a REAL product bug). The suite compensated with an
   ad-hoc zoo: `waitForLoadState("networkidle")` (settles on the dashboard but NOT
   a page with a live request), `toPass()` re-click loops, `waitForTimeout()`
   sleeps, `followLink`.

4. **CI retries paint over everything ≤50% flaky.** `retries: 1–2` proves "passes
   within N attempts", not "works": a 50%-flaky de-wrapped spec shipped green, and
   a 4-tests-broken PR self-reported green. Retries also interact badly with the
   non-idempotent specs of class 1.

## Fix (a) — the hygiene guard

`lib/__tests__/e2e-hygiene.test.ts` is a pure source-scan (the #448 /
telegram-chokepoint linter-with-teeth pattern) over **every `e2e/*.ts`** — specs
AND the shared driver/helper modules they import (`symptom-helpers.ts`, `nav.ts`,
…), excluding only the blessed `e2e/helpers.ts`. Phase 2 widened the scan past
`*.spec.ts` after `symptom-helpers.ts`'s `idleSettle` (#861) proved a settle
anti-pattern can hide in an imported helper the spec-only scan never read; the
same pass broadened the networkidle matcher to catch the
`waitForLoadState("networkidle", { timeout })` options-arg form the old
`…)`-anchored regex silently missed. It freezes **today's** count of two
mechanically-detectable settle anti-patterns per file and fails a NEW one:

- `waitForLoadState("networkidle")` — replace with `e2e/helpers.ts`.
- `waitForTimeout(...)` — replace with `settledClick`/`followLink` or a real
  auto-retrying `expect`. (The one legitimate use — the **bounded
  absence-of-effect wait** below — stays, allowlisted.)

#### The bounded absence-of-effect wait (the one sanctioned `waitForTimeout`)

A `waitForTimeout` is legitimate **only** to prove that within a KNOWN product time
window NOTHING happened — the non-occurrence of a timer-driven effect, which has no
positive event to await in its place. The two frozen cases:

- **Debounce-window proof** (`journal-provenance.spec.ts`, ×2): opening an activity
  row must NOT auto-fill calories, dirty the form, and trip the 700ms autosave.
  Waiting ~900ms lets a REGRESSED build's autosave fire before we assert
  not-`edited`; closing earlier lets a real bug pass green. Nothing to await —
  "the debounce elapsed with no POST" is exactly the absence being proven.
- **Poll-cadence proof** (`profile-switch-toasts.spec.ts`, ×3): after a profile
  switch, the doc/import toasters must NOT replay the new profile's terminal history
  as ghost toasts. Waiting past the 6s idle poll cadence lets a regressed build
  toast. The poll is a Server Action POST to the current route (indistinguishable
  from any other POST), so a `waitForResponse` gate can't reliably pick out "the
  toaster polled" — matching a generic POST would reintroduce the very race the wait
  rules out.

**The distinction from the banned use:** a settle `waitForTimeout` waits for a
POSITIVE effect to LAND (an interaction took hold) — replace it with `settledClick`
/ `followLink` / a retrying `expect`, which await the effect itself. An
absence-of-effect `waitForTimeout` waits for a window to PASS with nothing in it —
there is no effect to await, so the bounded wait is the honest expression. Prefer,
where possible, the **positive-action-then-negative-assert** form (perform an
awaited action guaranteed to land AFTER the window, then assert the absence) — but
when no such action exists (both cases above), the bounded wait stays, frozen at
the product window it probes.

The allowlist is per-file COUNTS (not line numbers), so it survives ordinary
edits, and it is **immutable-downward**: reducing a file's count below its frozen
value also fails, with a message to lower the allowlist — so the list only ever
shrinks as offenders migrate. Migrating a spec and dropping its allowlist entry
happen in the same PR.

### Not mechanically enforced — the fixture-ownership rule (class 1)

Detecting an "exact-count assertion against a shared-seed row" syntactically is
too clever: a numeric literal inside `toHaveCount(n)`/`toContainText("n today")`
can't be told apart from a spec asserting against a fixture IT created. So this is
a **convention gate, not a linter**:

- A spec that needs a specific data shape **owns its fixture** — a dedicated
  fixture login/profile (the `EMPTY_TRAINING` precedent, #809, in
  `e2e/fixture-logins.ts`) or a create-and-clean block keyed by a unique marker
  (the encounters #566 / providers merge specs' `beforeAll`/`afterAll` DB cleanup).
- **No exact-count assertion on a SHARED-seed row.** "Profile 1 has exactly 2
  supplements due today" is a landmine: any sibling that logs a dose on profile 1
  (or a retry of this spec) changes the count. Assert on YOUR fixture profile, or
  assert a presence/relationship that survives a neighbor's write (a specific row
  exists, a badge shows for a marker you planted), not a global tally.
- The `EMPTY_TRAINING` lesson: the shared seeded profiles always have activities,
  which is exactly why the first-run empty-state regression was never caught — the
  fix was a profile that stays activity-free ON PURPOSE. When a fixture would flip
  a SHARED surface between states (single- vs multi-source, empty vs populated),
  give it its own profile.

## Fix (b) — the blessed interaction module `e2e/helpers.ts`

ONE home for settled interactions. The file header carries the authoritative
decision tree; the summary:

| Situation                                                                                                            | Use                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Click fires a **Server Action** (form submit, dose confirm, create/delete) and you assert the result                 | `settledClick(page, locator)` — awaits the action's same-origin POST response before returning              |
| Click is a **navigation** to another route (Next `<Link>` / tab `<a href>`) that flakes on the pre-hydration swallow | `followLink(page, locator, /destination/)` — retries the click until the router commits (and holds) the URL |
| A **pure client** toggle / value settles in place / a toast appears                                                  | a plain auto-retrying `expect(...)` — Playwright's retry IS the wait; no helper                             |
| A genuinely non-atomic condition none of the above expresses                                                         | `toPass()` — LAST resort, and every use MUST carry a comment saying why a single `expect` can't express it  |

Why not networkidle: it waits for network SILENCE, not "my interaction landed" —
it settles falsely on a page with a long-poll/SSE/streaming request and adds
latency on a quiet one. Why not `waitForTimeout`: a fixed sleep is too short (CI
flake) or too long (slow suite) and asserts nothing.

`settledClick` works only when the click fires exactly one same-origin POST; for a
click that fires NO action (a client toggle, an `<a href>` nav) there is no POST to
await and it times out — that's what `followLink`/`expect` are for.

## Fix (c) — the changed-spec CI lane at retries=0

The full suite keeps retries for now (revisit once (a)+(b) reduce the flake
surface). A dedicated CI step computes the changed `e2e/*.spec.ts` versus the PR
base and, if any, runs just those at `--repeat-each=3 --retries=0` **before** the
full suite. A spec that is even 50%-flaky fails three-in-a-row-at-zero-retries, so
retry-masking can no longer ship a flaky spec. No changed specs → the step is a
cheap no-op.

## Follow-up (out of scope for the infra PR)

Migrate the grandfathered offenders incrementally, one spec per PR (the #860
Track-B incremental-migration discipline), lowering the allowlist each time until
it is empty; then migrate the cross-ownership anatomy assertions (class 2) onto
shared per-component driver helpers (the `e2e/symptom-helpers.ts` extraction
pattern); then revisit dropping full-suite retries once the flake surface is small.
