import { test, expect } from "@playwright/test";

// Issue #29: data-entry ergonomics — the three affordances end-to-end against the
// seeded DB.
//
//  1. Command-palette inline quick-log: `weight 84.3` parses (pure
//     parseQuickLog), previews, and Enter commits it through paletteQuickLog →
//     insertBodyMetric (the same write the Body form uses).
//  2. Repeat-last: a card's "Log again" opens a CREATE form pre-filled from the
//     stored activity; the seeded, complete session auto-saves as a NEW row.
//  3. Bulk table delete + undo: selecting rows in Data → Manage deletes them
//     through captureDelete (per row) and one "Undo" restores the whole batch.

test("command palette 'weight 84.3' logs a body metric (#29)", async ({
  page,
}) => {
  await page.goto("/");

  // Open the palette (Cmd/Ctrl-K; the handler accepts either modifier).
  await page.keyboard.press("Control+k");
  const input = page.getByLabel("Search or run a command");
  await expect(input).toBeVisible();

  // Typing the quick-log syntax surfaces a preview row; the seed login is kg.
  await input.fill("weight 84.3");
  const preview = page.getByTestId("palette-quicklog");
  await expect(preview).toContainText("84.3 kg");

  // Enter commits it — the success toast is the end-to-end write confirmation.
  await input.press("Enter");
  await expect(page.getByText("Logged weight 84.3 kg.")).toBeVisible();

  // …and it lands in the Body tab's History table (kg, so the value shows
  // as-is). Assert against the weight cell's stable testid — rows are date-desc,
  // so today's just-logged entry is the first one — rather than free text, which
  // also matches the (visually hidden) chart axis/point labels.
  await page.goto("/trends?tab=body");
  await expect(page.getByTestId("body-weight-cell").first()).toContainText(
    "84.3"
  );
});

test("'Log again' pre-fills a create form that saves a new activity (#29)", async ({
  page,
}) => {
  await page.goto("/training"); // default "Log" tab renders the Journal feed

  // The e2e seed plants a manual "Journal merge keeper" activity; repeat it.
  const titleCards = page
    .locator('[id^="activity-"]')
    .filter({ hasText: "Journal merge keeper" });
  await expect(titleCards.first()).toBeVisible();
  const before = await titleCards.count();

  // Open the first matching card's overflow (⋯) menu → "Log again".
  await titleCards
    .first()
    .getByRole("button", { name: "Activity actions" })
    .click();
  await page.getByTestId("log-again").click();

  // The editor opens pre-filled — its heading carries the source title.
  await expect(
    page.getByRole("heading", { name: "Journal merge keeper" })
  ).toBeVisible();

  // The prefilled, complete session auto-saves as a NEW row (dated today), so a
  // second card with the same title appears on the feed.
  await expect(titleCards).toHaveCount(before + 1);

  // Clean up the row this test just created: the editor is still open on it, so
  // delete it from there. The e2e DB is shared across specs (the harness seeds
  // once), and a lingering today-dated activity would (a) collide with the
  // journal-merge fixture's "Journal merge keeper" title and (b) add a new "Today"
  // day-group that shifts the journal's visible-day window, throwing off the
  // absolute card counts in journal-merge / undo-delete. Restoring the seed state
  // here keeps those specs order-independent.
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(titleCards).toHaveCount(before);
});

test("'Repeat last' button is not clipped by the editor pane's scroll container (#103)", async ({
  page,
}) => {
  await page.goto("/training"); // default "Log" tab renders the Journal feed

  // The button lives in the desktop editor aside's header row, which sits inside
  // a `sticky … overflow-y-auto` scroll container. Issue #103: the header's fixed
  // height was shorter than the bordered ghost button, so `items-center` pushed
  // the button's top above the row and the scroll container clipped it.
  const button = page.getByTestId("repeat-last");
  await expect(button).toBeVisible();

  // Regression: the button's top edge must not sit above its scrolling ancestor's
  // top edge (that overflow is exactly what got clipped).
  const container = button.locator(
    'xpath=ancestor::div[contains(@class,"overflow-y-auto")][1]'
  );
  const btnBox = await button.boundingBox();
  const containerBox = await container.boundingBox();
  expect(btnBox).not.toBeNull();
  expect(containerBox).not.toBeNull();
  expect(btnBox!.y).toBeGreaterThanOrEqual(containerBox!.y - 0.5);

  // And it stays fully within the viewport and remains clickable.
  expect(btnBox!.y).toBeGreaterThanOrEqual(0);
  await expect(button).toBeEnabled();
});

test("bulk-delete rows in Data → Manage, then Undo restores them (#29)", async ({
  page,
}) => {
  await page.goto("/data?section=manage");

  // The Body metrics dataset (undoable kind = body-metric) is seeded with rows.
  const card = page.locator(".card", {
    has: page.getByRole("heading", { name: "Body metrics" }),
  });
  await expect(card).toBeVisible();
  // Remember the "(N)" count in the heading to prove a full restore later.
  const countText = async () =>
    (await card.locator("h2 span").first().textContent())?.trim();
  const original = await countText();
  expect(original).toBeTruthy();

  // Enter edit mode → select every row shown → delete the selection.
  await card.getByRole("button", { name: "Edit" }).click();
  await card.getByLabel("Select all rows shown").check();
  await card.getByRole("button", { name: "Delete selected" }).click();
  // Confirm the inline "Delete N rows?" prompt.
  await card.getByRole("button", { name: "Delete", exact: true }).click();

  // One batch toast with an Undo action; click it.
  await expect(
    page.getByText(/Deleted \d+ rows? from Body metrics\./)
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();

  // The whole batch comes back (restored under new ids) — a "Restored N" toast,
  // and after a fresh render the dataset count matches where it started.
  await expect(page.getByText(/Restored \d+ rows?\./)).toBeVisible();
  await page.goto("/data?section=manage");
  await expect(card.locator("h2 span").first()).toHaveText(original!);
});
