import { test, expect } from "./fixtures";
import { followLink, hydratedClick } from "./helpers";
import { openCommandPalette } from "./nav";
// Fixture names come from the DB-free constants module, never from e2e/seed/*:
// a seed module pulls in lib/db, whose migration logging lands on stdout and
// corrupts the JSON that `scripts/e2e-shard-plan.ts --verify` parses from
// `playwright --list`.
import {
  E2E_LOGIN_OVERLAP,
  E2E_MEMBER_PASSWORD,
  OVERLAP_KEEPER_TITLE,
  OVERLAP_TWIN_TITLE,
  TOTALS_ONLY_TITLE,
  ZONE_WALK_TITLE,
} from "./fixture-logins";
import { loginAs } from "./nav";

// #2870 step 1 — every non-cycling activity has a canonical page: the Training
// Log's card rendered whole at its own URL, with ‹ older / newer › ledger
// navigation and the heart-rate block LAST (owner-ruled order). These pins ride
// the seeded strength history ("Back Squat" sessions from the seed): a sessions
// row in Analyze deep-links the page, the record renders with its sets, and the
// back link returns to the log.

test("an Analyze sessions row opens the activity's canonical page", async ({
  page,
}) => {
  await page.goto("/training?tab=analyze&kind=strength&item=Back%20Squat");
  const sessions = page.getByTestId("analyze-sessions");
  const firstRow = sessions.getByRole("link").first(); // first-ok: any seeded session's date link proves the deep link; order-agnostic
  await followLink(page, firstRow, /\/training\/activity\/\d+$/);

  const record = page.getByTestId("training-activity-page");
  await expect(record).toBeVisible();
  // The record IS the log card: its per-exercise details render, sets first.
  await expect(record.getByTestId("activity-details")).toBeVisible();
  await expect(record.getByText("Back Squat").first()).toBeVisible(); // first-ok: asserts the exercise renders on the record — order-agnostic

  // The page is part of the ledger, not a dead end: back to the log, and the
  // neighbor links walk (date, id) order when neighbors exist.
  await expect(page.getByRole("link", { name: /Training log/ })).toBeVisible();

  // "vs last" (#2870): the seeded history progresses this lift week over week,
  // so the record answers "am I progressing" in place rather than sending the
  // reader to Analyze to compare two numbers by eye.
  const delta = record.getByTestId("exercise-vs-last").first(); // first-ok: every lift on the session carries one; any proves the column
  await expect(delta).toBeVisible();
  await expect(delta).toHaveText(/(\+|−).+|same as last/);
});

test("an overlapping same-day session announces itself, and opens the merge picker (#2870)", async ({
  browser,
}) => {
  // In the log a double-logged session was discovered by sitting NEXT TO its
  // twin. A page shows one activity, so that adjacency — and the whole discovery
  // — is gone unless the record says so.
  //
  // Its own profile: the pair would otherwise be two more activities on the
  // shared feed the Timeline's windowing spec measures its 250-event page
  // against (see the fixture's own note).
  const member = await loginAs(browser, {
    username: E2E_LOGIN_OVERLAP,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await member.goto("/training?tab=log");
    await hydratedClick(
      member,
      member
        .getByTestId("training-log-row")
        .filter({ hasText: OVERLAP_KEEPER_TITLE })
    );
    await followLink(
      member,
      member.getByTestId("activity-pane-open"),
      /\/training\/activity\/\d+$/
    );

    const banner = member.getByTestId("activity-overlap-banner");
    await expect(banner).toBeVisible();
    // It names WHO else logged it and WHAT — the two facts that make a reader
    // recognise their own double-log.
    await expect(banner).toContainText("Strava");
    await expect(banner).toContainText(OVERLAP_TWIN_TITLE);

    // And it opens the card menu's EXISTING picker rather than a second flow.
    await member.getByTestId("activity-overlap-merge").click();
    await expect(member.getByTestId("merge-picker")).toBeVisible();
    await expect(member.getByTestId("merge-picker")).toContainText(
      OVERLAP_TWIN_TITLE
    );
  } finally {
    await member.close();
  }
});

test("a worn NON-CYCLING session draws its heart rate — the block #2870 exists for", async ({
  page,
}) => {
  // The journey that found this broken: browse the Log, read the record in the
  // pane, promote it to its page. The seeded walk carries per-minute HR inside
  // its own window, which is the only condition under which the block renders —
  // and rendering it used to take the whole page down through the error
  // boundary, because the chart is shared with the ride page and demanded that
  // page's chart-link provider (see RideChartLink's UNLINKED).
  await page.goto("/training?tab=log");
  const walkRow = page
    .getByTestId("training-log-row")
    .filter({ hasText: ZONE_WALK_TITLE });
  await hydratedClick(page, walkRow);
  await followLink(
    page,
    page.getByTestId("activity-pane-open"),
    /\/training\/activity\/\d+$/
  );

  const record = page.getByTestId("training-activity-page");
  await expect(record).toBeVisible();
  const hr = page.getByTestId("activity-hr-chart");
  await expect(hr).toBeVisible();
  // It says how much wear it is drawing, and the zone strip splits those same
  // minutes — an empty chart frame would satisfy neither.
  await expect(hr).toContainText(/\d+ recorded min/);
  await expect(page.getByTestId("activity-heart-rate-zones")).toBeVisible();

  // And what the DEVICE recorded second by second (#2870 step 4): the walk's
  // streams are stored now that the fetch follows the recording rather than the
  // sport, so the page draws them beside the wear minutes.
  const traces = page.getByTestId("activity-traces");
  await expect(traces).toBeVisible();
  await expect(traces.locator("svg")).toBeVisible();
  // A session that HAS detail never claims to be totals-only.
  await expect(page.getByTestId("activity-totals-only")).toHaveCount(0);

  // And its splits (#3009), cut at the READER's unit — a walk of 1.4 km gets
  // none at all from the ride page's 5 km interval, which is the whole reason
  // the interval follows the unit rather than the sport.
  const splits = page.getByTestId("activity-splits");
  await expect(splits).toBeVisible();
  await expect(splits.getByRole("heading")).toHaveText(/1 (km|mi) splits/);
  await expect(splits.locator("tbody tr")).not.toHaveCount(0);
});

test("a summary-only import says so, instead of leaving a silent short page", async ({
  page,
}) => {
  // The failure this closes is not that the page is short — a hand-entered walk
  // IS a total and a title. It is that a short page reads as something failing
  // to load. Said only where the source actually answered: its empty telemetry
  // row is the answer.
  await page.goto("/training?tab=log");
  await hydratedClick(
    page,
    page.getByTestId("training-log-row").filter({ hasText: TOTALS_ONLY_TITLE })
  );
  await followLink(
    page,
    page.getByTestId("activity-pane-open"),
    /\/training\/activity\/\d+$/
  );

  await expect(page.getByTestId("training-activity-page")).toBeVisible();
  await expect(page.getByTestId("activity-totals-only")).toContainText(
    /recorded totals for this session/
  );
  await expect(page.getByTestId("activity-traces")).toHaveCount(0);
  await expect(page.getByTestId("activity-hr-chart")).toHaveCount(0);
});

test("the ledger walk: older/newer links traverse adjacent activities", async ({
  page,
}) => {
  await page.goto("/training?tab=analyze&kind=strength&item=Back%20Squat");
  await followLink(
    page,
    page.getByTestId("analyze-sessions").getByRole("link").first(), // first-ok: newest session row; the walk below is what's under test
    /\/training\/activity\/\d+$/
  );
  // The newest session of a seeded multi-session history has an older neighbor.
  const older = page.getByTestId("activity-older-link");
  await expect(older).toBeVisible();
  await followLink(page, older, /\/training\/activity\/\d+$/);
  // And from there, a newer link back.
  await expect(page.getByTestId("activity-newer-link")).toBeVisible();
});

test("Edit opens the form docked IN the page — the page is the editor's host (#2870 step 2)", async ({
  page,
}) => {
  await page.goto("/training?tab=analyze&kind=strength&item=Back%20Squat");
  await followLink(
    page,
    page.getByTestId("analyze-sessions").getByRole("link").first(), // first-ok: any session reaches its page; the dock is what's under test
    /\/training\/activity\/\d+$/
  );

  await page.getByTestId("activity-page-edit").click();
  // The provider portals the full ActivityForm into the page's own dock — no
  // separate surface, and the autosave/edit-lock machinery rides along.
  const dock = page.getByTestId("activity-page-dock");
  await expect(dock.getByTestId("activity-form")).toBeVisible();
});

test("‹older› closes a docked edit — it never strands under the next record", async ({
  page,
}) => {
  await page.goto("/training?tab=analyze&kind=strength&item=Back%20Squat");
  await followLink(
    page,
    page.getByTestId("analyze-sessions").getByRole("link").first(), // first-ok: newest session; the nav-close is what's under test
    /\/training\/activity\/\d+$/
  );
  await page.getByTestId("activity-page-edit").click();
  await expect(
    page.getByTestId("activity-page-dock").getByTestId("activity-form")
  ).toBeVisible();

  // Walking the ledger remounts the record (keyed by activity), which closes
  // the docked editor for the record we just left — the form must not stay
  // portaled under an activity it doesn't belong to, where its writes would
  // target what the reader believes is on screen. Not followLink: its
  // destination pattern would also match the URL we're leaving, so it can't
  // tell a landed navigation from a swallowed click. And not the older link's
  // exact href either — a cycling neighbor canonically redirects to its rides
  // page — so the pin is simply "we left this record's URL".
  const startPath = new URL(page.url()).pathname;
  await page.getByTestId("activity-older-link").click();
  await page.waitForURL((u) => u.pathname !== startPath);
  await expect(page.getByTestId("activity-form")).toHaveCount(0);
});

test("a global 'Log activity' on the page opens the overlay, not this record's dock", async ({
  page,
}) => {
  await page.goto("/training?tab=analyze&kind=strength&item=Back%20Squat");
  await followLink(
    page,
    page.getByTestId("analyze-sessions").getByRole("link").first(), // first-ok: any session's page hosts the scoped dock under test
    /\/training\/activity\/\d+$/
  );

  // The page dock is SCOPED to this record's edits. A palette create must not
  // portal a brand-new, unrelated form under the record (below the fold, no
  // scroll) — it opens the overlay, visible where the tap happened.
  const input = await openCommandPalette(page);
  await input.fill("log workout");
  await page.getByTestId("palette-action-log-workout").click();
  const form = page.getByTestId("activity-form");
  await expect(form).toBeVisible();
  await expect(
    page.getByTestId("activity-page-dock").getByTestId("activity-form")
  ).toHaveCount(0);
});
