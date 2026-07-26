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

import { utcSqlString } from "./date";

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

// The app's "now" in SQLite's `datetime('now')` shape — "YYYY-MM-DD HH:MM:SS", UTC,
// no zone marker — so a stamp written from JS sorts, compares, and `date()`-truncates
// exactly like one SQLite wrote itself.
//
// This is the DATE-SEMANTIC write path (issue #1534). SQL's own `datetime('now')`
// reads the REAL clock, which the freeze above cannot reach: a suite that STRADDLES
// real UTC midnight writes rows stamped on one side of the boundary and reads them
// back against a `today()` on the other, and every date-keyed assertion becomes a
// coin flip. #1464's forward nudge fixed only the JS half of that.
//
// So: bind `sqlNow()` wherever the stamp's calendar DAY is later read — a SQL
// `date(col)`, a `.slice(0, 10)`, a `YYYY-MM-DD` string comparison, or a per-day
// GROUP BY that meets a `today()`-derived value. Pure audit stamps keep SQL's real
// clock on purpose: "last modified" displays, session/token expiry, lease claims,
// rate-limit windows, and retention cutoffs are all DURATIONS, and the clock seam
// must never be used for durations (see the header above).
//
// In production the override is unset, so this is byte-identical to what SQLite
// would have written — the rewrite is inert outside the e2e suite.
export function sqlNow(): string {
  return utcSqlString(now());
}
