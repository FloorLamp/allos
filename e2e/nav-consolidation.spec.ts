import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_NAV_FEMALE,
  E2E_LOGIN_NAV_MALE,
} from "./fixture-logins";

// Nav reorder + relevance gating (#1042 phase 1).
//
// 1. The frequency-ordered top level renders in the new order on BOTH viewports —
//    the desktop sidebar and the mobile drawer render the ONE shared
//    SidebarContent (#794), so each mount is asserted once, cheaply.
// 2. The Cycle entry is relevance-gated per cycleTrackingRelevant: visible for a
//    female premenopausal fixture, hidden for a male fixture with no cycle rows —
//    and the gate is COSMETIC (the page renders on a direct URL either way).
// 3. The data-gated specialty entries (Vision/Dental) hide on a no-data profile
//    while the deliberately-ungated ones (Skin, Mental health) stay visible.
//
// Fixture hygiene (#868): the gating tests run as the two dedicated read-only
// nav fixtures (e2e/fixture-logins.ts) in their own cookie-less contexts; the
// order tests only READ the shared admin session's sidebar (profile 1 owns
// vision/dental/cycle data, so every entry is present there). No mutations.

// The #1042 frequency order. Household appears for the admin session (it reaches
// 2+ profiles); Longevity took over Protocols' slot in phase 4 (the Protocols
// hub folded into /longevity#protocols).
const TOP_LEVEL_ORDER = [
  "Dashboard",
  "Training",
  "Nutrition",
  "Timeline",
  "Trends",
  "Upcoming",
  "Household",
  "Longevity",
  "Medical",
  "Data",
  "Settings",
];

test("desktop sidebar renders the frequency-ordered top level (#1042)", async ({
  page,
}) => {
  await page.goto("/");
  // The desktop aside is the only <aside> while the drawer is closed. On "/" no
  // Medical child is active, so the group is collapsed and each top-level entry's
  // text content is exactly its label.
  const entries = page.locator("aside nav > *");
  await expect(entries).toHaveText(TOP_LEVEL_ORDER);
});

test("mobile drawer renders the same order through the shared content (#1042)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  // Re-tap until the drawer is open — a pre-hydration tap on the hamburger is
  // swallowed (#500-class), and no single expect can both re-click and await the
  // drawer; opening is idempotent (the button only opens).
  const drawerNav = page.locator("div.fixed nav");
  await expect(async () => {
    if (!(await drawerNav.isVisible())) {
      await page.getByRole("button", { name: "Open menu" }).click();
    }
    await expect(drawerNav).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000, intervals: [300, 700, 1500] });
  await expect(drawerNav.locator("> *")).toHaveText(TOP_LEVEL_ORDER);
});

// Open the Medical group WITHOUT clicking: navigating to an always-visible child
// route (Illness episodes) force-expands the group (active-child rule), so the
// children list is asserted with zero interaction flake.
async function gotoExpandedMedical(page: Page): Promise<void> {
  await page.goto("/medical/episodes");
  await expect(
    page.locator("aside nav").getByRole("link", { name: "Illness episodes" })
  ).toBeVisible();
}

test("Cycle entry shows for a female premenopausal profile; empty Vision/Dental hide (#1042)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_NAV_FEMALE,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await gotoExpandedMedical(page);
    const nav = page.locator("aside nav");
    await expect(nav.getByRole("link", { name: "Cycle" })).toBeVisible();
    // Health record (#1042 phase 6): the eleven core index leaves collapsed into
    // ONE "Health record" leaf — so it's present and none of the folded ones are.
    await expect(
      nav.getByRole("link", { name: "Health record" })
    ).toBeVisible();
    for (const gone of ["Conditions", "Providers", "Coverage gaps", "Visits"]) {
      await expect(nav.getByRole("link", { name: gone })).toHaveCount(0);
    }
    // Data-gated specialty entries: this profile owns no vision/dental rows.
    await expect(nav.getByRole("link", { name: "Vision" })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Dental" })).toHaveCount(0);
    // The four specialty leaves are NOT folded in phase 6 (issue allows them as
    // follow-ups): Skin and Mental health stay visible with no data.
    await expect(nav.getByRole("link", { name: "Skin" })).toBeVisible();
    await expect(
      nav.getByRole("link", { name: "Mental health" })
    ).toBeVisible();
  } finally {
    await page.context().close();
  }
});

test("Cycle entry hides for a male profile with no cycle rows, but the page never hard-blocks (#1042)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_NAV_MALE,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await gotoExpandedMedical(page);
    const nav = page.locator("aside nav");
    await expect(
      nav.getByRole("link", { name: "Illness episodes" })
    ).toBeVisible();
    await expect(nav.getByRole("link", { name: "Cycle" })).toHaveCount(0);
    // The nav gate is cosmetic — a direct URL still renders the Cycle page.
    await page.goto("/medical/cycles");
    await expect(
      page.getByRole("heading", { name: "Cycle", exact: true })
    ).toBeVisible();
  } finally {
    await page.context().close();
  }
});
