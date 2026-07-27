// Shared credential + fixture-profile names for the e2e medical fixtures. Composed
// into e2e/fixture-logins.ts (which every spec and seeder still imports from) —
// see that file's header for the rules these constants live under. Add a login or
// fixture-profile name for THIS domain here, beside the fixtures that use it.

// A dedicated ADULT profile carrying ONE flagged biomarker reading — an out-of-range
// Hemoglobin A1c (#700 flagged-labs follow-up adapter). The followup-labs spec tracks a
// "Recheck A1c" follow-up from the biomarker detail page, watches it surface legibly on
// Upcoming, then lands a later same-family (eAG) reading and resolves the loop.
// Isolated + spec-owned on purpose: tracking a follow-up + adding/resolving a reading
// MUTATES care_plan_items + medical_records, which on a shared profile would race the
// biomarker/upcoming specs. The spec cleans its follow-up + the later reading in
// beforeAll AND afterAll so it's repeat-safe; the seeded source A1c is re-seeded each boot.
export const E2E_LOGIN_FLABS = "e2e_flabs";
export const FLAGGED_LAB_PROFILE = "Flagged Lab (e2e)";

// A dedicated ADULT profile carrying ONE flagged intraocular-pressure reading — an
// out-of-range right-eye IOP (#698 §6 IOP glaucoma follow-up adapter). The followup-iop
// spec tracks a "Recheck IOP / glaucoma workup" follow-up from the biomarker detail
// page, watches it surface legibly on Upcoming, then lands a later left-eye pressure and
// resolves the loop (bilateral — one workup covers both eyes). Isolated + spec-owned for
// the same reason as the flagged-lab profile: tracking/resolving MUTATES care_plan_items
// + medical_records. The spec cleans its follow-up + later reading in beforeAll/afterAll;
// the seeded source IOP is re-seeded each boot.
export const E2E_LOGIN_IOP = "e2e_iop";
export const FLAGGED_IOP_PROFILE = "Flagged IOP (e2e)";

// A member granted a dedicated ADULT profile proving the CODES → preventive-
// satisfaction loop (#1035/#1037) in the browser: its ONLY visit evidence is a
// coded generic encounter ("Office Visit" + CPT 99396 → adult_physical) and a
// completed CDT-coded dental row ("Prophy" + D1110 → dental_cleaning) — no text
// field matches a name synonym, so only the code path can satisfy them. Dedicated
// on purpose (#868): preventive-upcoming.spec.ts relies on profile 1's
// dental_cleaning item staying DUE (its mark-done fixture), which this profile's
// rows would extinguish if seeded there. Read-only in its spec — repeat-safe.
export const E2E_LOGIN_PREVCODE = "e2e_prevcode";
export const PREVENTIVE_CODES_PROFILE = "Preventive Codes (e2e)";
// A member granted a dedicated ADULT profile for the drug-allergy × medication
// cross-check spec (#1029): a recorded "Penicillin — hives" allergy plus a tracked
// amoxicillin (same-class hit) and cephalexin (documented cross-reactivity hit).
// Dedicated on purpose — an allergy warning on a SHARED profile would plant surprise
// safety-strip cards / Upcoming findings that race neighbor specs. The spec owns its
// dismissal state (reset per test), so it stays repeat-safe.
export const E2E_LOGIN_DRUG_ALLERGY = "e2e_drug_allergy";
export const DRUG_ALLERGY_PROFILE = "Drug Allergy (e2e)";

// ── Structural data-quality gaps (#1045) ──────────────────────────────────────
// A member whose SOLE (active) profile is intentionally GAPPY — no birthdate, no sex,
// and one failed-extraction document — so the dashboard "Data quality" widget renders
// the top-3 structural gaps (birthdate, sex, failed doc) with fix-it CTAs, and the
// dismiss test can silence one across the widget + the coaching rollup. Dedicated +
// isolated on purpose (#868): the dismiss test WRITES an upcoming_dismissals row on it,
// so it never perturbs a shared profile, and each test resets its own data-quality
// dismissals first so --repeat-each stays clean.
export const E2E_LOGIN_DQ_GAPPY = "e2e_dq_gappy";
export const DQ_GAPPY_PROFILE = "Data Quality Gappy (e2e)";

// A member whose SOLE (active) profile is structurally COMPLETE — birthdate + sex +
// smoking status + reviewed risk factors, and no meds/labs/failed-docs — so the
// "Data quality" widget SELF-HIDES (renders nothing, the absent-pillar rule). Proves
// the widget disappears on a complete profile.
export const E2E_LOGIN_DQ_COMPLETE = "e2e_dq_complete";
export const DQ_COMPLETE_PROFILE = "Data Quality Complete (e2e)";

// A caregiver granted TWO profiles — its own COMPLETE base profile plus a GAPPY child
// (no birthdate/sex) — so the household page shows a per-member data-quality gaps line
// on the child's card (kids are where birthdate/sex gaps cluster). Read-only in its
// spec, so concurrent workers never contend and it never perturbs the dashboard
// gappy/complete fixtures above.
export const E2E_LOGIN_DQ_CARE = "e2e_dq_care";
export const DQ_CARE_PARENT_PROFILE = "Data Quality Parent (e2e)";
export const DQ_CARE_CHILD_PROFILE = "Data Quality Child (e2e)";

// A member whose SOLE profile is a structurally-GAPPY ADULT (#1146): birthdate + sex
// set, but smoking status unknown, risk factors unreviewed, and a PARTIAL PhenoAge
// panel (one Albumin lab) — so the "Data quality" widget renders the adult-gated
// gaps whose CTAs must deep-link the exact forms (smoking-history / risk-factors
// anchors, the prefilled biomarker add form). It also owns the dashboard-deeplinks
// fixtures that need a quiet dedicated dashboard: a target-less goal (#1219 item 3)
// and four ongoing protocols + a layout that shows the active-protocols widget
// (#1219 item 4). Read-mostly: its spec only navigates; no dismissals are written.
export const E2E_LOGIN_DQ_ADULT = "e2e_dq_adult";
export const DQ_ADULT_PROFILE = "Data Quality Adult (e2e)";

// A member granted a dedicated ADULT profile for the record↔visit / episode↔visit
// linking spec (#1050/#1053). Seeds a self-contained visit + a same-day unlinked
// medication (with its prescription record) + an illness episode spanning that day
// with no linked visit — so the spec drives "From this visit?" → link all, the med's
// "Prescribed at" line, and the cockpit Care suggestion → link → encounter back-link
// entirely on its OWN profile (never a shared-seed row, so --repeat-each stays clean).
export const E2E_LOGIN_VISITLINKS = "e2e_visitlinks";
export const VISITLINKS_PROFILE = "Visit Links (e2e)";

// A member granted a dedicated profile for the encounter-detail enrichment spec
// (#1350/#1353). Seeds a self-contained subject visit with a same-provider prior
// visit (visit context), a completed appointment booked for it (scheduling origin),
// an illness episode spanning the visit with NO linked visit yet (the encounter-side
// "link an episode" suggestion → link → care trail), and a document-sourced + a manual
// condition (the RecordProvenance deep-link vs plain label). OWNS every row so the
// suite's shared-seed counts and --repeat-each stay clean.
export const E2E_LOGIN_ENCRICH = "e2e_encrich";
export const ENCRICH_PROFILE = "Encounter Enrichment (e2e)";

// #1099 — "Create a visit from this record?". A dedicated profile carrying ONE optical
// prescription dated a day with NO encounter, so the create-a-visit prompt renders on
// the Vision record card. The spec OWNS the profile (dedicated login), so accepting the
// prompt (which mutates: creates an encounter + links the Rx) can't disturb any
// shared-seed count. Idempotent under --repeat-each: the spec accepts only when the
// prompt is still present, then asserts the created-visit end-state.
export const E2E_LOGIN_CREATEVISIT = "e2e_createvisit";
export const CREATEVISIT_PROFILE = "Create Visit (e2e)";

// Records-surface enrichment sweep (issues #1354 + #1355). A dedicated member login +
// ADULT profile carrying the exact fixtures the enrichment lines read, so no spec ever
// exact-count-asserts a shared-seed row: a Penicillin allergy + an active Amoxicillin
// medication (a drug-allergy CLASS contraindication → the allergy-row cross-link and its
// deep-link to the med), a CYP2C19 poor-metabolizer variant + an active Clopidogrel
// medication (a PGx hit → the variant-row "Affects:" line), and a procedure linked to an
// encounter (the #1355 "Performed at:" visit line). Its OWN login/profile so the
// contraindication + PGx findings never perturb another spec's medications/allergies
// counts, and the fixture ids are uniquely anchored (own describe in the spec).
export const E2E_LOGIN_RECS_ENRICH = "e2e_recs_enrich";
export const RECS_ENRICH_PROFILE = "Records Enrich (e2e)";
export const RECS_ENRICH_ALLERGY_MED = "Amoxicillin 500 mg (e2e)";
export const RECS_ENRICH_PGX_MED = "Clopidogrel (e2e)";
export const RECS_ENRICH_PROCEDURE = "Knee arthroscopy (e2e)";

// ── Results-hub panel groups (#1499 section A) ────────────────────────────────
// A member granted a dedicated ADULT profile whose ENTIRE lab history is a known,
// small set of analytes spread over exactly three #1502 panels — five lipids (one
// flagged: a high LDL), two thyroid (none flagged), and one deliberately
// un-canonicalized reading that must land in the reserved "Other" bucket.
//
// Spec-owned on purpose (#868 fixture-ownership). The collapse's headers PUBLISH
// COUNTS ("Lipids · 5 analytes · 1 flagged"), and a count is the one assertion that
// cannot be made against a shared seed — a neighbor's write or a retry moves it. On
// its own profile the counts are exact and the flagged/unflagged contrast is
// guaranteed, which is what makes "flagged groups self-identify" testable at all.
// Read-only in its spec (only the client-side expand/collapse is exercised), so it
// stays repeat-safe with no reset.
export const E2E_LOGIN_PANELGROUPS = "e2e_panelgroups";
export const PANEL_GROUPS_PROFILE = "Panel Groups (e2e)";
// The one un-canonicalized analyte: reported under a vendor heading the taxonomy has
// nothing to say about, so it resolves to `other` and proves nothing is dropped.
export const PANEL_GROUPS_OTHER_ANALYTE = "E2E Unmapped Assay";
