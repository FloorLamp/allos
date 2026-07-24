import { test, expect } from "@playwright/test";
import { settledClick } from "./helpers";

// Wake-aware mornings (issue #1117): the "Auto — from your wake time" state on the
// Morning intake slot + the morning digest, and the sleep-summary opt-in, on
// Settings → Notifications. Runs as admin acting as the seeded profile 1 (shared
// storageState). As of #1072 the schedule is per-SUBJECT and always visible under
// "Reminders & schedule" (no longer gated behind a per-profile Telegram toggle).
// BLAST RADIUS: it drives the Morning/digest selects + the sleep toggle, then RESETS
// them (Morning back to Auto — profile 1's default, digest off, sleep off) so the
// shared fixture is left as found.
test.describe("wake-aware mornings (issue #1117)", () => {
  test("Auto option + sleep-summary opt-in round-trip", async ({ page }) => {
    test.slow(); // local `next dev` compiles the route on first hit

    await page.goto("/settings/notifications");

    const card = page.locator(".card", {
      has: page.getByRole("heading", { name: "Reminders & schedule" }),
    });
    await expect(card).toBeVisible();

    // #1378: the sleep summary is ON by default (an opt-OUT) — the toggle reads checked
    // before this spec touches it (profile 1 never stored an explicit choice), and the copy
    // reflects last night's sleep.
    await expect(page.getByTestId("digest-sleep-enabled")).toBeChecked();
    await expect(
      page.getByText("Include last night’s sleep summary")
    ).toBeVisible();

    const morning = page.getByTestId("supp-morning-hour");
    const digest = page.getByTestId("digest-hour");
    const save = card.getByRole("button", { name: "Save" });

    // The wake-aware option is offered on both the Morning slot and the digest.
    await expect(
      morning.getByRole("option", { name: /Auto — from your wake time/ })
    ).toHaveCount(1);
    await expect(
      digest.getByRole("option", { name: /Auto — from your wake time/ })
    ).toHaveCount(1);

    // Pick a specific Morning hour → it persists as a manual choice.
    await morning.selectOption("9");
    await settledClick(page, save);
    await expect(card.getByLabel("Saved")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("supp-morning-hour")).toHaveValue("9");

    // Switch the Morning slot + the digest to Auto. The sleep summary is on by default
    // (#1378); check() is a no-op here but pins that it round-trips as an explicit "1".
    await page.getByTestId("supp-morning-hour").selectOption("auto");
    await page.getByTestId("digest-hour").selectOption("auto");
    await page.getByTestId("digest-sleep-enabled").check();
    await settledClick(page, card.getByRole("button", { name: "Save" }));
    await expect(card.getByLabel("Saved")).toBeVisible();

    // All three round-trip across a reload.
    await page.reload();
    await expect(page.getByTestId("supp-morning-hour")).toHaveValue("auto");
    await expect(page.getByTestId("digest-hour")).toHaveValue("auto");
    await expect(page.getByTestId("digest-sleep-enabled")).toBeChecked();

    // Reset the shared fixture: Morning back to Auto (its default), digest off,
    // sleep off.
    await page.getByTestId("digest-hour").selectOption("");
    await page.getByTestId("digest-sleep-enabled").uncheck();
    await settledClick(page, card.getByRole("button", { name: "Save" }));
    await expect(card.getByLabel("Saved")).toBeVisible();
  });
});
