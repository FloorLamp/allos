// Overlay / compare math for the Trends hub (issue #212, Phase 2). Given two
// date-keyed numeric series (e.g. body weight vs resting HR, or two biomarkers),
// align them onto one shared time axis, optionally min-max normalize each so
// series in different units can be eyeballed together, and compute a Pearson
// correlation over the dates they share. All pure (no DB, no unit conversion) and
// unit-tested; the section component feeds it series it already built.

export interface DatedPoint {
  date: string; // YYYY-MM-DD
  value: number;
}

export interface AlignedPoint {
  date: string;
  a: number | null;
  b: number | null;
}

// Collapse a series to one value per date (last write wins for a duplicated date)
// as a date→value map. Non-finite values are dropped so NaN/Infinity can't poison
// the axis or the correlation.
function toDateMap(series: readonly DatedPoint[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of series) {
    if (p && typeof p.date === "string" && Number.isFinite(p.value)) {
      m.set(p.date, p.value);
    }
  }
  return m;
}

// Align two series onto the sorted union of their dates. Each row carries a's and
// b's value for that date, or null where a series has no reading. The result is
// ascending by date (ISO dates sort lexically), ready to plot on one axis.
export function alignSeries(
  a: readonly DatedPoint[],
  b: readonly DatedPoint[]
): AlignedPoint[] {
  const ma = toDateMap(a);
  const mb = toDateMap(b);
  const dates = [...new Set([...ma.keys(), ...mb.keys()])].sort();
  return dates.map((date) => ({
    date,
    a: ma.has(date) ? (ma.get(date) as number) : null,
    b: mb.has(date) ? (mb.get(date) as number) : null,
  }));
}

// The dates where BOTH series have a reading — the only rows a correlation can be
// computed over.
export function pairedPoints(
  aligned: readonly AlignedPoint[]
): { a: number; b: number }[] {
  const out: { a: number; b: number }[] = [];
  for (const p of aligned) {
    if (p.a != null && p.b != null) out.push({ a: p.a, b: p.b });
  }
  return out;
}

// Pearson correlation coefficient over the paired (both-present) dates. Returns
// null when fewer than 2 pairs exist or either series is constant (zero variance),
// since r is undefined there. Otherwise a number in [-1, 1].
export function pearson(aligned: readonly AlignedPoint[]): number | null {
  const pairs = pairedPoints(aligned);
  const n = pairs.length;
  if (n < 2) return null;
  let sa = 0;
  let sb = 0;
  for (const p of pairs) {
    sa += p.a;
    sb += p.b;
  }
  const ma = sa / n;
  const mb = sb / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (const p of pairs) {
    const da = p.a - ma;
    const db = p.b - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va === 0 || vb === 0) return null;
  const r = cov / Math.sqrt(va * vb);
  // Clamp tiny floating-point overshoot past ±1.
  return Math.max(-1, Math.min(1, r));
}

// Min-max normalize one axis of the aligned rows to [0, 1], based only on that
// axis's present values. A constant axis maps to 0.5 (mid-band) so it renders as a
// flat centered line rather than dividing by zero. Nulls are preserved (gaps stay
// gaps). Returns a fresh array; the input is not mutated.
function normalizeAxis(
  aligned: readonly AlignedPoint[],
  pick: (p: AlignedPoint) => number | null,
  set: (p: AlignedPoint, v: number | null) => AlignedPoint
): AlignedPoint[] {
  const values = aligned
    .map(pick)
    .filter((v): v is number => v != null && Number.isFinite(v));
  if (values.length === 0) return aligned.map((p) => set(p, pick(p)));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  return aligned.map((p) => {
    const v = pick(p);
    if (v == null) return set(p, null);
    return set(p, span === 0 ? 0.5 : (v - min) / span);
  });
}

// Min-max normalize BOTH axes independently to [0, 1] so two series in different
// units share a 0–1 axis and their shapes can be overlaid. Use this for the
// "normalized" overlay mode; leave it off for a dual-axis raw-value chart.
export function normalizeAligned(
  aligned: readonly AlignedPoint[]
): AlignedPoint[] {
  const a = normalizeAxis(
    aligned,
    (p) => p.a,
    (p, v) => ({ ...p, a: v })
  );
  return normalizeAxis(
    a,
    (p) => p.b,
    (p, v) => ({ ...p, b: v })
  );
}

export type CorrelationStrength = "none" | "weak" | "moderate" | "strong";

// A plain-language read on a Pearson r, for a caption under the overlay. Uses
// |r| thresholds (0.3 / 0.5 / 0.7 — common social-science rules of thumb) and
// names the sign. Null r (too few shared points / constant series) → null.
export function describeCorrelation(r: number | null): {
  strength: CorrelationStrength;
  sign: "positive" | "negative" | "none";
  label: string;
} | null {
  if (r == null) return null;
  const mag = Math.abs(r);
  const strength: CorrelationStrength =
    mag < 0.3 ? "none" : mag < 0.5 ? "weak" : mag < 0.7 ? "moderate" : "strong";
  const sign = strength === "none" ? "none" : r > 0 ? "positive" : "negative";
  const label =
    strength === "none"
      ? "No clear correlation"
      : `${strength[0].toUpperCase()}${strength.slice(1)} ${sign} correlation`;
  return { strength, sign, label };
}
