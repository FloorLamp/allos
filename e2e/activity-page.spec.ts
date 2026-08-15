import { test, expect } from "./fixtures";
import { followLink } from "./helpers";

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
