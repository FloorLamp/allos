import { test, expect } from "./fixtures";
import { type Request } from "@playwright/test";
import Database from "better-sqlite3";
import { hydratedClick, settledClick, settledFill } from "./helpers";
import { frozenNow, workerDbPath } from "./worker-env";
import { pinnedTimezone } from "./pinned-timezone";
import { dateStrInTz, zonedWallIsoToUtc, zonedWallTimeToUtc } from "@/lib/date";

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
  // No field to type a TYPE into — that absence IS the guard, so it is asserted
  // rather than assumed. Scoped to the type row: since #3273 the picker also carries
  // a collapsed "Happened earlier?" whose time input is a different question, and an
  // unscoped `locator("input")` would start passing for the wrong reason the day that
  // control changed.
  await expect(picker.locator(".grid input")).toHaveCount(0);

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
  const settleRuns = Number(await settle.getAttribute("data-motion-runs"));
  const rollingRuns = Number(await rolling.getAttribute("data-motion-runs"));
  await picker.getByTestId("stool-type-6").click();
  // Persistent receipts, not a race to sample the 300/250 ms transient flags.
  // The settle count is driven by the actual CSS animationstart event; the roll
  // count increments only when RollingNumber schedules its real rAF sequence.
  await expect(settle).toHaveAttribute(
    "data-motion-runs",
    String(settleRuns + 1)
  );
  await expect(rolling).toHaveAttribute(
    "data-motion-runs",
    String(rollingRuns + 1)
  );

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
  await expect(reducedSettle).toHaveAttribute("data-motion-runs", "0");
  await expect(rolling).toHaveAttribute("data-reduced-motion", "true");
  await expect(rolling).toHaveAttribute("data-rolling", "false");
  await expect(rolling).toHaveAttribute(
    "data-motion-runs",
    String(rollingRuns + 1)
  );
});

test("a Bristol tap queues offline and syncs exactly once (#3166)", async ({
  page,
  context,
}) => {
  const date = dateStrInTz(TZ, frozenNow());
  await page.goto("/?quick=log-stool");
  const picker = page.getByTestId("quick-entry-stool");
  const awaitHydrated = (await import("./helpers")).awaitHydrated;
  await awaitHydrated(picker.getByTestId("stool-type-6"));

  await context.setOffline(true);
  await picker.getByTestId("stool-type-6").click();
  await expect(page.getByTestId("offline-queue-badge")).toHaveText(
    /1 queued offline/
  );
  expect(bristolRows()).toEqual([]);

  await context.setOffline(false);
  await expect(page.getByText(/Synced 1 offline entr/)).toBeVisible();

  const rows = bristolRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ date, value: 6 });
  expect(zonedWallIsoToUtc(TZ, rows[0].started_at)?.getTime()).toBe(
    Math.floor(frozenNow().getTime() / 1000) * 1000
  );
  await page.reload();
  expect(bristolRows()).toHaveLength(1);
});

// #3273 — the picker states WHEN, and an unstated tap is unchanged.
//
// A bowel movement is exactly the event people log later, and until this the picker
// had no time affordance at all: a two-hours-late tap was wrong forever, because the
// Trends panel is read-only. The property with two halves, both asserted here: a
// stated minute is the instant the reading carries, and a tap that says nothing writes
// the row it wrote before the affordance existed — same second-grain key and all.
test('a stated "Happened earlier?" time is the instant the reading carries (#3273)', async ({
  page,
}) => {
  clearBristol();
  await page.goto("/?quick=log-stool");
  const picker = page.getByTestId("quick-entry-stool");
  await expect(picker).toBeVisible();

  const date = dateStrInTz(TZ, frozenNow());
  // The stored `started_at` is a profile-LOCAL WALL CLOCK, so every expectation below
  // is stated as the INSTANT that wall clock means — decoded with the same
  // `zonedWallIsoToUtc` the test above uses, against instants built by the safe
  // builder. Comparing the strings directly would mean assembling `${date}THH:MM:SS`
  // by hand, which is what e2e-fixture-time.test.ts's ledger exists to keep out of
  // spec files.
  const at = (hhmm: string) => zonedWallTimeToUtc(TZ, date, hhmm)!.getTime();
  const storedInstant = (started_at: string) =>
    zonedWallIsoToUtc(TZ, started_at)!.getTime();
  // What the clock-seam path writes, to the second: the write core reads the frozen
  // instant for the wall minute and takes the SECONDS off it in UTC, which is the
  // second-grain key itself. Whole seconds, so the frozen instant floors to its own.
  const tapInstant = Math.floor(frozenNow().getTime() / 1000) * 1000;

  // COLLAPSED: the fast path is untouched and the control is not even in the DOM.
  const toggle = picker.getByTestId("stool-when-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(picker.getByTestId("stool-when-time")).toHaveCount(0);

  // Leg 1 — the unstated tap writes the tap instant, seconds and all.
  //
  // ITS WRITE IS HELD OPEN while the statement is made, which is what makes the
  // ORDERING here a fact rather than a sample. The tap's settle resets the field, and
  // it runs when the write ANSWERS — arbitrarily later than the tap. Unheld, whether
  // the fill below lands before or after that reset is a race the box's load decides:
  // it failed 1 run in 3 under load, and the surviving shape was a silent one — the
  // second tap posting no time, colliding with the first row on the same second, and
  // one reading standing where two should be. Holding the POST puts the fill
  // deterministically INSIDE the flight window.
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const onThisPage = (url: URL): boolean => url.pathname === "/";
  await page.route(onThisPage, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await held;
    await route.continue();
  });
  const isWrite = (request: Request): boolean =>
    request.method() === "POST" && new URL(request.url()).pathname === "/";
  // Armed BEFORE the click so it cannot miss its event.
  const answered = page.waitForResponse((r) => isWrite(r.request()), {
    timeout: 30_000,
  });
  await hydratedClick(page, picker.getByTestId("stool-type-4"));
  // IN FLIGHT, PROVED BY THE PAGE RATHER THAN BY THE WIRE. The ledger paints its
  // optimistic count the moment `write()` is invoked and adopts the server's only in
  // `settle`, so this text is the tap having STARTED — which is the whole ordering
  // this leg needs, since the settle cannot run before the response this route is
  // holding. It replaces a `waitForRequest` ceiling that went red once on CI without
  // the write being broken: a network-timing bound on a loaded shard is a worse
  // question than the state it was standing in for.
  await expect(page.getByTestId("quick-entry-stool-count")).toHaveText(
    "1 logged today."
  );

  // The statement, made while that first write is still out. The day half is FIXED to
  // today, so a statement can only move the minute.
  await hydratedClick(page, toggle);
  await expect(picker.getByTestId("stool-when-date")).toHaveText("Today");
  await settledFill(page, picker.getByTestId("stool-when-time"), "07:05");

  release();
  await answered;
  // The tap posted NO time — it consumed the silence that was in force when it fired,
  // not the statement that arrived while it was in flight.
  const tapped = bristolRows();
  expect(tapped).toHaveLength(1);
  expect(tapped[0]).toMatchObject({ date, value: 4 });
  expect(storedInstant(tapped[0].started_at)).toBe(tapInstant);
  // …AND THE SETTLE LEFT THE NEW STATEMENT ALONE. A reset scoped to the tap rather
  // than to the field is the difference between the next tap adding a reading and
  // overwriting this one.
  await expect(picker.getByTestId("stool-when-time")).toHaveValue("07:05");

  // Leg 2 — the statement lands. The stated time carries :00 seconds, which is what
  // makes restating the same minute a correction rather than a phantom second movement.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await settledClick(page, picker.getByTestId("stool-type-3"));
  await expect(page.getByTestId("quick-entry-stool-count")).toHaveText(
    "2 logged today."
  );
  // Both rows survive — the statement moved the minute, it did not overwrite the tap.
  const both = bristolRows();
  expect(both.map((r) => [r.date, r.value])).toEqual([
    [date, 3],
    [date, 4],
  ]);
  // The stated wall minute, on the second: a stated time carries no seconds, which is
  // what makes restating the same minute a correction rather than a second movement.
  expect(both.map((r) => storedInstant(r.started_at))).toEqual([
    at("07:05"),
    tapInstant,
  ]);
  expect(both[0].started_at.endsWith(":00")).toBe(true);

  // THE STATEMENT IS SPENT BY THE TAP IT ANSWERS: the key is the instant, so a second
  // tap under a surviving 07:05 would silently overwrite the row the first one wrote.
  await expect(picker.getByTestId("stool-when-time")).toHaveValue("");
  clearBristol();
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
