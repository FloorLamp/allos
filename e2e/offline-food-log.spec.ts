import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { hydratedClick } from "./helpers";

// #1596: the food quick-adds — a one-tap food-group serving and the protein-grams
// control — queue while offline and replay through the same write cores on
// reconnect, landing EXACTLY ONCE despite the racing flush triggers (online event,
// on-load flush, Background Sync). Delta-based assertions on the server-rendered
// counts after a full reload prove the write landed once without exact-counting
// shared seed rows.

async function revealFoodGroup(page: Page, slug: string) {
  const row = page.getByTestId(`food-group-${slug}`);
  if (!(await row.isVisible())) {
    await page.getByTestId("food-more-groups-summary").click();
    await expect(row).toBeVisible();
  }
}

test("a food serving tapped offline queues, then syncs exactly once on reconnect (#1596)", async ({
  page,
  context,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();
  await revealFoodGroup(page, "nuts_seeds");

  // The server-rendered baseline for this meal slot today.
  const count = page.getByTestId("count-nuts_seeds");
  const before = Number((await count.textContent())?.trim() || "0");

  // The kitchen-moment: connection gone at the instant of the tap.
  await context.setOffline(true);
  await hydratedClick(page, page.getByTestId("log-nuts_seeds"));

  // Queued, not failed: the toast + pending badge, with the optimistic count
  // standing in for the server total.
  await expect(
    page.getByText("Saved offline — will sync when you reconnect.")
  ).toBeVisible();
  const badge = page.getByTestId("offline-queue-badge");
  await expect(badge).toHaveText(/1 queued offline/);
  await expect(count).toHaveText(String(before + 1));

  // The undo "−" is deliberately online-only (a decrement is not a capture): an
  // offline tap rolls back with an honest message rather than pretending.
  await hydratedClick(page, page.getByTestId("undo-nuts_seeds"));
  await expect(
    page.getByText("You're offline — removing a serving needs a connection.")
  ).toBeVisible();
  await expect(count).toHaveText(String(before + 1));
  await expect(badge).toHaveText(/1 queued offline/);

  // Reconnect → the "online" event triggers the replay.
  await context.setOffline(false);
  await expect(page.getByText(/Synced 1 offline entr/)).toBeVisible();
  await expect(badge).toHaveCount(0);

  // Durable server truth after a reload (which re-runs the on-load flush against
  // the drained queue): exactly ONE more serving than the baseline.
  await page.reload();
  await expect(page.getByTestId("food-log-bar")).toBeVisible();
  await revealFoodGroup(page, "nuts_seeds");
  await expect(page.getByTestId("count-nuts_seeds")).toHaveText(
    String(before + 1)
  );
  await expect(page.getByTestId("offline-queue-badge")).toHaveCount(0);
});

test("protein grams added offline queue, then sync exactly once on reconnect (#1596)", async ({
  page,
  context,
}) => {
  await page.goto("/nutrition");
  const quickAdd = page.getByTestId("protein-quickadd");
  await expect(quickAdd).toBeVisible();

  // The server-rendered baseline ("Ng today").
  const total = page.getByTestId("protein-quickadd-total");
  const before = Number(
    ((await total.textContent()) ?? "").match(/(\d+)g today/)?.[1] ?? "0"
  );

  await context.setOffline(true);
  await page.getByTestId("protein-quickadd-input").fill("30");
  await hydratedClick(page, page.getByTestId("protein-quickadd-add"));

  await expect(
    page.getByText("Saved offline — will sync when you reconnect.")
  ).toBeVisible();
  const badge = page.getByTestId("offline-queue-badge");
  await expect(badge).toHaveText(/1 queued offline/);
  await expect(total).toHaveText(`${before + 30}g today`);

  await context.setOffline(false);
  await expect(page.getByText(/Synced 1 offline entr/)).toBeVisible();
  await expect(badge).toHaveCount(0);

  // Durable, exactly once: the reloaded (server-rendered) total moved by 30 —
  // not 60, which is what a double-replay past the idempotency ledger would show.
  await page.reload();
  await expect(page.getByTestId("protein-quickadd-total")).toHaveText(
    `${before + 30}g today`
  );
  await expect(page.getByTestId("offline-queue-badge")).toHaveCount(0);
});
