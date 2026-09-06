import { test, expect } from "./fixtures";
import { followLink } from "./helpers";

// The Training Log is the activity index. Every row reaches the canonical
// activity page at every viewport; records no longer expand into a second
// desktop pane or a phone-only inline presentation.

// A ROW'S ACTIVITY ID comes off `data-history-row-id` (`feed:activity:N`), which is
// the substrate's row identity. The DOM `id` is the ANCHOR built from it, and the two
// are deliberately different spellings — reading the id out of the anchor is what
// broke when the Log moved onto this substrate.
const ACTIVITY_ROW =
  '[data-testid="history-row"][data-history-kind="activity"]';

test("activity rows open the canonical activity page", async ({ page }) => {
  await page.goto("/training?tab=log");
  // eslint-disable-next-line no-restricted-properties -- first-ok: newest seeded Push day; its set summaries prove the compact index reuses the record's own numbers
  const row = page
    .locator(ACTIVITY_ROW)
    .filter({ hasText: "Push day" })
    .first();
  await expect(row).toBeVisible();

  // THE SETS ARE THE SUBSTRATE'S OWN DISCLOSURE (#4079), not a training layer laid
  // over it. The activity's timeline event already carries its per-exercise set
  // summaries as `detailItems`, so the shared row draws the panel with no
  // training-specific code — and the panel is the row's SIBLING (#4045 §4), so it is
  // addressed on the page rather than inside the row.
  const rowId = (await row.getAttribute("data-history-row-id"))!;
  const id = rowId.replace("feed:activity:", "");
  expect(id, "an activity row's id is `feed:activity:N`").toMatch(/^\d+$/);
  await row.getByTestId("history-row-disclosure").click();
  const panel = page.locator(
    `[data-testid="history-row-panel"][data-history-row-id="${rowId}"]`
  );
  await expect(panel).toBeVisible();
  // The seed's Push day is these five lifts, and the panel names them — the point of
  // the disclosure is that the session's CONTENT reads here, not just its title.
  for (const lift of [
    "Barbell Bench Press",
    "Barbell Overhead Press",
    "Incline Bench Press",
    "Dumbbell Lateral Raise",
    "Tricep Pushdown",
  ]) {
    await expect(panel).toContainText(lift);
  }

  const detailLink = row.getByRole("link", { name: "Push day", exact: true });
  await expect(detailLink).toHaveAttribute("href", `/training/activity/${id}`);

  await followLink(page, detailLink, new RegExp(`/training/activity/${id}$`));
  await expect(page.getByTestId("training-activity-page")).toBeVisible();
  await expect(page.getByTestId("activity-record-body")).toBeVisible();
  await expect(page.getByTestId("training-log-reading-pane")).toHaveCount(0);
});

// #4079 RETIRED THE `#activity-N` DEEP LINK AND THE HASH AUTO-PAGER IT DROVE. That
// mechanism existed because the Log's private feed rendered one window and paged
// older history in on the client, so an address for a row below the window had to
// page until the row existed and then scroll to it. The bound lives in the URL now
// and the periods below it are folds, so there is no client pager to drive and no
// helper builds that address any more (`trainingLogActivityHref` retired with it).
//
// THE DAY ANCHOR SURVIVED THE SAME REASONING ONE STEP LATER. `ActiveDaysStrip` and
// `DayHistory` used to build `/training?tab=log#day-YYYY-MM-DD`, and it landed on
// nothing for any day outside the window the Log happened to draw; both name the day
// in the query now (`trainingLogDayHref`), which the page answers by reading that day.
// The anchor is kept because `#day-` links are already out in readers' bookmarks, so
// what is pinned here is the weaker promise it can actually keep: a day the Log has
// RENDERED still answers to the name it has always had.
test("a #day-YYYY-MM-DD anchor still addresses the day it names", async ({
  page,
}) => {
  await page.goto("/training?tab=log");
  const firstDay = page.getByTestId("training-log-day").first(); // eslint-disable-line no-restricted-properties -- first-ok: the newest rendered day; any rendered day proves the anchor grammar
  await expect(firstDay).toBeVisible();
  const anchor = (await firstDay.getAttribute("id"))!;
  expect(anchor, "the day section keeps the `day-` anchor grammar").toMatch(
    /^day-\d{4}-\d{2}-\d{2}$/
  );

  await page.goto("about:blank");
  await page.goto(`/training?tab=log#${anchor}`);
  const landed = page.locator(`#${anchor}`);
  await expect(landed).toBeVisible();
  // POSITION, not visibility: `toBeVisible()` is "non-empty bounding box" and passes
  // just as happily on a section a thousand pixels below the fold.
  const viewport = page.viewportSize()!;
  await expect
    .poll(
      async () => {
        const box = await landed.boundingBox();
        return box != null && box.y >= 0 && box.y < viewport.height;
      },
      { message: "the anchored day must be scrolled into the viewport" }
    )
    .toBe(true);
});

test("phone rows use the same canonical destination", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/training?tab=log");
  // SCOPED TO AN ACTIVITY ROW. The Training family also carries milestones and
  // endurance events, whose rows are owned by other surfaces and correctly go
  // somewhere else — an unscoped `.first()` asserts the activity destination against
  // whichever kind happened to be newest.
  const row = page.locator(ACTIVITY_ROW).first(); // eslint-disable-line no-restricted-properties -- first-ok: any activity row proves the shared destination
  await expect(row).toBeVisible();
  const id = (await row.getAttribute("data-history-row-id"))!.replace(
    "feed:activity:",
    ""
  );

  await followLink(
    page,
    row.getByTestId("history-row-title"),
    new RegExp(`/training/activity/${id}$`)
  );
  await expect(page.getByTestId("training-activity-page")).toBeVisible();
  await expect(page.getByTestId("activity-record-body")).toBeVisible();
});

// Back from an activity page, into a log the reader had OPENED older history in
// (issue #3179). Newly reachable rather than newly broken: before #3099 a row filled
// a reading pane without navigating, so there was no Back to take.
//
// BACK RETURNS TO THE VIEW YOU WIDENED (#3176's shape, re-based on #4079). The Log's
// window lives in the URL now — a fold is a link that writes `?open=`, not a client
// pager with component state that resets on remount — so the promise is the same and
// its mechanism is the platform's: opening a row is a real navigation, and Back
// returns to the URL that was showing the history you had opened.
//
// THE FOLD, NOT `?show=`, IS THE WIDENING THIS ASSERTS. Both are URL state, but the
// bound starts at HISTORY_DEFAULT_SHOW = 200 rows and the seeded profile's whole
// training history is 84 activities, so `hasMore` is false and "Show more" never
// renders for it — a test written against that control asserts on an element its
// fixture cannot produce. The fold is what actually replaced the pager, and the
// fixture reaches it on every run.
//
// The guarantee is "you come back to where you were, with the history you had
// opened", NOT "the pixel offset is restored" — asserting the offset would pin an
// accident; asserting viewport containment pins the promise.
test("Back returns to the widened log with the row you opened still on screen", async ({
  page,
}) => {
  await page.goto("/training?tab=log");
  const rows = page.locator(ACTIVITY_ROW);
  await expect(rows.first()).toBeVisible(); // eslint-disable-line no-restricted-properties -- first-ok: presence gate before counting
  const openingWindow = await rows.count();

  // Open older history. Without this the whole question is trivial — every row would
  // be in the DOM on a plain reload and Back could not tell us anything.
  const fold = page.locator('[data-testid^="training-log-fold-"]').first(); // eslint-disable-line no-restricted-properties -- first-ok: the newest fold, whichever period it is — order-agnostic
  await expect(fold).toBeVisible();
  await fold.locator('[data-testid$="-toggle"]').click();
  await page.waitForURL(/[?&]open=/);
  await expect
    .poll(() => rows.count(), {
      message:
        "opening a fold must reveal activity rows the opening window did not render",
    })
    .toBeGreaterThan(openingWindow);
  const widened = await rows.count();
  const widenedUrl = page.url();

  // The DEEPEST row now rendered. It sits outside the opening window, so it can
  // only be on screen after Back if the widened window came back too.
  const target = rows.nth(widened - 1);
  const targetId = (await target.getAttribute("id"))!;
  await target.scrollIntoViewIfNeeded();

  await target.getByTestId("history-row-title").click();
  await page.waitForURL(/\/training\/activity\/\d+$/);
  await expect(page.getByTestId("training-activity-page")).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(widenedUrl);
  await expect(rows.first()).toBeVisible(); // eslint-disable-line no-restricted-properties -- first-ok: presence gate before measuring
  expect(await rows.count()).toBe(widened);

  // POSITION, not `toBeVisible()`: Playwright's visibility check is "non-empty
  // bounding box" and passes just as happily on a row a thousand pixels below the
  // fold — which is exactly the failure this test exists to catch (#3176's shape).
  const viewport = page.viewportSize()!;
  await expect
    .poll(
      async () => {
        const box = await page.locator(`#${targetId}`).boundingBox();
        return box != null && box.y >= 0 && box.y < viewport.height;
      },
      {
        message:
          "the row the user opened must be back on screen after Back, not below the fold",
      }
    )
    .toBe(true);
});
