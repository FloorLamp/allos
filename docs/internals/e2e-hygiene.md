# E2E suite hygiene — fixtures, settled interactions, retries=0 lane

Status: **partial** (infrastructure shipped — helpers module, hygiene guard incl. the `.first()` count-freeze, changed-spec CI lane, the frozen app clock #990, the sharded CI e2e matrix + on-demand full-suite workflow + pass-on-retry flake telemetry; suite-wide migration of grandfathered offenders is a follow-up, per #868)

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

#### The `.first()` count-freeze (the fixture-ownership follow-through)

The guard freezes a THIRD pattern: **`.first()`**. On a SHARED seeded surface (an
offer list, a dose list, a review inbox) "the first row" is whatever a neighbor
spec or a retry of this spec left on top — the orchestration runbook's #1
recurring failure class. The full fixture-ownership rule stays a convention gate
(below — exact-count assertions can't be linted honestly), but `.first()` IS
mechanically detectable, so its growth is frozen with the same immutable-downward
per-file allowlist: a NEW unmarked `.first()` fails CI.

A `.first()` that is genuinely scoped to a spec-OWNED fixture (a list the spec
created and cleans, a locator already narrowed to a unique planted marker) is
legitimate — mark that line with a same-line `first-ok: <why>` comment (the
`phi-scan-ok` escape-marker shape) and it is excluded from the count. The
preferred fix when migrating an offender is an exact locator (testid, unique
marker text the spec planted) or a dedicated fixture login
(`e2e/fixture-logins.ts`), not a marker.

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

## Fix (d) — the frozen app clock (#990)

A fifth failure class, orthogonal to the four above: **fixtures derive dates
relative to the wall clock** (`today()`, "now − N hours/days"), so whether a seeded
row lands inside a day/week window depends on WHEN the suite runs. A run that
crosses local midnight invalidates its "today"-seeded specs en masse — observed
twice during the 2026-07-18→19 window: `illness-hero`'s "00:05 (Yesterday)" instead
of a same-day relative age, `workout-presence`'s live-session chip/dock rendering
nothing (the seeded draft's `date` no longer today), `workout-heatmap`'s active-day
cells, `protocol-reach`'s ongoing shading. The early-morning `now − N hours` window
also underflows across midnight.

The fix freezes the app's notion of "now" for the run via a single env-gated seam,
**`lib/clock.ts`**:

- `now()` reads `ALLOS_TEST_NOW` (an ISO instant) at CALL time — unset ⇒ real time
  (production is inert, zero behavior change), set ⇒ that fixed instant. It NEVER
  monkey-patches the global `Date`: timers, session TTLs, and Playwright's own
  waiting keep real time. Only DATE-DERIVATION paths route through it — `today()`
  (`lib/db.ts`, the load-bearing consumer), the `now`-defaulting parameters of the
  workout-presence / recommend / redose / food-slot / dose-log read+write cores, and
  the seed math that anchors fixtures — so the fixtures and the app agree on "today"
  by construction. Durations, log/audit timestamps, and cache TTLs stay real.
- `playwright.config.ts` computes `FROZEN_NOW` ONCE at config load — the run's
  **real start instant** (#1048, PR #1103; originally a fixed 12:00 local, which
  opened the "morning-UTC band": runtime-written rows keep real SQL
  `datetime('now')` wall-time, so whenever real time lagged the frozen noon by
  hours, every liveness/recency window read a just-written row as stale and ~10
  specs failed deterministically. Freezing at real start keeps |real − frozen|
  bounded by the run's own duration, which every recency window tolerates, at
  every hour; the residual is only a run that STARTS within its own duration of
  real midnight) — and sets `ALLOS_TEST_NOW` in BOTH webServer `env` blocks
  (default + demo). The webServer `env` applies to the whole `seed && start`
  shell command, so `scripts/seed.ts`, `e2e/seed-events.ts`, and `next start`
  all read the same instant. An externally-supplied `ALLOS_TEST_NOW` wins, so a
  boundary hour (e.g. `00:10` local) can be stress-tested on demand:
  `ALLOS_TEST_NOW="<today>T00:10:00" npm run test:e2e -- illness-hero workout-presence`.

`ALLOS_TEST_NOW` is a **test hook, not an operator knob** — it is deliberately
absent from `.env.example`. `bootTasks` (`lib/migrations/boot-tasks.ts`) logs a
`WARN [clock]` on every boot when it is set, so a misconfigured production instance
running on a frozen clock is loudly visible.

**The timezone pin (the #1103 follow-up).** Freezing at the run's REAL start
(#1103) removed the real-vs-frozen skew but left the frozen LOCAL time-of-day
equal to whatever hour CI started — and bucket-progression assertions (a Morning
dose is past due only once the profile-local clock passes 11:00,
`lib/medication-today.ts`) then failed deterministically for any run starting
00:00–10:59 UTC. The fix stabilizes the TIMEZONE instead of the clock:
`e2e/seed-events.ts` pins the instance-default timezone to the `Etc/GMT` offset
in which the frozen instant reads 13:mm local (`e2e/pinned-timezone.ts`, unit
test `lib/__tests__/pinned-timezone.test.ts`) — deterministic Midday at every
UTC start hour, zero skew preserved, and the local date always equals the frozen
instant's UTC date so `today()` and SQL-stamped rows can't diverge. Every
profile without a per-profile timezone resolves to the pin at read time; a
fixture designed against UTC wall-times opts out per-profile
(`setTimezone(id, "UTC")` — the food-slot ranking profile). The demo server
stays UTC (its specs are time-neutral).

## Fix (e) — sharded CI, the on-demand full-suite workflow, and flake telemetry

Three CI-shape changes from the flaky-e2e hardening pass (the merge-latency side
of the problem; the orchestration runbook `docs/orchestration.md` documents the
pain they replace):

- **The CI e2e job is a 4-way shard matrix.** Each shard is a fresh runner + a
  fresh `npx playwright test --shard=N/4` invocation → fresh app/demo servers per
  chunk. That roughly halves the per-push e2e wall-clock AND removes the
  long-lived-server cumulative degradation the runbook documents for
  single-process full runs (its local finding — "each shard finishes clean where
  one process degrades" — applied to CI). The changed-spec scrutiny lane moved to
  its own `e2e-changed` job so its zero-retry verdict lands fast without waiting
  on the matrix. Shared setup (Node, deps, Chromium, `next build`) lives in the
  composite action `.github/actions/e2e-setup/action.yml` so the jobs can't
  drift.
- **`.github/workflows/e2e-full.yml` (workflow_dispatch) is the fresh-runner
  full-suite gate.** Dispatch it against any branch (defaults: `--retries=0`,
  4-way sharded; `repeat_each` up to 3 for suite-wide hardening). It
  institutionalizes the runbook's conclusion that "CI on a fresh GitHub runner is
  the ultimate authority" — use it in place of a local full-suite run before a
  migration PR or big UI merge, and skip the local degradation-vs-regression
  triage entirely.
- **Pass-on-retry flake telemetry.** The full suite still runs `retries: 1`, and
  a pass-on-retry ships a GREEN run — previously a confirmed flake detection
  thrown away. The CI config now adds a `json` reporter
  (`test-results/e2e-results.json`), and every full-suite shard runs
  `scripts/e2e-flake-report.mjs`, which posts the run's `status: "flaky"` tests
  to the job summary. Telemetry only (always exit 0): it measures the flake
  backlog — file or fix what it surfaces — and is the precondition for the
  retries-drop decision below.

## Follow-up (out of scope for the infra PR)

Migrate the grandfathered offenders incrementally, one spec per PR (the #860
Track-B incremental-migration discipline), lowering the allowlists (`networkidle`
/ `waitForTimeout` / `.first()`) each time until they are empty; then migrate the
cross-ownership anatomy assertions (class 2) onto shared per-component driver
helpers (the `e2e/symptom-helpers.ts` extraction pattern); then revisit dropping
full-suite retries once the flake reports (fix e) read consistently clean.
