// Shared credential + fixture-profile names for the e2e nutrition fixtures. Composed
// into e2e/fixture-logins.ts (which every spec and seeder still imports from) —
// see that file's header for the rules these constants live under. Add a login or
// fixture-profile name for THIS domain here, beside the fixtures that use it.

// A member granted a dedicated profile carrying ONE same-source duplicate — two
// manual weigh-ins on one day (both "Manual entry") — so the Data → Review resolver
// renders a candidate pair whose source labels collide and the A/B disambiguation
// (#531) fallback is exercised in isolation, never touching profile 1's review
// inbox (whose exact duplicate count import-dedup.spec relies on).
export const E2E_LOGIN_DUP = "e2e_dup";
export const DUP_REVIEW_PROFILE = "Dup Review (e2e)";

// A member granted a dedicated ADULT profile that owns NO equipment (issue #592),
// so the activity form's equipment picker hits its empty state and renders the
// "Add equipment" bootstrap door to /equipment. Dedicated on purpose — profile 1
// (and every other fixture profile that a spec logs a non-strength activity on)
// owns gear, so the door only appears where the inventory is provably empty. No
// birthdate → adult → never training-restricted, so /training renders the full log.
export const E2E_LOGIN_NOGEAR = "e2e_nogear";
export const NO_GEAR_PROFILE = "No Gear (e2e)";

// A dedicated ADULT profile carrying a LIVE, in-progress strength session (issue
// #921): an activity logged today with a start_time, NO end_time, and a fresh
// auto-save timestamp — so derived workout presence reads `active`. Drives the
// app-wide workout dock (hydration + reopen) and the household presence chip.
// Isolated on purpose — an always-"active" session on a SHARED profile would plant
// a surprise dock/chip that races neighbor specs.
export const E2E_LOGIN_PRESENCE = "e2e_presence";
export const PRESENCE_PROFILE = "Workout Presence (e2e)";

// A dedicated ADULT profile for the protein-grams quick-add spec (#824): a bodyweight
// (so the adequacy target scales) plus a couple of protein-bearing food-group servings
// today (so the adequacy card renders over the ESTIMATED basis), and NO integration
// protein_g and NO protein_log rows. Isolated on purpose — the spec OWNS the protein_log
// writes on it, and logging grams flips the adequacy card to the COMBINED basis, which
// would race protein-adequacy.spec's shared-profile estimated-basis assertions if it ran
// on profile 1. No birthdate → adult → the food logger + adequacy card render.
export const E2E_LOGIN_PROTEIN = "e2e_protein";
export const PROTEIN_QUICKADD_PROFILE = "Protein Quickadd (e2e)";
// A dedicated ADULT profile carrying a JUST-FINISHED strength session (issue #924):
// a manual activity today with a start_time AND a recent end_time (~8 min ago), two
// working sets that hit their rep target, plus a prior session of the same lift a
// week earlier — so derived workout presence reads `finished` and the finished-
// window dashboard recap card renders with a PR. Read-only; isolated on purpose —
// an always-"finished" session on a SHARED profile would plant a surprise recap
// card that races neighbor specs.
export const E2E_LOGIN_RECAP = "e2e_recap";
export const RECAP_PROFILE = "Session Recap (e2e)";
// Dedicated ADULT + SENIOR profiles for the guided Fitness check spec (#834). Isolated
// on purpose: the spec RECORDS tests (writing fitness_assessments, a VO2 medical_records
// vital, and set rows on an assessment activity), which would perturb profile 1's seeded
// fitness sessions / pillar coverage under --repeat-each. Both carry sex + birthdate so
// the norms percentiles resolve; FITNESS also carries a PRIOR check so a re-record shows a
// check-over-check delta. FITNESS_SENIOR is age 72 so /training?tab=fitness renders the
// older-adult battery variant (arm curl, timed up-and-go, 4-stage balance — never a
// Cooper run or dead hang).
export const E2E_LOGIN_FITNESS = "e2e_fitness";
export const FITNESS_PROFILE = "Fitness Check (e2e)";
export const E2E_LOGIN_FITNESS_SENIOR = "e2e_fitness_senior";
export const FITNESS_SENIOR_PROFILE = "Fitness Senior (e2e)";
// A dedicated ADULT profile for the mobility spec (#840). Carries sex + birthdate (so the
// fitness-norms percentile gate opens) and a LOW sit-and-reach vital, so the Training
// overview's Mobility section renders a deficit→habit SUGGESTION (a Legs mobility habit).
// Isolated on purpose: the spec TAPS moves (writing a recovery activity) and the fixture
// keeps NO seeded recovery session / mobility_region target, so the log bar starts empty
// and the suggestion is present — state a shared profile couldn't guarantee under
// --repeat-each. The spec owns + cleans up its own toggles; it never clicks Accept (which
// would create a persistent target and hide the suggestion on the next repeat).
export const E2E_LOGIN_MOBILITY = "e2e_mobility";
export const MOBILITY_PROFILE = "Mobility (e2e)";

// A dedicated ADULT profile for the food-log slot-aware ranking + N-week habit trend
// specs (#950 / #954). Its per-tap food_log_events ledger is slot-SKEWED — exactly one
// dominant encourage group per window (whole_grains at breakfast, fatty_fish at lunch,
// berries in the evening) — so whatever slot the e2e wall clock lands in, the one-tap
// bar's lead must match the slot chip. It also carries a backdated "fatty fish 2×/week"
// habit (a real multi-week trend) and a freshly-created "leafy greens" habit (an honest
// cold-start trend). Dedicated + read-only on purpose: a slot-skewed ledger or backdated
// target on a SHARED profile would change its ranking/rollup and race neighbor specs.
export const E2E_LOGIN_FOODSLOT = "e2e_foodslot";
export const FOOD_SLOT_PROFILE = "Food Slot (e2e)";

// A dedicated ADULT profile for the nutrition trio (#974/#975/#976). Carries a recent
// weigh-in (a protein/fiber target to scale), this-week food-group servings across both
// protein- and fiber-bearing groups (so the protein gauge's weekly marker + the fiber
// estimate both render), a CONFIRMED capsule-unit fiber supplement today (the honest
// "grams unknown" fiber note), sex = male (a DRI fiber target), and one flagged low
// omega-3 reading (so the #577 engine fires and the vegetarian preset's plant-source
// substitution is observable). Spec-owned: the dietary-preferences spec MUTATES the
// profile's excluded set, so it lives off profile 1 (whose suggestions the coaching specs
// read) — and the preferences spec resets the set in afterAll so it's repeat-safe.
export const E2E_LOGIN_NUTRITION = "e2e_nutrition";
export const NUTRITION_PROFILE = "Nutrition Trio (e2e)";

// A dedicated ADULT profile for the deep-linked food quick-log's protein split (#2061).
// It carries a protein quick-add preset — which is what makes a profile a protein
// TRACKER, so the reserved protein entry joins the ranking mid-list and the quick-entry
// overlay renders the grams control — plus one ongoing protocol whose practice is a
// weekly `red_meat` floor. `red_meat` ranks BELOW protein, so the protocol's "Log
// servings" deep link pins a low-ranked group to the FRONT of the quick rows and the
// control's slice point has to be read off that rendered order rather than the ranked
// one. The profile logs no food at all, so the order is the curated catalog order and
// the pin's rank is deterministic. Isolated on purpose: a protein preset or a food-scope
// protocol on a shared profile would change its bar and race the neighbouring nutrition
// specs.
export const E2E_LOGIN_FOODPIN = "e2e_foodpin";
export const FOOD_PIN_PROFILE = "Food Pin Split (e2e)";
// The protocol's food-group scope — the group the deep link pins, and (deliberately) one
// that sits after the protein entry in the curated order.
export const FOOD_PIN_GROUP = "red_meat";
