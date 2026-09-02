import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { workerDbPath } from "./worker-env";

// The feed is slim rows since #2897, and since #4079 they are the shared history
// substrate's own rows — a history-row carrying the title is an activity's
// presence signal (full cards render only in the reading pane).
const feedRow = (page: Page, title: string) =>
  page.getByTestId("history-row").filter({ hasText: title });

// Training Log search reaches the WHOLE ledger, not the loaded window (#1634).
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

// A run of MORE THAN ONE PAGE of matching days (a filtered page is 14 days), for the
// filtered "Load more" test below. Two-digit leg numbers so "leg 01" can never
// substring-match "leg 10"…"leg 19". Deep past for the same reason as DEEP_DATE.
const PAGED_MARKER = "Orienteering Meridian Loop";
const PAGED_DAYS = 20;
const pagedDate = (i: number) => `2018-06-${String(i + 1).padStart(2, "0")}`;
const pagedTitle = (i: number) =>
  `${PAGED_MARKER} leg ${String(i + 1).padStart(2, "0")}`;

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
    db.prepare("DELETE FROM activities WHERE title LIKE ?").run(
      `${PAGED_MARKER}%`
    );
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
    // One match per day across PAGED_DAYS consecutive days, so the filtered feed
    // has a full first page (the newest 14) plus an older window to page into.
    for (let i = 0; i < PAGED_DAYS; i++) {
      ins.run(pagedDate(i), pagedTitle(i), 40, 5.0, null);
    }
  });
});

test.afterAll(() => {
  cleanup();
});

test("search reaches a row far below the default bound (#1634)", async ({
  page,
}) => {
  await page.goto("/training?tab=log");

  const search = page.getByPlaceholder("Search activities or exercises…");
  await expect(search).toBeVisible();

  // Precondition: the planted rows are NOT in the default window — otherwise the
  // test would pass without the reach ever being exercised.
  await expect(feedRow(page, MARKER)).toHaveCount(0);

  // The search is a GET form now (#4079): a filtered Log is a place. What #1634
  // guarantees is unchanged — the answer is the record's, not the window's.
  await search.fill(MARKER);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.waitForURL(/[?&]q=/);

  await expect(feedRow(page, IMPORTED_TITLE)).toBeVisible();
  await expect(feedRow(page, MANUAL_TITLE)).toBeVisible();
  await expect(feedRow(page, OLDER_TITLE)).toBeVisible();

  // Nothing was paged: the URL carries the query and nothing else.
  await expect(page).toHaveURL(/[?&]q=Kayaking\+Larkspur\+Reserve/);
  await expect(page).not.toHaveURL(/[?&]show=/);

  // And the honest-scope apology the old client-side filter had to print is gone.
  await expect(
    page.getByText("Only loaded activities are searched", { exact: false })
  ).toHaveCount(0);
});

test("a run of matching days longer than the default window comes back whole", async ({
  page,
}) => {
  // THE PAGER RETIRED (#4079's named retirements): folds and the History door
  // replace it, and a filtered read goes to the substrate's ceiling rather than
  // walking a cursor. So the property to pin is no longer "the next page lands" —
  // it is that the WHOLE matching run is the answer, oldest leg included.
  await page.goto("/training?tab=log&q=" + encodeURIComponent(PAGED_MARKER));

  await expect(feedRow(page, pagedTitle(PAGED_DAYS - 1))).toBeVisible();
  await expect(feedRow(page, pagedTitle(0))).toBeVisible();
  await expect(page.getByTestId("training-log-show-more")).toHaveCount(0);

  // AND THE PAGE IS SETTLED — it makes no request of its own. The middleware used to
  // re-set the session cookie on Server Action POSTs, which marked every feed
  // response "revalidated"; the client filter effect then re-fetched page one on each
  // refresh, an endless self-sustaining POST loop that clobbered the loaded window.
  // With the filter in the URL there is no such effect and no action to loop on, so
  // this is now a claim that the whole apparatus is gone rather than tamed.
  const strayPost = await page
    .waitForRequest(
      (r) => r.method() === "POST" && new URL(r.url()).pathname === "/training",
      { timeout: 3000 }
    )
    .catch(() => null);
  expect(strayPost, "the filtered feed kept fetching by itself").toBeNull();

  await expect(feedRow(page, pagedTitle(0))).toBeVisible();
  await expect(feedRow(page, pagedTitle(PAGED_DAYS - 1))).toBeVisible();
});

test("the source filter narrows a matching day by provider (#1634)", async ({
  page,
}) => {
  await page.goto("/training?tab=log&q=" + encodeURIComponent(MARKER));
  await expect(feedRow(page, IMPORTED_TITLE)).toBeVisible();

  // The option list is born from the ledger's own distinct sources and labelled by
  // the same activityProvenanceLabel the record's own chips use.
  const source = page.getByTestId("training-log-source-filter");
  await expect(source).toBeVisible();
  await source.getByRole("link", { name: "Strava", exact: true }).click();
  await page.waitForURL(/[?&]src=strava/);

  // Both planted rows sit on ONE day, so this proves the filter separates ROWS, not
  // just days: the Strava row stays, its manual same-day sibling goes.
  await expect(feedRow(page, IMPORTED_TITLE)).toBeVisible();
  await expect(feedRow(page, MANUAL_TITLE)).toHaveCount(0);
  await expect(feedRow(page, OLDER_TITLE)).toHaveCount(0);

  // Clearing every refinement returns the feed to its newest unfiltered window,
  // which does not contain the deep rows at all.
  await page.getByTestId("training-log-clear-filters").click();
  await page.waitForURL(/\/training\?tab=log$/);
  await expect(feedRow(page, MARKER)).toHaveCount(0);
  await expect(
    page.getByPlaceholder("Search activities or exercises…")
  ).toHaveValue("");
});
