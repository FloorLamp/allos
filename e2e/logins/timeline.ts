// Shared credential + fixture-profile names for the e2e timeline fixtures. Composed
// into e2e/fixture-logins.ts (which every spec and seeder still imports from) — see
// that file's header for the rules these constants live under. Add a login or
// fixture-profile name for THIS domain here, beside the fixtures that use it.

// ── Timeline mobile chrome budget (issue #1517) ──────────────────────────────
// ONE login granted TWO dedicated profiles, because the thing under test is a
// per-profile DEFAULT: the day view's symptom entry opens on arrival when the day
// already carries symptoms OR an illness-type situation is active, and stays
// collapsed otherwise. Those are three states of the same component and no single
// profile can hold them all — a profile with an active illness is expanded on EVERY
// day, which is exactly the branch that has to be provable separately.
//
// Dedicated ON PURPOSE (#868): the shared seed's profile 1 carries a live episode
// and a rotating symptom history, so "this day has no symptoms" is a landmine there;
// and the busy-day fixture below needs a day with enough events to scroll through,
// which a shared profile's day cannot promise under --repeat-each.
//
// All dates are DEEP PAST (2026-01-*, per the #1511 relative-or-deep-past rule) so
// they never drift into or out of a relative window, and the spec only navigates,
// scrolls and toggles client state — no writes, so it is repeat-safe.
export const E2E_LOGIN_TL_CHROME = "e2e_tl_chrome";
// Acting profile (created first ⇒ lowest id ⇒ first accessible): no active
// situation, one day WITH symptoms, one day without, one day full of events.
export const TL_CHROME_WELL_PROFILE = "Timeline Chrome Well (e2e)";
// The second profile, carrying an ACTIVE illness-type situation and no symptom rows
// — so an ordinary quiet day must still arrive with the entry open.
export const TL_CHROME_SICK_PROFILE = "Timeline Chrome Sick (e2e)";

// A day with enough events to give the single-day view real scroll range at 390px,
// which is what makes "the day nav is still reachable mid-page" assertable.
export const TL_CHROME_BUSY_DAY = "2026-01-20";
// A day carrying symptom rows (the "you are amending" auto-expand).
export const TL_CHROME_SYMPTOM_DAY = "2026-01-15";
// A day with nothing on it at all (the collapsed case).
export const TL_CHROME_QUIET_DAY = "2026-01-18";
// The title every busy-day activity carries, so the spec can count its own rows.
export const TL_CHROME_ACTIVITY = "TL Chrome Session";

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
