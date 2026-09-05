// A LONG SYNTHETIC TRAINING HISTORY, for measuring what the dashboard's two
// full-history scans cost past the seeded personas (#5073).
//
// `strengthSetRows` (lib/queries/training/strength.ts) and `getCardioByActivity`
// (lib/queries/training/cardio.ts) read EVERY set and EVERY effort a profile has ever
// logged — no window — and both are folded into `gatherCoachingInput`, which is one of
// the six gathers above the dashboard's first candidate. The seeded personas carry
// weeks of training, so nothing in the tree says what those scans cost at years. This
// writes the years.
//
//   ALLOS_DB_PATH=/tmp/snapshot.db npx tsx scripts/seed-training-history.ts \
//     --profile 1 --years 3
//
// It appends to an EXISTING profile on purpose: a profile carrying only training would
// leave the rest of the dashboard empty, and the question is what the tail costs on a
// real render. Point it at a COPY — it writes.
import "./load-env";
import { db, today, writeTx } from "../lib/db";
import { shiftDateStr } from "../lib/date";
import { VIA_SEEDED } from "./seed-logged-via";

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

// Five compound lifts on a repeating four-day split, so the scan's GROUPING work
// (per exercise, per load context) is exercised rather than one exercise repeated.
const SPLIT: [title: string, lifts: [string, number, number[]][]][] = [
  [
    "Push",
    [
      ["Barbell Bench Press", 100, [5, 5, 5, 5]],
      ["Incline Bench Press", 80, [8, 8, 8, 8]],
      ["Barbell Overhead Press", 60, [6, 6, 6, 6]],
      ["Tricep Pushdown", 35, [12, 12, 12, 12]],
    ],
  ],
  [
    "Pull",
    [
      ["Deadlift", 180, [3, 3, 3, 3]],
      ["Barbell Row", 90, [8, 8, 8, 8]],
      ["Pull Up", 0, [10, 10, 10, 10]],
      ["Dumbbell Curl", 18, [12, 12, 12, 12]],
    ],
  ],
  [
    "Legs",
    [
      ["Back Squat", 140, [5, 5, 5, 5]],
      ["Romanian Deadlift", 110, [8, 8, 8, 8]],
      ["Leg Press", 220, [10, 10, 10, 10]],
      ["Calf Raise", 90, [15, 15, 15, 15]],
    ],
  ],
  [
    "Upper",
    [
      ["Incline Bench Press", 75, [10, 10, 10, 10]],
      ["Barbell Row", 80, [10, 10, 10, 10]],
      ["Dumbbell Lateral Raise", 12, [15, 15, 15, 15]],
      ["Face Pull", 25, [15, 15, 15, 15]],
    ],
  ],
];

const CARDIO: [title: string, distanceKm: number, durationMin: number][] = [
  ["Easy run", 8, 45],
  ["Tempo run", 12, 58],
  ["Long ride", 40, 95],
];

function main(): void {
  const profileId = Number(flag("--profile") ?? 1);
  const years = Number(flag("--years") ?? 3);
  const days = Math.round(years * 365);

  const counts = writeTx(() => {
    const insActivity = db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, duration_min, distance_km, intensity, logged_via)
       VALUES (?,?,?,?,?,?,?, ${VIA_SEEDED})`
    );
    const insSet = db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
       VALUES (?,?,?,?,?)`
    );
    const from = today(profileId);
    let activities = 0;
    let sets = 0;
    for (let back = days; back >= 1; back -= 1) {
      const day = shiftDateStr(from, -back);
      // Four strength days then three cardio days, every week, for `years` years.
      if (back % 7 < 4) {
        const [title, lifts] = SPLIT[back % 4];
        // A slow linear ramp over the whole history, so the all-time best is genuinely
        // at the END of the scan rather than anywhere in it.
        const ramp = 1 + (days - back) / (days * 4);
        const activityId = Number(
          insActivity.run(profileId, day, "strength", title, 70, null, "hard")
            .lastInsertRowid
        );
        activities += 1;
        for (const [exercise, weightKg, reps] of lifts)
          reps.forEach((r, i) => {
            insSet.run(
              activityId,
              exercise,
              i + 1,
              Math.round(weightKg * ramp * 2) / 2,
              r
            );
            sets += 1;
          });
      } else {
        const [title, distanceKm, durationMin] = CARDIO[back % 3];
        insActivity.run(
          profileId,
          day,
          "cardio",
          title,
          durationMin,
          distanceKm,
          "moderate"
        );
        activities += 1;
      }
    }
    return { activities, sets };
  });

  process.stdout.write(
    `seeded profile ${profileId}: ${days} days, ${counts.activities} activities, ${counts.sets} sets\n`
  );
}

main();
