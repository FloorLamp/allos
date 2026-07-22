import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";

// The dashboard "Needs attention" hero's per-item snooze/dismiss popover (issue
// #281). It used to be a native <details> float with a translucent .card panel
// that never closed on an outside click or after picking an option; it is now the
// shared OverflowMenu popover (opaque panel, click-away backdrop, Escape close,
// portaled to <body>) — the same popover every other kebab menu in the app uses.
// These specs pin the fixed behavior against the seeded profile 1, whose hero
// always carries suppressible items (overdue appointment, low supply, care plan).

// Drop the suppression row a snooze in this file creates, so the shared seeded DB
// is left as found for the other specs that read profile 1's suppression store
// (the resetInteractionDismissals pattern). Short-lived connection, busy timeout
// so it never contends with the running server (WAL).
function removeSuppression(signalKey: string): void {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare("DELETE FROM upcoming_dismissals WHERE signal_key = ?").run(
      signalKey
    );
  } finally {
    db.close();
  }
}

test("the attention item menu opens an opaque popover and light-dismisses", async ({
  page,
}) => {
  await page.goto("/");
  const hero = page.getByRole("main").getByTestId("needs-attention");
  await expect(hero).toBeVisible();

  const trigger = hero
    .getByRole("button", { name: "Snooze or dismiss" })
    .first(); // first-ok: any attention item's snooze/dismiss menu — asserts the menu structure, order-agnostic
  await expect(trigger).toBeVisible();

  // Open → the portaled panel renders with the snooze/dismiss options and a
  // fully opaque background ("too transparent" was half of #281: the old panel
  // inherited the frosted-glass .card translucency).
  await trigger.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "1 day" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Dismiss" })).toBeVisible();
  const bg = await menu.evaluate((el) => getComputedStyle(el).backgroundColor);
  // Computed style is "rgb(...)" for alpha 1; "rgba(...)" would mean the panel
  // is still translucent.
  expect(bg).toMatch(/^rgb\(/);

  // Escape closes ("doesn't close properly" was the other half of #281 — the
  // old <details> stayed open until its trigger was clicked again).
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);

  // Reopen, then an outside click lands on the click-away backdrop and closes it.
  await trigger.click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("snoozing from the menu runs the action, closes the menu, and hides the item", async ({
  page,
}) => {
  await page.goto("/");
  const hero = page.getByRole("main").getByTestId("needs-attention");
  await expect(hero).toBeVisible();

  // Pick the first suppressible item (structural review/integration signals
  // render no menu) and derive its signal key from the row testid so the
  // suppression can be dropped again afterwards.
  const item = hero
    .locator('[data-testid^="attention-item-"]')
    .filter({ has: page.getByRole("button", { name: "Snooze or dismiss" }) })
    .first(); // first-ok: the first dismissible attention item; its suppression is dropped again afterward (order-agnostic, self-cleaning)
  await expect(item).toBeVisible();
  const testId = await item.getAttribute("data-testid");
  const signalKey = testId!.replace("attention-item-", "");

  try {
    await item.getByRole("button", { name: "Snooze or dismiss" }).click();
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: "1 day" })
      .click();

    // The action ran (toast confirms), the menu closed itself, and the
    // revalidated hero no longer shows the snoozed item.
    await expect(page.getByText("Snoozed for 1 day")).toBeVisible();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(
      hero.locator(`[data-testid="attention-item-${signalKey}"]`)
    ).toHaveCount(0);
  } finally {
    removeSuppression(signalKey);
  }
});
