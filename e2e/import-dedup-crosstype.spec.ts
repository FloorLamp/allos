import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath } from "./worker-env";

// Data → Review shows a cross-TYPE overlapping duplicate (#2271).
//
// THE REPORTED DEFECT, on the surface a person actually looks at. One gym session,
// recorded by two providers that did not disagree: Health Connect declined to classify
// it (EXERCISE_TYPE_OTHER_WORKOUT — "a workout, unspecified") and Strava called it
// `strength`. The rows differed ONLY in `type`, and `type` was a prerequisite for two
// rows to be COMPARED at all — both loaders bucketed on `(date, type)`. So detection
// never ran, the inbox never showed the pair, and the day read as two workouts.
//
// The unattended auto-merge collapses this pair on the next sync (pinned in the DB
// tier). No sync runs in the e2e world, so what the browser sees is exactly the state a
// user meets when their next sync has not happened yet: the pair waiting in Review.
//
// Fixture ownership (#868): a dedicated deep-past day, unique titles, deleted in
// beforeEach/afterAll. The pair is left UNMERGED — this spec asserts it surfaces and
// reads correctly; the merge interaction itself is import-dedup.spec.ts's.
const DB_PATH = workerDbPath();

// Deep past on purpose: the sample seed writes ~3 weeks of RELATIVE-date rows rolling
// back from the frozen "today", so a fixed date near the present eventually collides
// and turns the day's bucket into three rows. "Today" only moves forward.
const XDATE = "2025-11-06";
const HC_TITLE = "Cross Type Workout HC";
const STRAVA_TITLE = "Cross Type Workout Strava";

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(DB_PATH);
  try {
    db.pragma("busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}

function seedCrossTypePair() {
  withDb((db) => {
    db.prepare(
      `DELETE FROM activities WHERE profile_id = 1 AND title IN (?, ?)`
    ).run(HC_TITLE, STRAVA_TITLE);
    const ins = db.prepare(
      `INSERT INTO activities
         (profile_id, date, type, title, duration_min, distance_km,
          start_time, end_time, avg_hr, max_hr, source, external_id, edited)
       VALUES (1, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 0)`
    );
    // The stated absence: Health Connect recorded an hour and named no type.
    ins.run(
      XDATE,
      "unclassified",
      HC_TITLE,
      60,
      "14:30",
      "15:30",
      null,
      null,
      "health-connect",
      "health-connect:e2e-crosstype"
    );
    // The same session as Strava saw it — a different word for the same hour.
    ins.run(
      XDATE,
      "strength",
      STRAVA_TITLE,
      59,
      "14:30",
      "15:29",
      142,
      157,
      "strava",
      "strava:e2e-crosstype"
    );
  });
}

test.beforeEach(() => {
  seedCrossTypePair();
});

test.afterAll(() => {
  withDb((db) => {
    db.prepare(
      `DELETE FROM activities WHERE profile_id = 1 AND title IN (?, ?)`
    ).run(HC_TITLE, STRAVA_TITLE);
  });
});

test("Review offers the cross-type overlapping pair at high confidence (#2271)", async ({
  page,
}) => {
  await page.goto("/data?section=review");
  const review = page.getByTestId("review-inbox");
  await expect(review).toBeVisible();

  // Scoped to THIS spec's pair: the section total is a shared-world aggregate, so an
  // exact count would be a daily roulette (see import-dedup.spec.ts's note).
  const pair = review
    .getByTestId("dup-activity-pair")
    .filter({ hasText: HC_TITLE });
  await expect(pair).toHaveCount(1);
  // Overlapping clock windows are the strongest evidence the detector has — one person
  // cannot hold two sessions at the same time — so the pair lands on the HIGH tier even
  // though the two providers used different words for it.
  await expect(pair.getByText("High confidence")).toBeVisible();
  await expect(pair.getByText(STRAVA_TITLE)).toBeVisible();
});
