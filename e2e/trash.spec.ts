import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { settledClick } from "./helpers";

// Issue #2013: `deleted_rows` has held a fully restorable capture of every
// destructive delete since #30, and the ONLY affordance over it was a toast that
// disappeared in 15 seconds. This spec drives the exact journey that had no path
// before: delete a row, LET THE TOAST GO, open Data → Trash, and get it back.
//
// Fixture ownership (docs/internals/e2e-hygiene.md failure class 1): every row this
// spec touches is a uniquely-titled probe it created itself, and every assertion is
// scoped to that title — never a count over the shared trash, which any sibling
// spec's delete can add to.

const PROBE_PREFIX = "Trash probe";
let probeSeq = 0;

function cardsByTitle(page: Page, text: string | RegExp) {
  return page
    .getByRole("main")
    .locator('[id^="activity-"]')
    .filter({ hasText: text });
}

// The Trash row for a given probe title (the headline is "<title> · <date>").
function trashRow(page: Page, title: string) {
  return page.getByTestId("trash-row").filter({ hasText: title });
}

// Confirm the dialog-scoped Delete on the activity editor and await the capture POST.
async function confirmDelete(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await settledClick(
    page,
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete", exact: true })
  );
}

// Create a uniquely-titled cardio probe that auto-saves, then close the editor so the
// delete is driven from the CARD. Cardio + a duration auto-saves without the per-set
// equipment pick a bare strength variant needs (#342).
async function createProbe(page: Page): Promise<string> {
  const title = `${PROBE_PREFIX} ${Date.now()}-${++probeSeq}`; // clock-ok: unique probe-name suffix, never a stored timestamp
  await page.goto("/training");
  await page
    .getByRole("main")
    .getByRole("button", { name: "New activity" })
    .click();
  await page.getByRole("textbox", { name: "Activity name" }).fill(title);
  await page.getByPlaceholder(/What did you do/).fill("Running");
  await page
    .getByRole("listbox")
    .getByRole("button", { name: "Running", exact: true })
    .click();
  await page.getByTestId("cardio-duration").fill("30");
  // The Delete button appears only once the auto-save created the row — a stable
  // persist signal (it stays while the row exists, unlike the fading "Saved" check).
  await expect(
    page.getByRole("button", { name: "Delete", exact: true })
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(cardsByTitle(page, title)).toHaveCount(1);
  return title;
}

// Create a probe, delete it from its card, and WALK AWAY from the Undo toast — the
// state that used to be unreachable. Returns the probe's title.
async function deleteProbeAndAbandonTheToast(page: Page): Promise<string> {
  const title = await createProbe(page);
  await cardsByTitle(page, title).getByRole("button", { name: title }).click();
  await confirmDelete(page);
  await expect(cardsByTitle(page, title)).toHaveCount(0);
  // Navigating away discards the toast without waiting out its 15 seconds, which is
  // exactly what a person who noticed the mistake later did.
  await page.goto("/data?section=trash");
  return title;
}

test("a deleted row is restorable from Data → Trash after the toast is gone (#2013)", async ({
  page,
}) => {
  test.slow(); // local next dev compiles /training and /data on first hit

  const title = await deleteProbeAndAbandonTheToast(page);

  // The capture is listed with the identifying content read out of its payload —
  // the label column alone would say "activity" for every one of them.
  const row = trashRow(page, title);
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("trash-row-headline")).toContainText(title);

  // Restore is the same one-tap restore the toast performs.
  await settledClick(page, row.getByTestId("trash-restore"));
  await expect(page.getByText("Restored.")).toBeVisible();
  // The capture is consumed, so the Trash stops offering it.
  await expect(trashRow(page, title)).toHaveCount(0);

  // And the row is back on its own surface (under a NEW id, so match by title).
  await page.goto("/training");
  await expect(cardsByTitle(page, title)).toHaveCount(1);

  // Clean up: delete the restored probe and purge its capture, so this spec leaves
  // the shared DB exactly as it found it.
  await cardsByTitle(page, title).getByRole("button", { name: title }).click();
  await confirmDelete(page);
  await page.goto("/data?section=trash");
  const leftover = trashRow(page, title);
  // The purge button opens a confirm (no POST of its own) — the confirm's button is
  // what fires the action, so that is the settled click.
  await leftover.getByTestId("trash-purge").click();
  await settledClick(
    page,
    page
      .getByTestId("confirm-dialog")
      .getByRole("button", { name: "Delete permanently" })
  );
  await expect(trashRow(page, title)).toHaveCount(0);
});

test("Delete permanently removes a capture ahead of its window (#2013)", async ({
  page,
}) => {
  test.slow();

  const title = await deleteProbeAndAbandonTheToast(page);
  const row = trashRow(page, title);
  await expect(row).toHaveCount(1);

  // A destructive confirm, then the row leaves the list — the capture is gone, not
  // merely hidden.
  await row.getByTestId("trash-purge").click();
  await settledClick(
    page,
    page
      .getByTestId("confirm-dialog")
      .getByRole("button", { name: "Delete permanently" })
  );
  await expect(page.getByText("Deleted permanently.")).toBeVisible();
  await expect(trashRow(page, title)).toHaveCount(0);

  // Reloading proves it was a write, not client state — and the activity stays gone.
  await page.reload();
  await expect(trashRow(page, title)).toHaveCount(0);
  await page.goto("/training");
  await expect(cardsByTitle(page, title)).toHaveCount(0);
});

// Runs last on purpose: it is the one assertion in this file that is about the WHOLE
// trash rather than one owned row, so it empties everything first and then asserts
// the empty state. Emptying only ever removes captures of already-deleted rows, so no
// live fixture data of any spec is at risk.
test("Empty trash clears the list and leaves the empty state (#2013)", async ({
  page,
}) => {
  test.slow();

  const title = await deleteProbeAndAbandonTheToast(page);
  await expect(trashRow(page, title)).toHaveCount(1);

  await page.getByTestId("trash-empty-all").click();
  await settledClick(
    page,
    page
      .getByTestId("confirm-dialog")
      .getByRole("button", { name: "Empty trash" })
  );

  await expect(page.getByTestId("trash-row")).toHaveCount(0);
  await expect(page.getByTestId("trash-empty")).toBeVisible();

  // The emptied state survives a reload, and the deleted probe stays deleted.
  await page.reload();
  await expect(page.getByTestId("trash-empty")).toBeVisible();
  await page.goto("/training");
  await expect(cardsByTitle(page, title)).toHaveCount(0);
});
