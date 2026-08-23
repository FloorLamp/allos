// Shared credential + fixture-profile names for the e2e Trash fixtures. Composed into
// e2e/fixture-logins.ts (which every spec and seeder still imports from) — see that
// file's header for the rules these constants live under. Add a login or
// fixture-profile name for THIS domain here, beside the fixtures that use it.

// ── Data → Trash: dedicated profiles east and west of UTC (issues #3546, #3547) ──
//
// TWO THINGS AT ONCE, and they are the same fixture because they are the same need.
//
// #3547 — `e2e/trash.spec.ts`'s "Empty trash" test presses a control that deletes
// EVERY `deleted_rows` capture on the acting profile. On profile 1 — the shared admin
// profile every desktop spec browses as — that is a live violation of #868 fixture
// ownership: it destroys captures the test did not create, so no spec can seed a
// trashed row and trust it to still be there, and e2e/trash-probe.ts's plant-and-sweep
// exists only to work around it. The behaviour under test genuinely requires emptying,
// so the fix is scoping rather than avoidance: on a profile nothing else writes to,
// "everything" is only ever this spec's own rows.
//
// #3546 — a Trash row prints the profile-local day of the delete INSTANT. That
// conversion is only observable where the UTC day and the local day DIFFER, and no
// pin-following profile can ever show it: e2e/pinned-timezone.ts puts local time at
// 13:mm precisely so the local date always equals the frozen instant's UTC date. A
// fixture at midday proves nothing here — being at midday IS the defect class.
//
// WHY THESE TWO ZONES. Fixed-offset `Etc/GMT` zones (no DST, so the offset is the same
// on every date the suite is ever run) at the two extremes, ±25 hours apart. That is
// what lets ONE planted instant straddle in BOTH directions at once: at 11:30 UTC the
// east profile has already rolled into the next local day and the west profile has not
// yet left the previous one, so one capture renders three different days across east,
// UTC and west — and a `.slice(0, 10)` can only ever answer with the middle one. The
// same pairing the multi-view Timeline fixture uses for the same reason (#1329).
//
// Note the POSIX-INVERTED SIGN: `Etc/GMT-13` is UTC+13 and `Etc/GMT+12` is UTC−12.
//
// SEPARATE LOGINS, one profile each, rather than one login granted both: the spec
// needs to LOOK AT each profile's Trash page, and two sign-ins are cheaper and far
// less flake-prone than driving the acting-profile switcher between assertions.
export const E2E_LOGIN_TRASH_EAST = "e2e_trash_east";
export const TRASH_EAST_PROFILE = "Trash East (e2e)";
export const TRASH_EAST_TZ = "Etc/GMT-13"; // UTC+13

export const E2E_LOGIN_TRASH_WEST = "e2e_trash_west";
export const TRASH_WEST_PROFILE = "Trash West (e2e)";
export const TRASH_WEST_TZ = "Etc/GMT+12"; // UTC−12

// The UTC wall-clock hour every planted capture is stamped at. THE ONE HOUR OF THE DAY
// that is a different calendar day in both zones at once: 11:30 + 13 = 00:30 tomorrow
// in the east, 11:30 − 12 = 23:30 yesterday in the west. Move it and one of the two
// directions stops being tested while both assertions stay green.
export const TRASH_STRADDLE_HHMMSS = "11:30:00";
