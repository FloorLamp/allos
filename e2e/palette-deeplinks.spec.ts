import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { openCommandPalette } from "./nav";
import { followLink } from "./helpers";
import { workerDbPath } from "./worker-env";

// Command-palette hits land on their TARGET, not a hub (#1568).
//
// The assertion that matters here is the DESTINATION. The original bug was
// invisible as a navigation failure: an activity hit's href was the constant
// `/training`, so selecting it FROM /training — the natural place to be when
// searching for a workout — was a same-route push. The palette closed and
// nothing on screen changed, which reads as a dead control. A spec that only
// asserted "the palette closed" would have passed straight over it, so both
// cases below start on the source route and assert the URL they end up at.
//
// Fixture ownership (#868): this spec plants its OWN activity and medication
// under unique markers and deletes them, so it never exact-counts or perturbs a
// shared-seed row. Synthetic data only.
const DB_PATH = workerDbPath();
const ACTIVITY_MARKER = "E2E palette deeplink ride";
const MED_MARKER = "E2E palette deeplink Zolpiquine";
// Deep past on purpose: the journal renders one newest window with "Load more"
// (#451), so an old activity is exactly the row a journal anchor would strand —
// the timeline day link has to resolve for an activity of any age.
const ACTIVITY_DATE = "2019-03-14";

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(DB_PATH);
  try {
    db.pragma("busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}

function cleanup() {
  withDb((db) => {
    db.prepare("DELETE FROM activities WHERE title = ?").run(ACTIVITY_MARKER);
    db.prepare("DELETE FROM intake_items WHERE name = ?").run(MED_MARKER);
  });
}

let medId = 0;

test.beforeAll(() => {
  cleanup();
  medId = withDb((db) => {
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, duration_min)
       VALUES (1, ?, 'cardio', ?, 45)`
    ).run(ACTIVITY_DATE, ACTIVITY_MARKER);
    return Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, kind, active)
           VALUES (1, ?, 'medication', 1)`
        )
        .run(MED_MARKER).lastInsertRowid
    );
  });
});

test.afterAll(cleanup);

test("an activity hit picked FROM /training navigates to that activity's timeline day", async ({
  page,
}) => {
  test.slow();
  // Starting on /training is load-bearing: it is the one surface where the old
  // constant `/training` href made the bug invisible.
  await page.goto("/training");

  const input = await openCommandPalette(page);
  await input.fill(ACTIVITY_MARKER);

  const results = page.getByRole("listbox", { name: "Results" });
  const hit = results
    .getByRole("option")
    .filter({ hasText: ACTIVITY_MARKER })
    .first(); // first-ok: filtered to a marker THIS spec planted — exactly one activity carries it
  await expect(hit).toBeVisible();

  // The destination, not merely "the palette closed": the day-scoped timeline URL.
  await followLink(
    page,
    hit,
    new RegExp(
      `/timeline\\?from=${ACTIVITY_DATE}&to=${ACTIVITY_DATE}#timeline-day-${ACTIVITY_DATE}$`
    )
  );

  // And the anchor it points at actually resolves on the page it landed on.
  await expect(page.locator(`#timeline-day-${ACTIVITY_DATE}`)).toBeVisible();
  await expect(page.getByRole("main")).toContainText(ACTIVITY_MARKER);
});

test("a medication hit navigates to that medication's detail page", async ({
  page,
}) => {
  test.slow();
  // Same shape from the medications list: the hit used to stop at the list hub.
  await page.goto("/medications");

  const input = await openCommandPalette(page);
  await input.fill(MED_MARKER);

  const results = page.getByRole("listbox", { name: "Results" });
  const hit = results
    .getByRole("option")
    .filter({ hasText: MED_MARKER })
    .first(); // first-ok: filtered to a marker THIS spec planted — exactly one medication carries it
  await expect(hit).toBeVisible();

  await followLink(page, hit, new RegExp(`/medications/${medId}$`));
  await expect(page.getByRole("main")).toContainText(MED_MARKER);
});
