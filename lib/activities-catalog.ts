// Curated suggestions for cardio activities and sports, surfaced in the
// activity modal's autocomplete (reusing the same <datalist> search the
// strength exercise field uses). Past entries are merged in and the combined
// list is ranked by how often the user has logged each one.

export const CARDIO_ACTIVITIES = [
  "Running",
  "Walking",
  "Cycling",
  "Swimming",
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
  "Yoga",
  "Pilates",
  "Barre",
  "Tai Chi",
  "Stretching",
  "Dancing",
];

// Curated membership, for provenance checks: a cardio/sport name outside
// this set is user-coined, and the activity form keeps such parts "custom"
// so their type chips and (for cardio) distance field survive across
// sessions. The suggestion vocabulary can't stand in for this — it absorbs
// coined names after their first save.
const CURATED = new Set(
  [...CARDIO_ACTIVITIES, ...SPORTS].map((n) => n.toLowerCase())
);
export function isCuratedActivity(name: string): boolean {
  return CURATED.has(name.trim().toLowerCase());
}
