// Body-metric data hygiene (issue #45, domain 5): detect a day-over-day weight
// reading that jumped more than can be physiologically real, so a scale glitch or a
// lb/kg entry mix-up gets caught before it poisons every downstream trend, chart,
// and goal projection.
//
// Pure and client-safe — no DB/network. The DB gather lives in lib/rule-findings.ts
// (getWeights → these functions → Finding[]), surfaced as a dismissible finding on
// the Trends → Body tab. The complementary guard — rejecting IMPOSSIBLE values at
// ENTRY — lives in lib/body-metric-input.ts (validateBodyMetricInput). Every
// threshold is a named constant with its rationale; boundaries are unit-tested in
// lib/__tests__/weight-anomaly.test.ts.

// A single dated weight reading (canonical kg) with its row id, so a finding can
// link to the exact entry to fix/convert/delete.
export interface DatedWeight {
  id: number;
  date: string; // YYYY-MM-DD
  weightKg: number;
}

// A jump between two near-consecutive readings large enough to be a probable data
// error rather than real change.
export interface WeightAnomaly {
  // The id of the LATER (suspect) reading — the one to fix/convert/delete.
  id: number;
  date: string;
  prevDate: string;
  weightKg: number;
  prevWeightKg: number;
  // Signed fractional change from prev → this reading (e.g. +0.12 = up 12%).
  changeFraction: number;
  // True when the ratio between the two readings is close to the kg↔lb factor, so
  // the likeliest cause is a unit mix-up rather than a random scale misread.
  suspectedUnitError: boolean;
}

// A day-over-day change beyond this fraction of body weight is almost certainly not
// real: true weight can swing a couple of percent on water/food, but a >3% shift in
// ~a day is the classic scale-glitch / transposed-entry signature.
export const WEIGHT_JUMP_FRACTION = 0.03;

// Only compare readings this close together — the check is a DAY-over-day guard, so
// a legitimately large change spread across weeks (real weight loss) is never
// flagged. Three days absorbs a skipped weigh-in or two without turning a monthly
// gap into a false "jump".
export const WEIGHT_JUMP_MAX_GAP_DAYS = 3;

// Pounds per kilogram — the factor a lb value mistakenly entered as kg (or vice
// versa) is off by. A jump whose ratio lands near this (within the tolerance below)
// reads as a unit mix-up, so the finding can suggest "convert" over "delete".
export const KG_PER_LB = 2.2046226218;

// How close the reading ratio must sit to KG_PER_LB (or its inverse) to call it a
// unit error — ±12% catches an entry-unit slip while excluding an ordinary big
// glitch that merely happens to be ~2×.
export const UNIT_ERROR_TOLERANCE = 0.12;

// Only surface anomalies within this recent window (days). An old, already-lived-
// with glitch buried deep in history isn't worth a standing nudge; the point is to
// catch a fresh bad entry. Generous enough to still flag last month's mistake.
export const ANOMALY_LOOKBACK_DAYS = 60;

// Whole days from an ISO date to `today` (both YYYY-MM-DD), or Infinity if
// unparseable.
function daysSince(dateISO: string, today: string): number {
  const a = Date.parse(`${dateISO}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.round((b - a) / 86_400_000);
}

// Whole days between two ISO dates (absolute), or Infinity if unparseable.
function daysBetween(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return Infinity;
  return Math.abs(Math.round((tb - ta) / 86_400_000));
}

// Whether the ratio of two readings looks like a kg↔lb entry mix-up.
function looksLikeUnitError(a: number, b: number): boolean {
  if (a <= 0 || b <= 0) return false;
  const ratio = Math.max(a, b) / Math.min(a, b);
  return Math.abs(ratio - KG_PER_LB) <= UNIT_ERROR_TOLERANCE * KG_PER_LB;
}

// Detect probable-error weight jumps. `weights` is any set of dated readings (order-
// independent); consecutive readings within WEIGHT_JUMP_MAX_GAP_DAYS whose relative
// change exceeds WEIGHT_JUMP_FRACTION are flagged, newest first, limited to the
// recent lookback window. Each anomaly names the LATER reading (the one to fix).
export function detectWeightAnomalies(
  weights: readonly DatedWeight[],
  today: string
): WeightAnomaly[] {
  // Ascending by date so "prev → this" is chronological; a stable id tie-break
  // keeps two same-day rows deterministic.
  const asc = [...weights].sort((x, y) =>
    x.date === y.date ? x.id - y.id : x.date.localeCompare(y.date)
  );
  const out: WeightAnomaly[] = [];
  for (let i = 1; i < asc.length; i++) {
    const prev = asc[i - 1];
    const cur = asc[i];
    if (daysBetween(prev.date, cur.date) > WEIGHT_JUMP_MAX_GAP_DAYS) continue;
    if (prev.weightKg <= 0) continue;
    const changeFraction = (cur.weightKg - prev.weightKg) / prev.weightKg;
    if (Math.abs(changeFraction) <= WEIGHT_JUMP_FRACTION) continue;
    const ago = daysSince(cur.date, today);
    if (ago < 0 || ago > ANOMALY_LOOKBACK_DAYS) continue;
    out.push({
      id: cur.id,
      date: cur.date,
      prevDate: prev.date,
      weightKg: cur.weightKg,
      prevWeightKg: prev.weightKg,
      changeFraction,
      suspectedUnitError: looksLikeUnitError(cur.weightKg, prev.weightKg),
    });
  }
  // Newest suspect first.
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

// The stable suppression/identity key for a weight-anomaly finding: one per suspect
// row id (`body-hygiene:weight-jump:<id>`). Id-keyed (ids never recycle), so a
// dismissal follows the exact bad reading — fixing/deleting it drops the finding,
// and the stale dismissal simply never matches again (a dead row, not wrong
// suppression — AGENTS.md #203).
export const BODY_HYGIENE_PREFIX = "body-hygiene:";

export function weightAnomalySignalKey(id: number): string {
  return `${BODY_HYGIENE_PREFIX}weight-jump:${id}`;
}
