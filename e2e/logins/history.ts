// Shared credential + fixture-profile names for the e2e timeline fixtures. Composed
// into e2e/fixture-logins.ts (which every spec and seeder still imports from) — see
// that file's header for the rules these constants live under. Add a login or
// fixture-profile name for THIS domain here, beside the fixtures that use it.

// ── Timeline mobile chrome budget (issue #1517) ──────────────────────────────
// ONE login granted TWO dedicated profiles. The second one is still earning its keep
// after #4851: the day view's standalone symptom card used to arrive already open
// when an illness-type situation was active, and "no card even then" is a per-profile
// branch that a profile without an active illness cannot state.
//
// Dedicated ON PURPOSE (#868): the shared seed's profile 1 carries a live episode
// and a rotating symptom history, so "this day has no symptoms" is a landmine there;
// and the busy-day fixture below needs a day with enough events to scroll through,
// which a shared profile's day cannot promise under --repeat-each.
//
// All dates are DEEP PAST (2026-01-*, per the #1511 relative-or-deep-past rule) so
// they never drift into or out of a relative window. The spec's writes are two rows on
// the quiet day below — the add door's and the ⋯ correction's — each on its own symptom
// key and cleared either side of the test that makes it.
export const E2E_LOGIN_TL_CHROME = "e2e_tl_chrome";
// Acting profile (created first ⇒ lowest id ⇒ first accessible): no active
// situation, one day WITH symptoms, one day without, one day full of events. The
// symptom day is also what earns this profile its Symptoms chip — the Add past row
// offers the kinds a profile HAS rows for, like every other chip on it.
export const TL_CHROME_WELL_PROFILE = "Timeline Chrome Well (e2e)";
// The second profile, carrying an ACTIVE illness-type situation and no symptom rows
// — so an ordinary quiet day can prove the retired auto-open (#4851 item 3) is gone
// on the one profile that used to trigger it.
export const TL_CHROME_SICK_PROFILE = "Timeline Chrome Sick (e2e)";

// A day with enough events to give the single-day view real scroll range at 390px,
// which is what makes "the day nav is still reachable mid-page" assertable.
export const TL_CHROME_BUSY_DAY = "2026-01-20";
// A day carrying symptom rows, which is what puts `symptom` in this profile's
// present kinds and therefore the Symptoms chip in its Add past row.
export const TL_CHROME_SYMPTOM_DAY = "2026-01-15";
// A day with nothing on it at all — where the spec's own writes land (the add door's,
// and the ⋯ correction's), and the only fixture day it mutates.
export const TL_CHROME_QUIET_DAY = "2026-01-18";
// The title every busy-day activity carries, so the spec can count its own rows.
export const TL_CHROME_ACTIVITY = "TL Chrome Session";
// THE BUSY DAY'S ONE CLOCK-TIMED EVENT, and the only thing on it the day chart can
// draw as a tick (#4974). The twenty sessions are day-granular, so before this the
// chart on the busiest fixture day had an empty tick rail and "a tick tap scrolls
// the row without moving the chart" had nowhere to be asserted: the other day with
// ticks (#1068's) is six rows long, too short for its rail to have anywhere to
// stick. Late in the day on purpose — the feed lists it below the sessions, so the
// jump is long enough to pass the rail's pinning point.
export const TL_CHROME_TICK_DOC = "e2e-tl-chrome-evening-panel.pdf";
export const TL_CHROME_TICK_TIME = "00:20";

// ── Timeline base empty state (issue #1410) ──────────────────────────────────
// A login granted ONE profile that holds NOTHING — no activities, no metrics, no
// documents. The thing under test is a brand-new account's first impression of the
// Timeline, and that state is unreachable on any profile carrying fixture rows: the
// shared seed's profiles all have history, and a spec cannot delete its way to
// "empty" on a profile it doesn't own. So the fixture IS the emptiness — nothing is
// seeded beyond the login and the grant, and the spec only READS, which keeps it
// repeat-safe and keeps the profile genuinely empty for the next repeat.
export const E2E_LOGIN_TL_EMPTY = "e2e_tl_empty";
export const TL_EMPTY_PROFILE = "Timeline Empty (e2e)";
