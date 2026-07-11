import { CARDIO_ACTIVITIES, SPORTS } from "./activities-catalog";
import { liftInfo } from "./lifts";
import type { ActivityType } from "./types";

// Keyword sets for inferring an activity's type from its name.
const CARDIO_KEYWORDS = [
  "run",
  "jog",
  "sprint",
  "walk",
  "hike",
  "cycl",
  "bike",
  "spin",
  "swim",
  "row",
  "elliptical",
  "stair",
  "treadmill",
  "jump rope",
  "skipping",
  "hiit",
  "interval",
  "kayak",
  "canoe",
  "paddle",
  "ski",
  "skat",
  "snowshoe",
  "rollerblad",
  "cardio",
  "trail",
  "ruck",
  "zumba",
  "aerobic",
  "calisthenic",
  "bootcamp",
  "circuit",
  "crossfit",
];
const SPORT_KEYWORDS = [
  "tennis",
  "pickleball",
  "squash",
  "racquet",
  "badminton",
  "basketball",
  "soccer",
  "football",
  "baseball",
  "softball",
  "volleyball",
  "golf",
  "hockey",
  "rugby",
  "cricket",
  "box",
  "martial",
  "karate",
  "judo",
  "bjj",
  "climb",
  "boulder",
  "surf",
  "snowboard",
  "skateboard",
  "frisbee",
  "ultimate",
  "lacrosse",
  "handball",
  "water polo",
  "kickbox",
  "wrestl",
  "gymnast",
  "yoga",
  "pilates",
  "barre",
  "tai chi",
  "stretch",
  "dance",
];

// Exact curated names, authoritative over the fuzzy keyword lists below: a
// name the catalog lists is typed by which list it's on, so e.g. "Rowing"
// stays cardio (not the barbell-row lift) and "Skateboarding" stays a sport
// (not caught by cardio's "skat"). Keywords remain the fallback for the
// open-ended free text the catalog can't enumerate.
const CARDIO_CATALOG = new Set(CARDIO_ACTIVITIES.map((n) => n.toLowerCase()));
const SPORT_CATALOG = new Set(SPORTS.map((n) => n.toLowerCase()));

/** Infer the activity type from a name, or null if it can't be determined. */
export function resolveActivityType(name: string): ActivityType | null {
  const t = name.trim().toLowerCase();
  if (!t) return null;
  if (CARDIO_CATALOG.has(t)) return "cardio";
  if (SPORT_CATALOG.has(t)) return "sport";
  if (liftInfo(name)) return "strength";
  if (CARDIO_KEYWORDS.some((k) => t.includes(k))) return "cardio";
  if (SPORT_KEYWORDS.some((k) => t.includes(k))) return "sport";
  return null;
}

// Activities for which a distance makes sense.
const DISTANCE_KEYWORDS = [
  "run",
  "jog",
  "sprint",
  "walk",
  "hike",
  "cycl",
  "bike",
  "swim",
  "row",
  "kayak",
  "canoe",
  "ski",
  "trail",
  "treadmill",
  "ruck",
  "snowshoe",
  "ice skat",
];
export function requiresDistance(name: string): boolean {
  const t = name.trim().toLowerCase();
  return DISTANCE_KEYWORDS.some((k) => t.includes(k));
}

/** Type to seed a user-committed free-text activity with. Strength is a
 *  closed list (variant/equipment/muscle metadata doesn't apply to free
 *  text), so a strength inference is suppressed to null. */
export function inferFreeTextType(name: string): ActivityType | null {
  const t = resolveActivityType(name);
  return t === "strength" ? null : t;
}

/** Whether a part's distance input applies (and its entered value is saved):
 *  keyword-matched names as always, plus any custom (free-text) cardio part —
 *  a coined cardio activity deserves a distance even when no keyword
 *  recognizes it. */
export function showsDistanceField(
  name: string,
  type: ActivityType | null,
  custom: boolean
): boolean {
  if (type === "strength") return false;
  return requiresDistance(name) || (custom && type === "cardio");
}

/** Recover the activity name from a stored (generated) title, e.g.
 * "Morning Running Session" -> "Running". Used by the activity editor's
 * legacy-row loading. */
export function activityFromTitle(title: string): string {
  return title
    .trim()
    .replace(/^(Morning|Afternoon|Evening|Night)\s+/i, "")
    .replace(/\s+Session$/i, "")
    .trim();
}

/** The single part name the editor derives from a legacy (component-less)
 * cardio/sport row's freeform title: the stripped form when the picker knows
 * it, else the full title when IT is known (e.g. a row titled "Night Walk"
 * where "Night Walk" is a logged activity but "Walk" isn't), else the
 * stripped text — falling back to the title when stripping empties it — to
 * load as a custom activity. */
export function legacyActivityName(
  title: string,
  isKnown: (name: string) => boolean
): string {
  const stripped = activityFromTitle(title);
  if (isKnown(stripped)) return stripped;
  if (isKnown(title)) return title;
  return stripped || title;
}

/** Morning / Afternoon / Evening / Night from a "HH:MM" string, or null. */
export function timeOfDay(hhmm: string): string | null {
  if (!hhmm) return null;
  const h = Number(hhmm.slice(0, 2));
  if (Number.isNaN(h)) return null;
  if (h >= 5 && h < 12) return "Morning";
  if (h >= 12 && h < 17) return "Afternoon";
  if (h >= 17 && h < 21) return "Evening";
  return "Night";
}

/** Minutes between two "HH:MM" times, or null if invalid / not a positive span. */
export function minutesBetween(start: string, end: string): number | null {
  if (!start || !end) return null;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return null;
  const diff = eh * 60 + em - (sh * 60 + sm);
  return diff > 0 ? diff : null;
}

// One leg of a multisport ("brick") activity, as far as the roll-up cares.
export interface CompositeComponent {
  type: ActivityType;
  distance_km: number | null;
  duration_min: number | null;
}

// Multisport roll-up (issue #313, extracted from journal saveActivity). Collapses
// a composite's legs into the parent activity's overall distance/duration:
// - distance is the SUM of the legs, but ">0 else null" so a strength-only brick
//   (no distance) stores NULL rather than a misleading 0 km;
// - duration prefers the wall-CLOCK span (`clockDurationMin`, from start/end times)
//   when present — that's the true elapsed time including transitions — and only
//   falls back to the SUM of the legs' durations otherwise (again ">0 else null").
// Also reports whether any leg is a strength leg (the parent then gets a set-count).
// Pure so the journal write path and the Strava leg-grouping importer share it.
export function compositeRollup(
  components: CompositeComponent[],
  clockDurationMin: number | null
): {
  distanceKm: number | null;
  durationMin: number | null;
  hasStrength: boolean;
} {
  const hasStrength = components.some((c) => c.type === "strength");
  const totalDistanceKm = components.reduce(
    (sum, c) => sum + (c.distance_km ?? 0),
    0
  );
  const distanceKm = totalDistanceKm > 0 ? totalDistanceKm : null;
  const partsDuration = components.reduce(
    (sum, c) => sum + (c.duration_min ?? 0),
    0
  );
  const durationMin =
    clockDurationMin ?? (partsDuration > 0 ? partsDuration : null);
  return { distanceKm, durationMin, hasStrength };
}

/** Title-case lowercase words, leaving words with existing caps (e.g. HIIT). */
export function titleCase(s: string): string {
  return s.replace(/\b[\w']+/g, (w) =>
    w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w
  );
}
