// Today's reported burden (issue #1300): the ONE pure computation over a day's
// SELF-REPORTED load — logged symptom severities (symptom_logs) + the check-in Energy tap
// (mood store) — that decides whether coaching tilts toward an easier session, and names
// the actual report in basis-aware copy. It is the shared fn (#221): the coaching rest-tilt
// is its FIRST consumer; a future digest "burden line" reads the same result. PURE — no
// DB/clock; the gather passes today's rows in.
//
// Clean-signal posture (the regularityTravelInsight stance, mirrored from #1292): a
// conservative threshold — a single SEVERE symptom, OR moderate burden across several, OR
// low energy — never a manufactured number and never calendar-based (Period NEVER drives
// the tilt; when it's on and a symptom fired it, the copy MAY frame with it — #1298). This
// is self-report, so it's sufficient basis on its own: no sensor gets a veto (#1292's
// user-wins symmetry).

import { symptomLabel, severityLabel } from "./symptoms";

// One logged symptom-day the burden reads: its stored key + 1–4 severity.
export interface BurdenSymptom {
  symptom: string;
  severity: number;
}

export interface ReportedBurdenInput {
  // Today's logged symptoms (stored keys + severities), any order.
  symptoms: BurdenSymptom[];
  // Today's check-in Energy tap on the 1–5 scale (5 = energized), or null when unlogged.
  energy: number | null;
  // Whether Period context holds today (#1298) — FRAMING only; it never makes the tilt
  // fire on its own.
  periodContext?: boolean;
}

// Thresholds — tuned conservative (clean-signal). A severe symptom is level ≥ 3; moderate
// burden is ≥ 2 symptoms at level ≥ 2; low energy is ≤ 2 of 5 (drained end).
export const SEVERE_SYMPTOM_LEVEL = 3;
export const MODERATE_SYMPTOM_LEVEL = 2;
export const MODERATE_SYMPTOM_COUNT = 2;
export const LOW_ENERGY_MAX = 2;

export type BurdenBasis = "symptom" | "energy" | "both";

export interface ReportedBurden {
  // Whether the day's report crosses the rest-tilt threshold.
  tilts: boolean;
  // Which report drove it (null when it doesn't tilt).
  basis: BurdenBasis | null;
  // The worst symptom behind a symptom-basis tilt (for the named copy), else null.
  leadSymptom: BurdenSymptom | null;
  // Whether low energy contributed.
  lowEnergy: boolean;
  // Whether the copy may frame with Period (context on AND a symptom fired the tilt).
  periodFramed: boolean;
}

// Decide today's reported burden. Pure.
export function computeReportedBurden(
  input: ReportedBurdenInput
): ReportedBurden {
  const symptoms = input.symptoms.filter(
    (s) => Number.isFinite(s.severity) && s.severity >= 1
  );
  const worst = symptoms.reduce<BurdenSymptom | null>(
    (acc, s) => (acc == null || s.severity > acc.severity ? s : acc),
    null
  );
  const severe = worst != null && worst.severity >= SEVERE_SYMPTOM_LEVEL;
  const moderateCount = symptoms.filter(
    (s) => s.severity >= MODERATE_SYMPTOM_LEVEL
  ).length;
  const symptomBurden = severe || moderateCount >= MODERATE_SYMPTOM_COUNT;

  const lowEnergy = input.energy != null && input.energy <= LOW_ENERGY_MAX;

  const tilts = symptomBurden || lowEnergy;
  const basis: BurdenBasis | null = !tilts
    ? null
    : symptomBurden && lowEnergy
      ? "both"
      : symptomBurden
        ? "symptom"
        : "energy";

  return {
    tilts,
    basis,
    leadSymptom: symptomBurden ? worst : null,
    lowEnergy,
    periodFramed: !!input.periodContext && symptomBurden,
  };
}

// The basis-aware rest-tilt copy pieces (the shape a coaching RestReason maps onto), or
// null when the day doesn't tilt. Names the ACTUAL report — the symptom by label, low
// energy plainly — never a category or a number. Pure.
export interface BurdenTiltCopy {
  reasonCore: string;
  todayTail: string;
  also: string;
}

export function reportedBurdenTiltCopy(
  burden: ReportedBurden
): BurdenTiltCopy | null {
  if (!burden.tilts || burden.basis == null) return null;

  const symptomPhrase = burden.leadSymptom
    ? `${severityLabel(burden.leadSymptom.severity)} ${symptomLabel(
        burden.leadSymptom.symptom
      )}`.toLowerCase()
    : null;
  const periodFrame = burden.periodFramed ? " (during your period)" : "";

  if (burden.basis === "energy") {
    return {
      reasonCore: "Energy's low today",
      todayTail: " — an easy session may serve better.",
      also: "low energy today",
    };
  }

  // symptom / both — the symptom leads the copy; low energy rides along when both fired.
  const core =
    burden.basis === "both"
      ? `You logged ${symptomPhrase} today${periodFrame}, and your energy's low`
      : `You logged ${symptomPhrase} today${periodFrame}`;
  const also =
    burden.basis === "both"
      ? `logged ${symptomPhrase}, low energy`
      : `logged ${symptomPhrase}`;
  return {
    reasonCore: core,
    todayTail: " — consider an easier session.",
    also,
  };
}
