import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 117: backfill the canonical single activity component that the Fitbit
// Takeout exercise parser previously omitted.
//
// The parent title remains Fitbit's provider-owned wording ("Walk", "Swim",
// "Outdoor Bike"). The component is the app's grouping identity, matching the
// single-component summaries Strava and Oura already store. Restrict the correction
// to unedited rows with no component: a hand-corrected imported activity is
// user-owned, and a populated component must never be replaced.
//
// Self-contained by design (manifest freeze — never imports the live parser): this
// canonical map is the shipped historical correction. Future vocabulary changes
// belong in a new migration.
const COMPONENT_NAMES: Readonly<Record<string, string>> = {
  run: "Running",
  running: "Running",
  walk: "Walking",
  walking: "Walking",
  hike: "Hiking",
  hiking: "Hiking",
  swim: "Swimming",
  swimming: "Swimming",
  row: "Rowing",
  rowing: "Rowing",
  "rowing machine": "Rowing",
  "jumping rope": "Jump Rope",
  "tabata workout": "HIIT",
  "roller blading": "Rollerblading",
  "outdoor bike": "Cycling",
  "outdoor cycling": "Cycling",
  bike: "Cycling",
  bicycling: "Cycling",
  cycling: "Cycling",
  spinning: "Stationary Bike",
  "indoor cycling": "Stationary Bike",
  "exercise bike": "Stationary Bike",
  stairclimber: "Stair Climber",
  "stair climbing": "Stair Climber",
  weights: "Weight Training",
  "weight training": "Weight Training",
  "strength training": "Weight Training",
};

const STRENGTH_LABELS: ReadonlySet<string> = new Set([
  "weights",
  "weight training",
  "strength training",
  "trx",
]);

// Exact curated sports must win over fuzzy cardio fragments. For example,
// "Skateboarding" contains "skat" but is a sport, while "Ice Skating" is cardio.
const SPORT_LABELS: ReadonlySet<string> = new Set([
  "tennis",
  "basketball",
  "soccer",
  "football",
  "baseball",
  "softball",
  "volleyball",
  "badminton",
  "table tennis",
  "squash",
  "pickleball",
  "racquetball",
  "golf",
  "hockey",
  "lacrosse",
  "rugby",
  "cricket",
  "handball",
  "water polo",
  "boxing",
  "kickboxing",
  "martial arts",
  "wrestling",
  "rock climbing",
  "bouldering",
  "gymnastics",
  "surfing",
  "snowboarding",
  "skateboarding",
  "ultimate frisbee",
  "dancing",
]);

// Frozen subset of the shared activity taxonomy needed to correct already-imported
// Fitbit summaries. Sports are the conservative fallback; these lists only identify
// categories whose non-sport meaning is explicit in their name.
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
] as const;

const RECOVERY_KEYWORDS = [
  "yoga",
  "pilates",
  "barre",
  "tai chi",
  "stretch",
  "mobility",
  "mobilit",
  "foam roll",
  "cooldown",
  "cool down",
] as const;

function activityType(rawTitle: string, componentName: string): string {
  const raw = rawTitle.toLowerCase();
  const name = componentName.toLowerCase();
  if (STRENGTH_LABELS.has(raw)) return "strength";
  if (SPORT_LABELS.has(name)) return "sport";
  if (CARDIO_KEYWORDS.some((keyword) => name.includes(keyword)))
    return "cardio";
  if (RECOVERY_KEYWORDS.some((keyword) => name.includes(keyword)))
    return "recovery";
  return "sport";
}

interface FitbitActivityRow {
  id: number;
  title: string;
  type: string;
  distance_km: number | null;
  duration_min: number | null;
}

export function up(db: Database.Database): void {
  const profiles = db.prepare(`SELECT id FROM profiles`).all() as {
    id: number;
  }[];
  const find = db.prepare(
    `SELECT id, title, type, distance_km, duration_min
         FROM activities
        WHERE profile_id = ?
          AND source = 'fitbit-takeout'
          AND components IS NULL
          AND COALESCE(edited, 0) = 0`
  );
  const update = db.prepare(
    `UPDATE activities
        SET type = ?, components = ?
      WHERE id = ?
        AND profile_id = ?
        AND source = 'fitbit-takeout'
        AND components IS NULL
        AND COALESCE(edited, 0) = 0`
  );

  for (const profile of profiles) {
    const rows = find.all(profile.id) as FitbitActivityRow[];
    for (const row of rows) {
      const title = row.title.trim();
      const name = COMPONENT_NAMES[title.toLowerCase()] ?? title;
      const type = activityType(title, name);
      update.run(
        type,
        JSON.stringify([
          {
            name,
            type,
            distance_km: row.distance_km,
            duration_min: row.duration_min,
          },
        ]),
        row.id,
        profile.id
      );
    }
  }
}

export const migration: Migration = {
  id: 117,
  name: "117-fitbit-activity-components",
  up,
};
