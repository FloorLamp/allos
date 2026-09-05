// Shared credential + fixture-profile names for the global-search fixtures. Composed
// into e2e/fixture-logins.ts (which every spec and seeder still imports from) — see
// that file's header for the rules these constants live under. Add a login or
// fixture-profile name for THIS domain here, beside the fixtures that use it.

// ── Search into the record (issue #5006) ────────────────────────────────────
// ONE login over ONE dedicated profile carrying one row of each kind the spec picks:
// a practice session, a food serving and a symptom, each on its own DEEP-PAST day
// (#1511) so no relative window can drift them in or out.
//
// Dedicated ON PURPOSE (#868): the assertion is "the hit lands on THIS row", which
// needs a title no other fixture row shares and a day whose row set the spec can
// state. The shared seed's profile 1 logs practices and servings continuously, so
// both halves would be a lottery there. The spec only READS — it opens the palette,
// types, and follows the hit — so the fixture survives --repeat-each untouched.
export const E2E_LOGIN_SEARCH_RECORD = "e2e_search_record";
// NOT NAMED "Search …": the sidebar's own Search control is reached by
// `getByRole("button", { name: /^Search/ })` in e2e/nav-consolidation.spec.ts and
// e2e/profile-identity-bar.spec.ts, and every fixture profile a login can switch to
// renders a button carrying that profile's name. A profile called "Search Record"
// made those locators resolve to three elements instead of one.
export const SEARCH_RECORD_PROFILE = "Logged Rows (e2e)";

// The three seeded entries. Each name is deliberately unlike anything in the shared
// seed's vocabulary, so a hit carrying it can only be this fixture's row.
export const SEARCH_RECORD_PRACTICE = "Moonlight breathwork";
export const SEARCH_RECORD_PRACTICE_DAY = "2026-01-12";
// A curated food group: the spec types its NAME ("Leafy greens"), which is not a
// substring of the stored `leafy_greens` key — the half a slug-only LIKE would miss.
export const SEARCH_RECORD_FOOD_GROUP = "leafy_greens";
export const SEARCH_RECORD_FOOD_NAME = "Leafy greens";
export const SEARCH_RECORD_FOOD_DAY = "2026-01-13";
// Same shape one kind over: stored `sore_throat`, typed "Sore throat".
export const SEARCH_RECORD_SYMPTOM = "sore_throat";
export const SEARCH_RECORD_SYMPTOM_NAME = "Sore throat";
export const SEARCH_RECORD_SYMPTOM_DAY = "2026-01-14";
