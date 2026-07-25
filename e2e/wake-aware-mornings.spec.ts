import { test, expect } from "@playwright/test";
import { settledCheckSave, settledSelectSave } from "./helpers";

// Wake-aware mornings (issue #1117): the wake-derived "Auto" state on the
// Morning intake slot + the morning digest, and the sleep-summary opt-in, on
// Settings → Notifications. Runs as admin acting as the seeded profile 1 (shared
// storageState). As of #1072 the schedule is per-SUBJECT and always visible; #1462 §6
// split it into a "Schedule" card (slot times, quiet hours) and a "Message kinds" card
// (one row per kind: enable + config + channel routing), both autosaving on change.
// BLAST RADIUS: it drives the Morning/digest selects + the sleep toggle, then RESETS
// them (Morning back to Auto — profile 1's default, digest off, sleep off) so the
// shared fixture is left as found.
test.describe("wake-aware mornings (issue #1117)", () => {
  test("Auto option + sleep-summary opt-in round-trip", async ({ page }) => {
    test.slow(); // local `next dev` compiles the route on first hit

    await page.goto("/settings/notifications");

    const scheduleCard = page.getByTestId("notify-schedule");
    const kindsCard = page.getByTestId("notification-kinds");
    await expect(scheduleCard).toBeVisible();
    await expect(kindsCard).toBeVisible();

    const morning = page.getByTestId("supp-morning-hour");
    const digest = page.getByTestId("digest-hour");

    // The wake-aware option is offered on both the Morning slot and the digest.
    await expect(morning.getByRole("option", { name: /^Auto \(/ })).toHaveCount(
      1
    );
    await expect(digest.getByRole("option", { name: /^Auto \(/ })).toHaveCount(
      1
    );

    // Pick a specific Morning hour → it persists as a manual choice.
    await settledSelectSave(page, morning, "9", scheduleCard);
    await page.reload();
    await expect(page.getByTestId("supp-morning-hour")).toHaveValue("9");

    // Switch the Morning slot + the digest to Auto, and set the sleep summary on (it's the
    // opt-out default as of #1378; check() pins that it round-trips as an explicit "1").
    await settledSelectSave(
      page,
      page.getByTestId("supp-morning-hour"),
      "auto",
      scheduleCard
    );
    await settledSelectSave(
      page,
      page.getByTestId("digest-hour"),
      "auto",
      kindsCard
    );
    // #1378: the sleep summary is an opt-OUT (on by default WITH the digest). #1462 §6
    // nests it under the digest row as one of that kind's extras, so it appears only
    // once the digest is on — which it now is. (The default-on read is pinned in the
    // pure/action/DB tiers; this spec RESETS the toggle at the end, so the shared
    // profile-1 checkbox state isn't stable across --repeat-each and can't be asserted
    // here per e2e hygiene, #868.)
    await expect(
      page.getByText("Include last night’s sleep summary")
    ).toBeVisible();
    await settledCheckSave(
      page,
      page.getByTestId("digest-sleep-enabled"),
      true,
      kindsCard
    );

    // All three round-trip across a reload.
    await page.reload();
    await expect(page.getByTestId("supp-morning-hour")).toHaveValue("auto");
    await expect(page.getByTestId("digest-hour")).toHaveValue("auto");
    await expect(page.getByTestId("digest-sleep-enabled")).toBeChecked();

    // Reset the shared fixture: Morning back to Auto (its default), digest off,
    // sleep off.
    await settledCheckSave(
      page,
      page.getByTestId("digest-sleep-enabled"),
      false,
      kindsCard
    );
    await settledSelectSave(
      page,
      page.getByTestId("digest-hour"),
      "",
      kindsCard
    );
  });
});
