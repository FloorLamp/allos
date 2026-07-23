import { test, expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { settledClick } from "./helpers";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_OWN,
  OWN_SELF_PROFILE,
  OWN_OTHER_PROFILE,
} from "./fixture-logins";

// Own-profile link + not-self write affordances + login identity (issue #1013).
// Spec-OWNED fixtures (E2E_LOGIN_OWN granted two adult profiles, own_profile_id →
// the SELF profile, each with a due dose + a weigh-in — see e2e/seed-events.ts), on a
// fresh cookie-less context so the switch/weigh-in/workout writes never touch the
// admin storageState. The spec only READS affordance labels (no confirm/finish
// writes), so it's repeat-safe without a fixture reset.
//
// Uses the #1096 switch-to-<id> testid to change the acting profile (NOT the
// accessible-name lookup, which collides with the view toggles — that was just
// fixed; don't reintroduce it).

// Resolve the two fixture profile ids from the isolated e2e DB (short-lived
// connection, busy timeout) so the switch testid can target the OTHER profile.
function ownProfileIds(): { selfId: number; otherId: number } {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    const idOf = (name: string): number =>
      (
        db.prepare("SELECT id FROM profiles WHERE name = ?").get(name) as {
          id: number;
        }
      ).id;
    return { selfId: idOf(OWN_SELF_PROFILE), otherId: idOf(OWN_OTHER_PROFILE) };
  } finally {
    db.close();
  }
}

// Open the profile-menu popover past the pre-hydration disable gate (#830).
async function openProfileMenu(page: Page): Promise<void> {
  const trigger = page.getByTestId("user-menu-trigger");
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(page.getByTestId("user-menu-popover")).toBeVisible();
}

test.describe("Own-profile + not-self write affordances (issue #1013)", () => {
  test("menu shows 'Signed in as'; self affordance is plain, not-self names the subject", async ({
    browser,
  }) => {
    test.slow(); // local `next dev` compiles the dashboard/household on first hit
    const { otherId } = ownProfileIds();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_OWN,
      password: E2E_MEMBER_PASSWORD,
    });

    // Acting profile is SELF (lowest id / first accessible).
    await expect(page.getByTestId("user-menu-trigger")).toContainText(
      OWN_SELF_PROFILE
    );

    // The menu overlay answers "which login am I?".
    await openProfileMenu(page);
    await expect(page.getByTestId("signed-in-as")).toContainText(E2E_LOGIN_OWN);
    // Close the popover (outside click) before navigating.
    await page.keyboard.press("Escape");

    // Dashboard weigh-in, acting as SELF → the affordance stays PLAIN (self needs no
    // naming): the save button is just "Log".
    await page.goto("/");
    const saveSelf = page.getByTestId("weight-quick-add-save");
    await expect(saveSelf).toBeVisible();
    await expect(saveSelf).toHaveText("Log");

    // Household: acting as SELF, both cards render. The SELF card's dose confirm is
    // plain; the OTHER card's names the card's PERSON (not the viewer).
    await page.goto("/household");
    const selfCard = page
      .getByTestId("household-card")
      .filter({ hasText: OWN_SELF_PROFILE });
    const otherCard = page
      .getByTestId("household-card")
      .filter({ hasText: OWN_OTHER_PROFILE });
    await expect(selfCard.getByTestId("household-confirm-dose")).toHaveText(
      "Confirm"
    );
    await expect(otherCard.getByTestId("household-confirm-dose")).toHaveText(
      `Confirm — ${OWN_OTHER_PROFILE}`
    );

    // Switch the ACTING profile to the OTHER (not the login's own) via the #1096
    // switch-to-<id> control, then the dashboard weigh-in NAMES the subject.
    await page.goto("/");
    await openProfileMenu(page);
    await settledClick(page, page.getByTestId(`switch-to-${otherId}`));
    await expect(page.getByTestId("user-menu-trigger")).toContainText(
      OWN_OTHER_PROFILE
    );
    const saveOther = page.getByTestId("weight-quick-add-save");
    await expect(saveOther).toBeVisible();
    await expect(saveOther).toHaveText(`Log — ${OWN_OTHER_PROFILE}`);

    await page.context().close();
  });

  test("live workout editor names the not-self subject", async ({
    browser,
  }) => {
    test.slow();
    const { otherId } = ownProfileIds();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_OWN,
      password: E2E_MEMBER_PASSWORD,
    });

    // Act as the OTHER profile (not the login's own).
    await openProfileMenu(page);
    await settledClick(page, page.getByTestId(`switch-to-${otherId}`));
    await expect(page.getByTestId("user-menu-trigger")).toContainText(
      OWN_OTHER_PROFILE
    );

    // Start a live workout — the fastest-tapping surface. Its Finish button names
    // whose session it is (both fixture profiles are adults → live mode available).
    await page.goto("/training");
    await page.getByRole("main").getByTestId("start-workout").click();
    await expect(page.getByTestId("live-workout-panel")).toBeVisible();
    await expect(page.getByTestId("finish-workout")).toHaveText(
      `Finish workout — ${OWN_OTHER_PROFILE}`
    );

    await page.context().close();
  });

  test("mobile drawer carries the same 'Signed in as' identity", async ({
    browser,
  }) => {
    test.slow();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_OWN,
      password: E2E_MEMBER_PASSWORD,
    });
    // Mobile viewport → the sidebar is a drawer; the shared SidebarContent means the
    // same overlay (never a hand-mirrored hidden md:* branch).
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    // Open the mobile drawer past the pre-hydration hamburger swallow (#500): re-tap
    // until the drawer renders (idempotent — the button only opens). expect.poll, not
    // toPass/waitForTimeout.
    const openBtn = page.getByRole("button", { name: "Open menu" });
    const drawer = page.locator("div.fixed.inset-0.z-40");
    await expect
      .poll(
        async () => {
          if (!(await drawer.isVisible()))
            await openBtn.click().catch(() => {});
          return drawer.isVisible();
        },
        { timeout: 20_000 }
      )
      .toBe(true);
    // Open the profile menu WITHIN the drawer (the desktop aside also carries a
    // hidden trigger on mobile, so scope every lookup to the drawer).
    const trigger = drawer.getByTestId("user-menu-trigger");
    await expect(trigger).toBeEnabled();
    await trigger.click();
    await expect(drawer.getByTestId("user-menu-popover")).toBeVisible();
    await expect(drawer.getByTestId("signed-in-as")).toContainText(
      E2E_LOGIN_OWN
    );

    await page.context().close();
  });
});
