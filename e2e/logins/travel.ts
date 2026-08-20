// Shared credential + fixture-profile names for the e2e travel fixtures. Composed
// into e2e/fixture-logins.ts (which every spec and seeder still imports from) —
// see that file's header for the rules these constants live under.

// #3263 — the travel banner. TWO dedicated adult profiles and TWO logins, because
// the rule with the sharpest edge is about WHOSE day a device may speak for:
//
//   • E2E_LOGIN_TRAVEL is granted the TRAVELLER profile only, with own_profile_id
//     pointing at it. Acting as itself, so the banner is offered.
//   • E2E_LOGIN_TRAVEL_CARER is granted BOTH, with own_profile_id still pointing at
//     the traveller. The COMPANION profile is created FIRST so it holds the lower id
//     and is therefore the acting profile on sign-in (createSession takes
//     accessibleProfiles[0]) — which is precisely "a member acting from the
//     traveller's device, for somebody who is not them". That session must see
//     nothing, from the same browser, in the same zone.
//
// SPEC-OWNED END TO END: the spec MOVES the traveller profile's timezone, which
// changes that profile's whole calendar for the rest of the worker's run. Nothing
// else may read these profiles. Both follow the run's pinned timezone at seed time
// (no fixture-timezone override) — the switch under test is a RUNTIME one, made
// through the product's own control.
export const E2E_LOGIN_TRAVEL = "e2e_travel";
export const E2E_LOGIN_TRAVEL_CARER = "e2e_travel_carer";
export const TRAVEL_COMPANION_PROFILE = "Travel Companion (e2e)";
export const TRAVELLER_PROFILE = "Travel Traveller (e2e)";
