import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { settledClick, expectInView } from "./helpers";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_MVMEDS,
  MVMEDS_SELF_PROFILE,
  MVMEDS_RO_PROFILE,
  MVMEDS_SELF_MED,
  MVMEDS_RO_MED,
  E2E_LOGIN_VIEWONLY_WRITE,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

// The unified profile switcher (issue #1801).
//
// One identity bar + one switcher panel replaced three surfaces: the sidebar
// profile menu, the ProfileViewStrip, and (on a phone) nothing at all. This spec
// pins the parts of that unification no other spec covers:
//
//   * the SAFETY RULE, made structural — after any switch the FIRST stacked
//     avatar is the acting profile, and it is the one carrying `data-acting`.
//     Writes land on that profile, so its position is not decoration;
//   * switching from the bar on BOTH viewports, with the page's data following;
//   * the #33 read-only hint on the bar AND on the row it describes;
//   * the multiProfile gate — a single-profile instance keeps the wordmark and
//     grows no identity chrome at all;
//   * the retired surfaces staying retired.
//
// The view-set round-trip (stacked avatars + "+N more" updating) is asserted by
// multi-view.spec.ts and shell.mobile.spec.ts, which inherited the strip-era
// assertions; the name-line composition itself is pinned purely in
// lib/__tests__/profile-identity.test.ts.
//
// Fixture hygiene (#868): read-only over the seeded MVMEDS fixture (a caregiver
// granted its own profile WRITE + a second profile READ-ONLY) and the seeded
// single-profile view-only login, each in its OWN cookie-less context — the
// acting profile is SESSION state, so switching here can never touch the shared
// admin storageState or a sibling worker.

function profileId(name: string): number {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    return (
      db.prepare("SELECT id FROM profiles WHERE name = ?").get(name) as {
        id: number;
      }
    ).id;
  } finally {
    db.close();
  }
}

// Open the switcher past the pre-hydration disable gate (#830): the bar renders
// disabled until mounted, so wait for it to enable, then click.
async function openSwitcher(page: Page, mobile = false): Promise<void> {
  const barId = mobile ? "profile-identity-bar-mobile" : "profile-identity-bar";
  const panelId = mobile
    ? "profile-switcher-panel-mobile"
    : "profile-switcher-panel";
  const trigger = page.getByTestId(barId);
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(page.getByTestId(panelId)).toBeVisible();
}

// THE acting-emphasis pin: the bar's first stacked avatar is the acting profile,
// and it is the one marked `data-acting`. Asserted through the bar's own
// `data-acting-profile-id` too, so a reordering bug cannot pass by relabelling.
async function expectActing(
  page: Page,
  profileIdValue: number,
  mobile = false
): Promise<void> {
  const bar = page.getByTestId(
    mobile ? "profile-identity-bar-mobile" : "profile-identity-bar"
  );
  await expect(bar).toHaveAttribute(
    "data-acting-profile-id",
    String(profileIdValue)
  );
  await expect(
    bar.locator('[data-testid^="identity-avatar-"]').first() // first-ok: the assertion IS about the first avatar — acting-first is the safety rule this pins
  ).toHaveAttribute("data-testid", `identity-avatar-${profileIdValue}`);
  await expect(
    bar.getByTestId(`identity-avatar-${profileIdValue}`)
  ).toHaveAttribute("data-acting", "true");
}

test.describe("Unified profile switcher (issue #1801)", () => {
  test("switching from the bar reorders acting-first, carries the read-only hint, and the page follows", async ({
    browser,
  }) => {
    // Local `next dev` compiles /medications on first hit.
    test.slow();
    const selfId = profileId(MVMEDS_SELF_PROFILE);
    const roId = profileId(MVMEDS_RO_PROFILE);

    const page = await loginAs(browser, {
      username: E2E_LOGIN_MVMEDS,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/medications");

      // Acting is the WRITE profile (the lowest-id grant), so no read-only hint.
      await expect(page.getByTestId("profile-identity-bar")).toContainText(
        MVMEDS_SELF_PROFILE
      );
      await expectActing(page, selfId);
      await expectInView(page, 1);
      await expect(page.getByTestId("read-only-badge")).toHaveCount(0);

      // TWO VERBS, TWO CONTROLS: every accessible profile is a row with a
      // switch-to button AND its own view toggle — never one ambiguous tap.
      await openSwitcher(page);
      const panel = page.getByTestId("profile-switcher-panel");
      await expect(panel.getByTestId(`switch-to-${roId}`)).toBeVisible();
      await expect(panel.getByTestId(`view-toggle-${roId}`)).toBeEnabled();
      // You cannot un-view the profile you are acting as.
      await expect(panel.getByTestId(`view-toggle-${selfId}`)).toBeDisabled();
      // The #33 hint rides the ROW of the read-only profile, so "why can't I edit
      // here?" is answerable BEFORE switching rather than after.
      await expect(
        panel.getByTestId(`switcher-read-only-${roId}`)
      ).toBeVisible();
      await expect(
        panel.getByTestId(`switcher-read-only-${selfId}`)
      ).toHaveCount(0);

      // Switch to the read-only profile through the panel's switch-to control —
      // the existing switchProfileAction/setActiveProfile boundary, no new write
      // path.
      await settledClick(page, panel.getByTestId(`switch-to-${roId}`));

      // The bar reorders: the newly acting profile is FIRST and ringed.
      await expect(page.getByTestId("profile-identity-bar")).toContainText(
        MVMEDS_RO_PROFILE,
        { timeout: 20_000 }
      );
      await expectActing(page, roId);
      // …and the hint rides the bar, because that is where "who am I acting as"
      // is already being read.
      await expect(page.getByTestId("read-only-badge")).toBeVisible();

      // The PAGE follows the switch: the medications board is the read-only
      // profile's now, not the write profile's.
      await expect(page.getByText(MVMEDS_RO_MED)).toBeVisible();
      await expect(page.getByText(MVMEDS_SELF_MED)).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });

  test("the phone bar carries the identity, the top drawer switches, and the wordmark is gone", async ({
    browser,
  }) => {
    test.slow();
    const selfId = profileId(MVMEDS_SELF_PROFILE);
    const roId = profileId(MVMEDS_RO_PROFILE);

    const page = await loginAs(
      browser,
      { username: E2E_LOGIN_MVMEDS, password: E2E_MEMBER_PASSWORD },
      { viewport: { width: 390, height: 844 } }
    );
    try {
      await page.goto("/medications");

      // The bar took the wordmark's slot: on a multi-profile instance the brand
      // line is gone from the phone bar (home stays one tap away in the drawer).
      const bar = page.locator("header", {
        has: page.getByRole("button", { name: "Open menu" }),
      });
      await expect(
        bar.getByTestId("profile-identity-bar-mobile")
      ).toBeVisible();
      await expect(bar.getByText("Allos")).toHaveCount(0);
      await expectActing(page, selfId, true);

      // The TOP drawer drops from the bar and switches through the same rows.
      await openSwitcher(page, true);
      const panel = page.getByTestId("profile-switcher-panel-mobile");
      await expect(
        panel.getByTestId(`switcher-read-only-${roId}`)
      ).toBeVisible();
      await settledClick(page, panel.getByTestId(`switch-to-${roId}`));

      await expect(
        page.getByTestId("profile-identity-bar-mobile")
      ).toContainText(MVMEDS_RO_PROFILE, { timeout: 20_000 });
      await expectActing(page, roId, true);
      await expect(page.getByTestId("read-only-badge-mobile")).toBeVisible();
      await expect(page.getByText(MVMEDS_RO_MED)).toBeVisible();
    } finally {
      await page.context().close();
    }
  });

  test("a single-profile login keeps the wordmark and grows no identity chrome", async ({
    browser,
  }) => {
    test.slow();
    // A member granted exactly ONE profile — identity is unambiguous, so the whole
    // apparatus gates off (brand chrome instead of identity chrome).
    const page = await loginAs(
      browser,
      { username: E2E_LOGIN_VIEWONLY_WRITE, password: E2E_MEMBER_PASSWORD },
      { viewport: { width: 390, height: 844 } }
    );
    try {
      await page.goto("/");
      const bar = page.locator("header", {
        has: page.getByRole("button", { name: "Open menu" }),
      });
      await expect(bar.getByText("Allos")).toBeVisible();
      await expect(page.getByTestId("profile-identity-bar-mobile")).toHaveCount(
        0
      );
      await expect(
        page.getByTestId("profile-switcher-panel-mobile")
      ).toHaveCount(0);

      // Same at desktop: the sidebar gains nothing.
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/");
      await expect(page.getByTestId("profile-identity-bar")).toHaveCount(0);
      await expect(page.getByTestId("profile-switcher-panel")).toHaveCount(0);
      // The login half still renders — it is not what gated off.
      await expect(page.getByTestId("signed-in-as")).toBeVisible();
      await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
    } finally {
      await page.context().close();
    }
  });

  test("the retired sidebar profile menu and view strip are gone", async ({
    page,
  }) => {
    await page.goto("/");
    // The two surfaces #1801 unified away. Asserted on the shared admin session
    // (multi-profile), which is exactly where both used to render.
    await expect(page.getByTestId("user-menu-trigger")).toHaveCount(0);
    await expect(page.getByTestId("user-menu-popover")).toHaveCount(0);
    await expect(page.getByTestId("profile-view-strip")).toHaveCount(0);
    // What replaced them.
    await expect(page.getByTestId("profile-identity-bar")).toBeVisible();
    await expect(page.getByTestId("signed-in-as")).toBeVisible();
  });
});
