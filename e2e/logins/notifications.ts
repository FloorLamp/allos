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
