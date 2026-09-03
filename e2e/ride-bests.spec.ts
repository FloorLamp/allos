// THE CROSS-RIDE COMPARISON ON THE PAGES THAT SHOW IT (#3195).
//
// Three Mountain Biking rides are planted on the shared profile — a cycling
// identity the seed gives no telemetry, so the population these assertions state
// is exactly the three rides below and nothing the seed happens to carry. They are
// swept from an afterEach: deleting a title no test planted is a no-op, and doing
// it here means a mid-test failure strands nothing.
//
// WHAT THIS FILE IS FOR, in one line each:
//   • The first ride with power says so, instead of printing a wall of firsts.
//   • The middle ride keeps its medal after the last ride beats it.
//   • Every table states the window it compared within, in rides.
//   • The day's ride reaches the dashboard as one fixed-template statement.
import { test, expect } from "./fixtures";
import { openDashboardAll } from "./helpers";
import Database from "better-sqlite3";
import { deleteActivitiesTitled } from "./shared-profile-guard";
import { frozenNow, workerDbPath } from "./worker-env";
import {
  serializeCyclingStreamSummary,
  summarizeCyclingStreams,
} from "@/lib/cycling-stream-summary";
import { shiftDateStr } from "@/lib/date";

const FIRST = "Fictional bests opening ride";
const RECORD = "Fictional bests record ride";
const TODAY_RIDE = "Fictional bests today ride";
const PLANTED = [FIRST, RECORD, TODAY_RIDE];

// The pinned zone puts local time at 13:mm, so the profile-local date always
// equals the frozen instant's UTC date (e2e/pinned-timezone.ts).
const TODAY = frozenNow().toISOString().slice(0, 10);

test.afterEach(() => deleteActivitiesTitled(...PLANTED));

// A flat ride at a constant power and speed: 40 minutes, so the curve fills every
// duration the page shows, and 5 m/s+ so there are two full 5 km splits to rank.
function streamsFor(watts: number, metresPerSecond: number) {
  const time = Array.from({ length: 2401 }, (_, index) => index);
  return JSON.stringify({
    time: { data: time },
    distance: { data: time.map((second) => second * metresPerSecond) },
    watts: { data: time.map(() => watts) },
    moving: { data: time.map(() => true) },
  });
}

function plantRides() {
  const db = new Database(workerDbPath());
  const insert = db.prepare(
    `INSERT INTO activities
       (profile_id, date, type, title, duration_min, distance_km, components,
        source, external_id, avg_power_w)
     VALUES (1, ?, 'cardio', ?, 40, ?, ?, 'strava', ?, ?)`
  );
  const telemetry = db.prepare(
    `INSERT INTO activity_telemetry
       (profile_id, activity_id, source, streams_json, snapshot_at,
        stream_summary_json)
     VALUES (1, ?, 'strava', ?, ?, ?)`
  );
  const ids: Record<string, number> = {};
  for (const [title, day, watts, speed, external] of [
    [FIRST, shiftDateStr(TODAY, -2), 200, 5.2, "e2e:bests-1"],
    [RECORD, shiftDateStr(TODAY, -1), 300, 6.0, "e2e:bests-2"],
    [TODAY_RIDE, TODAY, 400, 6.8, "e2e:bests-3"],
  ] as const) {
    const streams = streamsFor(watts, speed);
    const id = Number(
      insert.run(
        day,
        title,
        Math.round(speed * 24) / 10,
        JSON.stringify([
          {
            name: "Mountain Biking",
            type: "cardio",
            distance_km: Math.round(speed * 24) / 10,
            duration_min: 40,
          },
        ]),
        external,
        watts
      ).lastInsertRowid
    );
    // Written here rather than left to a boot: the server is already running, so
    // nothing would fill it before this spec asserts (#2292).
    telemetry.run(
      id,
      streams,
      `${day}T12:00:00Z`,
      serializeCyclingStreamSummary(summarizeCyclingStreams(streams, null))
    );
    ids[title] = id;
  }
  db.close();
  return ids;
}

test("ride medals name the window they mean, and an old ride keeps what it earned", async ({
  page,
}) => {
  const ids = plantRides();

  // THE FIRST RIDE WITH POWER. Nothing came before it, so it earns no markers at
  // all — a table of first places reads as an achievement and would only be saying
  // that the history is empty (#2385).
  await page.goto(`/training/activity/${ids[FIRST]}`);
  const firstPower = page.getByTestId("ride-power-profile");
  await expect(page.getByTestId("ride-power-curve-window")).toHaveText(
    "First ride with recorded power."
  );
  await expect(firstPower.getByText("Best", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("ride-splits-window")).toHaveText(
    "First ride with recorded splits."
  );

  // THE MIDDLE RIDE, WHICH BEAT THE ONE BEFORE IT. Both its 5 km splits and every
  // power duration are firsts, against a population of two rides — stated as two
  // rides, never as "ever".
  await page.goto(`/training/activity/${ids[RECORD]}`);
  await expect(page.getByTestId("ride-power-curve-window")).toHaveText(
    "Compared with 1 earlier ride with recorded power."
  );
  await expect(
    page.getByTestId("ride-power-curve-1200").getByText("Best", { exact: true })
  ).toBeVisible();
  await expect(page.getByTestId("ride-splits-window")).toHaveText(
    "Compared with 1 earlier ride with recorded splits."
  );
  // Both its splits beat both of the opening ride's, and they place against EACH
  // OTHER as well — a ride holding the two fastest efforts prints "Best" and "2nd"
  // rather than "Best" twice. (The two differ by a second: the cursor stops at the
  // first sample past each boundary, so the first split carries the overshoot.)
  const splits = page.getByTestId("ride-distance-splits");
  await expect(splits.getByText("Best", { exact: true })).toHaveCount(1);
  await expect(splits.getByText("2nd", { exact: true })).toHaveCount(1);

  // THE LAST RIDE BEAT IT — and the middle ride's page still says what it earned.
  // A comparison made against CURRENT state would have rewritten it to "2nd".
  await page.goto(`/training/activity/${ids[TODAY_RIDE]}`);
  await expect(page.getByTestId("ride-power-curve-window")).toHaveText(
    "Compared with 2 earlier rides with recorded power."
  );
  await expect(
    page.getByTestId("ride-power-curve-1200").getByText("Best", { exact: true })
  ).toBeVisible();

  await page.goto(`/training/activity/${ids[RECORD]}`);
  await expect(
    page.getByTestId("ride-power-curve-1200").getByText("Best", { exact: true })
  ).toBeVisible();
  await expect(page.getByTestId("ride-power-curve-window")).toHaveText(
    "Compared with 1 earlier ride with recorded power."
  );
  // Same for its splits: the last ride is faster on all three of its own, so
  // against current state this row would hold no medal at all.
  await expect(
    page.getByTestId("ride-distance-splits").getByText("Best", { exact: true })
  ).toHaveCount(1);
});

test("the day's ride reaches the dashboard as one statement that names its window", async ({
  page,
}) => {
  plantRides();

  await page.goto("/");
  await openDashboardAll(page);
  const statement = page.locator(
    '[data-testid="dashboard-candidate"][data-candidate-id^="training.result:ride-best:"]'
  );
  await expect(statement).toHaveCount(1);
  await expect(statement).toContainText(
    "Best 20 min power of 3 rides with recorded power"
  );
  await expect(statement).toContainText("400 W");
});
