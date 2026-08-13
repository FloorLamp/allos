// Shared credential + fixture-profile names for the e2e notifications fixtures. Composed
// into e2e/fixture-logins.ts (which every spec and seeder still imports from) —
// see that file's header for the rules these constants live under. Add a login or
// fixture-profile name for THIS domain here, beside the fixtures that use it.

// A member granted a dedicated ADULT profile for the Home Assistant channel-config
// spec. Isolated as of #1025: the spec persists a REAL (unreachable) HA webhook to
// prove the config round-trip, and the temperature write paths now dispatch the
// red-flag nudge immediately — so an HA config left on a shared profile turns any
// crossing-temp log elsewhere in the suite into a failed real send that overwrites
// the GLOBAL delivery-health marker the notify-delivery-error spec asserts on. On
// its own profile (which no spec logs temperatures for), the persisted config can
// never be dispatched to.
export const E2E_LOGIN_HA_NOTIFY = "e2e_ha_notify";
export const HA_NOTIFY_PROFILE = "HA Notify (e2e)";

// A member with a dedicated adult profile for the digest ⚙️ Tune mirror spec (#1714).
// Isolated because the preference this spec writes is LOGIN-scoped and persists: on a
// shared login it would silence digest categories for every other spec's session, and
// a --repeat-each run would re-enter with the previous run's state.
export const E2E_LOGIN_DIGEST_TUNE = "e2e_digest_tune";
export const DIGEST_TUNE_PROFILE = "Digest Tune (e2e)";

// A member with a dedicated adult profile for the email notification channel spec
// (#1855). Isolated because the channel enable, the content mode, and the email
// matrix column are all LOGIN-scoped and persist for the worker's whole run — on a
// shared login a --repeat-each pass would re-enter with the previous run's state,
// and an enabled email channel would join every other spec's session. The address
// the spec writes onto logins.email is per-run-unique, like email-auth's.
export const E2E_LOGIN_EMAIL_NOTIFY = "e2e_email_notify";
export const EMAIL_NOTIFY_PROFILE = "Email Notify (e2e)";

// A member with a dedicated adult profile for the matrix COLUMN select-all (#1868 §2).
// Isolated for the same reason the per-cell matrix fixture is: a column sweep rewrites
// a whole channel's disabled-kinds blob in one write, which on a shared login would
// silence ten kinds for every other spec's session — and the safety-survival assertion
// needs to read a column this spec alone has touched.
export const E2E_LOGIN_NOTIF_SWEEP = "e2e_notif_sweep";
export const NOTIF_SWEEP_PROFILE = "Notif Sweep (e2e)";

// A member with a dedicated adult profile for the matrix column-liveness spec
// (#2565 part B). Isolated for both reasons at once: the spec drives the HOME ASSISTANT
// column from not-set-up to set-up and back, and that config is PROFILE-scoped, while
// the routing ticks it reads are LOGIN-scoped. It also needs a channel whose liveness
// no other spec can move — Telegram, Push and Email liveness all depend on instance-wide
// config that neighbouring specs configure and reset, so only a profile-owned channel
// gives a stable dead→live transition. Same #1025 hazard as the HA config fixture: the
// webhook it persists must never live on a profile any spec logs temperatures for, and
// the spec leaves the channel DISABLED as it found it.
export const E2E_LOGIN_MATRIX_INK = "e2e_matrix_ink";
export const MATRIX_INK_PROFILE = "Matrix Ink (e2e)";

// Two dedicated profiles for the persisted notify-tick log viewer (#2209). The spec
// asserts on RUN ROWS grouped by (run, profile), so it must own every line it counts
// — a shared profile would let another fixture's tick lines drift into its totals.
// Two profiles, because the point of the page is that BOTH shapes render: one that
// declined things, and one QUIET one the tick evaluated and had nothing to say about.
export const NOTIFY_LOG_BUSY_PROFILE = "Notify Log Busy (e2e)";
export const NOTIFY_LOG_QUIET_PROFILE = "Notify Log Quiet (e2e)";

// A dedicated ADMIN login + two profiles for the admin notification opt-in (#2345).
// It must be an admin (that is the whole case) and its own — never the shared admin
// storageState — because the spec writes login_profiles rows that decide who the
// fan-out reaches, and doing that to the storageState admin would quietly enrol
// every other spec's session as a recipient. OWN is declared as the login's
// own_profile_id (so the locked-on "your own profile" row has something to be), WARD
// is the un-opted-in profile the spec checks and unchecks.
export const E2E_LOGIN_NOTIFY_SCOPE = "e2e_notify_scope";
export const NOTIFY_SCOPE_OWN_PROFILE = "Notify Scope Own (e2e)";
export const NOTIFY_SCOPE_WARD_PROFILE = "Notify Scope Ward (e2e)";
