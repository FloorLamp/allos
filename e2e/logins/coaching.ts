// Shared credential + fixture-profile names for the e2e coaching fixtures. Composed
// into e2e/fixture-logins.ts (which every spec and seeder still imports from) —
// see that file's header for the rules these constants live under. Add a login or
// fixture-profile name for THIS domain here, beside the fixtures that use it.

// #1148/#1150 — the coaching rest card. A dedicated adult profile tripping TWO
// concurrent under-recovery signals at once: a short night (below the 6h floor →
// rest-sleep) AND an elevated resting HR (62 vs a ~54 baseline → rest-rhr), plus one
// old strength activity for training context. So the dashboard coaching card leads with
// the salience-ordered primary AND shows the "Also: …" line (#1148), and the
// "Training anyway" acknowledgment (#1150) has a real multi-signal rest rec to
// transform. Isolated on purpose: the ack/snooze writes here would race the coaching
// specs' reads on profile 1; its own profile means --repeat-each stays clean (the spec
// resets its ack/snooze rows itself).
export const E2E_LOGIN_REST = "e2e_rest";
export const REST_CARD_PROFILE = "Rest Card (e2e)";

// Well-day symptom logging + the reported-burden coaching tilt (issue #1300). A member
// granted a dedicated adult profile with a small strength history (so coaching has content,
// not the empty state) and NO illness / NO rest signals — a clean WELL profile. The spec
// logs a severe symptom from the check-in Report entry and asserts the coaching card tilts
// toward an easier session naming the symptom, with the suggest-only illness bridge present
// but not required. Dedicated + isolated so the symptom write never perturbs a neighbor.
export const E2E_LOGIN_WELLSYM = "e2e_wellsym";
export const WELL_SYMPTOM_PROFILE = "Well Symptom (e2e)";
