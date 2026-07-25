// Shared credential + fixture-profile names for the e2e illness fixtures. Composed
// into e2e/fixture-logins.ts (which every spec and seeder still imports from) —
// see that file's header for the rules these constants live under. Add a login or
// fixture-profile name for THIS domain here, beside the fixtures that use it.

// A member whose SOLE (therefore active) profile is currently sick — its own FULL
// cockpit renders at hero position. Used for the active-cockpit / mobile-first /
// collapse-persistence tests, which mutate ONLY this profile (never profile 1, whose
// seeded episode the other illness specs depend on staying live + expanded).
export const E2E_LOGIN_SICK_SELF = "e2e_sick_self";
export const SICK_SELF_PROFILE = "Sick Self (e2e)";

// A SECOND sick-solo login dedicated to the collapse-PERSISTENCE test, which mutates the
// stored hero collapse state — kept apart from SICK_SELF (whose read-only active-cockpit /
// mobile-first tests assert the default EXPANDED state) so the two never contend.
export const E2E_LOGIN_SICK_COLLAPSE = "e2e_sick_collapse";
export const SICK_COLLAPSE_PROFILE = "Sick Collapse (e2e)";

// Situation-aware coaching (#837 / #662 item 1): a dedicated sick profile WITH training
// history (so coaching has gap nags to HOLD, not the empty state) and one situational
// supplement tied to the active Illness situation (so the situations-bar activation
// acknowledgment has a count). Read-only in its specs — the dashboard coaching widget's
// HELD note + the "1 situational item now active" line — so it's repeat-safe and never
// touches the other sick fixtures' expected cockpit state.
export const E2E_LOGIN_SITCOACH = "e2e_sitcoach";
export const SITCOACH_PROFILE = "Situation Coaching (e2e)";

// The illness-care care finding (#805): a dedicated sick profile whose fever is logged
// on FOUR consecutive days (daysAgo 3→0), crossing the cited "more than 3 days" line so
// the finding surfaces on Upcoming. Dedicated ON PURPOSE — profile 1 carries the same
// 4-day-fever fixture, but the illness lifecycle specs (end/reopen episode, dismiss the
// finding) mutate profile 1's illness state, and under CI's --repeat-each co-location a
// sibling's end-episode/dismiss made the finding vanish for the reader. This profile is
// read-only in illness-care.spec, so the finding stays deterministic. seedSickEpisode's
// 1-day fever is NOT enough (the finding needs the 4-day run), so it's seeded directly.
export const E2E_LOGIN_ILLNESS_CARE = "e2e_illness_care";
export const ILLNESS_CARE_PROFILE = "Illness Care (e2e)";

// A caregiver granted their OWN well base profile plus two currently-sick children
// (Kid A owns a PRN med for the dose path). Acting as the well base profile, both kids
// render as compact accordion cockpits — the multi-sick / cross-profile-temp case.
export const E2E_LOGIN_CARE = "e2e_care";
export const CARE_PARENT_PROFILE = "Care Parent (e2e)";
export const SICK_KID_A_PROFILE = "Sick Kid A (e2e)";
export const SICK_KID_B_PROFILE = "Sick Kid B (e2e)";

// A SECOND caregiver granted their own well base profile plus Sick Kid A (shared with
// CARE) — the co-caregiver case: a dose CARE logs for Kid A shows on this login's hero.
export const E2E_LOGIN_COCARE = "e2e_cocare";
export const COCARE_PARENT_PROFILE = "Co Parent (e2e)";

// A member whose SOLE (active) profile carries a positive infection lab result
// ("HIV Antibody: Reactive") that is NOT on its problem list, so the condition-
// suggestion review item (#685) surfaces on Upcoming with an "Add to conditions"
// confirm. Dedicated + isolated on purpose — the confirm/dismiss flow MUTATES the
// problem list, and the spec self-heals (removes the condition at the start) so it's
// repeat-safe without touching any shared-seed profile.
export const E2E_LOGIN_CONDREV = "e2e_condrev";
export const CONDITION_REVIEW_PROFILE = "Condition Review (e2e)";

// A dedicated ADULT profile carrying a family history of heart disease AND a fresh
// out-of-range LDL (issue #656 item 4), so the biomarker-flag item on /upcoming
// gains its risk-layer "why-for-this-profile" line ("Family history of heart
// disease"). Read-only; isolated on purpose — a risk-elevated flagged lipid on a
// SHARED profile would change its hero/Upcoming flag set and race neighbor specs.
export const E2E_LOGIN_REASON = "e2e_reason";
export const REASON_MODEL_PROFILE = "Reason Model (e2e)";

// A dedicated ADULT profile for the Settings IA / notification-matrix spec (#928).
// Isolated on purpose: the matrix spec MUTATES notification prefs (enables Home
// Assistant, toggles per-kind cells) and asserts the safety-kind all-channels-off
// warning — which requires a CONFIGURED channel. Doing that on profile 1 (or any
// shared fixture) would race the home-assistant-notify / quiet-hours / preventive
// specs that also touch profile-1 notification state under --repeat-each. No
// birthdate → adult → the full Notifications tab + matrix render.
export const E2E_LOGIN_NOTIF = "e2e_notif";
export const NOTIF_PROFILE = "Notif Matrix (e2e)";

// ── Household visit + illness history fixtures (#1009) ────────────────────────
// A caregiver granted TWO dedicated profiles — a well parent and a currently-sick
// child — each carrying PAST visits + illness episodes so the merged care trail
// (/medical/episodes, the view-set surface #1373 Part 2 that superseded the removed
// /household/history) has real cross-profile content to interleave and tag by person.
// The child's Cold also carries a LINKED urgent-care visit + a prescribed course for the
// care-trail nesting cases. Spec-owned + isolated on purpose: the care-trail / episode-card
// / promotion specs only READ these fixtures, so concurrent workers never contend,
// and their dedicated profiles never perturb the illness-hero fixtures' cockpit
// assertions. The child's episodes are shaped for the episode-card cases: a CLOSED
// "Flu" that OVERLAPS the parent's Flu (card-present), and an OPEN "Cold" (currently
// sick → dashboard promotion). The parent also carries a far-past "Chickenpox" that
// overlaps nobody (card-absent case).
export const E2E_LOGIN_HHHIST = "e2e_hhhist";
export const HH_HISTORY_PARENT_PROFILE = "Household History Parent (e2e)";
export const HH_HISTORY_CHILD_PROFILE = "Household History Child (e2e)";

// A SECOND caregiver granted the SAME two history profiles as READ-ONLY, proving the
// merged history renders for a view-only grant (reads are allowed) without any write
// affordance. Separate login so the read-only assertions never race the write one.
export const E2E_LOGIN_HHHIST_RO = "e2e_hhhist_ro";

// ── Household-rollup + illness-episode caregiver fixtures (#868 census hardening) ──
// Five member logins granted the SHARED seeded profiles — profile 1 ("admin") and
// profile 2 ("Riley (child)", seeded by scripts/seed.ts) — so the household-rollup and
// illness-episode specs stop CREATING members at runtime through Settings → Family. That
// page's create/grant controls are onClick + router.refresh() (not form submits), so the
// grant rows render only after a client refresh that goes stale under CI load — the
// create-member census flake (#868 fixture-ownership discipline). Seeded grants render
// deterministically. These logins are READ-STRUCTURE ONLY: their grant sets are STATIC
// (never mutated by a spec), and the specs leave the shared profiles' data as found
// (household-rollup resets only its own dedicated dose row). Profile 1 is the lowest
// granted id, so a caregiver lands acting as it (createSession picks accessibleProfiles[0]).
//   • HH_CAREGIVER — profile 1 write + profile 2 write. Two Household cards; confirms
//     profile 2's due dose from its card while the active profile stays profile 1.
//   • HH_SOLO — profile 1 write ONLY. No Household nav; bounced off /household.
//   • HH_VIEWER — profile 1 read + profile 2 read. Sees both cards, NO confirm buttons.
export const E2E_LOGIN_HH_CAREGIVER = "e2e_hh_caregiver";
export const E2E_LOGIN_HH_SOLO = "e2e_hh_solo";
export const E2E_LOGIN_HH_VIEWER = "e2e_hh_viewer";
//   • ILLNESS_CAREGIVER — profile 1 write + profile 2 write. Acts as profile 2 (well),
//     so sick profile 1 surfaces only in the cross-profile illness-hero accordion (#858).
//   • ILLNESS_RO — profile 1 READ + profile 2 write. Acts as profile 2, opens sick
//     profile 1's episode read-tier (view-only banner, no write controls, #879).
export const E2E_LOGIN_ILLNESS_CAREGIVER = "e2e_illness_caregiver";
export const E2E_LOGIN_ILLNESS_RO = "e2e_illness_ro";

// Grounded record Q&A — "ask your records" (issue #878, Phase 2). A member granted a
// dedicated adult profile whose ONLY notable record is an antibiotics medication
// (Amoxicillin, its notes naming it an antibiotics course) plus a matching urgent-care
// visit — so the palette's "Ask about your records" over "when did I last take
// antibiotics?" retrieves them and renders a LINKED answer. The e2e DB boots without an
// AI tier, so the answer is the offline structured floor (the grounded rows, linked);
// the empty-retrieval "nothing found" refusal is exercised over an unmatched question.
// Read-only + isolated (never a shared-seed profile), so it's safe under --repeat-each.
export const E2E_LOGIN_ASK = "e2e_ask";
export const ASK_RECORDS_PROFILE = "Records QA (e2e)";
export const ASK_RECORDS_MED = "Amoxicillin";

// Finding-closure toast on the settings autosave path (issue #1305). A dedicated member
// whose SOLE (active) profile has SEX set but NO birthdate — so the structural
// data-quality "Set a birthdate" gap fires, and setting a birthdate on Profile settings
// clears it and toasts. The closure spec OWNS it and resets the birthdate at test start
// (direct-DB), so --repeat-each stays clean and it never perturbs the DQ_GAPPY dashboard
// fixtures (whose gappy state the data-quality spec asserts).
export const E2E_LOGIN_CLOSURE_DQ = "e2e_closure_dq";
export const CLOSURE_DQ_PROFILE = "Closure DQ (e2e)";

// View-only access (issue #33). Two dedicated member logins granted ONLY profile 1 (the
// shared sample record the spec reads — its "Adherence Refill Med (e2e)" + the vitals
// quick-add form), one per access LEVEL, so view-only-access.spec stops creating members
// at runtime through Settings → Family (createLoginViaFamily/setGrantsViaFamily — an
// onClick+router.refresh() create/grant that went stale under CI load, the #830/#1111
// census flake that failed shard 4). Profile 1 is each login's SOLE grant, so it's the
// active profile on sign-in (createSession picks accessibleProfiles[0]). The read login
// proves a mutation is bounced server-side; the write login proves the same mutation
// succeeds (it writes one vital to profile 1 — exactly what the runtime-created write
// member always did, so the shared-profile write target is unchanged).
export const E2E_LOGIN_VIEWONLY_READ = "e2e_viewonly_read";
export const E2E_LOGIN_VIEWONLY_WRITE = "e2e_viewonly_write";

// #1093 — the symptom↔photo cross-link. A dedicated sick-solo login with an OPEN illness
// episode (seedSickEpisode logs cough + fever TODAY), so its episode cockpit's photo strip
// offers those symptoms in the "Symptom (optional)" selector. symptom-photo-link.spec logs
// in as this login and attaches a photo TAGGED to a specific symptom, proving the photo
// binds to its log (the symptom label chip renders on the thumbnail). Isolated + owns its
// own photos so it can exact-count / delete-all without touching the shared profile-1
// episode the round3 spec drives. Synthetic, no PHI.
export const E2E_LOGIN_SICK_PHOTO = "e2e_sick_photo";
export const SICK_PHOTO_PROFILE = "Sick Photo Link (e2e)";
