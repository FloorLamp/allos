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
//
// THIS FILE IS A THIN COMPOSER (issue #1511). The constants themselves live in
// per-domain modules under e2e/logins/, mirroring the e2e/seed/ domain modules
// that seed them — so two PRs adding fixtures for different domains no longer
// collide here. Import sites are unchanged: everything is re-exported below, so
// specs and seeders keep importing from "./fixture-logins". Add a NEW constant to
// the domain module that seeds it; add a line below only for a new domain.
// Re-exports are listed ALPHABETICALLY — insert alphabetically.

export * from "./logins/coaching";
export * from "./logins/coverage-gaps";
export * from "./logins/dashboard";
export * from "./logins/findings";
export * from "./logins/household";
export * from "./logins/illness";
export * from "./logins/intake";
export * from "./logins/medical";
export * from "./logins/metrics";
export * from "./logins/notifications";
export * from "./logins/nutrition";
export * from "./logins/shared";
export * from "./logins/situations";
export * from "./logins/training";
export * from "./logins/trends";
