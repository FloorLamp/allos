// Shared credential + fixture-profile names for the e2e member logins seeded by
// e2e/seed-events.ts (issue #391). Kept in a PLAIN module (no @playwright/test
// import) so BOTH the seeder (a tsx script) and the specs can import the same
// constants without pulling Playwright into the seed process. The seeder creates
// each login directly in the DB (username + scrypt hash + a single grant) so a
// spec can sign in as an isolated, non-admin session in its OWN cookie context —
// which lets a test drive a NON-profile-1 active profile (a child, a fixture
// integration profile) WITHOUT mutating the shared admin storageState's
// server-side active profile (the flake class the shared-session switchProfile
// helpers risk under parallel workers).

export const E2E_MEMBER_PASSWORD = "e2e-member-pass-1234";

// A member granted ONLY the seeded "Riley (child)" profile, so Riley is its sole
// (and therefore active) profile on login. Read-only uses across specs:
//   - equipment-manager: the age-gate redirect off /settings/equipment,
//   - integrations-strava: the disconnected (no-connection) setup form,
//   - immunizations: proving reads are profile-scoped (Riley's own empty list),
//   - ai-logs-access: a member is bounced off the admin-only AI logs page.
// Every one of those is a READ, so concurrent sessions of this login never
// contend on shared data.
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

// A member granted a dedicated profile carrying ONE same-source duplicate — two
// manual weigh-ins on one day (both "Manual entry") — so the Data → Review resolver
// renders a candidate pair whose source labels collide and the A/B disambiguation
// (#531) fallback is exercised in isolation, never touching profile 1's review
// inbox (whose exact duplicate count import-dedup.spec relies on).
export const E2E_LOGIN_DUP = "e2e_dup";
export const DUP_REVIEW_PROFILE = "Dup Review (e2e)";
