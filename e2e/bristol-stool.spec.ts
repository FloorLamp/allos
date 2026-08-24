import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { settledClick } from "./helpers";
import { frozenNow, workerDbPath } from "./worker-env";
import { pinnedTimezone } from "./pinned-timezone";
import { zonedWallIsoToUtc } from "@/lib/date";

// Bristol stool form, end to end (issue #2785).
//
// What only a browser can prove here is that the seven buttons ARE the entry surface:
// the number is never typed, so the guard against a 0 or an 8 is not a validator the
// user can route around — there is no field to route around it with. The spec therefore
// asserts the vocabulary the picker actually renders, taps one, and reads the row back
// out of the store the placement decision put it in.
//
// It also pins the panel's ONE presentation rule: a day is rendered by its TYPES, never
// by an average of them. A day carrying type 1 and type 7 must show both marks — an
// averaged surface would show one mark at 4, the middle of the scale.

const DB_PATH = workerDbPath();
// metric_samples.started_at is a profile-LOCAL wall clock, so decoding one back to an
// instant needs the run's rotating instance timezone (e2e/pinned-timezone.ts).
const TZ = pinnedTimezone(frozenNow().toISOString()).zone;

function clearBristol(): void {
  const db = new Database(DB_PATH);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(
      "DELETE FROM metric_samples WHERE profile_id = 1 AND metric = 'bristol_stool_type'"
    ).run();
  } finally {
    db.close();
  }
}

function bristolRows(): { date: string; started_at: string; value: number }[] {
  const db = new Database(DB_PATH);
  try {
    return db
      .prepare(
        `SELECT date, started_at, value FROM metric_samples
          WHERE profile_id = 1 AND metric = 'bristol_stool_type'
          ORDER BY started_at`
      )
      .all() as { date: string; started_at: string; value: number }[];
  } finally {
    db.close();
  }
}

function seedBristol(date: string, hhmmss: string, type: number): void {
  const db = new Database(DB_PATH);
  try {
    db.pragma("busy_timeout = 5000");
    // metric_samples.started_at holds a profile-LOCAL wall clock for a hand-entered
    // reading — the `${date}THH:MM:SS` shape the write core builds through
    // zonedDateParts, not a UTC instant (lib/time-columns.ts calls the column's
    // convention `mixed` and says so). So the fixture writes that same shape rather
    // than routing through zonedWallTimeToUtc, which would store the wrong string
    // under the rotating instance timezone.
    const wall = `${date}T${hhmmss}`;
    db.prepare(
      `INSERT INTO metric_samples (profile_id, source, metric, date, started_at, ended_at, value)
         VALUES (1, 'manual', 'bristol_stool_type', ?, ?, ?, ?)`
    ).run(date, wall, wall, type);
  } finally {
    db.close();
  }
}

test.beforeEach(() => clearBristol());
test.afterEach(() => clearBristol());

test("the picker offers exactly the seven types and logs the tapped one", async ({
  page,
}) => {
  // The same overlay the sheet's Body segment opens, reached by url (#1424).
  await page.goto("/?quick=log-stool");

  const sheet = page.getByTestId("quick-entry-sheet");
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("quick-entry-body")).toHaveAttribute(
    "data-form",
    "stool"
  );

  const picker = page.getByTestId("quick-entry-stool");
  await expect(picker).toBeVisible();

  // Seven buttons — no 0, no 8, and no free-entry field to type one into. That
  // absence is the guard, so it is asserted rather than assumed.
  for (let type = 1; type <= 7; type += 1) {
    await expect(picker.getByTestId(`stool-type-${type}`)).toBeVisible();
  }
  await expect(picker.getByTestId("stool-type-0")).toHaveCount(0);
  await expect(picker.getByTestId("stool-type-8")).toHaveCount(0);
  await expect(picker.locator("input")).toHaveCount(0);

  // The accessible name is the SCALE's own description, not the two-word caption
  // the button has room for — that is what makes a self-reported type comparable.
  await expect(picker.getByTestId("stool-type-3")).toHaveAttribute(
    "aria-label",
    "Type 3, Like a sausage but with cracks on the surface"
  );

  await expect(page.getByTestId("quick-entry-stool-count")).toHaveText(
    "Nothing logged today."
  );

  const before = frozenNow().getTime();
  const settle = picker.getByTestId("stool-settle-6");
  const rolling = picker.getByTestId("quick-entry-stool-rolling-count");
  const sawSettle = expect(settle).toHaveAttribute("data-settling", "true");
  const sawRoll = expect(rolling).toHaveAttribute("data-rolling", "true");
  await picker.getByTestId("stool-type-6").click();
  await Promise.all([sawSettle, sawRoll]);

  // The sheet STAYS OPEN — several a day is ordinary, and a mis-tap is corrected by
  // tapping again rather than by reopening.
  await expect(page.getByTestId("quick-entry-stool-count")).toHaveText(
    "1 logged today."
  );
  await expect(sheet).toBeVisible();
  const after = frozenNow().getTime();

  const rows = bristolRows();
  expect(rows).toHaveLength(1);
  expect(rows[0].value).toBe(6);
  // Instant grain: the row records WHEN, which is what makes a deliberate second tap
  // a second observation instead of an overwrite of the first.
  //
  // BRACKETED, not "not midnight" (#3214). The tap is bracketed between two readings
  // of the app's clock seam and the stamp has to land between them — that states the
  // property, "stamped during this operation". The old check asserted the time part
  // was not `00:00:00`, which infers the clock from one value the stamp is unlikely
  // to equal; it reds outright under the boundary-stress hook that supplies
  // ALLOS_TEST_NOW at local midnight (playwright.config.ts), and it would keep
  // passing if the fallback ever became any other fixed time.
  //
  // The run FREEZES that seam, so the two captures coincide and the bracket collapses
  // to an identity against the frozen instant — the strongest form of the same
  // statement, and the reason no tolerance is needed here.
  const stampedAt = zonedWallIsoToUtc(TZ, rows[0].started_at);
  expect(stampedAt).not.toBeNull();
  // Whole seconds, so the lower bound is `before` floored to its own second.
  expect(stampedAt!.getTime()).toBeGreaterThanOrEqual(
    Math.floor(before / 1000) * 1000
  );
  expect(stampedAt!.getTime()).toBeLessThanOrEqual(after);

  // Reduced motion keeps the write/count end state and removes both transient
  // animation bands. The frozen instant makes this a correction of the reading,
  // so the daily count correctly remains one.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedSettle = picker.getByTestId("stool-settle-5");
  await settledClick(page, picker.getByTestId("stool-type-5"));
  await expect(page.getByTestId("quick-entry-stool-count")).toHaveText(
    "1 logged today."
  );
  await expect(reducedSettle).toHaveAttribute("data-reduced-motion", "true");
  await expect(reducedSettle).not.toHaveClass(/motion-settle/);
  await expect(rolling).toHaveAttribute("data-reduced-motion", "true");
  await expect(rolling).toHaveAttribute("data-rolling", "false");
});

test("the Body panel shows a day's types as marks, never as one average", async ({
  page,
}) => {
  await page.goto("/?quick=log-stool");
  const picker = page.getByTestId("quick-entry-stool");
  await expect(picker).toBeVisible();

  // The two extremes on one day. Their mean is 4 — the middle of the scale — so an
  // averaged surface would draw the worst day in the window as textbook-normal.
  //
  // One reading is TAPPED and the other is seeded, because the suite freezes the
  // clock (ALLOS_TEST_NOW) and every tap in a run therefore claims the same instant —
  // which the store's second-resolution natural key correctly reads as one reading
  // corrected, not two. The DB tier proves the two-row case through the stated-time
  // door; what this spec is for is the PANEL, and the panel needs a day that really
  // holds two types.
  await settledClick(page, picker.getByTestId("stool-type-1"));
  seedBristol(bristolRows()[0].date, "23:59:59", 7);

  await page.goto("/trends");

  const panel = page.getByTestId("bristol-panel");
  await expect(panel).toBeVisible();

  // The distribution counted BOTH extremes once and put nothing on type 4.
  await expect(panel.getByTestId("bristol-bar-1")).toHaveAttribute(
    "data-count",
    "1"
  );
  await expect(panel.getByTestId("bristol-bar-7")).toHaveAttribute(
    "data-count",
    "1"
  );
  await expect(panel.getByTestId("bristol-bar-4")).toHaveAttribute(
    "data-count",
    "0"
  );

  // …and the day itself carries both marks.
  const day = bristolRows()[0].date;
  await expect(panel.getByTestId(`bristol-day-${day}`)).toHaveAttribute(
    "data-types",
    "1,7"
  );
});

test("the panel is absent for a profile with nothing logged", async ({
  page,
}) => {
  // Never an empty chart with an exhortation under it: a profile that does not use
  // this sees the Body section exactly as it was.
  await page.goto("/trends");
  await expect(page.getByTestId("bristol-panel")).toHaveCount(0);
});
