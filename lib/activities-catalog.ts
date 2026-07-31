// Curated suggestions for cardio activities and sports, surfaced in the
// activity modal's autocomplete (reusing the same <datalist> search the
// strength exercise field uses). Past entries are merged in and the combined
// list is ranked by how often the user has logged each one.

export const CARDIO_ACTIVITIES = [
  "Running",
  "Walking",
  "Cycling",
  "Swimming",
  "Open Water Swim",
  "Rowing",
  "Elliptical",
  "Stair Climber",
  "Jump Rope",
  "Hiking",
  "Rucking",
  "Treadmill",
  "Spin Class",
  "HIIT",
  "Incline Walk",
  "Trail Run",
  "Kayaking",
  "Canoeing",
  "Paddleboarding",
  "Skiing",
  "Cross-Country Skiing",
  "Snowshoeing",
  "Ice Skating",
  "Skating",
  "Rollerblading",
  "Mountain Biking",
  "Stationary Bike",
  "Air Bike",
  "SkiErg",
  "Mixed Cardio",
  "Cardio Class",
  "Aerobics",
  "Water Aerobics",
  "Zumba",
  "Bootcamp",
  "Circuit Training",
  "CrossFit",
  "Calisthenics",
];

export const SPORTS = [
  "Tennis",
  "Basketball",
  "Soccer",
  "Football",
  "Baseball",
  "Softball",
  "Volleyball",
  "Badminton",
  "Table Tennis",
  "Squash",
  "Pickleball",
  "Racquetball",
  "Golf",
  "Hockey",
  "Lacrosse",
  "Rugby",
  "Cricket",
  "Handball",
  "Water Polo",
  "Boxing",
  "Kickboxing",
  "Martial Arts",
  "Wrestling",
  "Rock Climbing",
  "Bouldering",
  "Gymnastics",
  "Surfing",
  "Snowboarding",
  "Skateboarding",
  "Ultimate Frisbee",
  "Dancing",
];

// Curated recovery (mobility / flexibility) activities — the HABIT-tier movement
// domain (issue #840). Split OUT of SPORTS so yoga/stretch classify as `recovery`,
// not `sport` (a mobility session never carries strength/sport performance semantics).
export const RECOVERY_ACTIVITIES = [
  "Yoga",
  "Pilates",
  "Barre",
  "Tai Chi",
  "Stretching",
  "Mobility",
];

// Curated membership, for provenance checks: a cardio/sport name outside
// this set is user-coined, and the activity form keeps such parts "custom"
// so their type chips and (for cardio) distance field survive across
// sessions. The suggestion vocabulary can't stand in for this — it absorbs
// coined names after their first save.
const CURATED = new Set(
  [...CARDIO_ACTIVITIES, ...SPORTS, ...RECOVERY_ACTIVITIES].map((n) =>
    n.toLowerCase()
  )
);
export function isCuratedActivity(name: string): boolean {
  return CURATED.has(name.trim().toLowerCase());
}

// ---- Indoor / outdoor, and the indoor alternative (issue #1724) --------------------
//
// Weather-aware recommendations need two facts the catalog never carried: whether an
// activity happens OUTDOORS, and what the indoor version of it is. Both are properties
// of the activity, so they belong here beside the vocabulary rather than in the
// recommendation engine — the conditions stamps (#1728) read the same flag.
//
// MEMBERSHIP IS CONSERVATIVE AND EXPLICIT. Only activities that are outdoors by their
// nature are listed: a run can happen on a treadmill and a swim can happen in a pool,
// which is exactly why "Running" and "Swimming" are NOT here while "Trail Run" and
// "Open Water Swim" are — an unqualified name is ambiguous, and guessing would park a
// session someone was always going to do indoors. Anything unlisted is treated as
// weather-neutral and is never parked.

// Activities that happen outdoors by their nature.
const OUTDOOR_ACTIVITIES = new Set(
  [
    "Cycling",
    "Mountain Biking",
    "Trail Run",
    "Hiking",
    "Rucking",
    "Kayaking",
    "Canoeing",
    "Paddleboarding",
    "Skiing",
    "Cross-Country Skiing",
    "Snowshoeing",
    "Snowboarding",
    "Surfing",
    "Rollerblading",
    "Skateboarding",
    "Open Water Swim",
    "Golf",
    "Rock Climbing",
  ].map((n) => n.toLowerCase())
);

// Whether an activity is outdoor-by-nature. Case/space-folded; an unknown or ambiguous
// name is NOT outdoor (weather-neutral, never parked, never stamped).
export function isOutdoorActivity(name: string): boolean {
  return OUTDOOR_ACTIVITIES.has(name.trim().toLowerCase());
}

// The indoor stand-ins for an outdoor activity, best first. A list rather than a single
// name because the engine offers the first one the profile can actually DO (equipment
// or logged history) and falls through when it can do none of them — the alternative is
// an offer, not a substitution the app is entitled to make.
const INDOOR_ALTERNATIVES: Record<string, string[]> = {
  cycling: ["Stationary Bike", "Spin Class", "Air Bike"],
  "mountain biking": ["Stationary Bike", "Spin Class"],
  "trail run": ["Treadmill", "Elliptical"],
  hiking: ["Treadmill", "Incline Walk", "Stair Climber"],
  rucking: ["Incline Walk", "Treadmill", "Stair Climber"],
  "open water swim": ["Swimming"],
  kayaking: ["Rowing", "SkiErg"],
  canoeing: ["Rowing"],
  paddleboarding: ["Rowing"],
  "cross-country skiing": ["SkiErg", "Rowing"],
  skiing: ["SkiErg"],
  snowshoeing: ["Incline Walk", "Treadmill"],
  snowboarding: ["SkiErg"],
  rollerblading: ["Elliptical", "Stationary Bike"],
  skateboarding: ["Elliptical"],
  surfing: ["Rowing"],
  golf: [],
  "rock climbing": ["Bouldering"],
};

// The indoor alternatives for an outdoor activity, best first. Empty for an activity
// with no honest indoor equivalent (golf) and for anything unlisted — the engine then
// falls through to its normal next-best pick, with the disclosure intact.
export function indoorAlternatives(name: string): string[] {
  return INDOOR_ALTERNATIVES[name.trim().toLowerCase()] ?? [];
}
