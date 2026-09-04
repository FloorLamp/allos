import { expect, test } from "./fixtures";
import { type Page } from "@playwright/test";
import {
  appContent,
  comboboxRows,
  deleteActivityFromForm,
  followLink,
  hydratedClick,
} from "./helpers";
import { openLogSheet, showLogRow } from "./log-sheet-helpers";

// THE WORKSPACE'S EXIT, AT THE VIEWPORT WHERE IT IS THE ONLY ONE (#5111).
//
// Below `sm` the activity panel is `w-full`, so the overlay's backdrop has no
// pixel left to tap; a phone has no keyboard for Escape; and the drag handle
// renders only while a workout runs. Every other close in this suite goes
// through Escape or the backdrop, which is precisely why nothing caught a New
// activity form with no way out. These tests drive the ✕ itself, in the phone
// project, so the exit is asserted where it is load-bearing rather than where
// three other doors would answer for it.
//
// #5095 rides along rather than getting its own file: the fallback the focus
// trap used to be left to picks the mobile minimize button HERE and the
// generated title on desktop, so this viewport is where the wrong landing spot
// is visible at all.

// The workspace, and the scope every lookup inside it hangs off. `ActivityOverlay`
// renders through `createPortal`, so this panel is a client-only subtree with
// exactly one copy — it cannot sit inside a streamed Suspense boundary, which is
// the hazard `appContent()` exists for (#4890). Scoping to the overlay's own
// testid is what e2e/helpers.ts prescribes for a portalled surface.
function workspace(page: Page) {
  return page.getByTestId("activity-overlay-panel"); // testid-scope-ok: ActivityOverlay portals to <body>, one copy
}

// Same shape-tolerant combobox pick the live-workout and live-page specs use.
async function pickActivity(page: Page, name: string) {
  await page.getByPlaceholder(/What did you do/).fill(name);
  await comboboxRows(page)
    .filter({ hasText: name })
    .first() // first-ok: transient combobox list this spec just opened by typing `name`; the first filtered match is the intended option
    .click();
}

test("a new activity closes from the header ✕, and there is no backdrop behind it", async ({
  page,
}) => {
  await page.goto("/training?tab=log");
  const sheet = await openLogSheet(page);
  await (await showLogRow(sheet, "log-activity")).click();

  const panel = workspace(page);
  await expect(panel).toBeVisible();
  // The dialog is the landing spot (#5095), not whatever the trap's fallback
  // would have reached first.
  await expect(panel).toBeFocused();

  // WHY THE ✕ IS THE ONLY EXIT HERE, measured rather than asserted in prose: the
  // panel spans the whole screen, so the container that closes on click has no
  // exposed pixel. An x of 0 AND a width equal to the viewport — either alone is
  // satisfied by a drawer pinned to one edge.
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBe(0);
  expect(box!.width).toBe(390);

  const close = panel.getByTestId("close-activity");
  await expect(close).toBeVisible();
  await close.click();

  // Nothing to discard, so nothing to ask: the workspace is simply gone.
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0); // testid-scope-ok: the confirm sheet portals to <body> (BottomSheet), one copy
});

test("the ✕ asks before discarding an edit the form cannot save", async ({
  page,
}) => {
  await page.goto("/training?tab=analyze&kind=strength&item=Back%20Squat");
  await followLink(
    page,
    appContent(page).getByTestId("analyze-sessions").getByRole("link").first(), // first-ok: any stored session reaches the editor under test
    /\/training\/activity\/\d+$/
  );
  await hydratedClick(page, appContent(page).getByTestId("activity-page-edit"));
  const panel = workspace(page);
  await expect(panel.getByTestId("activity-form")).toBeVisible();

  // Blank a stored set's weight: a real row, edited, that auto-save cannot
  // persist — the one state #3420's guard exists for. The grid sits one tap
  // behind the compact summary chip on a seeded uniform session (#3336).
  await hydratedClick(page, panel.getByTestId("set-summary").first()); // first-ok: any part's sets can be made incomplete; the first is always present
  await panel.getByTestId("set1-weight").first().fill(""); // first-ok: any incomplete stored set blocks this edit; set 1 is always present

  // The ✕ is the SAME guarded route as Done and the backdrop, so it asks — and
  // Cancel leaves the work on screen rather than half-closing the workspace.
  const close = panel.getByTestId("close-activity");
  const discard = page.getByTestId("confirm-dialog"); // testid-scope-ok: the confirm sheet portals to <body> (BottomSheet), one copy
  await close.click();
  await expect(discard).toContainText("Discard unsaved changes?");
  await discard.getByRole("button", { name: "Cancel" }).click();
  await expect(panel.getByTestId("activity-form")).toBeVisible();

  await close.click();
  await discard.getByRole("button", { name: "Close anyway" }).click();
  await expect(panel).toHaveCount(0);
});

test("a live workout finishes from the sticky footer, and Save closes the workspace", async ({
  page,
}) => {
  test.slow();
  await page.goto("/training?tab=log");
  const sheet = await openLogSheet(page);
  const workout = await showLogRow(sheet, "live-workout");
  await expect(workout).toContainText("Start workout");
  await workout.click();
  const panel = workspace(page);
  await expect(panel.getByTestId("live-workout-panel")).toBeVisible();
  // On this viewport the trap's fallback would take the minimize button, which
  // sits above the form in the DOM (#5095).
  await expect(panel).toBeFocused();

  // THE FOOTER CARRIES THE SESSION'S ONE COMMIT. Scoped to the footer, because
  // the live panel at the TOP of the form carries its own Finish — the whole
  // complaint was that reaching that one means scrolling back past every logged
  // set. Done and Close are absent by name: the reachable button used to be a
  // Done that pocketed the running session instead of ending it.
  const footer = panel.getByTestId("activity-form-footer");
  const finish = footer.getByRole("button", {
    name: "Finish workout",
    exact: true,
  });
  await expect(finish).toBeVisible();
  await expect(
    footer.getByRole("button", { name: "Done", exact: true })
  ).toHaveCount(0);
  await expect(
    footer.getByRole("button", { name: "Close", exact: true })
  ).toHaveCount(0);

  // Parking still belongs to the drag handle on a phone, and a restore lands on
  // the dialog exactly as the first open did.
  await panel.getByTestId("minimize-workout").click();
  // The dock renders in ActivityEditorProvider, a client subtree of
  // app/(app)/layout.tsx OUTSIDE app-content-container and every StreamedSection.
  const dock = page.getByTestId("workout-dock"); // testid-scope-ok: layout chrome, outside every streamed boundary
  await expect(dock).toBeVisible();
  await dock.getByTestId("workout-dock-open").click();
  await expect(panel).toBeFocused();

  // Give the session something to keep, so the close below is a finish and not
  // the empty-row discard, and a title this spec can find it by afterwards.
  const title = "E2E Phone Finish";
  await panel.getByLabel("Activity name").fill(title);
  await pickActivity(page, "Barbell Bench Press");
  await panel
    .getByTestId("next-set-card")
    .getByRole("button", { name: "Use" })
    .click();
  await expect(panel.getByTestId("set1-weight")).toHaveValue(/^\d/);

  await finish.click();
  await expect(panel.getByTestId("session-complete-step")).toBeVisible();

  // ONE STEP: Save stamps the end, leaves live mode and closes. It used to
  // collapse back to the plain editor for the row just finished, making Save the
  // third tap of four.
  await panel.getByTestId("recap-save").click();
  await expect(panel).toHaveCount(0);
  await expect(dock).toHaveCount(0);

  // Closing pops the history entry the phone workspace holds (so the hardware
  // Back button closes the form rather than leaving the page), which lands the
  // tab back where it opened from. Read the finished session off the log instead:
  // a reopen through the server is a stronger reading of the end stamp than the
  // collapsed editor's own field was.
  await page.goto("/training?tab=log");
  const row = appContent(page)
    .getByTestId("history-row")
    .filter({ hasText: title })
    .first(); // first-ok: the activity row THIS spec created, filtered by its own title
  await expect(row).toBeVisible();
  await hydratedClick(page, row.getByTestId("history-row-title"));
  await page.waitForURL(/\/training\/activity\/\d+$/);
  await hydratedClick(page, appContent(page).getByTestId("activity-page-edit"));
  await expect(workspace(page).getByTestId("end-time-input")).toHaveValue(
    /^\d\d:\d\d$/
  );
  await deleteActivityFromForm(page);
});
