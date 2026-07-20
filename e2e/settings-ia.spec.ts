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

    // Guard (moved from home-assistant-notify.spec.ts when that spec went to its
    // own fixture profile): the HA card's submit button is deliberately NOT named
    // "Save" — role name matching is substring-based, and pre-existing specs (e.g.
    // preventive-nudge.spec.ts) click a bare "Save" on this admin page. Exactly one
    // "Save"-named button (the Telegram card's) must exist, or those clicks turn
    // strict-mode ambiguous.
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(1);
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

    // Jumping scrolls the target section to the top of the viewport (robust to
    // hash/scroll timing — asserts the actual effect, not the URL mechanics).
    await page.getByTestId("anchor-training").click();
    await expect
      .poll(
        async () => {
          const box = await page.locator("#training").boundingBox();
          return box ? box.y : 99999;
        },
        { timeout: 10_000 }
      )
      .toBeLessThan(200);
    await expect(
      page
        .locator("#training")
        .getByRole("heading", { name: "Training", exact: true })
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

      // Toggling a Telegram kind persists across a reload (tier-correct action).
      // State-relative + self-restoring so it's repeat-each safe (the fixture DB
      // persists across the 3 repeats).
      //
      // The matrix checkbox fires its action from a CLIENT onChange (optimistic
      // flip + disabled-while-saving), so a click in the hydration window is
      // silently swallowed while an unrelated on-load POST can still satisfy
      // settledClick's any-POST arm (the #830 class — this spec failed exactly so
      // in CI). toPass is justified: "my click landed" is non-atomic and there is
      // no navigation for followLink — re-click until the OPTIMISTIC flip proves
      // onChange fired. React batches the flip with `disabled={saving}` into one
      // render, so once flipped, waiting for the box to re-ENABLE proves the save
      // round-trip (action + refresh) completed — only then is a reload safe.
      const toggleMatrixCell = async (testid: string, to: boolean) => {
        const cell = member.getByTestId(testid);
        await expect(async () => {
          await cell.click();
          await expect(cell).toBeChecked({ checked: to });
        }).toPass();
        await expect(cell).toBeEnabled();
      };
      const tgRefill = member.getByTestId("matrix-cell-telegram-refill");
      const wasChecked = await tgRefill.isChecked();
      await toggleMatrixCell("matrix-cell-telegram-refill", !wasChecked);
      await member.reload();
      await expect(
        member.getByTestId("matrix-cell-telegram-refill")
      ).toBeChecked({ checked: !wasChecked });
      // Restore the fixture (leave the column as we found it).
      await toggleMatrixCell("matrix-cell-telegram-refill", wasChecked);

      // Configure Home Assistant so the profile has one CONFIGURED channel, then
      // turn a SAFETY kind (dose) off on it — with no other channel configured, the
      // row warns (warn, never block).
      const ha = member.getByTestId("ha-settings");
      const haEnable = member.getByTestId("ha-enable");
      if (!(await haEnable.isChecked())) await haEnable.check();
      await member
        .getByTestId("ha-webhook-url")
        .fill("http://homeassistant.local:8123/api/webhook/allos-notif");
      // Saving the HA card resets its per-kind grid to all-on, so dose starts ON.
      await settledClick(member, member.getByTestId("ha-save"));
      await member.reload();

      // Baseline: with HA configured and dose ON, no safety warning.
      const haDose = member.getByTestId("matrix-cell-ha-dose");
      if (!(await haDose.isChecked())) await settledClick(member, haDose);
      await expect(
        member.getByTestId("matrix-safety-warning-dose")
      ).toHaveCount(0);
      // Turn dose off for the only configured channel → the warning appears.
      await settledClick(member, member.getByTestId("matrix-cell-ha-dose"));
      await expect(
        member.getByTestId("matrix-safety-warning-dose")
      ).toBeVisible();
      // Restore: dose back on, warning clears (leave clean for the next repeat).
      await settledClick(member, member.getByTestId("matrix-cell-ha-dose"));
      await expect(
        member.getByTestId("matrix-safety-warning-dose")
      ).toHaveCount(0);
      // ha card still rendered (sanity — the section didn't collapse).
      await expect(ha).toBeVisible();
    } finally {
      await member.context().close();
    }
  });
});
