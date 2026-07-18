// Pure icon-key resolution for activities. No React here — this maps an
// activity's type, title, and (optionally) its structured component/sport names
// to a stable icon KEY. `components/ActivityIcon.tsx` maps that key to a Tabler
// icon component. Kept pure and separate so the keyword matching is unit-tested
// (lib/__tests__/activity-icon.test.ts).
//
// Why component/sport names matter: an imported Strava ride is stored with the
// athlete's free-text title ("Morning Ride") but a canonical component sport
// ("Cycling"). Matching the structured sport first makes the journal icon agree
// with the activity form (which already icons off the canonical name) — see the
// bug where a bike ride showed a bike icon in the form but a running icon in the
// journal.

import { parseComponents } from "./types";

export type ActivityIconKey =
  | "barbell"
  | "run"
  | "medal"
  | "activity"
  | "ping-pong"
  | "disc"
  | "jump-rope"
  | "mountain"
  | "karate"
  | "skateboard"
  | "snowboard"
  | "ski"
  | "ice-skate"
  | "roller-skate"
  | "surf"
  | "kayak"
  | "bike"
  | "swim"
  | "walk"
  | "flame"
  | "basketball"
  | "soccer"
  | "american-football"
  | "baseball"
  | "volleyball"
  | "tennis"
  | "golf"
  | "yoga"
  | "stretch";

const TYPE_FALLBACK: Record<string, ActivityIconKey> = {
  strength: "barbell",
  cardio: "run",
  sport: "medal",
  // Recovery/mobility sessions (issue #840) icon as the stretch glyph by default;
  // per-move component names still match the yoga/stretch keyword rules first.
  recovery: "stretch",
};

// A keyword is a plain substring by default, or a RegExp when a word boundary
// matters — "ride" must not fire on "stride"/"pride"/"override", so it is
// `/\bride\b/` rather than the substring "ride".
type Matcher = string | RegExp;

// Ordered most-specific → most-general; the first RULE whose keyword is found in
// any source wins. Order matters (e.g. "table tennis" before "tennis", "skipping"
// before "ski"). Each source string is lowercased before matching.
const KEYWORD_ICONS: [Matcher[], ActivityIconKey][] = [
  [["table tennis", "ping pong", "ping-pong"], "ping-pong"],
  [["ultimate frisbee", "frisbee", "ultimate"], "disc"],
  [["jump rope", "jump-rope", "skipping"], "jump-rope"],
  [["rock climb", "bouldering", "climbing", "climb"], "mountain"],
  [
    [
      "martial",
      "karate",
      "judo",
      "jiu-jitsu",
      "jiu jitsu",
      "bjj",
      "taekwondo",
      "muay thai",
      "kickbox",
      "boxing",
      "wrestl",
    ],
    "karate",
  ],
  [["skateboard"], "skateboard"],
  [["snowboard"], "snowboard"],
  [["skiing", "ski"], "ski"],
  [["ice skat"], "ice-skate"],
  [["roller skat", "skating", "skate"], "roller-skate"],
  [["surf"], "surf"],
  [["rowing", "row"], "kayak"],
  [["kayak", "canoe", "paddle"], "kayak"],
  // "ride" (word-boundary) catches a component-less Strava-style title like
  // "Morning Ride"; the structured "Cycling" component is matched here too.
  [["cycling", "bicycle", "biking", "bike", "spin", /\bride\b/], "bike"],
  [["swimming", "swim"], "swim"],
  [["hiking", "hike", "snowshoe"], "mountain"],
  [["walking", "walk", "ruck"], "walk"],
  [["treadmill", "running", "run", "jog", "sprint", "trail"], "run"],
  [["hiit", "interval", "circuit"], "flame"],
  [["elliptical", "stair"], "run"],
  [["basketball"], "basketball"],
  [["soccer"], "soccer"],
  [["american football", "football"], "american-football"],
  [["baseball", "softball"], "baseball"],
  [["volleyball"], "volleyball"],
  [["badminton"], "tennis"],
  [["pickleball"], "ping-pong"],
  [["squash", "racquetball", "racquet"], "tennis"],
  [["tennis"], "tennis"],
  [["golf"], "golf"],
  [["rugby"], "american-football"],
  [["cricket"], "baseball"],
  [["yoga", "tai chi"], "yoga"],
  [["pilates", "barre", "stretch", "mobility"], "stretch"],
  [["dance", "dancing", "zumba"], "yoga"],
];

function srcMatches(src: string, m: Matcher): boolean {
  return typeof m === "string" ? src.includes(m) : m.test(src);
}

/**
 * Resolve the icon key for an activity. Strength is always the barbell. For
 * cardio/sport, the structured component/sport names (e.g. Strava's canonical
 * "Cycling") are matched BEFORE the free-text title, then the title, then a
 * per-type fallback. Source order is the priority — the first source with ANY
 * rule match decides, so a structured "Running" outranks every title keyword (a
 * run titled "Skate park loop" must not icon as skating). Rule order breaks
 * ties within one source ("table tennis" before "tennis").
 */
export function pickActivityIconKey(
  type: string,
  title?: string,
  sportNames?: string[]
): ActivityIconKey {
  if (type === "strength") return "barbell";
  const sources = [...(sportNames ?? []), title ?? ""]
    .filter((s) => s)
    .map((s) => s.toLowerCase());
  for (const src of sources) {
    for (const [keys, icon] of KEYWORD_ICONS) {
      if (keys.some((k) => srcMatches(src, k))) return icon;
    }
  }
  return TYPE_FALLBACK[type] ?? "activity";
}

/**
 * Non-strength component (sport/cardio) names parsed from an activity's stored
 * `components` JSON, for icon keyword matching. Defensive: returns [] for absent
 * or malformed JSON. Strength component names are excluded so a lift name can't
 * pull a cardio/sport row's icon (e.g. a "Farmer's Walk" lift → walk icon).
 */
export function activityComponentSportNames(
  componentsJson: string | null | undefined
): string[] {
  return parseComponents(componentsJson)
    .filter((c) => c && typeof c.name === "string" && c.type !== "strength")
    .map((c) => c.name);
}
