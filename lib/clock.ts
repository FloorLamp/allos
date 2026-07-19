// The app's single clock seam (issue #990). Exposes the app's notion of "now" so an
// e2e run can FREEZE the wall clock — a suite run can then never cross local midnight
// out from under its "today"-seeded fixtures, and never lands in the early-morning
// now-minus-hours window (see docs/internals/e2e-hygiene.md).
//
// The override is read at CALL time from the ALLOS_TEST_NOW env var (an ISO instant):
//   • unset            ⇒ real time — zero behavior change, so production is inert.
//   • set to an instant ⇒ that fixed instant, every call.
//
// This seam covers only DATE-DERIVATION paths — today()/window/range/dueness and the
// relative-date labels computed from them (plus the seed math that anchors fixtures to
// the same "today"). It must NEVER be used for durations, timers, session TTLs, log
// timestamps, or Playwright's own waiting — those keep real time. And it NEVER
// monkey-patches the global Date: timers and the runtime keep the real clock.
//
// ALLOS_TEST_NOW is a TEST HOOK, not an operator knob — it is intentionally absent
// from .env.example. A boot-time warning (see lib/migrations/boot-tasks.ts) makes a
// misconfigured production instance loudly visible.

// The raw override string, or undefined when unset/blank. Read fresh each call so a
// test can set/unset it per process without a stale cache.
export function clockOverride(): string | undefined {
  const v = process.env.ALLOS_TEST_NOW;
  return v && v.trim() ? v : undefined;
}

// The app's "now". Returns the ALLOS_TEST_NOW instant when set to a valid date,
// otherwise the real current instant. An unparseable override is ignored (falls back
// to real time) so a typo can't freeze the clock at the epoch.
export function now(): Date {
  const override = clockOverride();
  if (override) {
    const d = new Date(override);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}
