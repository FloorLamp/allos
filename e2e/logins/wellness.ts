// Shared credential + fixture-profile names for the e2e wellness fixtures. Composed
// into e2e/fixture-logins.ts (which every spec and seeder still imports from) —
// see that file's header for the rules these constants live under. Add a login or
// fixture-profile name for THIS domain here, beside the fixtures that use it.

// #3066 — the practice ZERO STATE. A dedicated adult profile with no practice
// target and no practice log, which is the whole fixture: the defect is that the
// #1620 nav gate hides /wellness for exactly this profile while every other door
// onto practices needs a practice to already exist.
//
// It needs its OWN profile because the state under test is an ABSENCE on the shared
// seed's most-used domain — profile 1 tracks practices, and a spec that deleted them
// to reach the zero state would break every other practice spec reading the same
// rows. Write grant (the spec creates the first practice) and the spec removes what
// it created, so --repeat-each stays clean.
export const E2E_LOGIN_PRACTICE_ZERO = "e2e_practice_zero";
export const PRACTICE_ZERO_PROFILE = "Practice Zero (e2e)";
