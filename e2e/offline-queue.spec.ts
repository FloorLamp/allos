import { test, expect } from "@playwright/test";

// #28: PWA offline write queue. A body-metric quick-add submitted while the browser
// is OFFLINE must be queued in IndexedDB (not lost), show a "queued" state + pending
// badge, and then replay to the server on reconnect — landing EXACTLY ONCE even
// though several flush triggers (the online event, the on-load flush, Background
// Sync) can race. body_metrics has no natural unique key, so a duplicate would be a
// second History row; asserting a single row is what proves the server-side
// replayed_keys idempotency ledger works.
//
// Uses Playwright's context.setOffline to simulate the dead-reception moment. The
// distinctive notes marker makes the row trivially findable + countable.
test("a body metric logged offline queues, then syncs exactly once on reconnect (#28)", async ({
  page,
  context,
}) => {
  const marker = `offline-e2e-${Date.now()}`;

  await page.goto("/trends?tab=body");
  const form = page
    .locator("form")
    .filter({ has: page.getByRole("heading", { name: "Log body metrics" }) });
  await expect(form).toBeVisible();

  // Go offline BEFORE submitting — the moment logging actually happens at a gym
  // with no signal.
  await context.setOffline(true);

  await form.getByLabel("Weight (kg)").fill("81.4");
  await form.getByLabel("Notes").fill(marker);
  await form.getByRole("button", { name: "Save entry" }).click();

  // It's queued, not failed: the "saved offline" toast + the pending badge.
  await expect(
    page.getByText("Saved offline — will sync when you reconnect.")
  ).toBeVisible();
  const badge = page.getByTestId("offline-queue-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText(/1 queued offline/);

  // Nothing reached the server yet — the History table has no marker row.
  await expect(page.getByText(marker)).toHaveCount(0);

  // Reconnect → the "online" event triggers a flush that replays the queue.
  await context.setOffline(false);

  // The queue drains: the sync confirmation toast fires and the badge disappears.
  await expect(page.getByText(/Synced 1 offline entr/)).toBeVisible();
  await expect(badge).toHaveCount(0);

  // The row is now persisted server-side — and appears EXACTLY ONCE (the idempotency
  // ledger prevented a double-replay from the racing flush triggers).
  await page.goto("/trends?tab=body");
  await expect(page.getByText(marker)).toHaveCount(1);

  // A further reload (which re-runs the on-load flush against an empty queue) must
  // not resurrect or duplicate anything.
  await page.reload();
  await expect(page.getByText(marker)).toHaveCount(1);
  await expect(page.getByTestId("offline-queue-badge")).toHaveCount(0);
});
