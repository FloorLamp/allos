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

// A member with a dedicated adult profile for the matrix COLUMN select-all (#1868 §2).
// Isolated for the same reason the per-cell matrix fixture is: a column sweep rewrites
// a whole channel's disabled-kinds blob in one write, which on a shared login would
// silence ten kinds for every other spec's session — and the safety-survival assertion
// needs to read a column this spec alone has touched.
export const E2E_LOGIN_NOTIF_SWEEP = "e2e_notif_sweep";
export const NOTIF_SWEEP_PROFILE = "Notif Sweep (e2e)";
