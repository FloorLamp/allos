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

// #475: an offline entry the server REJECTS on replay must NOT vanish with a
// "synced" toast — it's parked in a reviewable panel with a reason so the user can
// re-enter it. We drive the real offline→queue path, then intercept the replay
// JSON API to return a `rejected` disposition (the defect is purely the client-side
// disposition of the server's honest answers), and assert the review panel appears,
// the badge clears, and nothing was persisted.
test("a rejected offline entry is surfaced for review, not silently dropped (#475)", async ({
  page,
  context,
}) => {
  const marker = `offline-reject-${Date.now()}`;

  await page.goto("/trends?tab=body");
  const form = page
    .locator("form")
    .filter({ has: page.getByRole("heading", { name: "Log body metrics" }) });
  await expect(form).toBeVisible();

  await context.setOffline(true);
  await form.getByLabel("Weight (kg)").fill("77.3");
  await form.getByLabel("Notes").fill(marker);
  await form.getByRole("button", { name: "Save entry" }).click();

  const badge = page.getByTestId("offline-queue-badge");
  await expect(badge).toHaveText(/1 queued offline/);

  // Force the replay to answer "rejected" for whatever intents are posted.
  await page.route("**/api/offline-replay", async (route) => {
    const body = route.request().postDataJSON() as {
      intents?: { key: string }[];
    };
    const results = (body.intents ?? []).map((i) => ({
      key: i.key,
      status: "rejected" as const,
      reason: "The server couldn't validate this entry.",
    }));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, results }),
    });
  });

  await context.setOffline(false);

  // The rejected entry is parked for review — never silently discarded.
  const review = page.getByTestId("offline-rejected-review");
  await expect(review).toBeVisible();
  await expect(review).toContainText(/couldn.?t be applied/i);
  await expect(review).toContainText("Body metric");

  // The live queue badge clears (the intent left the live queue) and the entry
  // did NOT persist server-side.
  await expect(badge).toHaveCount(0);
  await page.unroute("**/api/offline-replay");
  await page.goto("/trends?tab=body");
  await expect(page.getByText(marker)).toHaveCount(0);

  // The review panel survives a reload (persisted in the dead-letter store) and can
  // be dismissed once the user has re-entered the data.
  await expect(page.getByTestId("offline-rejected-review")).toBeVisible();
  await page
    .getByTestId("offline-rejected-review")
    .getByRole("button", { name: "Dismiss all" })
    .click();
  await expect(page.getByTestId("offline-rejected-review")).toHaveCount(0);
});
