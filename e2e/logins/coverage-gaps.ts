// Shared credential + fixture-profile names for the e2e coverage-gaps fixtures. Composed
// into e2e/fixture-logins.ts (which every spec and seeder still imports from) —
// see that file's header for the rules these constants live under. Add a login or
// fixture-profile name for THIS domain here, beside the fixtures that use it.

// A member granted ONLY the seeded "Riley (child)" profile, so Riley is its sole
// (and therefore active) profile on login. Read-only uses across specs:
//   - equipment-manager: the age-gate redirect off /equipment,
//   - integrations-strava: the disconnected (no-connection) setup form,
//   - immunizations: proving reads are profile-scoped (Riley's own empty list),
//   - ai-logs-access: a member is bounced off the admin-only AI logs page.
// Most uses are reads. The pediatric-medication persistence spec adds one medication
// on the isolated e2e DB; no other spec depends on Riley's medication list.
export const E2E_LOGIN_CHILD = "e2e_child";

// A member granted a dedicated profile whose Strava connection is seeded in the
// terminal `needs_reauth` state, so /integrations/strava renders the reconnect CTA.
export const E2E_LOGIN_STRAVA = "e2e_strava";
export const STRAVA_REAUTH_PROFILE = "Strava Reauth (e2e)";

// A member granted a dedicated, connection-less profile used to exercise the
// Health Connect generate → rotate token flow. It MUTATES only its own profile's
// connection (never profile 1's, whose unconnected state the review-inbox spec
// relies on).
export const E2E_LOGIN_HC = "e2e_hc";
export const HEALTH_CONNECT_PROFILE = "Health Connect (e2e)";

// #1063 — the mobile clipped-content audit. A dedicated profile whose Health
// Connect connection is seeded CONNECTED with a long, synthetic DB-backed token,
// so the mobile-overflow spec can assert the endpoint/token rows fit a phone
// viewport WITHOUT generating or rotating anything — the HEALTH_CONNECT_PROFILE
// above is owned by the generate→rotate spec, whose token mutations would race a
// concurrent reader under parallel workers. Read-only in its spec.
export const E2E_LOGIN_MOBILE_HC = "e2e_mobile_hc";
export const MOBILE_HC_PROFILE = "Mobile HC (e2e)";

// #1991 — the day-grouped sync history. A member granted a dedicated profile whose
// Health Connect connection carries a DAY of high-frequency pushes (the exporter
// re-sends its rolling window every ~20 minutes), so the spec can assert that ~30
// runs collapse to one day line with its one anomaly, and that the drill-in promises
// only the records it can actually list. Its own profile, because the assertions are
// about a stream nothing else may add to.
export const E2E_LOGIN_SYNC_HISTORY = "e2e_sync_history";
export const SYNC_HISTORY_PROFILE = "Sync History (e2e)";

// #2146 — the quiet-stream row on Data → Review. A member granted a dedicated adult
// profile whose Health Connect connection is HEALTHY (recent ok pushes right up to
// the frozen clock) while its `hr_minutes` stream stopped hours ago, with the three
// days behind today carrying data so the shared #2097/#2146 expected-active gate
// passes. That combination is the whole point of the fixture and it must not be
// disturbed: on any shared profile a neighbour's push or minute row would move one
// half of it. Read-only in its spec. Synthetic, no PHI.
export const E2E_LOGIN_QUIET_STREAM = "e2e_quiet_stream";
export const QUIET_STREAM_PROFILE = "Quiet Stream (e2e)";
