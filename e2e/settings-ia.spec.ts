import { test, expect } from "@playwright/test";
import { loginAs, followLink } from "./nav";
import { settledClick } from "./helpers";
import { E2E_LOGIN_NOTIF, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Settings IA overhaul (#928): the new tab strip, the anchor-nav Profile tab, the
// Notifications tab that composes all three tiers + the kind × channel matrix, the
// Admin sub-nav fronting the diagnostic viewers, and the health cards relocated to
// Medical → Background. Admin cases run on the shared admin storageState (profile 1);
// the matrix-mutation cases run as a DEDICATED member login (NOTIF_PROFILE) so
// toggling notification prefs never races the shared profile-1 notification specs.

test.describe("Settings IA (#928) — admin", () => {
  test("the Notifications tab composes push (login), profile, and Server sections + the matrix", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/settings/notifications");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    // The full admin strip.
    for (const name of [
      "Preferences",
      "Profile",
      "Notifications",
      "Family",
      "Server",
      "Admin",
    ]) {
      await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
    }

    // All three tier sections render (Server section is admin-only).
    await expect(page.getByText("This login", { exact: true })).toBeVisible();
    await expect(page.getByText("This profile", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Server", { exact: true }).first()
    ).toBeVisible();
    await expect(page.getByTestId("push-settings")).toBeVisible();
    await expect(page.getByTestId("notification-matrix")).toBeVisible();
  });

  test("the Profile tab has a sticky anchor jump-nav that jumps to each section", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/settings/profile");
    const nav = page.getByTestId("profile-anchor-nav");
    await expect(nav).toBeVisible();
    await expect(page.getByTestId("anchor-identity")).toBeVisible();
    await expect(page.getByTestId("anchor-coaching")).toBeVisible();

    // Jumping updates the location hash and reveals the target section.
    await page.getByTestId("anchor-training").click();
    await expect(page).toHaveURL(/#training$/);
    await expect(
      page.locator("#training").getByRole("heading", { name: "Training" })
    ).toBeVisible();
  });

  test("the Admin tab fronts AI logs | Errors | Audit via a second-level nav", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/settings/logs");
    // The strip entry is "Admin"; the sub-nav carries the three viewers.
    await expect(
      page.getByRole("link", { name: "Admin", exact: true })
    ).toBeVisible();
    const subnav = page.getByTestId("admin-subnav");
    await expect(subnav).toBeVisible();

    await followLink(
      page,
      subnav.getByRole("link", { name: "Errors" }),
      /\/settings\/errors$/
    );
    await expect(page.getByText(/Server error log/)).toBeVisible();

    await followLink(
      page,
      subnav.getByRole("link", { name: "Audit" }),
      /\/settings\/audit$/
    );
    // Still the same Admin strip entry, now with Audit active in the sub-nav.
    await expect(
      page.getByRole("link", { name: "Admin", exact: true })
    ).toBeVisible();
  });

  test("the health cards moved to Medical → Background", async ({ page }) => {
    test.slow();
    await page.goto("/medical/background");
    await expect(
      page.getByRole("heading", { name: "Background" })
    ).toBeVisible();
    await expect(page.getByTestId("smoking-history")).toBeVisible();
    await expect(page.getByTestId("risk-factors")).toBeVisible();
    await expect(page.getByTestId("emergency-toggle")).toBeVisible();
  });
});

test.describe("Settings IA (#928) — member + matrix", () => {
  test("a member sees three tabs, no admin entries, and no Server section", async ({
    browser,
  }) => {
    test.slow();
    const member = await loginAs(browser, {
      username: E2E_LOGIN_NOTIF,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/settings/notifications");
      for (const name of ["Preferences", "Profile", "Notifications"]) {
        await expect(
          member.getByRole("link", { name, exact: true })
        ).toBeVisible();
      }
      for (const name of ["Family", "Server", "Admin"]) {
        await expect(
          member.getByRole("link", { name, exact: true })
        ).toHaveCount(0);
      }
      // The login section + matrix render; the admin-only Server section does not.
      await expect(member.getByTestId("push-settings")).toBeVisible();
      await expect(member.getByTestId("notification-matrix")).toBeVisible();
      await expect(member.getByText("Server", { exact: true })).toHaveCount(0);
    } finally {
      await member.context().close();
    }
  });

  test("the matrix: push can't deliver food, a Telegram toggle persists, and an all-off safety kind warns", async ({
    browser,
  }) => {
    test.slow();
    const member = await loginAs(browser, {
      username: E2E_LOGIN_NOTIF,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/settings/notifications");
      const matrix = member.getByTestId("notification-matrix");
      await expect(matrix).toBeVisible();

      // Inherently-undeliverable cell: push × food renders as unavailable, not a box.
      await expect(
        member.getByTestId("matrix-unavailable-push-food")
      ).toBeVisible();
      await expect(member.getByTestId("matrix-cell-push-food")).toHaveCount(0);

      // Toggling a Telegram kind off persists across a reload (tier-correct action).
      const tgRefill = member.getByTestId("matrix-cell-telegram-refill");
      await expect(tgRefill).toBeChecked();
      await settledClick(member, tgRefill);
      await member.reload();
      await expect(
        member.getByTestId("matrix-cell-telegram-refill")
      ).not.toBeChecked();

      // Configure Home Assistant so the profile has one CONFIGURED channel, then
      // turn a SAFETY kind (dose) off on it — with no other channel configured, the
      // row warns (warn, never block).
      const ha = member.getByTestId("ha-settings");
      await member.getByTestId("ha-enable").check();
      await member
        .getByTestId("ha-webhook-url")
        .fill("http://homeassistant.local:8123/api/webhook/allos-notif");
      await settledClick(member, member.getByTestId("ha-save"));
      await member.reload();

      // No safety warning yet — dose is delivered by HA.
      await expect(
        member.getByTestId("matrix-safety-warning-dose")
      ).toHaveCount(0);
      // Turn dose off for the only configured channel → the warning appears.
      await settledClick(member, member.getByTestId("matrix-cell-ha-dose"));
      await expect(
        member.getByTestId("matrix-safety-warning-dose")
      ).toBeVisible();
      // ha card still rendered (sanity — the section didn't collapse).
      await expect(ha).toBeVisible();
    } finally {
      await member.context().close();
    }
  });
});
