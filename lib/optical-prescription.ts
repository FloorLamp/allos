// Pure normalization + display helpers for structured optical prescriptions (#697).
//
// The ONE place raw optical-Rx strings (from the AI extractor OR a manual form) are
// coerced onto the DB's shape, plus the display labels the UI reads. No DB/network
// imports, so the Server Actions and the import persist path share the same coercion
// (the "one question, one computation" rule) and it unit-tests without a handle.
//
// Scope: nothing here interprets a prescription's clinical meaning — it maps a
// stated kind onto the enum, parses dioptre / axis / distance numbers off the loose
// notation an Rx slip uses (a leading "+", "plano"/"pl", "DS", "SPH"), and formats
// what the slip already said (OD = right eye, OS = left eye).

import type { OpticalKind } from "./types/medical";

export const OPTICAL_KINDS: readonly OpticalKind[] = ["glasses", "contacts"];

// Normalize a stated kind onto the enum. Unknown / absent → 'glasses' (the safe
// default: an eyeglass Rx is the common case, and it stores the same refraction).
export function normalizeOpticalKind(raw: unknown): OpticalKind {
  if (typeof raw !== "string") return "glasses";
  const s = raw.trim().toLowerCase();
  if (
    s.includes("contact") ||
    s === "cl" ||
    s.includes("lens") ||
    s.includes("soft") ||
    s.includes("toric") ||
    s.includes("rgp")
  )
    return "contacts";
  return "glasses";
}

// Parse a dioptre value (sphere / cylinder / add) off an Rx slip. Accepts a leading
// "+" ("+1.25"), a bare negative ("-2.00"), "plano" / "pl" / "0" (→ 0), and strips a
// trailing unit token ("D", "DS", "SPH"). Returns null when there's nothing numeric.
export function parseDiopter(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s === "plano" || s === "pl" || s === "plan" || s === "ds") return 0;
  const m = s.match(/[+-]?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

// Parse a cylinder axis: a whole degree in [0, 180]. Anything outside that range,
// or non-numeric, → null (an axis is only meaningful with a cylinder anyway).
export function parseAxis(raw: unknown): number | null {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    const r = Math.round(raw);
    return r >= 0 && r <= 180 ? r : null;
  }
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  const m = s.match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const r = Math.round(Number(m[0]));
  return Number.isFinite(r) && r >= 0 && r <= 180 ? r : null;
}

// Parse a plain positive measurement (PD in mm, contact base curve / diameter in mm).
// Returns null when there's nothing numeric or the value is non-positive.
export function parseMillimeters(raw: unknown): number | null {
  if (typeof raw === "number")
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  const m = s.match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ── Cylinder-notation canonicalization (#1036) ────────────────────────────────
//
// The same refraction is written two ways: MINUS-cylinder (US optometry standard,
// and how contact-lens torics are always written) and PLUS-cylinder (common in
// ophthalmology). They transpose exactly — "−2.00 −1.00 ×180" ≡ "−3.00 +1.00 ×090"
// — and the SPHERE differs by the full cylinder amount between the notations, so
// storing both uncompared makes the sphere-over-time trend read a convention switch
// as fake myopia progression. Canonical storage is MINUS-cylinder (the kg/km rule
// applied to notation); this is exact algebra, no heuristics, and no clinical
// interpretation — the slip's refraction is stored exactly, in one convention.

// One eye's refraction triple, as stored (sphere/cylinder in dioptres, axis in
// whole degrees 0–180 or null).
export interface EyeRefraction {
  sphere: number | null;
  cylinder: number | null;
  axis: number | null;
}

// Quarter-dioptre steps are exact in binary, but keep the algebra safe for odd
// decimal steps too.
function roundDiopter(n: number): number {
  return Math.round(n * 100) / 100;
}

// Transpose a plus-cylinder refraction onto canonical minus-cylinder form:
//   sphere′ = sphere + cyl,  cyl′ = −cyl,  axis′ = (axis + 90) mod 180 (0 ⇒ 180,
//   matching the 1–180 axis convention: 90 ↔ 180 wrap).
// A minus-cylinder or cylinder-less triple passes through UNTOUCHED. A plus-cyl
// entry with a MISSING axis still transposes sphere/cyl (the sphere is what the
// trend reads) with axis′ = null; a missing sphere transposes cyl/axis only (the
// minus-cyl sphere would be sphere + cyl, which is unknowable without the sphere).
export function transposeToMinusCylinder(eye: EyeRefraction): EyeRefraction {
  const { sphere, cylinder, axis } = eye;
  if (cylinder == null || cylinder <= 0) return eye;
  return {
    sphere: sphere == null ? null : roundDiopter(sphere + cylinder),
    cylinder: roundDiopter(-cylinder),
    axis: axis == null ? null : (axis + 90) % 180 || 180,
  };
}

// The ONE shared per-eye coercion (#221): parse a slip's sphere/cylinder/axis
// strings and canonicalize onto minus-cylinder notation. The manual form, the AI
// Rx-slip extractor, and the FHIR VisionPrescription mapper all route an eye's
// triple through here, so every path normalizes identically and a plus-cyl entry
// can never land raw in od_/os_sphere/cylinder/axis.
export function parseEyeRefraction(
  sphereRaw: unknown,
  cylinderRaw: unknown,
  axisRaw: unknown
): EyeRefraction {
  return transposeToMinusCylinder({
    sphere: parseDiopter(sphereRaw),
    cylinder: parseDiopter(cylinderRaw),
    axis: parseAxis(axisRaw),
  });
}

export function kindLabel(k: OpticalKind): string {
  return k === "contacts" ? "Contacts" : "Glasses";
}

// Format a dioptre value the way an Rx reads: an explicit leading "+" for a positive
// power, two decimals, and "Plano" for exactly zero. Null → an em dash placeholder.
export function formatDiopter(n: number | null): string {
  if (n == null) return "—";
  if (n === 0) return "Plano";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}`;
}

// The one-line identity a prescription shows in a list / tab / passport: the kind and
// a compact per-eye sphere ("OD −2.00 / OS −1.75"), so two Rx of the same kind are
// still distinguishable at a glance. Purely factual — no interpretation.
export function prescriptionDisplayLabel(rx: {
  kind: OpticalKind;
  od_sphere: number | null;
  os_sphere: number | null;
}): string {
  const eyes: string[] = [];
  if (rx.od_sphere != null) eyes.push(`OD ${formatDiopter(rx.od_sphere)}`);
  if (rx.os_sphere != null) eyes.push(`OS ${formatDiopter(rx.os_sphere)}`);
  const eyePart = eyes.length ? ` (${eyes.join(" / ")})` : "";
  return `${kindLabel(rx.kind)}${eyePart}`;
}

// Expiry state for the plain "expires soon" / "expired" text on the Vision page —
// deliberately UI text, NOT a findings-engine signal (#697 leaves the calm-finding
// wiring to the existing vision_exam machinery). `today` and `expiry` are ISO
// YYYY-MM-DD. Returns null when there's no expiry to judge. "soon" = within 60 days.
// One dated point on the per-eye sphere-over-time progression ("is my myopia getting
// worse?" — #697). Built purely from the stored prescriptions so the Vision page and
// any future surface read the SAME series (the one-question-one-computation rule).
export interface SphereProgressionPoint {
  date: string; // issued_date (ISO), only dated Rx contribute
  od: number | null;
  os: number | null;
}

// Build the sphere-over-time series (OLDEST first, only prescriptions with an issued
// date and at least one eye's sphere), plus the net change from first→last per eye
// (negative = more myopic). `null` net when an eye has fewer than two data points.
export function sphereProgression(
  prescriptions: {
    issued_date: string | null;
    od_sphere: number | null;
    os_sphere: number | null;
  }[]
): {
  points: SphereProgressionPoint[];
  netOd: number | null;
  netOs: number | null;
} {
  const points: SphereProgressionPoint[] = prescriptions
    .filter(
      (p) => p.issued_date && (p.od_sphere != null || p.os_sphere != null)
    )
    .map((p) => ({
      date: p.issued_date as string,
      od: p.od_sphere,
      os: p.os_sphere,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const net = (pick: (pt: SphereProgressionPoint) => number | null) => {
    const vals = points.map(pick).filter((v): v is number => v != null);
    return vals.length >= 2 ? vals[vals.length - 1] - vals[0] : null;
  };
  return { points, netOd: net((p) => p.od), netOs: net((p) => p.os) };
}

export type RxExpiryState = "expired" | "expiring-soon" | "current";

export function rxExpiryState(
  expiry: string | null,
  today: string,
  soonWithinDays = 60
): RxExpiryState | null {
  if (!expiry) return null;
  const exp = Date.parse(`${expiry}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(exp) || Number.isNaN(now)) return null;
  if (exp < now) return "expired";
  const days = (exp - now) / 86_400_000;
  return days <= soonWithinDays ? "expiring-soon" : "current";
}
