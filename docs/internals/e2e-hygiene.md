# Writing E2E tests

A browser test must protect a user journey or integration that a cheaper tier
cannot observe. Start with the [change and test policy](../change-policy.md).
Use existing helpers and fixtures; do not create a second test harness.

## Fixtures and isolation

- Import `test` from `e2e/fixtures.ts`. It supplies worker-local databases,
  servers, authentication, the frozen clock, and streamed-content handling.
- Give writes and derived assertions spec-owned data. A shared profile's count,
  latest reading, average, or empty state can change when another test writes.
- Reuse login identities unless login/session behavior is the subject. Isolate
  health data with a profile, not another expensive password hash.
- Use `fixtureProfileId` in `e2e/seed-events.ts`, or the constructors in
  `e2e/fixture-profile.ts`. They apply production profile defaults. Remove your
  own domain rows and use `destroyFixtureProfile` for constructor-owned state.
- Restore settings and rows you change. Worker isolation does not prevent two
  tests on that worker from leaking into each other.
- A temp directory comes from `makeTmpDir` (`lib/__tests__/tmp-dir.ts`); lint
  refuses a raw `mkdtemp` in any test tier.
- A fixture must represent a state a real user can reach. Include realistic
  boundary cases only when they distinguish the behavior under test.

## Time

- Use the shared frozen clock (`ALLOS_TEST_NOW`). App and browser must agree.
- Construct profile-local instants through
  `zonedWallTimeToUtc(getTimezone(profileId), day, "HH:MM")`; naive datetime
  strings are host-dependent. Keep instants distinct from local date labels.
- `e2e/pinned-timezone.ts` chooses the run's zone. Read
  `e2e/fixture-timezones.ts` before using an exception; its reason must still
  match the fixture's behavior.
- If a display switches to profile-local days, update fixtures feeding that
  column and verify the relevant zones/boundaries. One start hour is insufficient
  evidence for a time-dependent failure.

## Interactions

`e2e/helpers.ts` owns the decision tree and implementation. Use its helpers:

| Interaction                                   | Helper                                             |
| --------------------------------------------- | -------------------------------------------------- |
| Server Action button                          | `settledClick`                                     |
| Action plus an asynchronously rendered result | `settledClickApplied`                              |
| Navigation to a fixed URL                     | `followLink`                                       |
| Relative navigation or a toggle               | `hydratedClick`, then assert the destination/state |
| Controlled input                              | `settledFill`, `settledCheck`, `settledSelect`     |
| Input that autosaves                          | Corresponding `*Save` helper                       |
| File input posting an action                  | `settledUpload`                                    |
| Mobile drawer                                 | `openMobileDrawer`                                 |
| Touch gesture                                 | `touchSwipe`, `touchSwipeFrom`, `touchPinch`       |

A repeat must be idempotent. Repeating a toggle or a relative Next button can
undo or overshoot the desired state. Action completion and rendered application
are separate events: wait for the one the next assertion needs.

Do not use `networkidle` to infer hydration or arbitrary sleeps to settle a
write. For absence-of-effect windows, carry the `waitfortimeout-ok` reason the
lint rule asks for; do not add another generic delay helper.

Use `appContent(page)` and scoped locators to avoid a streamed staged copy.
Anchor on the item's own identity element; a row's text may include unrelated
picker options. Avoid `.first()` as a substitute for identifying the subject.
Keep established dialogs, disclosures, and combobox interaction helpers.

## Assertions and CSS

- Assert persisted writes, navigation, accessible state, meaningful order, or
  usable controls. Do not pin exact classes, colors, spacing, or obsolete labels.
- Wait for the specific loaded child before measuring its container. A loading
  placeholder can fit while the real content clips.
- For an opened `Disclosure`, wait until its inner content fits the disclosure
  before capturing or hit testing; `getAnimations()` completion may not cover
  the `::details-content` transition.
- Use `expectNoClippedContent` for clipped content; document scroll width alone
  cannot detect content hidden by an overflow-clipping ancestor.
- Read related geometry in one settled snapshot (`settledBoxes` where suitable).
  Use geometry only when it proves usability and no semantic assertion can.
- An absence assertion must reach the state that could produce the unwanted
  effect. Do not let polling skip past a transient defect's observation window.
- A race test must deliberately reach its race window.

## Run and inspect

Run authored/edited files once with `--retries=0`. When tests share mutable
state, run the whole file with `--workers=1`.

Mobile files use `*.mobile.spec.ts`; the project supplies viewport and touch
settings. Verify routing without a `--project` filter, as CI does. A desktop-named
file can still set a phone viewport, so filenames alone do not identify coverage.

For shared UI changes, search for affected testids, roles, routes, locator helper
calls, and geometry assertions. A spec can be affected without naming the changed
component. This identifies coverage; it does not authorize rewriting expectations.

[Orchestration E2E/CI](../orchestration/e2e-ci.md) owns who runs local/full suites,
build reuse, and the merge bar. [Diagnosis](e2e-diagnosis.md) covers failure
mechanisms and reproduction. The `e2e/**` blocks in `eslint.config.mjs` refuse the
settle, clock, harness and family shapes above (a reviewed exception is an
`eslint-disable-line` with its reason); `lib/__tests__/e2e-hygiene.test.ts` keeps
the offline-navigation rule and the count ratchets. Do not grow either's
exceptions to make a spec pass.
