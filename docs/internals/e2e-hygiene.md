# E2E suite hygiene — fixtures, settled interactions, retries=0 lane

Status: **partial** (infrastructure shipped — DB-per-worker isolation (#1538),
helpers module, hygiene guard incl. the `.first()`/`.toPass(` count-freezes and
the #1392 fixture-login budget, changed-spec CI lane, the frozen app clock #990,
the sharded CI e2e matrix, retries=0 end-to-end #1160, the on-demand +
weekly-census full-suite workflow, pass-on-retry flake telemetry, the opt-in
`mobile` phone-viewport project #1420, the #1534 SQL clock seam + UTC-midnight
CI backstop, the #1543 document-level-overflow freeze + the #1545
degenerate-input convention; suite-wide migration of the grandfathered
`.first()`/`.toPass(` offenders is the remaining follow-up, per #868)

Maintainer documentation for the Playwright suite's reliability discipline
(issue \#868). The user-facing "how to run e2e" note lives in AGENTS.md's
browser-e2e bullet; this doc is the deep-dive on WHY the suite flakes and the
conventions that stop it.

## The four failure classes (from a day of orchestrated verification)

The suite is the right size (~340 specs, ~7m CI) and is **not** classically
order-dependent. The recurring reds fall into four classes:

1. **Shared mutable world + exact-value assertions (the root disease).** One
   seeded DB and one shared logged-in session for the WHOLE run, and specs
   assert EXACT state on shared fixtures — "2 today", "≥ 2 episode rows",
   "profile 1 stays sick". Any spec — or a RETRY of the same spec re-running
   against its own side effects — that mutates the shared world breaks a
   neighbor. Observed: the prn "3 today" cascade; a fresh-profile hijack of the
   shared session cascading into illness/prn specs; a spec that dared not end
   the seeded episode because siblings depended on it.

   **Halved, not cured, by DB-per-worker (#1538 — see below).** Each Playwright
   worker now owns its own database, server and session, so two specs can no
   longer collide CONCURRENTLY and `--workers=N` is honest. Specs that share a
   worker still run against one database in sequence, so a spec that leaves the
   world changed can still break a neighbour — and WHICH neighbour now depends
   on the scheduler. The fixture-ownership rule below is therefore unchanged:
   own your fixture, never exact-count a shared-seed row.

2. **Cross-ownership anatomy assertions.** Specs pin ANOTHER feature's DOM
   anatomy (med-card-parity pinning the refill-badge text,
   food-drug-interactions pinning list-card layout, smoke pinning an explainer).
   Every UI rework then breaks 1–3 neighbor specs the author didn't know
   existed.

3. **Settling is reinvented per spec.** A Server-Action POST + trailing
   `router.refresh()` detaches elements mid-interaction; a pre-hydration click
   gets dropped (#730/#830 — one was a REAL product bug). The suite compensated
   with an ad-hoc zoo: `waitForLoadState("networkidle")` (settles on the
   dashboard but NOT a page with a live request), `toPass()` re-click loops,
   `waitForTimeout()` sleeps, `followLink`.

**Mobile no-overflow assertions go through `expectNoClippedContent`
(e2e/helpers.ts, #1063), and nothing else is allowed to (#1543).** The app shell
clips horizontal overflow (`overflow-x-clip`), so a broken phone-width layout
renders as invisible, unreachable content and the naive document-level
`scrollWidth > clientWidth` check reads zero on every page. The blessed helper
asserts ELEMENT-level containment — every rendered element's right edge inside
the viewport unless it sits in a working `overflow-x: auto` container that
itself fits — and folds the document-level check in for unclipped surfaces
(share/print views). Set the phone viewport after auth, anchor on a
page-specific element first, then call it; offenders are reported with
tag/testid/class + widths. The hand-rolled form is now frozen at ZERO by the
hygiene guard — see "Assertion integrity" below.

4. **CI retries paint over everything ≤50% flaky.** `retries: 1–2` proves
   "passes within N attempts", not "works": a 50%-flaky de-wrapped spec shipped
   green, and a 4-tests-broken PR self-reported green. Retries also interact
   badly with the non-idempotent specs of class 1.

**The picker-in-row `hasText` trap (#1879 — proven live to act on the wrong
patient).** `filter({ hasText })` matches a row's ENTIRE subtree text, including
the `<option>` labels of an embedded `<select>` and the accessible names of an
embedded chip picker — so on a surface where every row carries every household
profile name (the portals pending rows, any future picker-in-row list), a
row-scoped `hasText: "RILEY"` matches the FIRST row whenever a profile is named
Riley, and the driver acts on the wrong row indistinguishably from success. It
passes today only while fixture labels happen not to collide with fixture
profile names — the same daily-roulette shape as class 1. Anchor on the label
ELEMENT, never the row: an exact-text anchor
(`.filter({ has: page.getByText(label, { exact: true }) })`), a dedicated label
testid, or — what the portals specs do since #1874 — a row attribute carrying
the identity (`[data-testid="pending-row"][data-label="…"]`).

## Fix (a) — the hygiene guard

`lib/__tests__/e2e-hygiene.test.ts` is a pure source-scan (the #448 /
telegram-chokepoint linter-with-teeth pattern) over **every `e2e/*.ts`** — specs
AND the shared driver/helper modules they import (`symptom-helpers.ts`,
`nav.ts`, …), excluding only the blessed `e2e/helpers.ts`. Phase 2 widened the
scan past `*.spec.ts` after `symptom-helpers.ts`'s `idleSettle` (#861) proved a
settle anti-pattern can hide in an imported helper the spec-only scan never
read; the same pass broadened the networkidle matcher to catch the
`waitForLoadState("networkidle", { timeout })` options-arg form the old
`…)`-anchored regex silently missed. It freezes **today's** count of the
mechanically-detectable settle anti-patterns per file and fails a NEW one:

- `waitForLoadState("networkidle")` — replace with `e2e/helpers.ts`. (Allowlist
  EMPTY — the suite has zero; any new one fails.)
- `waitForTimeout(...)` — replace with `settledClick`/`followLink` or a real
  auto-retrying `expect`. (The one legitimate use — the **bounded
  absence-of-effect wait** below — stays, allowlisted.)
- a document-level overflow check (`documentElement.scrollWidth` /
  `document.body.scrollWidth` compared against the viewport) — replace with
  `expectNoClippedContent(page)`. Frozen at ZERO: under the shell's
  `overflow-x-clip` the comparison can't fail, so every such line asserted
  nothing (#1543). Full reasoning in "Assertion integrity" below.
- `.toPass(` — the "commented last resort", now with teeth (added after the
  flake burn-down): a retrying block hides WHICH step raced — the same disease
  as CI retries, writ small — so new unmarked uses fail. Await the actual signal
  instead (`settledClick` / `followLink` / a plain retrying `expect` on ONE
  locator). A reviewed, genuinely-necessary use (e.g. a reload-until-rendered
  loop over a navigation, with no single awaitable event) carries a same-line
  `topass-ok: <why>` comment on the line where `.toPass(` appears (usually the
  closing `}).toPass({...})`), mirroring `first-ok`. Existing offenders are
  frozen per-file, immutable-downward.

### The bounded absence-of-effect wait (the one sanctioned `waitForTimeout`)

A `waitForTimeout` is legitimate **only** to prove that within a KNOWN product
time window NOTHING happened — the non-occurrence of a timer-driven effect,
which has no positive event to await in its place. The two frozen cases:

- **Debounce-window proof** (`journal-provenance.spec.ts`, ×2): opening an
  activity row must NOT auto-fill calories, dirty the form, and trip the 700ms
  autosave. Waiting ~900ms lets a REGRESSED build's autosave fire before we
  assert not-`edited`; closing earlier lets a real bug pass green. Nothing to
  await — "the debounce elapsed with no POST" is exactly the absence being
  proven.
- **Poll-cadence proof** (`profile-switch-toasts.spec.ts`, ×3): after a profile
  switch, the doc/import toasters must NOT replay the new profile's terminal
  history as ghost toasts. Waiting past the 6s idle poll cadence lets a
  regressed build toast. The poll is a Server Action POST to the current route
  (indistinguishable from any other POST), so a `waitForResponse` gate can't
  reliably pick out "the toaster polled" — matching a generic POST would
  reintroduce the very race the wait rules out.

**The distinction from the banned use:** a settle `waitForTimeout` waits for a
POSITIVE effect to LAND (an interaction took hold) — replace it with
`settledClick` / `followLink` / a retrying `expect`, which await the effect
itself. An absence-of-effect `waitForTimeout` waits for a window to PASS with
nothing in it — there is no effect to await, so the bounded wait is the honest
expression. Prefer, where possible, the **positive-action-then-negative-assert**
form (perform an awaited action guaranteed to land AFTER the window, then assert
the absence) — but when no such action exists (both cases above), the bounded
wait stays, frozen at the product window it probes.

The allowlist is per-file COUNTS (not line numbers), so it survives ordinary
edits, and it is **immutable-downward**: reducing a file's count below its
frozen value also fails, with a message to lower the allowlist — so the list
only ever shrinks as offenders migrate. Migrating a spec and dropping its
allowlist entry happen in the same PR.

### The `.first()` count-freeze (the fixture-ownership follow-through)

The guard freezes a THIRD pattern: **`.first()`**. On a SHARED seeded surface
(an offer list, a dose list, a review inbox) "the first row" is whatever a
neighbor spec or a retry of this spec left on top — the orchestration runbook's
\#1 recurring failure class. The full fixture-ownership rule stays a convention
gate (below — exact-count assertions can't be linted honestly), but `.first()`
IS mechanically detectable, so its growth is frozen with the same
immutable-downward per-file allowlist: a NEW unmarked `.first()` fails CI.

A `.first()` that is genuinely scoped to a spec-OWNED fixture (a list the spec
created and cleans, a locator already narrowed to a unique planted marker) is
legitimate — mark that line with a same-line `first-ok: <why>` comment (the
`phi-scan-ok` escape-marker shape) and it is excluded from the count. The
preferred fix when migrating an offender is an exact locator (testid, unique
marker text the spec planted) or a dedicated fixture login
(`e2e/fixture-logins.ts`), not a marker.

### The family-create freeze + `e2e/family-helpers.ts` (phase-2 create-member hardening)

The Settings → People & access create/grant controls are
`onClick`+`router.refresh()`
handlers, NOT native form submits (`FamilyManager.tsx`), and that shape breeds
two races: a click dispatched in the hydration window is SWALLOWED (no create
POST fires at all — #730/#830), and the settings shell's background toasters
poll via Server Action POSTs to the current route that are indistinguishable
from the create action's own POST, so a bare `settledClick` FALSE-SETTLES on a
bystander poll while a stale post-`refresh` matrix never shows the new row
(#1111). Nine near-identical copies of the compensating goto→fill→click→verify
dance had accreted across the dynamic specs.

They now live in ONE blessed home, **`e2e/family-helpers.ts`**, with three
drivers:

- `createLoginViaFamily(page, opts?)` — creates a login (member or admin,
  optional email/invite), retrying the whole cycle against the DURABLE
  `login-row` (the universal row — an admin renders no `grant-row`, so login-row
  is the one signal that works for both); idempotent via the NOCASE-unique
  username. `settledFill`s the username first so the card is hydrated before the
  controlled role/invite toggles.
- `createProfileViaFamily(page, label)` — VERIFY-FIRST create (profile names are
  NOT unique-constrained, so a blind re-click could add a second same-named
  profile), then switch to it and defer onboarding through the product's own
  affordance.
- `setGrantsViaFamily(page, username, { profileId, access })` — grants a profile
  at an access level, scoping the checkbox by the `grant-cell-<username>-<id>`
  testid (no `.first()`), then settles on the "Access updated." banner.

The guard freezes the three inline markers — `getByPlaceholder("Username")`,
`"Add a profile"`, `"Save access"` — at ZERO in every file EXCEPT
`family-helpers.ts` (which is SKIPPED, not allowlisted — it owns them by
design), so a NEW inline create/grant sequence fails CI and must route through
the helper. A spec that adds a second full family navigation this way (create
THEN grant is two page loads) may need `test.slow()` for the extra budget — the
two-factor precedent.

### Not mechanically enforced — the fixture-ownership rule (class 1)

Detecting an "exact-count assertion against a shared-seed row" syntactically is
too clever: a numeric literal inside `toHaveCount(n)`/`toContainText("n today")`
can't be told apart from a spec asserting against a fixture IT created. So this
is a **convention gate, not a linter**:

- A spec that needs a specific data shape **owns its fixture** — a dedicated
  fixture login/profile (the `EMPTY_TRAINING` precedent, #809, in
  `e2e/fixture-logins.ts`) or a create-and-clean block keyed by a unique marker
  (the encounters #566 / providers merge specs' `beforeAll`/`afterAll` DB
  cleanup).
- **No exact-count assertion on a SHARED-seed row.** "Profile 1 has exactly 2
  supplements due today" is a landmine: any sibling that logs a dose on profile
  1 (or a retry of this spec) changes the count. Assert on YOUR fixture profile,
  or assert a presence/relationship that survives a neighbor's write (a specific
  row exists, a badge shows for a marker you planted), not a global tally.
- The `EMPTY_TRAINING` lesson: the shared seeded profiles always have
  activities, which is exactly why the first-run empty-state regression was
  never caught — the fix was a profile that stays activity-free ON PURPOSE. When
  a fixture would flip a SHARED surface between states (single- vs multi-source,
  empty vs populated), give it its own profile.

## Assertion integrity — the two ways an assertion lies (#1543 / #1545)

A spec can be green for two opposite bad reasons: it asserts something that
**cannot fail**, or it asserts something that **must not be allowed to change**.
Both shipped in this suite, one of each, and they are the same mistake seen from
either side — an assertion whose truth value doesn't track the product.

### (1) The vacuous guard: it can't fail (#1543)

The app shell is `<main className="… overflow-x-clip">`
(`app/(app)/layout.tsx`). Clipped overflow is never scrollable overflow, so on
every `(app)` page `document.documentElement.scrollWidth` equals the viewport
width **no matter what the page contains** — measured under a 3000px-wide div
injected into `<main>` at a 390px viewport, it still reads
`{doc: 390, inner: 390}` and the comparison PASSES (the same page under
`expectNoClippedContent` reports `right=3000 vs viewport=390`). Fifteen sites
across thirteen specs hand-rolled that comparison as their mobile-overflow gate
(one of them inverted, `> viewport` expected false — unconditionally false, same
vacuity). Each one read like a guard, cost a line of review attention, and could
not go red.

The fix is the one that already existed: `expectNoClippedContent(page)` measures
ELEMENT-level containment and names the offender. The hand-rolled form is frozen
at ZERO by the hygiene guard, which is a TEXT scan — so a comment or string
inside an `e2e/*.ts` that spells the pattern out counts itself; phrase spec
prose without the literal (this doc is not scanned, which is why it can be
explicit).

**The general rule: prove a guard both ways before trusting it.** A guard is
only worth its line if you have seen it fail. When you add or convert one, break
the thing it guards ONCE — inject the offending element, delete the fixture row
— and watch it go red, then remove the injection and watch it go green.
`#1063`'s helper was written that way (hiding the hamburger fails 14 mobile
tests and none of the desktop ones); the fifteen naive copies were not.

### (2) The frozen defect: it can't be fixed (#1545)

The inverse failure. `trends-metric-pages.spec.ts` required `period-stat-7`,
`period-stat-30` AND `period-stat-90` to all be visible on a metric detail page.
The fixture's steps series is three consecutive days, so all three trailing
windows contained the SAME readings and the page rendered the identical four
numbers three times — the defect #1541 was filed for. The presence trio had
encoded that defect as the contract: fixing it turned the spec red, so the spec
had to be re-pointed as part of the fix rather than confirming it.

The convention, for any **windowed or aggregating statistic** (trailing windows,
rolling averages, per-period rollups, streaks, adherence rates):

- **Ship the degenerate inputs as pure cases**: all windows coincident, a single
  reading, and empty. Those are not exotic — they are the ordinary state of a
  new install, a fresh integration, a metric recorded once.
  `bodyMetricPeriodStats` (`lib/trends-body-metrics.ts`) carries all three in
  `lib/__tests__/trends-body-metrics.test.ts`, and each asserts the shape a
  SURFACE can render: one card, keyed by the widest window it covers, carrying
  its reading count and covered span. **The window's boundary is one of those
  inputs.** #1909 moved these windows to complete days only (they end
  yesterday), which shifted every calendar cutoff back a day — and a fixture
  calibrated to the OLD boundary, weigh-ins at exactly −7d and −1d, silently
  became an all-coincident one. Recalibrating the fixture is the fix; retargeting
  the assertion to "1 card" would have thrown the signal away.
- **Assert what the surface renders, differentially.** Prefer "the number of
  stat cards equals the number of DISTINCT windows" over a fixed-presence trio,
  and drive a fixture where that count is a SIGNAL rather than a constant — the
  metric page spec now pairs an all-coincident fixture (3 consecutive days → 1
  card) with a partial-collapse one (weigh-ins at −9d and −1d → 2 cards, `7d` +
  `30–90d`). A presence assertion that would still pass if the windows
  collapsed, merged or split is not measuring the statistic; it is measuring the
  template.

This is the `#448` findings-builder rule one layer down. There, an engine with
solid boundary-pinning pure tests still shipped bugs because its INPUT layer was
structurally invisible to the pure tier; here, a surface with solid presence
assertions still shipped a defect because the OUTPUT shape was pinned as a
constant. Same remedy in both: test the seam against a realistic fixture, and
choose the assertion that changes when the answer changes.

## Streamed sections: the harness settles the reveal (#1644)

The Trends Overview surface streams its body census below a fast head (digest +
starred grid), behind a `<Suspense>` boundary. In the streamed HTML the census
arrives in a `<div hidden id="S:n">` staging node at the end of `<body>`, and
React moves it into its section on a schedule of its own — a rAF, or a coalescing
timeout that a loaded CI shard can stretch to SECONDS past the load event. During
that window a census testid matches TWO nodes (the staged copy, then mid-move
both), which strict mode reports as a duplicated-element bug; five spec classes
hit it in one week, per-spec waits kept losing to their own 5s defaults, and every
future census-touching spec inherited the trap.

So the wait lives in the HARNESS, not in specs: `installStreamRevealGuard`
(e2e/helpers.ts) wraps `goto`/`reload`/`goBack`/`goForward` so a full-document
navigation returns only once no staging node remains, under a generous named
ceiling. The `browser` fixture installs it on every page of every context — the
same choke point as the frozen-clock patch, covering the built-in fixtures,
`loginAs`, and every hand-built context. Client-side navigations render in place
and never stage, so they need nothing.

What this means when writing a spec:

- Assert census content directly after a navigation — no per-spec reveal wait
  exists, and none should be reintroduced.
- The rule generalizes: any FUTURE streamed boundary on any page is covered by
  the same guard, because it keys on React's staging nodes, not on Trends ids.
- Do NOT reach for `waitForTimeout` or `networkidle` if a streamed surface
  seems racy — if the guard's ceiling is ever exceeded, its error names the
  stuck page; that is a finding, not a flake to sleep past.

## A declared ceiling above 30 s needs `test.slow()` (2026-08-02)

A named `{ timeout: N }` on an assertion bounds only that assertion — the TEST
still dies at Playwright's 30 s default. So a ceiling raised past 30 s is inert:
the run is killed before the ceiling it declares can ever apply, and the failure
reads as the ceiling's message with a _shorter_ elapsed time than the ceiling
itself, which is the tell. `wellness-practices.spec.ts:137` spent a full cycle
in that state — a 45 s ceiling that never once got to 45 s, dying at 30.1 s.

If an assertion genuinely needs more than 30 s, add `test.slow()` (or a
`test.setTimeout`) in the same change, and say in the comment why the sequence is
slow. And treat a ceiling that keeps needing to grow as evidence the test's SETUP
is the problem, not its budget.

**A ceiling that keeps growing is a setup problem — seed instead.** That test
drove two full UI create round-trips (plus a reload and an untrack) as setup for
assertions about EDITS. Its ceiling went 5 s → 20 s → 45 s → `test.slow()`, and
still exhausted 45 s on shard 4 against diffs that cannot reach wellness. Seeding
the two practices straight into the worker DB (#868 spec-owned fixtures) took the
test from 25–31 s to **under 7 s**, deterministically, with every assertion
unchanged. Nothing was lost, because the create and untrack paths are each
already covered by a sibling test in the same file. When you find yourself
raising a number a third time, ask what the test is NAMED for and seed everything
that isn't that.

## Fix (b) — the blessed interaction module `e2e/helpers.ts`

ONE home for settled interactions. The file header carries the authoritative
decision tree; the summary:

| Situation                                                                                                            | Use                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Click fires a **Server Action** (form submit, dose confirm, create/delete) and you assert the result                 | `settledClick(page, locator)` — awaits an action POST that started AFTER the click and targets this page's route (#1952)         |
| Click is a **navigation** to another route (Next `<Link>` / tab `<a href>`) that flakes on the pre-hydration swallow | `followLink(page, locator, /destination/)` — retries the click until the router commits (and holds) the URL                      |
| **Fill** a controlled input whose Save reads component STATE (Settings' save-from-state cards, autosave-on-blur)     | `settledFill(page, field, value)` — waits for React to hydrate the field before filling, so the value lands in state             |
| **Toggle** a controlled checkbox (`.check()`/`.uncheck()`) whose state feeds a save or a later assertion             | `settledCheck(page, box, checked)` — waits for hydration before toggling; idempotent, so it also replaces an `isChecked()` guard |
| A **pure client** toggle / value settles in place / a toast appears                                                  | a plain auto-retrying `expect(...)` — Playwright's retry IS the wait; no helper                                                  |
| A **client** disclosure / chip / overflow menu / dialog opener whose CLICK itself can be lost pre-hydration          | `hydratedClick(page, locator)` — clicks ONCE after React attaches; then assert what it revealed. NEVER `settledClick` (#1952)    |
| A genuinely non-atomic condition none of the above expresses                                                         | `toPass()` — LAST resort, and every use MUST carry a comment saying why a single `expect` can't express it                       |

Why not networkidle: it waits for network SILENCE, not "my interaction landed" —
it settles falsely on a page with a long-poll/SSE/streaming request and adds
latency on a quiet one. Why not `waitForTimeout`: a fixed sleep is too short (CI
flake) or too long (slow suite) and asserts nothing.

`settledClick` works only when the click fires exactly one same-origin POST; for
a click that fires NO action (a client toggle, an `<a href>` nav) there is no
POST to await and it times out — that's what `followLink`/`hydratedClick`/`expect`
are for. Its timeout message says so explicitly, because that timeout almost
always means the CALL SITE is wrong rather than the app being slow (#1952).

### The pre-hydration fill-revert (`settledFill`, #1188)

A `.fill()` dispatched **before React hydrates** a controlled input sets the DOM
value (so a plain `toHaveValue` passes) but never fires the input's `onChange`,
so the component's STATE never updates — and hydration then REVERTS the field to
state. Anything that reads state afterward loses the value:

- A Save that builds its FormData from component state (Settings'
  `PublicUrlSettings`/`SmtpSettings`) persists the empty/stale value
  **silently** (an empty value is a valid save), and no value-assertion catches
  it because the DOM looked set — this was the ~1/3-under-load `email-auth:58`
  flake.
- An autosave-on-blur card (`useSaveStatus`) never sees a change, so no save
  fires and a later `reload → toHaveValue` mismatch flakes LOUDLY.

`settledFill(page, field, value)` waits until React has attached its
`__reactFiber$…`/`__reactProps$…` markers to the node (the same hydration signal
`followLink` waits on for clicks) BEFORE filling, so `onChange` fires and the
value lands in state. Use it wherever a spec fills a controlled input and then
relies on component state — Settings save-from-state cards and autosave-on-blur
fields are the canonical victims. `settledFill` guarantees the value reached
state, NOT that a later save kept it; when the save's success is silent (empty
is valid), also reload-and-assert the persisted effect (the email-auth
precedent).

The **checkbox** analog is `settledCheck(page, box, checked)`. A
`.check()`/`.uncheck()` before hydration clicks a controlled checkbox
(`checked={…} onChange={…}`) but no `onChange` is wired, so state never flips
and hydration reverts the box — Playwright then reports
`check: Clicking the checkbox did not change its state` (the `food-telegram`
line-26 flake). `settledCheck` waits for the same hydration markers, then
`setChecked(checked)` (idempotent — a no-op when already in the target state, so
it subsumes a `if (!await box.isChecked())` guard) and confirms it holds. Its
text-input sibling stays `settledFill`.

### The bystander-poll false-settle is APP-WIDE, and a following `goto` LOSES the write (#1437)

The `settledClick` caveat first written for the Family screen (#1111) is not
family-specific. **Every** app page mounts two headless watchers —
`ImportJobsToaster` and `ExtractionToaster` — and each polls a Server Action on
a 6-second timer. Server Actions POST to the CURRENT route URL, so from
Playwright's side those are indistinguishable from the action a click fires.
Measured while idle on `/records/history/visits`: **2 POSTs every 6s**, on every
authenticated route.

**#1949 moved both polls to a `fetch` GET, and #1952 correlated the wait** (see
below) — but the doctrine stands, because the poll is not the only thing that can
POST to a route you are standing on. `settledClick` used to arm a wait for ANY
same-origin POST, so it could resolve on one of those polls while the click's own
action was still in flight. Usually harmless — the follow-up retrying `expect`
absorbs the lag. It is NOT harmless when the next line NAVIGATES:

```ts
await settledClick(
  page,
  addCard.getByRole("button", { name: "Add", exact: true })
);
await page.goto("/nutrition?tab=supplements"); // ← aborts the in-flight create
```

A `goto`/`reload` right after a false-settle aborts the pending action request
and the write is **lost, not late**. Reproduced deterministically by delaying
the action POST: the row never lands, and the spec then fails at some LATER
assertion about a downstream surface ("element(s) not found"), which reads like
a rendering/timing bug on a page that is in fact perfectly correct — the
appointment simply does not exist. That is the #1437 census red
(`surgery-bridge.spec.ts`), twice, at `retries: 0`.

**Rule:** when a settled click is followed by a NAVIGATION, settle on the
durable **server-rendered marker the completed mutation produces** before
navigating —

```ts
await settledClick(page, addBtn);
await expect(ourScheduledRows(page)).toHaveCount(1); // holds the page until it commits
await page.goto("/nutrition?tab=supplements");
```

The assertion's own retry is the wait, it can't be faked by a poll, and —
crucially — nothing navigates away while the action is still in flight. Same
shape as the `mood-server-logged` precedent in `helpers.ts`. Keep spec CLEANUP
under this rule too: a cleanup click followed by a `goto` can drop the cleanup
and hand the next spec a mutated shared profile.

### "Any POST" was never a contract (#1952)

The bystander poll above had a second, quieter victim. Because the wait accepted
ANY same-origin POST, a `settledClick` aimed at a control that posts **nothing**
was satisfied by the toasters' poll — so ~22 tests across 14 spec files asserted
nothing about their own click and passed anyway. That is the worst shape a green
test can have: it does not fail when the product breaks, it fails when unrelated
traffic goes away. #1949 removed the traffic and all 22 went red at once.

`settledClick` now correlates. Two filters replace "any POST":

1. **Started after the click** — requests are collected from a `page.on("request")`
   window opened in the same synchronous turn as `locator.click()`, matched on
   Playwright's `Request` object identity. A poll already in flight when the click
   landed can no longer satisfy the wait, which is the #1437 false-settle above.
2. **Is a Server Action** — Next stamps every hydrated action dispatch with a
   `next-action` header carrying the action id, and a route-handler POST (`/api/…`)
   has none. The pre-hydration native `<form>` submit is the one action without that
   header (its id rides the body), so it is still matched on the route it
   necessarily posts to. `opts.url` overrides both.

   This filter was originally "targets this page's route", and that is where the
   first regression came from: it is true of a Server Action, but pinning the route
   at ARM time breaks on the unwind `followLink` documents — the App Router can
   commit a destination and then fall back to the source route mid-interaction. On
   `illness-episode-followups` it did exactly that, and the Save action **and** both
   toaster polls posted to `/` after unwinding off `/medical/episodes/2`, so the
   arm-time pin rejected the click's own action and blamed the call site for a
   navigation underneath it. Keying on the header is both tighter (a same-route
   `/api` POST no longer qualifies) and immune to the unwind. **A same-route filter
   that needs per-call-site `{ url }` opt-outs would have been the weaker design;
   this one needs none.**

**What it does not guarantee, stated plainly:** two Server Actions are
indistinguishable from outside the browser unless you pin their action ids, which
are build-generated hashes no spec should hard-code. A background actor that posted
an action AFTER the click would still satisfy the wait. Nothing does that
today, and `chrome-refresh-scan`'s chrome-actor list is where such an actor would
have to appear — but the guarantee is "an action POST to this route, caused no
earlier than this click", not "this click's action". Where that residue matters
(a settled click followed by a navigation), the durable-marker rule above still
applies.

When this wait does time out, the failure now reports the page it armed on, the
page the browser is on NOW, every same-origin POST it saw with the reason each was
refused, and the click's own error if the click never landed — so the next reader
does not have to re-instrument the helper to find out which of those happened.

**The lesson for the call site, which is the half that actually recurs:** a
control that opens something — a disclosure, a chip, an overflow menu, a confirm
sheet — posts nothing, and the thing it opened is the honest signal. Two of the
sites this issue corrected only post in the OTHER branch of their own logic:
`dup-cluster-merge` submits a clean cluster but merely opens the picker for a
conflicting one, and a row's "Remove" awaits `confirm()` and posts only on yes.
The testid is not the signal; what the handler does with the state it is in is.

## Where fixtures live (the #1511 split)

`e2e/seed-events.ts` and `e2e/fixture-logins.ts` **keep their names** — the
run's global setup still runs the former (once, into the template DB), every
spec still imports from the latter — but both are now thin composers over
per-domain modules:

- `e2e/seed/*.ts` — one module per domain (`training`, `medical`, `intake`,
  `household`, `illness`, `metrics`, `nutrition`, `dashboard`, …), each
  exporting `seedX()` functions that the entrypoint calls **in the original
  order**. That order is load-bearing: fixtures build on rows earlier calls
  insert, and row ids follow insertion order, so a NEW domain's call is appended
  at the end unless it must run earlier. Helpers used by more than one domain
  (`seedMemberLogin`, `fixtureProfileId`, `grantProfile`, `PROFILE_ID`) live in
  `e2e/seed/common.ts`; fixture DATA never does.
- `e2e/logins/*.ts` — the same domain split for the credential +
  fixture-profile-name constants, re-exported (alphabetically) from
  `e2e/fixture-logins.ts`.
- `e2e/fixture-profile.ts` stays put: `createFixtureProfile` /
  `destroyFixtureProfile` are the blessed profile CONSTRUCTOR pair, not seed
  content.
- `e2e/helpers.ts` stays ONE module on purpose — it is the settle-primitive
  chokepoint, and two homes for the same wait is the drift it exists to prevent.
  Its functions are ordered ALPHABETICALLY so additions stop landing on the same
  trailing lines.

The point is merge-queue throughput: two PRs adding fixtures for different
domains no longer touch the same file. **The hygiene guard's scan is recursive**
(`specFiles()` walks `e2e/**`), so the moved content keeps being scanned — a
guard that silently stopped seeing it would be worse than the conflicts.

### The fixture-LOGIN budget (#1392)

The seeded fixture population is **monotonic**: every dedicated fixture login is
a permanent row under Settings → People & access and a permanent member of the
grant matrix.
That ratchet is what grew the family page into the #830/#1111/#1392 census
family (a 5 MB `O(logins × profiles)` render that starved the durable-row probes
until the #1412 collapse capped it at `O(logins)`). The product fix removed the
cliff; this rule removes the ratchet.

**Seed a fixture LOGIN only when a spec signs in as it, or when the login itself
is the subject** (access control, the family screen). A separate login is the
only way to drive a non-profile-1 active profile in its OWN cookie context
without mutating the shared admin `storageState`'s server-side active profile —
that is a real need and it stays. But a fixture that only wants an **isolated
profile** takes `fixtureProfileId(name)` in `seed-events.ts` and **no login**: a
profile is cheap here, a login is not.

Enforced by the hygiene guard's sixth check: every `E2E_LOGIN_*` constant in the
fixture-login modules must be referenced by a spec AND used in a sign-in
position (`loginAs(` / `creds(` / `username:`). A deliberate exception carries a
written reason in `LOGIN_NO_SIGNIN_ALLOW` (today: the sleep-page hash-clone
TEMPLATE login and the `#1412` grant-matrix subject login). A login no spec
references at all fails as dead weight. Census of the population when the guard
landed: **94 login constants, 92 signed in as, 2 justified exceptions, 0
droppable** — the budget's job is the next 94, not this one.

### The fixture-PROFILE constructor (#1487)

A fixture profile created with a bare `INSERT INTO profiles` is **not** the
profile a user can create. `createProfile` (Settings → People & access) and
`bootstrapAuth` both seed the standard Overview metric saves
(`lib/standard-metric-seeds.ts`); a raw insert seeds nothing. That divergence
was invisible for as long as Trends Overview rendered the four standard metric
tiles unconditionally — and became a broken state the moment \#1487 made the
grid membership-driven, because ~107 raw-SQL fixture profiles would have
rendered an EMPTY Overview that production can't reach.

So every e2e profile is created through the one blessed constructor
`e2e/fixture-profile.ts` — `createFixtureProfile(db, name)` (or
`createFixtureProfileWithId` for a fixture that pins an id), which delegates to
the same production seeding core. `fixtureProfileId(name)` in `seed-events.ts`
routes through it, so the ordinary "give me an isolated profile" path needs no
thought; a spec that creates its own profile on a directly-opened handle imports
it.

**The destructor is half of it.** The moment the constructor started seeding,
two specs' hand-rolled cleanups — clear my own rows, then `DELETE FROM profiles`
— began failing on `saved_items.profile_id`'s foreign key. Creation gained
side-state; the destructors did not. So the module ships the pair:
`destroyFixtureProfile(db, id)` removes what the constructor wrote and then the
profile row, while a spec's OWN fixture data stays the spec's business. When the
production seed core grows a second table, it is added in ONE file instead of
being chased through the suite as FK failures.

Enforced by the hygiene guard's seventh check: `INSERT INTO profiles` **and**
`DELETE FROM profiles` are both frozen at ZERO in every `e2e/*.ts` except the
constructor module, which owns the markers (note the guard is a text scan —
phrase a comment about the pattern without spelling the statement out, or it
counts itself). The general rule it encodes: **a fixture must be reachable by a
real user gesture, and disposable by its own destructor** — when a creation path
grows a side effect, the fixture constructor/destructor pair grows with it,
rather than each spec re-deriving day-one state (or its teardown) by hand.

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
relative to the wall clock** (`today()`, "now − N hours/days"), so whether a
seeded row lands inside a day/week window depends on WHEN the suite runs. A run
that crosses local midnight invalidates its "today"-seeded specs en masse —
observed twice during the 2026-07-18→19 window: `illness-hero`'s "00:05
(Yesterday)" instead of a same-day relative age, `workout-presence`'s
live-session chip/dock rendering nothing (the seeded draft's `date` no longer
today), `workout-heatmap`'s active-day cells, `protocol-reach`'s ongoing
shading. The early-morning `now − N hours` window also underflows across
midnight.

The fix freezes the app's notion of "now" for the run via a single env-gated
seam, **`lib/clock.ts`**:

- `now()` reads `ALLOS_TEST_NOW` (an ISO instant) at CALL time — unset ⇒ real
  time (production is inert, zero behavior change), set ⇒ that fixed instant. It
  NEVER monkey-patches the global `Date`: timers, session TTLs, and Playwright's
  own waiting keep real time. Only DATE-DERIVATION paths route through it —
  `today()` (`lib/db.ts`, the load-bearing consumer), the `now`-defaulting
  parameters of the workout-presence / recommend / redose / food-slot / dose-log
  read+write cores, and the seed math that anchors fixtures — so the fixtures
  and the app agree on "today" by construction. Durations, log/audit timestamps,
  and cache TTLs stay real.
- `playwright.config.ts` computes `FROZEN_NOW` ONCE at config load — the run's
  **real start instant** (#1048, PR #1103; originally a fixed 12:00 local, which
  opened the "morning-UTC band": runtime-written rows keep real SQL
  `datetime('now')` wall-time, so whenever real time lagged the frozen noon by
  hours, every liveness/recency window read a just-written row as stale and ~10
  specs failed deterministically. Freezing at real start keeps |real − frozen|
  bounded by the run's own duration, which every recency window tolerates, at
  every hour; the residual is only a run that STARTS within its own duration of
  real midnight) — and hands it to `e2e/global-setup.ts` via `config.metadata`,
  which seeds the template under it and persists it to
  `e2e/.data/run-context.json`. Every worker's server reads that file and boots
  with the same `ALLOS_TEST_NOW`, so `scripts/seed.ts`, `e2e/seed-events.ts` and
  every `next start` in the run share one instant (workers are separate
  processes — a module-level `new Date()` would give each of them a different
  one). An externally-supplied `ALLOS_TEST_NOW` wins, so a boundary hour (e.g.
  `00:10` local) can be stress-tested on demand:
  `ALLOS_TEST_NOW="<today>T00:10:00" npm run test:e2e -- illness-hero workout-presence`.

`ALLOS_TEST_NOW` is a **test hook, not an operator knob** — it is deliberately
absent from `.env.example`. `bootTasks` (`lib/migrations/boot-tasks.ts`) logs a
`WARN [clock]` on every boot when it is set, so a misconfigured production
instance running on a frozen clock is loudly visible.

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

**The SQL-side clock (#1534) — the half the freeze couldn't reach.**
`ALLOS_TEST_NOW` freezes the JS clock; SQLite's own `date('now')` /
`datetime('now')` / `CURRENT_TIMESTAMP` reads the REAL one, and no env var can
change that. So a run that STRADDLES real 00:00 UTC writes rows stamped on one
side of the boundary and reads them back against a `today()` on the other, and
every date-keyed assertion becomes a coin flip — 3 of 4 shards red on two PRs on
the 2026-07-25→26 night (one of them a JSON-only edit, which is what proved it
main-side), in an exclusively date-keyed failure set. #1464's forward NUDGE only
moved the frozen instant to the side of the boundary the run spends most of its
time on; it cannot make a SQL stamp follow.

The rule, and it is a rule about SEMANTICS, not about which function you like:

- A stamp whose **calendar DAY** is later read — a SQL `date(col)` /
  `substr(col, 1, 10)`, a JS `.slice(0, 10)` / `dateFromCreatedAt`, a
  `YYYY-MM-DD` comparison, or a per-day `GROUP BY` that meets a
  `today()`-derived value — is bound from the seam: **`sqlNow()`**
  (`lib/clock.ts`), which renders `now()` in SQLite's `datetime('now')` shape
  (`"YYYY-MM-DD HH:MM:SS"`, UTC) so it sorts, compares and truncates identically
  to a SQLite-written value. In production the override is unset and the two are
  byte-identical, so the rewrite is inert outside the suite.
- Everything else **keeps SQL's real clock on purpose**, because the seam must
  never own a DURATION: session/token expiry, lease and claim timeouts,
  rate-limit windows, retention cutoffs, rolling "last N days" windows, and
  plain "last modified" audit stamps.

`lib/__tests__/sql-clock-seam.test.ts` is the guard: a pure source scan over
`lib`/`app`/`scripts` that fails CI on a NEW raw now-read in query text, with a
per-file frozen count and a written reason for every keep. Column DEFAULTs of
`(datetime('now'))` live in shipped, immutable migrations and are out of the
scan's reach, so the write sites that must not rely on one bind `sqlNow()`
explicitly (`intake_items`, `intake_item_doses`, `intake_item_logs`,
`medical_documents`, `conditions`, `allergies`, `imaging_studies`, `goals`,
`injuries`).

The belt to that braces is a **CI backstop** in `.github/actions/e2e-setup` (so
the sharded matrix, the changed-spec lane and `e2e-full.yml` all inherit it):
when the suite is about to start within 12 minutes of UTC midnight it sleeps
past the boundary, loudly, bounded at 13 minutes. It runs LAST in setup, so the
~4 min build already counts toward clearing the boundary; outside the window it
is a no-op. It is honest about being a mitigation — it covers the forks of the
problem the audit missed.

## Fix (e) — sharded CI, the on-demand full-suite workflow, and flake telemetry

Three CI-shape changes from the flaky-e2e hardening pass (the merge-latency side
of the problem; the orchestration runbook `docs/orchestration.md` documents the
pain they replace):

- **The CI e2e job is a 4-way shard matrix.** Each shard is a fresh runner + a
  fresh `npx playwright test --shard=N/4` invocation → fresh app/demo servers
  per chunk. That roughly halves the per-push e2e wall-clock AND removes the
  long-lived-server cumulative degradation the runbook documents for
  single-process full runs (its local finding — "each shard finishes clean where
  one process degrades" — applied to CI). The changed-spec scrutiny lane moved
  to its own `e2e-changed` job so its zero-retry verdict lands fast without
  waiting on the matrix. Shared setup (Node, deps, Chromium, `next build`) lives
  in the composite action `.github/actions/e2e-setup/action.yml` so the jobs
  can't drift.
- **`.github/workflows/e2e-full.yml` is the fresh-runner full-suite gate — on
  demand AND weekly.** Dispatch it against any branch (defaults: `--retries=0`,
  4-way sharded; `repeat_each` up to 3 for suite-wide hardening) in place of a
  local full-suite run before a migration PR or big UI merge — it
  institutionalizes the runbook's conclusion that "CI on a fresh GitHub runner
  is the ultimate authority", skipping the local degradation-vs-regression
  triage. It ALSO runs on a **weekly `schedule`** (Sundays) as a drift census:
  the whole suite on main at `--retries=0 --repeat-each=2`. Per-PR CI runs each
  spec once, so a newly-introduced low-rate timing flake can land green and only
  bite weeks later; the weekly census re-proves the retries=0 cleanliness and
  names any drift in its check annotations. A red weekly run is a new
  flake-ledger item — fix the named spec like #1159; never re-add retries. (On a
  `schedule` event `inputs.*` is empty, so the run step's `|| '0'` / `|| '2'`
  fallbacks pick the census form; the `event_name`-scoped concurrency group
  keeps a manual dispatch and the weekly run from cancelling each other.)
- **Pass-on-retry flake telemetry → the retries drop.** The telemetry ran the
  full suite at `retries: 1` and posted every `status: "flaky"` (pass-on-retry)
  test to the job summary via a `json` reporter
  (`test-results/e2e-results.json`)
  - `scripts/e2e-flake-report.mjs`, so the flake backlog was measured instead of
    masked. That backlog was the precondition for dropping retries — and once it
    read clean (the family-calendar flake, the last item, closed by #1159), the
    sharded CI matrix moved to **`retries: 0`** (`playwright.config.ts`). The
    suite now runs at zero retries end-to-end — changed-spec lane, shared-infra
    fallback, and full matrix — so a flake fails the run loudly instead of
    shipping green on a retry. The telemetry step stays wired: an on-demand
    `e2e-full.yml` census dispatched at `--retries=1` still surfaces
    pass-on-retry tests through the same script, and at the default `retries: 0`
    it reports an accurate empty.

## Fix (f) — DB-per-worker isolation (#1538)

Until this landed, the suite booted ONE app server against ONE seeded SQLite
database and ran every worker against it, so `--workers>1` fabricated failures
(two specs writing the same rows at the same moment) and the local gate was
pinned to `--workers=1` — 30–60 minutes on a large spec set, the pipeline's
biggest wall-clock tax.

**Why server-per-worker.** `lib/db.ts` opens ONE `better-sqlite3` handle at boot
from `ALLOS_DB_PATH` and keeps it for the process lifetime. One server is
therefore exactly one database for life; routing a per-request database inside a
single server would mean rewriting the product's connection singleton. So a
database per worker means a server per worker. The cost is one `next start` per
worker (~0.2 s boot, ~190 MB RSS) against ONE shared production build.

**The shape.**

- `e2e/global-setup.ts` runs ONCE: it makes sure the production build is current
  (see below), then seeds the two TEMPLATE directories — `e2e/.data/template/`
  (`scripts/seed.ts` → `e2e/seed-events.ts`, in that load-bearing order) and
  `e2e/.data/template-demo/` (the same seed under `ALLOS_DEMO_MODE=1`) — and
  writes the run's frozen instant to `e2e/.data/run-context.json`. There is no
  `webServer` block any more.
- A template is a DIRECTORY, not a bare `.db`: the seed also writes cwd-relative
  artifacts the app later reads (`data/logs/errors.jsonl` — the Settings →
  Errors fixture — plus uploads and integration payloads), so the seed runs with
  the template dir as its CWD and everything travels with the copy.
- `e2e/fixtures.ts` exports the `test` every spec imports. Its **worker-scoped**
  `workerApp` fixture copies the template into
  `e2e/.data/worker-<workerIndex>/`, boots
  `next start <repoRoot> -p <PORT_BASE + parallelIndex>` **with that directory
  as CWD**, signs in as admin against that server, and overrides the `baseURL`
  and `storageState` options. Because Playwright fills in missing context
  options from the test's resolved `use` (including for a manual
  `browser.newContext()`), `page.goto("/timeline")` and `loginAs(browser, …)`
  target this worker's server with no per-spec change.
- The server's CWD is what isolates every cwd-relative runtime artifact:
  `data/uploads/**`, `data/logs/ai.jsonl`, `data/logs/errors.jsonl`,
  `data/backups/**`. Those used to be shared by every spec in the run (and were
  wiped out of a developer's own `data/` on each run); now they are per worker,
  and the repo-root `data/` is never touched.
- **No `auth.setup.ts` / no shared `e2e/.auth/state.json`.** A session is a row
  in ONE database, so a single shared storage state cannot authenticate N
  databases; each worker signs itself in and keeps its own `auth.json`.
- **The demo project has no second server.** `e2e/fixtures.ts` recognises the
  `demo` project by name and boots THAT worker's server with `ALLOS_DEMO_MODE=1`
  off the demo template, unauthenticated. The project sets
  `fullyParallel: false` so `demo.spec.ts` keeps running in one worker, in
  order.

**Worker directory vs slot port (why two indices).** Playwright retires a worker
process after a failed test and starts a REPLACEMENT for the same slot, and the
two OVERLAP — the replacement sets up while its predecessor is still tearing
down. So the DIRECTORY (database, uploads, logs, storage state) is keyed on
`TEST_WORKER_INDEX`, unique per worker PROCESS: a replacement never wipes a
directory another process is still serving from. Only the PORT is keyed on the
slot (`TEST_PARALLEL_INDEX`) — ports must stay a small bounded range — and it is
handed over explicitly: the replacement kills the pid recorded in
`e2e/.data/slot-<n>.pid` and waits for the listener to go. On a red run that
hand-off happens once per failure, which is why it is a reclaim rather than an
error.

**Direct-DB specs.** A spec that opens SQLite itself resolves the file with
`workerDbPath()` (`e2e/worker-env.ts`) — the ONE module mapping a worker index
to its port, directory, database, mailbox and storage state. It keys on
`TEST_PARALLEL_INDEX`, which Playwright sets on the worker process before it
loads any test file, so a module-level `const DB = workerDbPath()` already
resolves to that worker's database. Reading `process.env.ALLOS_DB_PATH` from a
spec is banned by the hygiene guard: that variable is the APP SERVER's
environment, not the spec process's.

**A build is now required locally.** Per-worker servers run `next start`, so
local runs no longer use `next dev` (which takes a per-project single-instance
lock and would make each worker compile every route it touches). `global-setup`
builds automatically when `.next/BUILD_ID` is missing or older than any build
input (`app/`, `components/`, `lib/`, `public/`, and the root configs — `e2e/**`
is excluded, so editing a spec never triggers a rebuild). `E2E_SKIP_BUILD=1`
never builds, `E2E_FORCE_BUILD=1` always does; in CI the build step owns it and
`global-setup` only asserts it exists.

**Ports.** Worker N listens on `PORT_BASE + N`, `PORT_BASE` from `E2E_PORT`
(default 3100) — a RANGE, not the old app/demo pair. Give a worktree a range
wide enough for its worker count.

**Workers.** Locally the Playwright default (half the cores) applies; pass
`--workers=N` or `PW_WORKERS=N`. **CI still runs one worker per shard**: the
4-way shard matrix already spends a 2-core runner, and several `next start`
processes on it would trade honest parallelism for swap. Raising it is now a
measurement, not a redesign.

**Measured (48-spec / 212-test slice, one 4-core container, back to back).** The
shared-DB harness at `--workers=4` fails 20 tests; DB-per-worker at
`--workers=4` fails 16 — and the six it drops are exactly the shared-world class
(the dose ledger's restructure/skip history, 2FA enrolment, the login-scoped
Trends default range, a cross-profile illness hero). At `--workers=1` the two
harnesses are indistinguishable (4 vs 3 failures, ~11 min each; the residue
fails on both and is an interaction-latency problem in that container, not
isolation). Wall-clock on that box: 11.1 min at one worker, 8.3 min at two,
9.1–10.1 min at four — four workers means four `next start` processes AND four
browsers on four cores, so the curve turns over at two. On a bigger machine the
useful worker count is higher; the Playwright default (half the cores) is the
right starting point either way.

**One clock, everywhere — a spec's "now" is the frozen now (#1538 follow-up).**
`ALLOS_TEST_NOW` freezes the SERVER's `now()` for the whole run, but a browser
cannot read an env var, and neither can a spec process. That gap is the length
of the run, and it stopped being negligible: a `--repeat-each=3` lane over a
large spec set runs ~90 minutes, where the old assumption "real time ≈ frozen
time" breaks outright. It failed first as a deterministic red 29 minutes into a
lane — `workout-presence`'s finished-session test back-dates the activity form's
CLIENT-prefilled start by 40 minutes and gives it a 30-minute duration, a
10-minute margin, so once real time had run 10+ minutes past the frozen instant
the session it wrote ended in the SERVER's future and the #924 recap card never
rendered. Two halves close it:

- **The browser** runs on the frozen clock: `e2e/fixtures.ts` patches
  `browser.newContext` so every context — the built-in `page`/`context` fixtures
  and every hand-built one (`loginAs`, anonymous, phone-viewport) — gets
  `clock.setSystemTime(frozenNow)`. The clock still TICKS from there
  (`setSystemTime`, not `setFixedTime`), so timers, animations and polling are
  untouched and elapsed time within a test stays real.
- **The spec** derives timestamps from `frozenNow()` (`e2e/worker-env.ts`),
  never `new Date()` / `Date.now()`. The hygiene guard freezes today's
  wall-clock reads per file; a new one needs `frozenNow()` or a same-line
  `clock-ok: <why>` marker, which is for uses that are NOT stored timestamps — a
  unique-name suffix, a TOTP probe that genuinely needs real time.

Verified as a before/after: with the run's frozen instant set 60 minutes in the
past, the #1441 test fails 3/3 without the context clock and passes 3/3 with it.

**What isolation does NOT buy you.** A worker's database is copied once per
worker, not once per test, so specs sharing a worker still share a world in
sequence — and which specs share a worker depends on the scheduler. Fixture
ownership (#868) is unchanged, and exact-count assertions against shared-seed
rows stay banned.

## The `mobile` project — opt-in phone-viewport coverage (#1420)

Every project used to run at 1280×900, so the mobile shell (`MobileNav`'s top
bar and slide-in drawer, bottom sheets, touch targets) had no regression
coverage except in the handful of specs that hand-set a phone viewport via
`test.use`. The `mobile` project (playwright.config.ts) closes that:
iPhone-class **390×844**, `hasTouch: true`, same per-worker seeded DB and same
per-worker session as `chromium` — nothing else differs.

**It is opt-in, not a second copy of the suite.** Its `testMatch` admits exactly
two things:

- `smoke.spec.ts` — the broad "every primary surface renders" sweep, worth
  having at both viewports (it is the only spec that runs in BOTH projects); and
- any spec named **`*.mobile.spec.ts`**.

The naming convention was chosen over a `@mobile` tag because it needs no
per-test annotation, it is visible in `ls e2e/`, and CI needs no new filter: the
`e2e-changed` lane globs `^e2e/.*\.spec\.ts$` and runs
`npx playwright test <specs>` with **no `--project` filter**, so a changed
`*.mobile.spec.ts` lands in this project automatically (and a changed
`smoke.spec.ts` runs in both). The sharded full matrix likewise runs
`npm run test:e2e`, so the mobile project rides along and its handful of tests
distribute across the four shards — the suite grows by the mobile spec count,
never by a mobile clone of the whole thing.

That routing takes BOTH halves of the config, and the second half is easy to
forget: a `--project`-less run executes a spec in **every** project whose
filters admit it, and `chromium`'s `testMatch` admits everything — so `chromium`
carries `testIgnore: /\.mobile\.spec\.ts$/`, without which every mobile spec
would ALSO run at 1280×900 and fail deterministically in CI (it did, on the
first push of \#1420). `demo` needs no such guard: its `testMatch` only admits
`demo.spec.ts`. **Verify a mobile spec the way CI invokes it — with no
`--project` flag.** A local `--project=mobile` run masks this class of
misrouting exactly.

**Writing a mobile spec.** Name it `<feature>.mobile.spec.ts` and set NO
viewport (the project owns it — a `test.use({ viewport })` inside would defeat
the point). Every rule in this doc applies unchanged: spec-owned fixtures,
settled interactions from `e2e/helpers.ts`, no `waitForTimeout`/`networkidle`,
no unmarked `.first()`/`.toPass(`, `retries: 0`. One mobile-specific helper
lives in the blessed module: **`openMobileDrawer(page)`** — the drawer's
`<aside>` is not even mounted until the hamburger is tapped, and that tap fires
no action and no navigation (a pure `setOpen(true)`), so it is decision-tree
case 4 (a marked re-tap loop, safe because the hamburger only ever sets `open`
true). Use it rather than re-rolling the tap.

`e2e/smoke.mobile.spec.ts` is the reference spec (bar renders, hamburger mounts
the drawer, the drawer carries the shared `<SidebarContent>` nav, a drawer link
navigates). Acceptance was verified the way the issue asked: hiding the
hamburger (`display: none`) fails 14 tests in this project and none in the
desktop ones.

Note the one shared-spec accommodation: `smoke.spec.ts`'s "the app shell
rendered, not a Next error boundary" anchor is now viewport-conditional
(`appShellAnchor`) — the desktop sidebar is `hidden md:flex` and its links live
in the unmounted drawer on a phone, so below `md` the anchor is the hamburger
instead of the sidebar's Data link. That is the shape to copy if another
dual-viewport spec needs one: pick the anchor from `page.viewportSize()`, don't
fork the spec.

## Driving touch gestures (#1425 / #1469)

Gesture specs live in the `mobile` project (`hasTouch`) and drive real Chromium
touch input through `touchSwipe` in `e2e/helpers.ts` (CDP
`Input.dispatchTouchEvent` — `page.touchscreen` only taps, and `page.mouse`
produces pointer events the app's gestures deliberately ignore). Two traps cost
a debugging session each and are now handled inside the helpers, so specs never
have to think about them:

- **Measure only a settled element.** `centerOf` polls `boundingBox()` until two
  reads agree. Every overlay arrives on a 240ms slide; coordinates taken
  mid-animation send the touch to a position the panel has already left, and the
  gesture silently lands on some other element.
- **A swipe cannot be retried.** Unlike a tap, re-firing a day-swipe skips a
  day, so a gesture spec waits for hydration deterministically (`shell-chrome`'s
  `data-ready="true"`) instead of looping a `toPass`.

A swiped client navigation also commits only when the destination's RSC payload
arrives, which on the Timeline can take several seconds cold — give those URL
assertions a real timeout rather than the 5s default.

Full reasoning: `docs/internals/overlays.md`.

## Follow-up (out of scope for the infra PR)

Migrate the grandfathered offenders incrementally, one spec per PR (the #860
Track-B incremental-migration discipline), lowering the allowlists (`.first()`
and `.toPass(` are the two with remaining backlog — `networkidle` is empty and
`waitForTimeout` is down to its irreducible absence-of-effect proofs) each time
until they are empty; then migrate the cross-ownership anatomy assertions
(class 2) onto shared per-component driver helpers (the `e2e/symptom-helpers.ts`
extraction pattern).

Dropping full-suite retries — the last item on this list — is **done**: the
flake reports (fix e) read clean once #1159 closed the family-calendar flake,
and the sharded CI matrix moved to `retries: 0` (see the telemetry note above).
Keep it that way — a spec that can't hold at zero retries is a flake to fix, not
a run to retry.

## Recurring-failure census

CI failures at `--retries=0` that recurred on diffs that could not have caused
them. Two unrelated-diff occurrences of the same failure earn an entry here and
a named-ceiling (or root-cause) fix; one occurrence is exonerated by a local
3×-at-CI-parity pass and a retrigger.

| Spec / assertion                                                                                               | Occurrences                                                                                                                                                                                   | Diagnosis                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `imaging.spec.ts` — PET row after Add (`toContainText("PET …")`)                                               | 2026-07-29 (PR #1666, trends-only diff), 2026-07-30 (PR #1694, release-notes JSON only), 2026-07-30 (PR #1715) — the third occurrence waited the FULL 20 s ceiling and the row never appeared | **Latency is DISPROVEN as the explanation** — a 20 s ceiling did not save it, on a shard whose two sibling imaging tests passed in 1.1 s and 1.5 s. The real defect was that this test alone submitted BLIND: `settledClick` resolves on any same-origin POST, including one carrying a refusal, and `addImagingStudy` reports failure as an inline `role="alert"` with no row. A refused, a never-submitted and a merely slow add were therefore indistinguishable, and all three surfaced 20 s later as a bare "element(s) not found" on the row locator — a signature that names neither the failure nor its reason. Instrumented locally (see Resolution): the write always commits, the repaint is driven by the add action's own response (proven by disabling the layout's 6 s `ExtractionToaster`/`ImportJobsToaster` polls — the repaint still lands), the form is fully hydrated before the fills, and the repaint costs ~0.3 s unthrottled / ~8 s under a 25× CPU throttle. The CI trigger itself is not yet named: the `error-context.md` artifacts for all three runs live on blob storage that this environment's egress policy blocks. | Assert the SUBMIT OUTCOME (`submitWithToast`, "Study saved") at parity with the two sibling tests, plus an explicit `imaging-study-list` visibility assertion so "list missing" is distinguishable from "row missing"; the 20 s ceiling stays but now covers only post-success repaint. Product fix in the same change: `revalidateImaging()` revalidated `/results`, a pure `redirect()` stub that renders no imaging, so nothing but the client-side `router.refresh()` could ever repaint the list — it now revalidates `/results/imaging`, the route that renders it. **A next occurrence is expected to fail at the toast with the inline error in the snapshot; re-open this entry with that text.** |
| `shell.mobile.spec.ts` — the measurements form inside the quick-entry overlay (`#m-weight`)                    | 2026-07-30, measured locally at CI parity on the PR branch AND on unmodified `main` (3×3 runs, ~10.5 s per test either way)                                                                   | Same class: the overlay's props arrive from a Server Action whose response carries a re-render of the seeded profile's dashboard — the heaviest page in the app — which exceeds the 5 s default on a loaded runner regardless of the diff. Raising only the ceiling made both trees pass 3/3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Named 20 s ceiling on that assertion (PR for #1525/#1633).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `illness-front-door.spec.ts` — `symptom-log-bar` after `feeling-sick-activate`                                 | 2026-07-30 (PR #1702, release-notes JSON only); previously failing 3/4 locally on clean main (flagged in #1695's report)                                                                      | Same Server-Action full-page re-render latency class — the activate action's re-render exceeds the 5 s default on a loaded shard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Named 20 s ceilings on the three post-activate `symptom-log-bar` waits (this change).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `illness-front-door.spec.ts` — `temp-quick-entry` closes after quick-save (`toHaveCount(0)`)                   | 2026-07-31 (PR #1755, release-notes JSON only)                                                                                                                                                | Same Server-Action full-page re-render latency class as the row above — the quick-save action's re-render exceeds the 5 s default on a loaded shard; the panel only unmounts when it lands.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Named 20 s ceiling on the post-save `temp-quick-entry` count assert (this change).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `wellness-practices.spec.ts` — first `practice-log-button` after the second create (`settledClick` pre-assert) | pre-2026-07-31 watch-list occurrence (unrelated diff); 2026-07-31 (PR #1758, patient-portals-only diff)                                                                                       | The second Save's Server-Action re-render repaints the whole practice list, and `settledClick`'s own pre-visibility assert runs at the 5 s default — it does not honor `opts.timeout` — so the first card lookup after the save can outrun it on a loaded shard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Named 20 s ceiling on the first post-create card wait before the `settledClick` sequence (this change). If a third spec hits the same shape, fix `settledClick` to honor `opts.timeout` in its pre-assert instead of ceiling call sites one at a time.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
