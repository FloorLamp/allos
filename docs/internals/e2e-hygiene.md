# E2E suite hygiene — fixtures, settled interactions, retries=0 lane

Status: **partial** (infrastructure shipped — helpers module, hygiene guard incl. the `.first()`/`.toPass(` count-freezes and the #1392 fixture-login budget, changed-spec CI lane, the frozen app clock #990, the sharded CI e2e matrix, retries=0 end-to-end #1160, the on-demand + weekly-census full-suite workflow, pass-on-retry flake telemetry, the opt-in `mobile` phone-viewport project #1420; suite-wide migration of the grandfathered `.first()`/`.toPass(` offenders is the remaining follow-up, per #868)

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

**Mobile no-overflow assertions go through `expectNoClippedContent` (e2e/helpers.ts, #1063).** The app shell clips horizontal overflow (`overflow-x-clip`), so a broken phone-width layout renders as invisible, unreachable content and the naive document-level `scrollWidth > clientWidth` check reads zero on every page. The blessed helper asserts ELEMENT-level containment — every rendered element's right edge inside the viewport unless it sits in a working `overflow-x: auto` container that itself fits — and folds the document-level check in for unclipped surfaces (share/print views). Set the phone viewport after auth, anchor on a page-specific element first, then call it; offenders are reported with tag/testid/class + widths.

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
`…)`-anchored regex silently missed. It freezes **today's** count of the
mechanically-detectable settle anti-patterns per file and fails a NEW one:

- `waitForLoadState("networkidle")` — replace with `e2e/helpers.ts`. (Allowlist
  EMPTY — the suite has zero; any new one fails.)
- `waitForTimeout(...)` — replace with `settledClick`/`followLink` or a real
  auto-retrying `expect`. (The one legitimate use — the **bounded
  absence-of-effect wait** below — stays, allowlisted.)
- `.toPass(` — the "commented last resort", now with teeth (added after the
  flake burn-down): a retrying block hides WHICH step raced — the same disease
  as CI retries, writ small — so new unmarked uses fail. Await the actual
  signal instead (`settledClick` / `followLink` / a plain retrying `expect` on
  ONE locator). A reviewed, genuinely-necessary use (e.g. a
  reload-until-rendered loop over a navigation, with no single awaitable
  event) carries a same-line `topass-ok: <why>` comment on the line where
  `.toPass(` appears (usually the closing `}).toPass({...})`), mirroring
  `first-ok`. Existing offenders are frozen per-file, immutable-downward.

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

#### The family-create freeze + `e2e/family-helpers.ts` (phase-2 create-member hardening)

The Settings → Family create/grant controls are `onClick`+`router.refresh()`
handlers, NOT native form submits (`FamilyManager.tsx`), and that shape breeds two
races: a click dispatched in the hydration window is SWALLOWED (no create POST fires
at all — #730/#830), and the settings shell's background toasters poll via Server
Action POSTs to the current route that are indistinguishable from the create action's
own POST, so a bare `settledClick` FALSE-SETTLES on a bystander poll while a stale
post-`refresh` matrix never shows the new row (#1111). Nine near-identical copies of
the compensating goto→fill→click→verify dance had accreted across the dynamic specs.

They now live in ONE blessed home, **`e2e/family-helpers.ts`**, with three drivers:

- `createLoginViaFamily(page, opts?)` — creates a login (member or admin, optional
  email/invite), retrying the whole cycle against the DURABLE `login-row` (the
  universal row — an admin renders no `grant-row`, so login-row is the one signal that
  works for both); idempotent via the NOCASE-unique username. `settledFill`s the
  username first so the card is hydrated before the controlled role/invite toggles.
- `createProfileViaFamily(page, label)` — VERIFY-FIRST create (profile names are NOT
  unique-constrained, so a blind re-click could add a second same-named profile), then
  switch to it and defer onboarding through the product's own affordance.
- `setGrantsViaFamily(page, username, { profileId, access })` — grants a profile at an
  access level, scoping the checkbox by the `grant-cell-<username>-<id>` testid (no
  `.first()`), then settles on the "Access updated." banner.

The guard freezes the three inline markers — `getByPlaceholder("Username")`,
`"Add a profile"`, `"Save access"` — at ZERO in every file EXCEPT `family-helpers.ts`
(which is SKIPPED, not allowlisted — it owns them by design), so a NEW inline
create/grant sequence fails CI and must route through the helper. A spec that adds a
second full family navigation this way (create THEN grant is two page loads) may need
`test.slow()` for the extra budget — the two-factor precedent.

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

| Situation                                                                                                            | Use                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Click fires a **Server Action** (form submit, dose confirm, create/delete) and you assert the result                 | `settledClick(page, locator)` — awaits the action's same-origin POST response before returning                                   |
| Click is a **navigation** to another route (Next `<Link>` / tab `<a href>`) that flakes on the pre-hydration swallow | `followLink(page, locator, /destination/)` — retries the click until the router commits (and holds) the URL                      |
| **Fill** a controlled input whose Save reads component STATE (Settings' save-from-state cards, autosave-on-blur)     | `settledFill(page, field, value)` — waits for React to hydrate the field before filling, so the value lands in state             |
| **Toggle** a controlled checkbox (`.check()`/`.uncheck()`) whose state feeds a save or a later assertion             | `settledCheck(page, box, checked)` — waits for hydration before toggling; idempotent, so it also replaces an `isChecked()` guard |
| A **pure client** toggle / value settles in place / a toast appears                                                  | a plain auto-retrying `expect(...)` — Playwright's retry IS the wait; no helper                                                  |
| A genuinely non-atomic condition none of the above expresses                                                         | `toPass()` — LAST resort, and every use MUST carry a comment saying why a single `expect` can't express it                       |

Why not networkidle: it waits for network SILENCE, not "my interaction landed" —
it settles falsely on a page with a long-poll/SSE/streaming request and adds
latency on a quiet one. Why not `waitForTimeout`: a fixed sleep is too short (CI
flake) or too long (slow suite) and asserts nothing.

`settledClick` works only when the click fires exactly one same-origin POST; for a
click that fires NO action (a client toggle, an `<a href>` nav) there is no POST to
await and it times out — that's what `followLink`/`expect` are for.

### The pre-hydration fill-revert (`settledFill`, #1188)

A `.fill()` dispatched **before React hydrates** a controlled input sets the DOM
value (so a plain `toHaveValue` passes) but never fires the input's `onChange`, so
the component's STATE never updates — and hydration then REVERTS the field to
state. Anything that reads state afterward loses the value:

- A Save that builds its FormData from component state (Settings'
  `PublicUrlSettings`/`SmtpSettings`) persists the empty/stale value **silently**
  (an empty value is a valid save), and no value-assertion catches it because the
  DOM looked set — this was the ~1/3-under-load `email-auth:58` flake.
- An autosave-on-blur card (`useSaveStatus`) never sees a change, so no save fires
  and a later `reload → toHaveValue` mismatch flakes LOUDLY.

`settledFill(page, field, value)` waits until React has attached its
`__reactFiber$…`/`__reactProps$…` markers to the node (the same hydration signal
`followLink` waits on for clicks) BEFORE filling, so `onChange` fires and the value
lands in state. Use it wherever a spec fills a controlled input and then relies on
component state — Settings save-from-state cards and autosave-on-blur fields are the
canonical victims. `settledFill` guarantees the value reached state, NOT that a
later save kept it; when the save's success is silent (empty is valid), also
reload-and-assert the persisted effect (the email-auth precedent).

The **checkbox** analog is `settledCheck(page, box, checked)`. A
`.check()`/`.uncheck()` before hydration clicks a controlled checkbox
(`checked={…} onChange={…}`) but no `onChange` is wired, so state never flips and
hydration reverts the box — Playwright then reports `check: Clicking the checkbox
did not change its state` (the `food-telegram` line-26 flake). `settledCheck` waits
for the same hydration markers, then `setChecked(checked)` (idempotent — a no-op
when already in the target state, so it subsumes a `if (!await box.isChecked())`
guard) and confirms it holds. Its text-input sibling stays `settledFill`.

### The bystander-poll false-settle is APP-WIDE, and a following `goto` LOSES the write (#1437)

The `settledClick` caveat first written for the Family screen (#1111) is not
family-specific. **Every** app page mounts two headless watchers —
`ImportJobsToaster` and `ExtractionToaster` — and each polls a Server Action on a
6-second timer. Server Actions POST to the CURRENT route URL, so from Playwright's
side those are indistinguishable from the action a click fires. Measured while idle
on `/records/history/visits`: **2 POSTs every 6s**, on every authenticated route.

`settledClick` arms a same-origin POST wait, so it can resolve on one of those polls
while the click's own action is still in flight. Usually harmless — the follow-up
retrying `expect` absorbs the lag. It is NOT harmless when the next line NAVIGATES:

```ts
await settledClick(
  page,
  addCard.getByRole("button", { name: "Add", exact: true })
);
await page.goto("/nutrition?tab=supplements"); // ← aborts the in-flight create
```

A `goto`/`reload` right after a false-settle aborts the pending action request and
the write is **lost, not late**. Reproduced deterministically by delaying the action
POST: the row never lands, and the spec then fails at some LATER assertion about a
downstream surface ("element(s) not found"), which reads like a rendering/timing bug
on a page that is in fact perfectly correct — the appointment simply does not exist.
That is the #1437 census red (`surgery-bridge.spec.ts`), twice, at `retries: 0`.

**Rule:** when a settled click is followed by a NAVIGATION, settle on the durable
**server-rendered marker the completed mutation produces** before navigating —

```ts
await settledClick(page, addBtn);
await expect(ourScheduledRows(page)).toHaveCount(1); // holds the page until it commits
await page.goto("/nutrition?tab=supplements");
```

The assertion's own retry is the wait, it can't be faked by a poll, and — crucially —
nothing navigates away while the action is still in flight. Same shape as the
`mood-server-logged` precedent in `helpers.ts`. Keep spec CLEANUP under this rule
too: a cleanup click followed by a `goto` can drop the cleanup and hand the next spec
a mutated shared profile.

### The fixture-LOGIN budget (#1392)

The seeded fixture population is **monotonic**: every dedicated fixture login is a
permanent row on Settings → Family and a permanent member of the grant matrix. That
ratchet is what grew the family page into the #830/#1111/#1392 census family (a 5 MB
`O(logins × profiles)` render that starved the durable-row probes until the #1412
collapse capped it at `O(logins)`). The product fix removed the cliff; this rule
removes the ratchet.

**Seed a fixture LOGIN only when a spec signs in as it, or when the login itself is
the subject** (access control, the family screen). A separate login is the only way
to drive a non-profile-1 active profile in its OWN cookie context without mutating the
shared admin `storageState`'s server-side active profile — that is a real need and it
stays. But a fixture that only wants an **isolated profile** takes
`fixtureProfileId(name)` in `seed-events.ts` and **no login**: a profile is cheap here,
a login is not.

Enforced by the hygiene guard's sixth check: every `E2E_LOGIN_*` constant in
`e2e/fixture-logins.ts` must be referenced by a spec AND used in a sign-in position
(`loginAs(` / `creds(` / `username:`). A deliberate exception carries a written reason
in `LOGIN_NO_SIGNIN_ALLOW` (today: the sleep-page hash-clone TEMPLATE login and the
`#1412` grant-matrix subject login). A login no spec references at all fails as dead
weight. Census of the population when the guard landed: **94 login constants, 92
signed in as, 2 justified exceptions, 0 droppable** — the budget's job is the next 94,
not this one.

## Fix (c) — the changed-spec CI lane at retries=0

A dedicated CI step computes the changed `e2e/*.spec.ts` versus the PR base and,
if any, runs just those at `--repeat-each=3 --retries=0` **before** the full
suite. A spec that is even 50%-flaky fails three-in-a-row-at-zero-retries, so
retry-masking can no longer ship a flaky spec. No changed specs → the step is a
cheap no-op. The full suite now runs at zero retries too (see the retries-drop
note below), so this lane's strict verdict is the whole suite's standard, not a
special case.

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
- **`.github/workflows/e2e-full.yml` is the fresh-runner full-suite gate — on
  demand AND weekly.** Dispatch it against any branch (defaults: `--retries=0`,
  4-way sharded; `repeat_each` up to 3 for suite-wide hardening) in place of a
  local full-suite run before a migration PR or big UI merge — it
  institutionalizes the runbook's conclusion that "CI on a fresh GitHub runner is
  the ultimate authority", skipping the local degradation-vs-regression triage.
  It ALSO runs on a **weekly `schedule`** (Sundays) as a drift census: the whole
  suite on main at `--retries=0 --repeat-each=2`. Per-PR CI runs each spec once,
  so a newly-introduced low-rate timing flake can land green and only bite weeks
  later; the weekly census re-proves the retries=0 cleanliness and names any
  drift in its check annotations. A red weekly run is a new flake-ledger item —
  fix the named spec like #1159; never re-add retries. (On a `schedule` event
  `inputs.*` is empty, so the run step's `|| '0'` / `|| '2'` fallbacks pick the
  census form; the `event_name`-scoped concurrency group keeps a manual dispatch
  and the weekly run from cancelling each other.)
- **Pass-on-retry flake telemetry → the retries drop.** The telemetry ran the
  full suite at `retries: 1` and posted every `status: "flaky"` (pass-on-retry)
  test to the job summary via a `json` reporter (`test-results/e2e-results.json`)
  - `scripts/e2e-flake-report.mjs`, so the flake backlog was measured instead of
    masked. That backlog was the precondition for dropping retries — and once it
    read clean (the family-calendar flake, the last item, closed by #1159), the
    sharded CI matrix moved to **`retries: 0`** (`playwright.config.ts`). The suite
    now runs at zero retries end-to-end — changed-spec lane, shared-infra fallback,
    and full matrix — so a flake fails the run loudly instead of shipping green on a
    retry. The telemetry step stays wired: an on-demand `e2e-full.yml` census
    dispatched at `--retries=1` still surfaces pass-on-retry tests through the same
    script, and at the default `retries: 0` it reports an accurate empty.

## The `mobile` project — opt-in phone-viewport coverage (#1420)

Every project used to run at 1280×900, so the mobile shell (`MobileNav`'s top bar
and slide-in drawer, bottom sheets, touch targets) had no regression coverage
except in the handful of specs that hand-set a phone viewport via `test.use`. The
`mobile` project (playwright.config.ts) closes that: iPhone-class **390×844**,
`hasTouch: true`, same seeded-DB webServer and same `auth.setup.ts` storage state
as `chromium` — nothing else differs.

**It is opt-in, not a second copy of the suite.** Its `testMatch` admits exactly
two things:

- `smoke.spec.ts` — the broad "every primary surface renders" sweep, worth having
  at both viewports (it is the only spec that runs in BOTH projects); and
- any spec named **`*.mobile.spec.ts`**.

The naming convention was chosen over a `@mobile` tag because it needs no
per-test annotation, it is visible in `ls e2e/`, and CI needs no new filter: the
`e2e-changed` lane globs `^e2e/.*\.spec\.ts$` and runs `npx playwright test
<specs>` with **no `--project` filter**, so a changed `*.mobile.spec.ts` lands in
this project automatically (and a changed `smoke.spec.ts` runs in both). The
sharded full matrix likewise runs `npm run test:e2e`, so the mobile project rides
along and its handful of tests distribute across the four shards — the suite grows
by the mobile spec count, never by a mobile clone of the whole thing.

That routing takes BOTH halves of the config, and the second half is easy to
forget: a `--project`-less run executes a spec in **every** project whose filters
admit it, and `chromium`'s `testMatch` admits everything — so `chromium` carries
`testIgnore: /\.mobile\.spec\.ts$/`, without which every mobile spec would ALSO
run at 1280×900 and fail deterministically in CI (it did, on the first push of
#1420). `demo` needs no such guard: its `testMatch` only admits `demo.spec.ts`.
**Verify a mobile spec the way CI invokes it — with no `--project` flag.** A local
`--project=mobile` run masks this class of misrouting exactly.

**Writing a mobile spec.** Name it `<feature>.mobile.spec.ts` and set NO viewport
(the project owns it — a `test.use({ viewport })` inside would defeat the point).
Every rule in this doc applies unchanged: spec-owned fixtures, settled
interactions from `e2e/helpers.ts`, no `waitForTimeout`/`networkidle`, no unmarked
`.first()`/`.toPass(`, `retries: 0`. One mobile-specific helper lives in the
blessed module: **`openMobileDrawer(page)`** — the drawer's `<aside>` is not even
mounted until the hamburger is tapped, and that tap fires no action and no
navigation (a pure `setOpen(true)`), so it is decision-tree case 4 (a marked
re-tap loop, safe because the hamburger only ever sets `open` true). Use it rather
than re-rolling the tap.

`e2e/smoke.mobile.spec.ts` is the reference spec (bar renders, hamburger mounts
the drawer, the drawer carries the shared `<SidebarContent>` nav, a drawer link
navigates). Acceptance was verified the way the issue asked: hiding the hamburger
(`display: none`) fails 14 tests in this project and none in the desktop ones.

Note the one shared-spec accommodation: `smoke.spec.ts`'s "the app shell rendered,
not a Next error boundary" anchor is now viewport-conditional (`appShellAnchor`) —
the desktop sidebar is `hidden md:flex` and its links live in the unmounted drawer
on a phone, so below `md` the anchor is the hamburger instead of the sidebar's
Data link. That is the shape to copy if another dual-viewport spec needs one: pick
the anchor from `page.viewportSize()`, don't fork the spec.

## Follow-up (out of scope for the infra PR)

Migrate the grandfathered offenders incrementally, one spec per PR (the #860
Track-B incremental-migration discipline), lowering the allowlists (`.first()`
and `.toPass(` are the two with remaining backlog — `networkidle` is empty and
`waitForTimeout` is down to its irreducible absence-of-effect proofs) each time
until they are empty; then migrate the cross-ownership anatomy assertions (class 2) onto shared per-component driver helpers (the `e2e/symptom-helpers.ts`
extraction pattern).

Dropping full-suite retries — the last item on this list — is **done**: the flake
reports (fix e) read clean once #1159 closed the family-calendar flake, and the
sharded CI matrix moved to `retries: 0` (see the telemetry note above). Keep it
that way — a spec that can't hold at zero retries is a flake to fix, not a run to
retry.
