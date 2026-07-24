// Per-test outcome moment + battery-completion finale for the Fitness check (issue
// #1307). Saving a test has real substance the engine ALREADY computes (percentile /
// band / delta); this formats it into the in-place "you just earned this" moment the
// entry modal shows before it closes, and the completion summary the check page (and the
// weekly recap) render when the last outstanding test lands.
//
// #221 — FORMATTERS, never a second computation. The outcome panel reads the tile VM
// (lib/fitness-tile) the grid already renders — same percentile / strength band / range
// flag / rough band + delta vocabulary — so the modal and the tile can never disagree.
// The completion decision + counts read the model (lib/fitness-check-model) the header
// already renders. DB-free and pure so it's unit-tested against the same fixtures the
// tiles/model use.

import type { FitnessTile } from "./fitness-tile";
import type {
  FitnessTestResult,
  FitnessCheckModel,
} from "./fitness-check-model";

// The in-place outcome panel VM for a just-saved test — a formatter over the tile VM.
export interface FitnessOutcome {
  key: string;
  label: string;
  valueText: string; // "50 kg"
  marker: string; // the tier overlay: "68th percentile" / strength band / range flag / rough band
  deltaText: string | null; // "+6 vs your last check" (improvement-aware sign kept)
  deltaArrow: "up" | "down" | null;
  roughGuide: boolean; // self-norm disclosure carried through (#1135)
  // One-line aria-live announcement composed from the above (screen-reader + headline).
  announcement: string;
}

function valueText(tile: FitnessTile): string {
  const v = tile.value == null ? "" : String(tile.value);
  return tile.unit ? `${v} ${tile.unit}`.trim() : v;
}

// Build the outcome VM from a MEASURED tile. The delta text keeps the tile's improvement-
// aware sign; an unmeasured tile (shouldn't reach here) yields a bare marker.
export function buildFitnessOutcome(tile: FitnessTile): FitnessOutcome {
  const vt = valueText(tile);
  const deltaText =
    tile.delta != null && tile.deltaArrow
      ? `${tile.delta > 0 ? "+" : ""}${tile.delta} vs your last check`
      : null;
  const arrowGlyph =
    tile.deltaArrow === "up" ? "↑ " : tile.deltaArrow === "down" ? "↓ " : "";
  // "Grip strength 50 kg — 68th percentile · ↑ +3 vs your last check".
  const head = `${tile.label} ${vt}`.trim();
  const tail: string[] = [];
  if (tile.overlay) tail.push(tile.overlay);
  if (deltaText) tail.push(`${arrowGlyph}${deltaText}`);
  const announcement = tail.length ? `${head} — ${tail.join(" · ")}` : head;
  return {
    key: tile.key,
    label: tile.label,
    valueText: vt,
    marker: tile.overlay,
    deltaText,
    deltaArrow: tile.deltaArrow,
    roughGuide: tile.roughGuide,
    announcement,
  };
}

// ── Battery completion (the finale) ──────────────────────────────────────────────

export interface BatteryCompletion {
  measured: number; // fresh-measured tests in the denominator
  total: number; // non-equipment-missing tests
  complete: boolean; // every non-excluded test carries a FRESH value
}

// Whether the battery is complete — the SAME "fresh value for every test, equipment-
// missing tests out of the denominator" definition the finale hangs on (#1307). "Fresh"
// = measured AND not stale (a stored value older than the retest window doesn't count as
// today's fitness — the #1129 staleness gate). A synced/auto-counted value counts toward
// completion; only whether a value is fresh matters, not whether the user typed it. An
// empty in-scope denominator is never "complete".
export function batteryCompletion(
  results: readonly FitnessTestResult[],
  equipmentMissingKeys: ReadonlySet<string>
): BatteryCompletion {
  const inScope = results.filter((r) => !equipmentMissingKeys.has(r.key));
  const fresh = (r: FitnessTestResult) => r.measured && !r.provenance?.stale;
  const measured = inScope.filter(fresh).length;
  const total = inScope.length;
  return { measured, total, complete: total > 0 && measured === total };
}

export interface BatteryCompletionSummary {
  fitnessAge: number | null;
  priorFitnessAge: number | null;
  improved: number;
  declined: number;
  fresh: number; // measured this check with no prior value to compare — "new"
}

// The factual completion summary — "fitness age 34 (was 36) · 4 improved · 2 declined ·
// 1 new" (#1307). Counts read the per-test deltas the model already holds; fitness age +
// prior come straight off the model. No confetti-science — the numbers are the
// celebration. Equipment-missing tests are excluded (they can't improve/decline).
export function batteryCompletionSummary(
  model: FitnessCheckModel,
  equipmentMissingKeys: ReadonlySet<string>
): BatteryCompletionSummary {
  const inScope = model.results.filter(
    (r) => r.measured && !equipmentMissingKeys.has(r.key)
  );
  return {
    fitnessAge: model.headlineFitnessAge?.fitnessAge ?? null,
    priorFitnessAge: model.priorHeadlineFitnessAge?.fitnessAge ?? null,
    improved: inScope.filter((r) => r.improved === true).length,
    declined: inScope.filter((r) => r.improved === false).length,
    fresh: inScope.filter((r) => r.delta == null).length,
  };
}
