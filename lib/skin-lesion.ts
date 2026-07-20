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

// Synonym/alias layer (#1038): common loose phrasings — the way a derm report or
// photo caption names a spot — folded onto the coarse vocabulary. EXCLUSION
// DISCIPLINE: only anatomically unambiguous mappings belong here (a sole IS on the
// foot; a calf IS on the leg). Boundary or ambiguous terms (wrist, elbow, ankle,
// groin, ear, "head", flank, torso) are deliberately ABSENT — guessing a wrong
// region would silently merge two different moles' follow-up tracks, which is
// worse than the honest null. Keys are matched against the whole cleaned phrase
// after qualifier stripping, so multi-word entries ("belly button") work.
const BODY_REGION_SYNONYMS: Record<string, BodyRegion> = {
  // abdomen
  belly: "abdomen",
  tummy: "abdomen",
  stomach: "abdomen",
  abdominal: "abdomen",
  navel: "abdomen",
  umbilicus: "abdomen",
  "belly button": "abdomen",
  // foot
  sole: "foot",
  heel: "foot",
  toe: "foot",
  toes: "foot",
  feet: "foot",
  instep: "foot",
  // leg (lower leg)
  calf: "leg",
  calves: "leg",
  shin: "leg",
  knee: "leg",
  legs: "leg",
  // face
  temple: "face",
  forehead: "face",
  cheek: "face",
  chin: "face",
  nose: "face",
  jaw: "face",
  brow: "face",
  eyebrow: "face",
  eyelid: "face",
  // hand
  palm: "hand",
  finger: "hand",
  fingers: "hand",
  thumb: "hand",
  knuckle: "hand",
  hands: "hand",
  // arm (upper arm — "upper"/"lower" are stripped as qualifiers, so "upper arm"
  // reaches "arm" directly; these cover the muscle names)
  bicep: "arm",
  biceps: "arm",
  tricep: "arm",
  triceps: "arm",
  arms: "arm",
  forearms: "forearm",
  // thigh
  hamstring: "thigh",
  quadriceps: "thigh",
  thighs: "thigh",
  // buttock
  buttocks: "buttock",
  butt: "buttock",
  glute: "buttock",
  glutes: "buttock",
  gluteal: "buttock",
  // chest (the breast/sternum are on the chest wall)
  breast: "chest",
  sternum: "chest",
  // back (the scapular region is the surface of the back)
  scapula: "back",
  "shoulder blade": "back",
  // neck
  nape: "neck",
  // shoulder
  shoulders: "shoulder",
  hips: "hip",
};

// Qualifier tokens stripped before re-matching the core term: laterality ("left
// upper arm" — the laterality itself lands in body_side via normalizeBodySide),
// position modifiers, and filler. "back" is NOT here — it is a region.
const BODY_REGION_QUALIFIERS = new Set([
  "left",
  "right",
  "l",
  "r",
  "lt",
  "rt",
  "upper",
  "lower",
  "mid",
  "middle",
  "central",
  "proximal",
  "distal",
  "inner",
  "outer",
  "anterior",
  "posterior",
  "medial",
  "lateral",
  "dorsal",
  "ventral",
  "front",
  "side",
  "area",
  "region",
  "of",
  "the",
  "on",
  "near",
]);

// Coerce a region onto the coarse vocabulary, or null when empty/unknown. Free text is
// NOT preserved here (the free-text location detail belongs in `label`); an unknown
// region degrades to null so filters/grouping stay on the fixed map.
//
// Tolerant matching (#1038): the manual form is a <select> (always canonical), but
// the AI-extraction / import path feeds loose free text ("left upper back",
// "belly", "R forearm"). Before this fold, every loose phrasing degraded silently
// to null → 'other', splitting one mole's follow-up track in two. The fold is
// CONSERVATIVE: exact match first, then the synonym table on the whole phrase,
// then qualifier-stripping (laterality/position words) and a re-match of the core
// — an unrecognized core still degrades to null (never guess a region).
export function normalizeBodyRegion(raw: unknown): BodyRegion | null {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!v) return null;
  if ((BODY_REGIONS as readonly string[]).includes(v)) return v as BodyRegion;

  const match = (phrase: string): BodyRegion | null => {
    if ((BODY_REGIONS as readonly string[]).includes(phrase))
      return phrase as BodyRegion;
    return BODY_REGION_SYNONYMS[phrase] ?? null;
  };

  // Fold punctuation/hyphens to spaces so "belly-button" / "arm, left" tokenize.
  const cleaned = v
    .replace(/[.,;:()/]+/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const whole = match(cleaned);
  if (whole) return whole;

  // Strip qualifier tokens and re-match the remaining core ("left upper arm" →
  // "arm", "R forearm" → "forearm"). A multi-word core only matches if it is
  // itself a region or a listed synonym — anything else stays null.
  const core = cleaned
    .split(" ")
    .filter((t) => t && !BODY_REGION_QUALIFIERS.has(t))
    .join(" ");
  if (!core || core === cleaned) return null;
  return match(core);
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

// Laterality abbreviations the import path's loose text uses ("R forearm", "lt").
const SIDE_ABBREVIATIONS: Record<string, BodySide> = {
  l: "left",
  lt: "left",
  r: "right",
  rt: "right",
};

// Tolerant like normalizeBodyRegion (#1038): exact vocabulary first, then the
// L/R abbreviations, then a LEADING laterality word off a longer phrase ("left
// upper arm" → left) — the same phrase the region fold strips it from, so the
// laterality isn't lost when the AI put the whole location in one field.
// Anything else (including ambiguous words like "center") stays null.
export function normalizeBodySide(raw: unknown): BodySide | null {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!v) return null;
  if ((BODY_SIDES as readonly string[]).includes(v)) return v as BodySide;
  if (SIDE_ABBREVIATIONS[v]) return SIDE_ABBREVIATIONS[v];
  const first = v
    .replace(/[.,;:()/-]+/g, " ")
    .trim()
    .split(/\s+/)[0];
  if (!first || first === v) return null;
  if ((BODY_SIDES as readonly string[]).includes(first))
    return first as BodySide;
  return SIDE_ABBREVIATIONS[first] ?? null;
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
