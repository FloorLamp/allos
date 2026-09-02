import { test, expect } from "./fixtures";
import { followLink, hydratedClick } from "./helpers";
import { openCommandPalette } from "./nav";
// Fixture names come from the DB-free constants module, never from e2e/seed/*:
// a seed module pulls in lib/db, whose migration logging lands on stdout and
// corrupts the JSON that `scripts/e2e-shard-plan.ts --verify` parses from
// `playwright --list`.
import {
  E2E_LOGIN_OVERLAP,
  E2E_LOGIN_SESSION_PEERS,
  SESSION_PEERS_TITLE,
  E2E_MEMBER_PASSWORD,
  OVERLAP_KEEPER_TITLE,
  OVERLAP_TWIN_TITLE,
  TOTALS_ONLY_TITLE,
  ZONE_WALK_TITLE,
} from "./fixture-logins";
import { loginAs } from "./nav";

// #2870 step 1 — every non-cycling activity has a canonical page: the Training
// Log's session body at its own URL, with ‹ older / newer › ledger
// navigation and capability-based effort/course sections. These pins ride
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
  await expect(record.getByTestId("activity-icon")).toHaveCount(1);
  // This is a detail PAGE, not feed-card chrome stranded at its own URL.
  await expect(record.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(record.getByRole("heading", { name: "Overview" })).toHaveCount(
    0
  );
  const summary = record.getByTestId("activity-summary");
  await expect(summary).toHaveAttribute("data-density", "detail");
  await expect(summary).toContainText("Duration");
  await expect(
    record.getByTestId("activity-record-body").locator(".card")
  ).toHaveCount(0);
  await expect(record.getByTestId("activity-detail-link")).toHaveCount(0);
  // The page-native body still carries the full per-exercise detail, sets first.
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
    await followLink(
      member,
      member
        .getByTestId("history-row")
        .filter({ hasText: OVERLAP_KEEPER_TITLE }),
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
  // page's chart-link provider (see SessionChartLink's UNLINKED).
  await page.goto("/training?tab=log");
  const walkRow = page
    .getByTestId("history-row")
    .filter({ hasText: ZONE_WALK_TITLE });
  await followLink(page, walkRow, /\/training\/activity\/\d+$/);

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
  await expect(record.getByRole("heading", { name: "Effort" })).toBeVisible();
  await expect(traces.getByTestId("session-telemetry-chart")).toBeVisible();
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
  await followLink(
    page,
    page.getByTestId("history-row").filter({ hasText: TOTALS_ONLY_TITLE }),
    /\/training\/activity\/\d+$/
  );

  await expect(page.getByTestId("training-activity-page")).toBeVisible();
  await expect(page.getByTestId("activity-totals-only")).toContainText(
    /recorded session totals/
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

test("Edit uses the same activity workspace at desktop and phone widths", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/training?tab=analyze&kind=strength&item=Back%20Squat");
  await followLink(
    page,
    page.getByTestId("analyze-sessions").getByRole("link").first(), // first-ok: any session reaches its page; the dock is what's under test
    /\/training\/activity\/\d+$/
  );

  await page.getByTestId("activity-page-edit").click();
  await expect(page.getByTestId("activity-overlay-panel")).toBeVisible();
  await expect(page.getByTestId("activity-form")).toBeVisible();
  await expect(page.getByTestId("activity-page-dock")).toHaveCount(0);
  const desktopPanel = await page
    .getByTestId("activity-overlay-panel")
    .boundingBox();
  expect(desktopPanel).not.toBeNull();
  expect(desktopPanel!.x + desktopPanel!.width).toBe(1440);
  expect(desktopPanel!.width).toBeLessThan(1440);
  await page.getByRole("button", { name: "Done", exact: true }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("activity-page-edit").click();
  await expect(page.getByTestId("activity-overlay-panel")).toBeVisible();
  await expect(page.getByTestId("activity-form")).toBeVisible();
  await expect(page.getByTestId("activity-page-dock")).toHaveCount(0);
  const phonePanel = await page
    .getByTestId("activity-overlay-panel")
    .boundingBox();
  expect(phonePanel).not.toBeNull();
  expect(phonePanel!.x).toBe(0);
  expect(phonePanel!.width).toBe(390);

  // Mobile Back uses the form's save-aware close request. A blocked edit must
  // ask before it is discarded, and cancelling restores the Back sentinel.
  // AFFECTED BY #3336 AND NOT EDITED BY IT UNTIL NOW: this seeded Leg day is five
  // uniform runs, so every part opens as the compact sentence and there is no
  // `set1-weight` in the document at all. The grid is one tap behind the summary chip
  // — `hydratedClick`, because a tap that lands pre-hydration is swallowed silently and
  // the next line would read as "element not found" rather than as a missed click.
  await hydratedClick(page, page.getByTestId("set-summary").first()); // first-ok: any part's sets can be made incomplete; the first is always present
  await page.getByTestId("set1-weight").first().fill(""); // first-ok: any incomplete stored set blocks this edit; set 1 is always present
  await page.goBack();
  const discard = page.getByTestId("confirm-dialog");
  await expect(discard).toContainText("Discard unsaved changes?");
  await discard.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("activity-form")).toBeVisible();
  await page.goBack();
  await discard.getByRole("button", { name: "Close anyway" }).click();
  await expect(page.getByTestId("activity-form")).toHaveCount(0);
});

test("the overlay closes back onto the same activity", async ({ page }) => {
  await page.goto("/training?tab=analyze&kind=strength&item=Back%20Squat");
  await followLink(
    page,
    page.getByTestId("analyze-sessions").getByRole("link").first(), // first-ok: any session reaches the edit flow under test
    /\/training\/activity\/\d+$/
  );
  const startPath = new URL(page.url()).pathname;
  await page.getByTestId("activity-page-edit").click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByTestId("activity-form")).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe(startPath);
});

test("a global 'Log activity' on the page uses the same overlay", async ({
  page,
}) => {
  await page.goto("/training?tab=analyze&kind=strength&item=Back%20Squat");
  await followLink(
    page,
    page.getByTestId("analyze-sessions").getByRole("link").first(), // first-ok: any session's page reaches the overlay under test
    /\/training\/activity\/\d+$/
  );

  // The global create action uses the same predictable overlay as Edit.
  const input = await openCommandPalette(page);
  await input.fill("log workout");
  await page.getByTestId("palette-action-log-workout").click();
  const form = page.getByTestId("activity-form");
  await expect(form).toBeVisible();
  await expect(page.getByTestId("activity-overlay-panel")).toBeVisible();
});

test("a session is measured against its own like-for-like peers (#3009)", async ({
  browser,
}) => {
  // For endurance the personal baseline beats any published standard: the
  // question is not "is this fast" but "is this fast FOR ME, on this kind of
  // session, at this distance". Its own profile, so the median is the fixture's
  // and not whatever else the shared seed happens to hold.
  const member = await loginAs(browser, {
    username: E2E_LOGIN_SESSION_PEERS,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await member.goto("/training?tab=log");
    await followLink(
      member,
      member
        .getByTestId("history-row")
        .filter({ hasText: SESSION_PEERS_TITLE })
        .first(), // first-ok: the newest of four same-titled fixture sessions — the subject
      /\/training\/activity\/\d+$/
    );

    const comparison = member.getByTestId("activity-comparison");
    await expect(comparison).toBeVisible();
    // It says what it compared against — a median of one would be a comparison
    // in name only.
    await expect(comparison).toContainText(/3 similar sessions/);
    await expect(comparison).toContainText(
      /within \d+% of this session’s distance/
    );
    // Speed and heart rate both have peers carrying them, so both are available
    // in the converged comparison chart. Selecting either metric updates the one
    // shared ranking instead of rendering parallel metric blocks.
    const metrics = comparison.getByRole("group", {
      name: "Comparison metric",
    });
    const speed = metrics.getByRole("button", { name: "Speed" });
    const heartRate = metrics.getByRole("button", { name: "Heart rate" });
    await expect(speed).toHaveAttribute("aria-pressed", "true");
    await expect(heartRate).toBeVisible();
    await expect(member.getByTestId("activity-comparison-range")).toContainText(
      /Median/
    );
    await heartRate.click();
    await expect(heartRate).toHaveAttribute("aria-pressed", "true");
    await expect(
      comparison.getByRole("list", { name: /Average heart rate across/ })
    ).toBeVisible();
  } finally {
    await member.close();
  }
});
