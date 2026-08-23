// THE UNBOUNDED-NAME CORPUS (#3631) — the seed values behind the `textLength`
// dial, and the roster of data families that need one.
//
// ── WHAT THIS IS FOR ────────────────────────────────────────────────────────────
//
// A control whose intrinsic width is set by DATA NOBODY CHOSE is a class, not a
// page: a `select` of item names, a chip carrying a portal-imported title, a cell
// holding a lab analyte's full name. A portal import writes "Calcium
// Carbonate-Cholecalciferol (CALCIUM 500 + D ORAL TABLET)"; a household names a
// profile whatever it likes. Nothing the app controls bounds any of it.
//
// #3478 was one instance — the dose ledger's Item filter, 447px wide on a 390px
// phone with the shell clipping the last 108px in silence. The geometry census
// (scripts/ux-geometry-census.mjs) could not have found it, and #3631 is that fact:
// the probe was never blind, THE CORPUS WAS. The baseline seed's longest medication
// label is "Atorvastatin (inactive)" — 23 characters, which fits a phone at any
// width — so a census run over it reports zero clipped elements on that route,
// correctly and uselessly. A corpus that finds nothing reads exactly like a corpus
// that is not there.
//
// ── WHY THE DIAL AND NOT THE BASELINE ───────────────────────────────────────────
//
// The obvious fix is to put one long imported medication in the baseline story.
// Measured, that costs more than it looks (the numbers are on #3631):
//
//   * scripts/seed.ts IS the e2e demo template DB (e2e/global-setup.ts seeds
//     scripts/seed.ts then e2e/seed-events.ts). A long name on profile 1 widens
//     controls under every neighbouring spec that reads profile 1 — which is
//     exactly the cost #3478's own fixture refused to pay when it took a DEDICATED
//     profile instead (e2e/logins/intake.ts, "a 55-character medication name on a
//     shared profile would widen controls under every neighbouring spec").
//   * The baseline look is a PIN: `npm run seed`, the e2e template, and census
//     `--baseline` diffing all rely on it being byte-stable (scripts/seed-rng.ts).
//
// The `textLength` dial already existed for this exact class ("Long names —
// truncation and wrap behavior", scripts/seed-rng.ts) and already had one hook: a
// long goal title. It was a corpus of one field. So this module widens THAT, rather
// than adding a parallel concept — the dial is off in the baseline by construction
// (`sampleDials(DEFAULT_SEED)` returns BASELINE_DIALS), so nothing here moves a
// baseline screenshot, a baseline metric, or the e2e template DB by one pixel.
//
//   SEED_RNG=3 UX_SEED=1 node scripts/ux-walkthrough.mjs --serve pages
//
// is the census over this corpus; seed 3 is "past illness + long names", the
// smallest seed that turns the dial on with the least other perturbation, and
// lib/__tests__/seed-long-names.test.ts pins it so the documented number cannot rot.
//
// ── THE ROSTER IS THE POINT ─────────────────────────────────────────────────────
//
// #3631's second acceptance criterion: the set of controls whose width is set by
// user-uncontrolled data must be ENUMERATED somewhere a person adding one will
// read, "otherwise the next such control is invisible again and the corpus only
// ever covers what someone remembered". UNBOUNDED_NAME_FIELDS below is that
// enumeration, and it is deliberately a ROSTER RATHER THAN A LIST OF WINS: a family
// this corpus does NOT yet plant is carried with `planted: false` and its reason,
// in the lib/__tests__/tap-floor-reach.test.ts tradition, so a blind spot is a
// number that can go up instead of a silence. Adding a family means adding an entry
// and a hook in scripts/seed.ts — the test below fails until both exist.
//
// docs/internals/design-system.md §3 ("Selects are width-capped; no control renders
// past the viewport") points here.

/**
 * CHARACTERS in a planted value.
 *
 * What it bounds, said out loud: the planted string must be long enough that the
 * control it sizes RENDERS PAST the census's 390px mobile viewport, because a
 * corpus whose longest name still fits is the corpus #3631 is about.
 *
 * The derivation, from the one place this was measured on a real box (#3478,
 * e2e/dose-ledger-phone.mobile.spec.ts): a 55-character option gave the `.input`
 * select a 447px natural width at 390px — about 8.1px per character including the
 * control's own padding and chevron. 390 / 8.1 ≈ 48 characters to reach the edge,
 * so 52 is that with a margin rather than at it.
 *
 * It is a FLOOR ON THE VALUE, not a promise about every surface: a family rendered
 * at a smaller type size needs a longer string, and an entry that lands short is
 * the entry's problem to fix, not this constant's.
 */
export const UNBOUNDED_NAME_MIN_CHARS = 52;

/**
 * The values the `textLength: "long"` dial plants, keyed by data family.
 *
 * Every one is a plausible thing a real portal import writes — the point is a
 * corpus that looks like production, not a corpus of padded strings. Referenced
 * from the dial hooks in scripts/seed.ts, which is where they actually land.
 */
export const LONG_NAMES = {
  /** An intake item (medication / supplement) name, as a pharmacy portal writes it. */
  intakeItem: "Calcium Carbonate-Cholecalciferol (CALCIUM 500 + D ORAL TABLET)",
  /** A clinical result's analyte name, as a reference lab writes it. */
  clinicalResult: "25-Hydroxyvitamin D2 and D3, Mass Spectrometry (Serum)",
  /** A problem-list entry, as a hospital's coded problem list writes it. */
  condition: "Essential (primary) hypertension without heart failure",
} as const;

export type LongNameKey = keyof typeof LONG_NAMES;

export interface UnboundedNameField {
  /** Key into LONG_NAMES when planted; a stable roster id either way. */
  key: string;
  /** The stored field, named the way the schema names it. */
  field: string;
  /** WHO writes the value — the reason nothing in the app bounds its length. */
  writtenBy: string;
  /**
   * The controls known to size themselves to this family today. Not exhaustive
   * and never claimed to be: it is what the next person starts from, and the
   * reason each entry names files rather than describing them.
   */
  controls: readonly string[];
  /** Does the `textLength: "long"` dial plant a value for this family today? */
  planted: boolean;
  /** Why not, when it does not — a blind spot with a reason beats a silence. */
  why?: string;
}

/**
 * THE ROSTER. Planted families first, then what this corpus still cannot express.
 */
export const UNBOUNDED_NAME_FIELDS: readonly UnboundedNameField[] = [
  {
    key: "intakeItem",
    field: "intake_items.name",
    writtenBy:
      "a document/portal import (source='extracted') or the person typing a product name",
    controls: [
      "components/intake/DoseLedgerItemFilter.tsx — the ledger's Item select (#3478's own control)",
      "components/intake/IntakeRulesEditor.tsx — the keep-apart / take-together Other item select",
      "app/(app)/medications/MedicationCard.tsx — the card heading and its chip row",
    ],
    planted: true,
  },
  {
    key: "clinicalResult",
    field: "medical_records.name (category 'lab')",
    writtenBy: "a reference lab or portal import, in the lab's own vocabulary",
    controls: [
      "components/ClinicalResultsTable.tsx — the analyte cell",
      "components/ObservationSearch.tsx — the observation picker's options",
      "components/PanelFilterSelect.tsx — panel labels beside it (closed vocabulary itself, but it shares the row)",
    ],
    planted: true,
  },
  {
    key: "condition",
    field: "conditions.name",
    writtenBy: "a coded problem list arriving with a document import",
    controls: [
      "app/(app)/records/problems/conditions/ConditionList.tsx — problem-list rows and their chips",
      "components/IntakeItemForm.tsx — the indication picker's options",
    ],
    planted: true,
  },
  {
    key: "profileName",
    field: "profiles.name",
    writtenBy: "the household, who may call a profile anything at all",
    controls: [
      "components/ProfileSwitcherPanel.tsx — the acting-profile control",
      "app/(app)/household/page.tsx — member cards and their headings",
    ],
    planted: false,
    why: "profile 1's name is the app shell's identity — it is in the header of EVERY census screenshot, so a long value here moves the whole census rather than the surfaces that render it, and the reading would be about the change rather than about the app. It wants its own decision (a long-named MEMBER profile is the likelier shape), not a line in this one.",
  },
  {
    key: "providerName",
    field: "providers.name",
    writtenBy: "a facility directory or referral import",
    controls: [
      "components/ProviderCombobox.tsx — the provider picker's options",
      "app/(app)/records/ProvidersSection.tsx — provider rows",
    ],
    planted: false,
    why: "not yet measured. The seed's providers are shared across records, appointments and encounters, so a long value here reaches surfaces this lane did not look at; rostered so the gap is a number rather than a silence.",
  },
];
