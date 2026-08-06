import { test, expect } from "./fixtures";
import { hydratedClick, settledClick } from "./helpers";
import { loginAs } from "./nav";
import { E2E_LOGIN_MOBILITY, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// #2130: `mobility-move` is declared idempotent in ONE_TAP_AFFORDANCES — the
// offline queue's own stated admission criterion — and the coverage record made
// it a member. The ON tap (a pure capture: set-add per (profile, date, move))
// queues while offline and replays through the same write core on reconnect,
// exactly once under the replayed_keys ledger. The OFF tap stays online-only
// (a removal against live state, the documented "−" exclusion) and refuses
// honestly. Runs as the dedicated mobility login so no shared-seed rows are
// counted; the flow normalizes and cleans its one move.

test("a mobility move tapped offline queues, then syncs exactly once on reconnect (#2130)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_MOBILITY,
    password: E2E_MEMBER_PASSWORD,
  });
  test.slow();
  const context = page.context();
  try {
    await page.goto("/training?tab=overview");
    // A move the mobility.spec.ts flows never touch, so the specs stay
    // order-independent.
    const chip = page.getByTestId("mobility-move-neck_cars");
    await expect(chip).toBeVisible();
    // Normalize to OFF so the flow is repeat-safe.
    if ((await chip.getAttribute("aria-pressed")) === "true") {
      await settledClick(page, chip);
      await expect(chip).toHaveAttribute("aria-pressed", "false");
    }
    const total = page.getByTestId("mobility-move-total");
    const before = Number(
      ((await total.textContent()) ?? "").trim().split(" ")[0] || "0"
    );

    // Connection gone at the instant of the tap.
    await context.setOffline(true);
    await hydratedClick(page, chip);

    // Queued, not failed: the toast + pending badge, with the optimistic chip
    // standing in for the queued write.
    await expect(
      page.getByText("Saved offline — will sync when you reconnect.")
    ).toBeVisible();
    const badge = page.getByTestId("offline-queue-badge");
    await expect(badge).toHaveText(/1 queued offline/);
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await expect(total).toContainText(String(before + 1));

    // The OFF tap is deliberately not queueable: an offline un-tap rolls back
    // with an honest message, and the queue still holds exactly one entry.
    await chip.click();
    await expect(
      page.getByText("You're offline — removing a move needs a connection.")
    ).toBeVisible();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await expect(badge).toHaveText(/1 queued offline/);

    // Reconnect → the "online" event triggers the replay.
    await context.setOffline(false);
    await expect(page.getByText(/Synced 1 offline entr/)).toBeVisible();
    await expect(badge).toHaveCount(0);

    // Durable server truth after a reload (which re-runs the on-load flush
    // against the drained queue): the move is logged exactly once.
    await page.reload();
    const after = page.getByTestId("mobility-move-neck_cars");
    await expect(after).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("mobility-move-total")).toContainText(
      String(before + 1)
    );
    await expect(page.getByTestId("offline-queue-badge")).toHaveCount(0);

    // Cleanup: untap online so a repeat starts from the same place.
    await settledClick(page, after);
    await expect(after).toHaveAttribute("aria-pressed", "false");
  } finally {
    await context.close();
  }
});
