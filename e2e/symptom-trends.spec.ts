import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath, frozenNow } from "./worker-env";
import { historyDayHref } from "../lib/hrefs";

// The symptom analysis surface (#1852): "how many migraine days last month, and is it
// getting worse?". `/trends/symptoms` answers it in counts; the chronological record is
// `/history`'s (#3958) and is deliberately not duplicated here.
//
// FIXTURE (#868 hygiene): the spec owns every row it asserts on — two uniquely-named
// CUSTOM symptoms on profile 1, deleted in `beforeEach` and again in a `finally`. The
// shared seed's own symptoms may well earn tiles of their own; nothing below counts
// tiles, only the two this spec wrote.
//
// Days come off the profile's OWN calendar (#1417): the run's timezone rotates, and
// "which month is this day in" is exactly the question the page answers.

const PROFILE = 1;
const RECURRING = "e2e-trend-migraine";
const OCCASIONAL = "e2e-trend-twinge";
const OWNED = [RECURRING, OCCASIONAL];

function openDb(): Database.Database {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  return db;
}

function deleteFixtureRows(db: Database.Database): void {
  db.prepare(
    `DELETE FROM symptom_logs WHERE profile_id = ? AND symptom IN (?, ?)`
  ).run(PROFILE, ...OWNED);
}

function profileTimezone(db: Database.Database): string {
  const row = db
    .prepare(
      `SELECT value FROM profile_settings WHERE profile_id = ? AND key = 'timezone'`
    )
    .get(PROFILE) as { value: string } | undefined;
  return row?.value || "UTC";
}

/** `offset` days from the frozen run instant, on the profile's own calendar. */
function localDay(tz: string, offset: number): string {
  const at = new Date(frozenNow().getTime() + offset * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(at);
}

test.beforeEach(() => {
  const db = openDb();
  try {
    deleteFixtureRows(db);
  } finally {
    db.close();
  }
});

test.describe("symptom trends (#1852)", () => {
  test("charts a recurring symptom's monthly day-counts and leaves a one-off out of the charts", async ({
    page,
  }) => {
    const db = openDb();
    try {
      const tz = profileTimezone(db);
      // −45 guarantees a different calendar month from today whatever the run date;
      // the other two land in today's month or the one before it. Either way the
      // symptom clears "three days across two months".
      const recurringDays = [0, -2, -45].map((o) => localDay(tz, o));
      const onceDay = localDay(tz, -3);
      for (const [index, day] of recurringDays.entries()) {
        db.prepare(
          `INSERT INTO symptom_logs (profile_id, date, symptom, severity)
           VALUES (?, ?, ?, ?)`
        ).run(PROFILE, day, RECURRING, index + 2);
      }
      db.prepare(
        `INSERT INTO symptom_logs (profile_id, date, symptom, severity)
         VALUES (?, ?, ?, 1)`
      ).run(PROFILE, onceDay, OCCASIONAL);

      // FIXTURE CONTROL: the four rows really are there, on four distinct days
      // spanning at least two months — so a "3 days" reading below cannot be an
      // artefact of a fixture that never landed.
      const rows = db
        .prepare(
          `SELECT date, symptom FROM symptom_logs
            WHERE profile_id = ? AND symptom IN (?, ?) ORDER BY date`
        )
        .all(PROFILE, ...OWNED) as { date: string; symptom: string }[];
      expect(rows).toHaveLength(4);
      expect(new Set(rows.map((r) => r.date.slice(0, 7))).size).toBeGreaterThan(
        1
      );

      await page.goto("/trends/symptoms");
      const tile = page.getByTestId(`symptom-tile-${RECURRING}`);
      await expect(tile).toBeVisible();
      await expect(
        tile.getByTestId(`symptom-tile-${RECURRING}-days`)
      ).toHaveText("3 days");

      // The month the three-days-ago and today entries fall in carries at least the
      // two of them that share it, and the −45 day's month carries its one.
      const thisMonth = recurringDays[0].slice(0, 7);
      const oldMonth = recurringDays[2].slice(0, 7);
      expect(oldMonth).not.toBe(thisMonth);
      await expect(
        tile.getByTestId(`symptom-month-${RECURRING}-${oldMonth}`)
      ).toContainText("1");

      // The one-off gets NO chart — and the converse, so that absence is a verdict
      // rather than a fixture that failed to write: it is named, with its count, in
      // the page's "also logged" line.
      await expect(page.getByTestId(`symptom-tile-${OCCASIONAL}`)).toHaveCount(
        0
      );
      await expect(page.getByTestId("symptom-trends-occasional")).toContainText(
        `${OCCASIONAL} (1 day)`
      );
    } finally {
      deleteFixtureRows(db);
      db.close();
    }
  });

  test("the day bar links to the analysis", async ({ page }) => {
    const db = openDb();
    try {
      const tz = profileTimezone(db);
      const day = localDay(tz, 0);
      // The bar's day card opens on its own when the day already carries a symptom.
      db.prepare(
        `INSERT INTO symptom_logs (profile_id, date, symptom, severity)
         VALUES (?, ?, ?, 2)`
      ).run(PROFILE, day, RECURRING);

      await page.goto(historyDayHref(day));
      const link = page
        .getByTestId("symptom-log-bar")
        .first() // first-ok: the acting profile's own symptom bar — order-agnostic
        .getByTestId("symptom-analysis-link");
      await expect(link).toBeVisible();
      await link.click();
      await expect(page.getByTestId("symptom-trends-page")).toBeVisible();
      // The link landed on the analysis of THIS profile's log: one day is not a
      // pattern, so the symptom just written is named in the "also logged" line.
      await expect(page.getByTestId("symptom-trends-occasional")).toContainText(
        `${RECURRING} (1 day)`
      );
    } finally {
      deleteFixtureRows(db);
      db.close();
    }
  });
});
