import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath } from "./worker-env";

// Journal search reaches the WHOLE ledger, not the loaded window (#1634).
//
// THE SCENARIO THAT FAILED BEFORE THIS FIX. Training → Log renders one newest
// window of day-groups and pages older ones in on "Load more" (#451). All four
// filters ran client-side over those loaded pages, so searching for a session older
// than the fetched window returned "No activities match your filters" while the row
// sat in `activities` — the only remedy was clicking "Load more" until the entire
// history was in memory. The spec below plants a match FAR outside the first window
// and asserts it renders from a plain search, with ZERO "Load more" clicks.
//
// Fixture ownership (#868): every row this spec plants carries a unique marker and is
// deleted in beforeAll/afterAll, so it never perturbs — or exact-counts — a shared
// seed row. Synthetic data only.
const DB_PATH = workerDbPath();

// Deep past on purpose. The sample seed writes ~3 weeks of RELATIVE-date rows rolling
// back from the frozen "today", and a page is 14 days; a 2019 date is permanently
// beyond the newest window however the clock moves, which is exactly the row the old
// client-side filter could not see.
const DEEP_DATE = "2019-03-14";
const MARKER = "Kayaking Larkspur Reserve";
const IMPORTED_TITLE = `${MARKER} tempo effort`;
const MANUAL_TITLE = `${MARKER} cooldown paddle`;
// A second marker on a nearer-but-still-unloaded day, so the assertion isn't resting
// on one row alone.
const OLDER_DATE = "2020-08-02";
const OLDER_TITLE = `${MARKER} portage day`;

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
    db.prepare("DELETE FROM activities WHERE title LIKE ?").run(`${MARKER}%`);
  });
}

test.beforeAll(() => {
  cleanup();
  withDb((db) => {
    const ins = db.prepare(
      `INSERT INTO activities
         (profile_id, date, type, title, duration_min, distance_km, source)
       VALUES (1, ?, 'sport', ?, ?, ?, ?)`
    );
    // Two rows on ONE deep day, differing only in provenance — the source filter has
    // to tell them apart within a day the day-scan selected for both.
    ins.run(DEEP_DATE, IMPORTED_TITLE, 75, 6.2, "strava");
    ins.run(DEEP_DATE, MANUAL_TITLE, 30, 2.1, null);
    ins.run(OLDER_DATE, OLDER_TITLE, 50, 3.4, null);
  });
});

test.afterAll(() => {
  cleanup();
});

test("search finds an activity in an UNFETCHED window without Load more (#1634)", async ({
  page,
}) => {
  await page.goto("/training");

  const search = page.getByPlaceholder("Search activities or exercises…");
  await expect(search).toBeVisible();

  // Precondition: the planted rows are NOT in the first window — otherwise the test
  // would pass without the fix ever running.
  await expect(page.locator(".card", { hasText: MARKER })).toHaveCount(0);
  const loadMore = page.getByTestId("journal-load-more");
  await expect(loadMore).toBeVisible();

  await search.fill(MARKER);

  // The store answers through a Server Action (loadJournalPage), whose response
  // carries a rebuilt window of cards. Named 20 s ceiling for that Server-Action
  // round-trip on a loaded shard, per docs/internals/e2e-hygiene.md.
  await expect(page.locator(".card", { hasText: IMPORTED_TITLE })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator(".card", { hasText: MANUAL_TITLE })).toBeVisible();
  await expect(page.locator(".card", { hasText: OLDER_TITLE })).toBeVisible();

  // No "Load more" was clicked anywhere above — the match came from the store.
  // And the honest-scope apology the old client-side filter had to print is gone:
  // what the feed shows under a filter IS the answer now.
  await expect(
    page.getByText("Only loaded activities are searched", { exact: false })
  ).toHaveCount(0);

  // Non-matching seed rows are filtered out, so the feed really is the match set.
  await expect(page.getByTestId("journal-search-pending")).toHaveCount(0);
});

test("the source filter narrows a matching day by provider (#1634)", async ({
  page,
}) => {
  await page.goto("/training");

  const search = page.getByPlaceholder("Search activities or exercises…");
  await search.fill(MARKER);
  await expect(page.locator(".card", { hasText: IMPORTED_TITLE })).toBeVisible({
    timeout: 20_000, // Server-Action round-trip ceiling (see above).
  });

  // The option list is born from the ledger's own distinct sources and labelled by
  // the same activityProvenanceLabel the cards' chips use.
  const source = page.getByTestId("journal-source-filter");
  await expect(source).toBeVisible();
  await source.selectOption("strava");

  // Both planted rows sit on ONE day, so this proves the filter separates ROWS, not
  // just days: the Strava row stays, its manual same-day sibling goes.
  await expect(page.locator(".card", { hasText: IMPORTED_TITLE })).toBeVisible({
    timeout: 20_000, // Server-Action round-trip ceiling (see above).
  });
  await expect(page.locator(".card", { hasText: MANUAL_TITLE })).toHaveCount(0);
  await expect(page.locator(".card", { hasText: OLDER_TITLE })).toHaveCount(0);

  // Clearing every filter returns the feed to its newest unfiltered window, which
  // does not contain the deep rows at all.
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.locator(".card", { hasText: MARKER })).toHaveCount(0, {
    timeout: 20_000, // Server-Action round-trip ceiling (see above).
  });
  await expect(search).toHaveValue("");
});
