// Pure domain helpers for SKIN-LESION tracking (issue #715). No DB/network — the
// normalizers, the coarse body-map vocabulary, the display labels, and the lesion
// IDENTITY function every surface keys on (#482). The Server Actions + import path (if
// any) call the normalizers so a form/enum value can never trip the DB CHECK; the
// follow-up adapter (lib/followup-skin.ts) and the queries key resolution/grouping on
// the identity function so a "recheck" of the SAME mole resolves the right follow-up
// and its serial photos gather under one lesion.
//
// SCOPE BOUNDARY (issue #715, LAW): the ABCDE fields are USER-RECORDED OBSERVATIONS,
// never scored into a malignancy/risk verdict. Nothing here judges a lesion as
// "concerning" — the app tracks and compares; any assessment is the user's
// dermatologist's. Copy stays informational.

import type { SkinLesion } from "./types/medical";

// The lesion lifecycle classifier. 'active' is a lesion being tracked; 'watch' is one
// flagged for a recheck (seeds a follow-up — #700); 'removed' is excised/gone (history).
export type SkinLesionStatus = "active" | "watch" | "removed";

export const SKIN_LESION_STATUSES: readonly SkinLesionStatus[] = [
  "active",
  "watch",
  "removed",
];

const STATUS_LABELS: Record<SkinLesionStatus, string> = {
  active: "Active",
  watch: "Watch",
  removed: "Removed",
};

export function skinLesionStatusLabel(
  status: string | null | undefined
): string {
  const s = String(status ?? "").toLowerCase();
  return (STATUS_LABELS as Record<string, string>)[s] ?? "Active";
}

// Coerce a submitted/stored status onto the CHECK set; anything off-vocabulary
// degrades to the safe default 'active' (the dental normalizer posture) so an import
// or a tampered form can never assert a bad status.
export function normalizeSkinLesionStatus(raw: unknown): SkinLesionStatus {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  return (SKIN_LESION_STATUSES as readonly string[]).includes(v)
    ? (v as SkinLesionStatus)
    : "active";
}

// The COARSE body-map region vocabulary — a small, fixed set (the "coarse body-map
// region" of the ask). The free-text detail of WHERE lives in the lesion's `label`
// ("upper left forearm, near elbow"); this classifier is the map bucket the list
// filters/groups by. Rendered as a <select> in the form, so it is always valid there.
export const BODY_REGIONS = [
  "scalp",
  "face",
  "neck",
  "chest",
  "back",
  "abdomen",
  "shoulder",
  "arm",
  "forearm",
  "hand",
  "buttock",
  "hip",
  "thigh",
  "leg",
  "foot",
  "genital",
  "other",
] as const;

export type BodyRegion = (typeof BODY_REGIONS)[number];

// Title-case a region token for display ("forearm" → "Forearm").
export function bodyRegionLabel(region: string | null | undefined): string {
  const r = String(region ?? "").trim();
  if (!r) return "—";
  return r.charAt(0).toUpperCase() + r.slice(1);
}

// Coerce a region onto the coarse vocabulary, or null when empty/unknown. Free text is
// NOT preserved here (the free-text location detail belongs in `label`); an unknown
// region degrades to null so filters/grouping stay on the fixed map.
export function normalizeBodyRegion(raw: unknown): BodyRegion | null {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!v) return null;
  return (BODY_REGIONS as readonly string[]).includes(v)
    ? (v as BodyRegion)
    : null;
}

// Laterality of a paired region. 'midline' for a central lesion; null when unknown or
// the region isn't paired.
export type BodySide = "left" | "right" | "midline";

export const BODY_SIDES: readonly BodySide[] = ["left", "right", "midline"];

const SIDE_LABELS: Record<BodySide, string> = {
  left: "Left",
  right: "Right",
  midline: "Midline",
};

export function bodySideLabel(side: string | null | undefined): string {
  const s = String(side ?? "").toLowerCase();
  return (SIDE_LABELS as Record<string, string>)[s] ?? "";
}

export function normalizeBodySide(raw: unknown): BodySide | null {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  return (BODY_SIDES as readonly string[]).includes(v) ? (v as BodySide) : null;
}

// A positive size in millimetres, or null. Diameter is one of the ABCDE dimensions;
// this is the measured value (the "D > 6 mm" flag is a separate user observation).
export function normalizeSizeMm(raw: unknown): number | null {
  const n = Number(String(raw ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : null;
}

// A checkbox/flag value → 0/1 (the ABCDE observations are stored as 0/1 ints).
export function toFlag(raw: unknown): 0 | 1 {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  return v === "1" || v === "on" || v === "true" || v === "yes" ? 1 : 0;
}

// The five ABCDE observation dimensions, in order. LABELS ARE DESCRIPTIVE, NOT
// PRESCRIPTIVE — they name what the user observed, never a verdict (#715 scope).
export const ABCDE_DIMENSIONS = [
  { key: "asymmetry", letter: "A", label: "Asymmetry" },
  { key: "border", letter: "B", label: "Border irregular" },
  { key: "color", letter: "C", label: "Color varied" },
  { key: "diameter", letter: "D", label: "Diameter over 6 mm" },
  { key: "evolving", letter: "E", label: "Evolving / changed" },
] as const;

export type AbcdeKey = (typeof ABCDE_DIMENSIONS)[number]["key"];

// The set ABCDE letters for a lesion, e.g. "A·B·E" — a compact, NEUTRAL summary of the
// recorded observations (no count-as-score, no threshold judgment). Empty string when
// none are set.
export function abcdeLetters(l: Pick<SkinLesion, AbcdeKey>): string {
  return ABCDE_DIMENSIONS.filter((d) => l[d.key] === 1)
    .map((d) => d.letter)
    .join("·");
}

// YYYY-MM of an observation date (for a compact "(2026-03)" reason tail).
function observedMonth(l: Pick<SkinLesion, "observed_date">): string {
  return l.observed_date ? l.observed_date.slice(0, 7) : "";
}

// The lesion's display label — the free-text identity name, or a body-map fallback so
// an unlabeled lesion still reads ("Forearm lesion"). Never empty.
export function skinLesionDisplayLabel(
  l: Pick<SkinLesion, "label" | "body_region" | "body_side">
): string {
  const label = l.label?.trim();
  if (label) return label;
  const region = bodyRegionLabel(l.body_region);
  const side = bodySideLabel(l.body_side);
  if (region !== "—")
    return side ? `${side} ${region.toLowerCase()} lesion` : `${region} lesion`;
  return "Skin lesion";
}

// The compact body-map location ("Left forearm", "Back"), or "" when unknown.
export function bodyMapLabel(
  l: Pick<SkinLesion, "body_region" | "body_side">
): string {
  const region = bodyRegionLabel(l.body_region);
  if (region === "—") return "";
  const side = bodySideLabel(l.body_side);
  return side ? `${side} ${region.toLowerCase()}` : region;
}

// The lesion IDENTITY key (#482) — the ONE function every surface keys on so serial
// records/photos of the SAME mole gather together and a recheck resolves the right
// follow-up. Strict on the normalized (region, side, label) tuple: distinct moles stay
// APART (the exclusion discipline — over-collapsing would let a recheck of one mole
// wrongly "resolve" another). Two records are the same lesion iff their keys match.
export function skinLesionIdentityKey(
  l: Pick<SkinLesion, "label" | "body_region" | "body_side">
): string {
  const region = (normalizeBodyRegion(l.body_region) ?? "").toLowerCase();
  const side = (normalizeBodySide(l.body_side) ?? "").toLowerCase();
  const label = (l.label ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return `${region}|${side}|${label}`;
}

// Whether two lesion records describe the SAME lesion (strict identity match).
export function sameLesion(
  a: Pick<SkinLesion, "label" | "body_region" | "body_side">,
  b: Pick<SkinLesion, "label" | "body_region" | "body_side">
): boolean {
  return skinLesionIdentityKey(a) === skinLesionIdentityKey(b);
}
