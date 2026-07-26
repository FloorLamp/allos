// Shared credential + fixture-profile names for the e2e trends fixtures. Composed
// into e2e/fixture-logins.ts (which every spec and seeder still imports from) —
// see that file's header for the rules these constants live under. Add a login or
// fixture-profile name for THIS domain here, beside the fixtures that use it.

// #1067 Phase 1 — Trends → Body mobile overhaul. A dedicated adult profile with a
// KNOWN, PARTIAL set of synced body metrics so the chart-jump chips + per-chart
// anchors are deterministic: it has weight + resting HR (the body-composition
// block), steps, a sleep night, and one day of heart-rate minutes — but NO
// hydration / BMR / calories / lean-mass / BMI etc., so those metrics' chips must
// be ABSENT (the "chartless charts hide their chip" assertion). Read-only grant;
// the spec only navigates + scrolls (no writes), so --repeat-each stays clean.
export const E2E_LOGIN_TRENDS_BODY = "e2e_trends_body";
export const TRENDS_BODY_PROFILE = "Trends Body (e2e)";

// ── Curated Trends Overview (issue #1487 rendering half / #1485 A+B) ─────────
// A dedicated adult profile for the membership-driven Overview grid. It owns a
// KNOWN tile mix so both halves of the grid are deterministic at phone width:
//   populated → weight + resting HR (two weigh-ins, so two tiles draw a sparkline)
//   empty     → body fat + training volume (never logged) and a starred analyte
//               with no readings at all → the #1485 A compact one-line rows
// Dedicated ON PURPOSE (#868): the spec UNSTARS a standard metric and stars it
// back through the picker. Doing that on profile 1 would move a shared-seed tile
// to the front of the saved order (a re-star is a fresh save) and change the grid
// every other Trends spec reads. Write grant — the spec's writes are its own
// profile's saved_items, and it restores them itself, so --repeat-each stays clean.
export const E2E_LOGIN_TRENDS_CURATE = "e2e_trends_curate";
export const TRENDS_CURATE_PROFILE = "Trends Curate (e2e)";
// A canonical analyte this profile has NO readings for — the never-measured saved
// tile. (Profile 1 seeds its own; this one must not depend on that.)
export const TRENDS_CURATE_EMPTY_ANALYTE = "Ferritin";
