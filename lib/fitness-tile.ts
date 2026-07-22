// Pure grid-tile view model for the #1132 Fitness-check heat grid — a VIEW over the
// existing FitnessTestResult (buildFitnessCheckModel), NO new scoring engine (#221). Each
// tile is colored red→green by FAVORABILITY (green = favorable on every tile), with the
// ENCODING per tier so nothing is faked (the #834 no-fake-percentile discipline is about
// not inventing a percentile, not about withholding color): monotonic tiles show position,
// body/evidence tiles show honest distance-from-reference, the #1135 self-norm tiles show a
// DISCLOSED rough band, and unmeasured stays grey (never red — "hide, don't shame", #489).
//
// DB-free and pure so it's unit-tested per encoding in lib/__tests__. The overlay marker
// (percentile number / strength band / range flag / cited state / rough band + delta) is
// ALWAYS present as text — the grid is never color-only (the dataviz accessibility rule).

import { formatPercentile } from "@/lib/fitness-norms";
import type {
  FitnessTestResult,
  FitnessProvenance,
} from "@/lib/fitness-check-model";
import type { FitnessDomain, FitnessTier } from "@/lib/fitness-battery";

// The BASIS drives the overlay marker + the honesty disclosure; it mirrors the tier but
// collapses to "unmeasured" for a grey tile.
export type TileBasis =
  | "percentile"
  | "standard"
  | "body"
  | "evidence"
  | "self-norm"
  | "self-trend"
  | "unmeasured";

// Discrete favorability buckets → the green→red ramp (theme-aware classes live in the
// component). `neutral` is the ONLY grey — unmeasured, or a self-trend residue with no
// direction.
export type HeatTone = "bad" | "weak" | "mid" | "good" | "great" | "neutral";

export interface FitnessTile {
  key: string;
  label: string;
  domain: FitnessDomain;
  tier: FitnessTier;
  unit: string;
  measured: boolean;
  value: number | null;
  basis: TileBasis;
  // 0–100 favorability (higher = greener); null → neutral/grey (unmeasured or delta-only).
  heat: number | null;
  tone: HeatTone;
  // The marker text above the fill (percentile / band / flag / cited state / rough band).
  overlay: string;
  // #1135: the tile discloses a "rough guide" reference (self-norm tiles only).
  roughGuide: boolean;
  selfNormCitation: string | null; // the rough-guide source, for the entry-modal disclosure
  provenance: FitnessProvenance | null;
  stale: boolean;
  delta: number | null;
  improved: boolean | null;
  deltaArrow: "up" | "down" | null; // direction of an IMPROVEMENT-aware delta
}

// The favorability → tone bucket (shared by the tiles AND the domain bars, so the color
// language is one computation across both surfaces — #221 at the formatter layer).
export function heatTone(heat: number | null): HeatTone {
  if (heat == null) return "neutral";
  if (heat >= 80) return "great";
  if (heat >= 60) return "good";
  if (heat >= 40) return "mid";
  if (heat >= 20) return "weak";
  return "bad";
}
const toneFromHeat = heatTone;

function evidenceState(heat: number): string {
  if (heat >= 66) return "good";
  if (heat >= 33) return "borderline";
  return "risk";
}

// Build the tile VM for one battery result. Reads only model fields (favorability +
// tier-specific detail) — the reference lookups already ran in the model.
export function buildFitnessTile(r: FitnessTestResult): FitnessTile {
  const deltaArrow: "up" | "down" | null =
    r.delta == null || r.delta === 0 ? null : r.improved ? "up" : "down";

  if (!r.measured) {
    return {
      key: r.key,
      label: r.label,
      domain: r.domain,
      tier: r.tier,
      unit: r.unit,
      measured: false,
      value: null,
      basis: "unmeasured",
      heat: null,
      tone: "neutral",
      overlay: "Not measured",
      roughGuide: false,
      selfNormCitation: null,
      provenance: null,
      stale: false,
      delta: null,
      improved: null,
      deltaArrow: null,
    };
  }

  const heat = r.favorability;
  const stale = !!r.provenance?.stale;

  // Overlay marker + basis per tier.
  let basis: TileBasis;
  let overlay: string;
  let roughGuide = false;
  switch (r.tier) {
    case "norms":
      basis = "percentile";
      overlay = r.percentile ? formatPercentile(r.percentile) : "—";
      break;
    case "standard":
      basis = "standard";
      overlay = r.standing?.label ?? "—";
      break;
    case "body":
      basis = "body";
      overlay =
        heat != null && heat >= 100 ? "in healthy range" : "outside range";
      break;
    case "evidence":
      basis = "evidence";
      overlay = heat != null ? evidenceState(heat) : "—";
      break;
    case "self-norm":
      basis = "self-norm";
      roughGuide = true;
      overlay = r.selfNorm
        ? `${r.selfNorm.bandLabel} · rough guide`
        : "rough guide";
      break;
    default:
      basis = "self-trend";
      overlay =
        deltaArrow === "up"
          ? "improving"
          : deltaArrow === "down"
            ? "declining"
            : "tracked";
      break;
  }

  // Self-trend colors by delta DIRECTION only (no absolute fill).
  const tone: HeatTone =
    r.tier === "self-trend"
      ? deltaArrow === "up"
        ? "good"
        : deltaArrow === "down"
          ? "bad"
          : "neutral"
      : toneFromHeat(heat);

  return {
    key: r.key,
    label: r.label,
    domain: r.domain,
    tier: r.tier,
    unit: r.unit,
    measured: true,
    value: r.value,
    basis,
    heat: r.tier === "self-trend" ? null : heat,
    tone,
    overlay,
    roughGuide,
    selfNormCitation: r.selfNorm?.citation ?? null,
    provenance: r.provenance,
    stale,
    delta: r.delta,
    improved: r.improved,
    deltaArrow,
  };
}

export function buildFitnessTiles(results: FitnessTestResult[]): FitnessTile[] {
  return results.map(buildFitnessTile);
}
