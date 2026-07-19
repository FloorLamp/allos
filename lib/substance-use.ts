// Substance-use screening instruments + consumption/reduction-target logic (issue
// #998). PURE — no DB/network, client-safe, unit-tested in
// lib/__tests__/substance-use.test.ts. The #716 mental-health instrument pattern
// re-instantiated for behavioral health's other half: screen → track → support
// reduction, with the SAME no-gamification contract.
//
// INSTRUMENT LICENSING (determined per instrument — reviewed by the repo owner;
// the #716 rule is that FULL ITEM TEXT is baked only when reproduction is clearly
// permitted, while scoring thresholds and severity bands are uncopyrightable facts
// and are always baked):
//   • AUDIT-C (3 items) — IN-APP administration with baked item text. Developed by
//     Bush, Kivlahan, McDonell, Fihn & Bradley (Arch Intern Med 1998) within the US
//     Department of Veterans Affairs ACQUIP study; the VA and US federal health
//     agencies (e.g. HIV.gov, CDC) state and treat the AUDIT-C as available for use
//     in the public domain, and distribute the item text freely without a licensing
//     step. Confidence: high → item text baked, with citation.
//   • AUDIT (full 10-item, WHO) — TOTAL-SCORE ENTRY ONLY, no item text. The WHO
//     AUDIT manual (Babor et al., WHO/MSD/MSB/01.6a) permits reproduction for
//     non-commercial clinical/educational use, but that grant is narrower than this
//     repo's redistribution surface (self-hosted, license-unconstrained deploys), so
//     the CONSERVATIVE path applies: the app records an outside-administered total
//     (0–40) and bakes only the WHO risk-zone thresholds (facts).
//   • DAST-10 — TOTAL-SCORE ENTRY ONLY, no item text. Copyright Harvey A. Skinner
//     (1982) / CAMH; reproduction permissions are not clearly free. Only the
//     published interpretation bands (facts) are baked.
//
// SENSITIVITY (decided, #998 — these are LAW):
//   • NEVER gamify. No streaks, no badges, no "X days sober" milestones, no
//     celebratory copy. Reduction support is a user-set target + progress toward it
//     + a calm coaching observation — a harm-reduction tracker, not a chip-counter.
//     The write paths never touch `activities`, so the milestone/streak machinery is
//     structurally blind to this domain (the #716 exemption-by-construction, pinned
//     by lib/__db_tests__/substance-use.test.ts).
//   • Non-judgmental, informational framing: "what your intake is", never "you
//     drink too much". Absence of a flag is not clearance. Not a diagnosis.
//   • A severe AUDIT/AUDIT-C/DAST score gets the calm "worth discussing with a
//     clinician" note the other instruments carry — it is NOT wired to the crisis
//     surface (#996 is explicit/item-9 only) and NEVER a notification.
//   • Private by default: standard per-profile grants; the only cross-surface reach
//     is the coaching tier (#449 — hideable rollup, never a push, never the hero).

import type { SeverityBand } from "./mental-health";

// ---- Screening instruments -------------------------------------------------

export const SUBSTANCE_INSTRUMENTS = ["AUDIT-C", "AUDIT", "DAST-10"] as const;
export type SubstanceInstrument = (typeof SUBSTANCE_INSTRUMENTS)[number];

export function isSubstanceInstrument(v: unknown): v is SubstanceInstrument {
  return (
    typeof v === "string" &&
    (SUBSTANCE_INSTRUMENTS as readonly string[]).includes(v)
  );
}

// One in-app item: its prompt plus its OWN answer options. Unlike PHQ-9/GAD-7
// (one shared 0..3 scale), the AUDIT-C items each carry distinct 0..4 option labels,
// so options ride per-item.
export interface SubstanceInstrumentItem {
  prompt: string;
  options: readonly { value: number; label: string }[];
}

export interface SubstanceInstrumentDef {
  key: SubstanceInstrument;
  // The canonical_name the score is stored under in medical_records (#482 one
  // identity) — the observation substrate, same as PHQ-9/GAD-7.
  canonicalName: string;
  title: string;
  measures: string;
  // How the score is captured: "in-app" ships baked item text (licensing above);
  // "total-only" records an outside-administered total with NO reproduced items.
  entry: "in-app" | "total-only";
  // The baked items (in-app instruments only; empty for total-only).
  items: readonly SubstanceInstrumentItem[];
  maxTotal: number;
  // The preventive screening this instrument's score satisfies (screenings dataset).
  satisfiesScreening: string;
  // Published severity bands, ordered lowest→highest, contiguous over 0..maxTotal.
  bands: readonly SeverityBand[];
  // The band LEVEL from which the calm "worth discussing with a clinician" note
  // shows. Never a crisis trigger, never a notification.
  discussBandLevel: number;
  // Plain-language source line for the bands/thresholds (facts, always shown).
  citation: string;
}

// AUDIT-C — alcohol screen, items 1–3 of the AUDIT. Public domain (see header).
// Bands follow the published UK Public Health England / NHS AUDIT-C banding
// (0–4 lower risk, 5–7 increasing, 8–10 higher, 11–12 possible dependence). The
// commonly used positive-screen thresholds differ by sex (≥3 women / ≥4 men); that
// nuance stays in UI copy, not the band table (bands are sex-independent facts).
const AUDIT_C: SubstanceInstrumentDef = {
  key: "AUDIT-C",
  canonicalName: "AUDIT-C",
  title: "AUDIT-C",
  measures: "alcohol use",
  entry: "in-app",
  items: [
    {
      prompt: "How often do you have a drink containing alcohol?",
      options: [
        { value: 0, label: "Never" },
        { value: 1, label: "Monthly or less" },
        { value: 2, label: "2–4 times a month" },
        { value: 3, label: "2–3 times a week" },
        { value: 4, label: "4 or more times a week" },
      ],
    },
    {
      prompt:
        "How many standard drinks containing alcohol do you have on a typical day when you are drinking?",
      options: [
        { value: 0, label: "1 or 2" },
        { value: 1, label: "3 or 4" },
        { value: 2, label: "5 or 6" },
        { value: 3, label: "7 to 9" },
        { value: 4, label: "10 or more" },
      ],
    },
    {
      prompt: "How often do you have six or more drinks on one occasion?",
      options: [
        { value: 0, label: "Never" },
        { value: 1, label: "Less than monthly" },
        { value: 2, label: "Monthly" },
        { value: 3, label: "Weekly" },
        { value: 4, label: "Daily or almost daily" },
      ],
    },
  ],
  maxTotal: 12,
  satisfiesScreening: "alcohol_screening",
  bands: [
    { level: 0, label: "Lower risk", min: 0, max: 4 },
    { level: 1, label: "Increasing risk", min: 5, max: 7 },
    { level: 2, label: "Higher risk", min: 8, max: 10 },
    { level: 3, label: "Possible dependence", min: 11, max: null },
  ],
  discussBandLevel: 2,
  citation:
    "Bush et al. 1998 (VA ACQIP); bands per the published UK PHE/NHS AUDIT-C scoring.",
};

// AUDIT — the full WHO 10-item alcohol screen. Total-only (see header). Bands are
// the WHO manual's risk zones (facts).
const AUDIT: SubstanceInstrumentDef = {
  key: "AUDIT",
  canonicalName: "AUDIT",
  title: "AUDIT",
  measures: "alcohol use",
  entry: "total-only",
  items: [],
  maxTotal: 40,
  satisfiesScreening: "alcohol_screening",
  bands: [
    { level: 0, label: "Lower risk", min: 0, max: 7 },
    { level: 1, label: "Increasing risk", min: 8, max: 15 },
    { level: 2, label: "Higher risk", min: 16, max: 19 },
    { level: 3, label: "Possible dependence", min: 20, max: null },
  ],
  discussBandLevel: 2,
  citation:
    "WHO AUDIT manual (Babor et al.), risk zones I–IV. Item text is not reproduced in-app.",
};

// DAST-10 — general drug-use screen (past 12 months, non-alcohol). Total-only (see
// header). Bands are Skinner's published interpretation levels (facts).
const DAST_10: SubstanceInstrumentDef = {
  key: "DAST-10",
  canonicalName: "DAST-10",
  title: "DAST-10",
  measures: "drug use",
  entry: "total-only",
  items: [],
  maxTotal: 10,
  satisfiesScreening: "drug_use_screening",
  bands: [
    { level: 0, label: "None reported", min: 0, max: 0 },
    { level: 1, label: "Low", min: 1, max: 2 },
    { level: 2, label: "Moderate", min: 3, max: 5 },
    { level: 3, label: "Substantial", min: 6, max: 8 },
    { level: 4, label: "Severe", min: 9, max: null },
  ],
  discussBandLevel: 3,
  citation:
    "Skinner 1982 (DAST); published DAST-10 interpretation bands. Item text is not reproduced in-app.",
};

const DEFS: Record<SubstanceInstrument, SubstanceInstrumentDef> = {
  "AUDIT-C": AUDIT_C,
  AUDIT: AUDIT,
  "DAST-10": DAST_10,
};

export function substanceInstrumentDef(
  key: SubstanceInstrument
): SubstanceInstrumentDef {
  return DEFS[key];
}

export function allSubstanceInstrumentDefs(): readonly SubstanceInstrumentDef[] {
  return SUBSTANCE_INSTRUMENTS.map((k) => DEFS[k]);
}

// canonical_name → instrument, for reading a stored biomarker row back as a
// substance-instrument score (#482: the canonical_name IS the identity).
export function substanceInstrumentForCanonicalName(
  name: string | null | undefined
): SubstanceInstrument | null {
  if (!name) return null;
  const norm = name.trim().toLowerCase();
  for (const def of allSubstanceInstrumentDefs()) {
    if (def.canonicalName.toLowerCase() === norm) return def.key;
  }
  return null;
}

// The severity band a total falls in — same clamping contract as the mental-health
// severityBand (a bad extraction never throws).
export function substanceSeverityBand(
  instrument: SubstanceInstrument,
  total: number
): SeverityBand {
  const def = DEFS[instrument];
  const t = Math.round(total);
  for (const b of def.bands) {
    if (t >= b.min && (b.max == null || t <= b.max)) return b;
  }
  return t < def.bands[0].min ? def.bands[0] : def.bands[def.bands.length - 1];
}

// Whether a total sits at/above the instrument's discuss-with-a-clinician band.
// Drives ONLY the calm on-surface note — never the crisis surface (#996 is
// item-9/explicit only), never a finding, never a notification.
export function shouldSuggestClinicianDiscussion(
  instrument: SubstanceInstrument,
  total: number
): boolean {
  return (
    substanceSeverityBand(instrument, total).level >=
    DEFS[instrument].discussBandLevel
  );
}

// ---- Consumption + reduction target (alcohol standard drinks) --------------

// The tracked substances. Alcohol is the one with a consumption ledger today: a
// standard drink IS one serving of the curated `alcohol` food group (its dataset
// serving line is literally "One standard drink…"), so consumption rides the
// EXISTING food_log / food_log_events observation store (#860/#944 — no new value
// store, no parallel table). Tobacco/nicotine participates through the existing
// structured smoking status (lib/smoking.ts) rather than a per-unit ledger.
export const SUBSTANCES = ["alcohol"] as const;
export type Substance = (typeof SUBSTANCES)[number];

export function isSubstance(v: unknown): v is Substance {
  return typeof v === "string" && (SUBSTANCES as readonly string[]).includes(v);
}

// The food_log group_key alcohol consumption is stored under — the ledger identity
// shared with Nutrition's one-tap bar (one store, two surfaces, one computation).
export const ALCOHOL_FOOD_GROUP = "alcohol";

// The largest sane weekly cap (mirrors the food-habit MAX_PER_WEEK clamp scale).
export const MAX_WEEKLY_CAP = 70;

// A reduction target's weekly state: this week's logged standard drinks vs the
// user-set cap. `cap` 0 is a valid target (an alcohol-free week — "Dry January").
// Semantics are INVERTED from every other frequency target (a ceiling, not a
// floor), which is exactly why substance targets are EXCLUDED from
// getFrequencyTargetProgress — a floor-semantics reader would nag toward MORE.
export interface SubstanceCapStatus {
  count: number; // standard drinks logged this week
  cap: number; // the user-set weekly cap
  over: boolean; // count > cap
  remaining: number; // drinks left under the cap (0 when at/over)
}

export function substanceCapStatus(
  count: number,
  cap: number
): SubstanceCapStatus {
  const c = Math.max(0, Math.round(count));
  const k = Math.max(0, Math.round(cap));
  return {
    count: c,
    cap: k,
    over: c > k,
    remaining: Math.max(0, k - c),
  };
}

// The ONE progress line every surface renders ("one question, one computation"):
// the substance page, the coaching finding detail, and any future formatter all
// share this. Calm and factual — never celebratory, never judgmental.
export function capProgressLine(s: SubstanceCapStatus): string {
  if (s.cap === 0) {
    return s.count === 0
      ? "No drinks logged this week — your target is an alcohol-free week."
      : `${s.count} ${drinksWord(s.count)} logged this week — your target is an alcohol-free week.`;
  }
  if (s.over) {
    return `${s.count} ${drinksWord(s.count)} logged this week — ${s.count - s.cap} over your ${s.cap}-drink weekly cap.`;
  }
  return `${s.count} of your ${s.cap}-drink weekly cap used.`;
}

function drinksWord(n: number): string {
  return n === 1 ? "drink" : "drinks";
}

// ---- Coaching-finding identity (#448/#449) ---------------------------------

// The findings-bus namespace for the over-target observation. Keyed on the
// substance (a stable #203 key), so a dismiss follows the target regardless of
// which week is current.
export const SUBSTANCE_USE_PREFIX = "substance-use:";

export function substanceTargetSignalKey(substance: Substance): string {
  return `${SUBSTANCE_USE_PREFIX}over-target:${substance}`;
}
