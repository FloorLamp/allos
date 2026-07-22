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
// 3. The four specialty surfaces (Vision/Dental/Skin/Mental health) folded into the
//    Health record page (#1042 final tail) — none is a Medical nav leaf anymore.
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
  "Sleep",
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

test("Cycle entry shows for a female premenopausal profile; the folded Medical group is its final shape (#1042)", async ({
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
    // The #1042 target Medical group — Health record · Results · Medications ·
    // Illness episodes · Cycle · Passport — is present. (Substance use, a #998
    // surface, folded into Health record › Specialty as an adult-gated section in
    // #1175, so it is no longer a Medical nav leaf.)
    for (const present of [
      "Health record",
      "Results",
      "Medications",
      "Illness episodes",
      "Cycle",
      "Passport",
    ]) {
      await expect(nav.getByRole("link", { name: present })).toBeVisible();
    }
    // The eleven core index leaves collapsed into "Health record" …
    for (const gone of ["Conditions", "Providers", "Coverage gaps", "Visits"]) {
      await expect(nav.getByRole("link", { name: gone })).toHaveCount(0);
    }
    // … and the specialty leaves (incl. Substance use, folded into Records ›
    // Specialty in #1175) + the standalone Crisis support leaf are gone too (all
    // folded into Health record; /crisis-resources stays a route, only its nav slot
    // was removed).
    for (const gone of [
      "Vision",
      "Dental",
      "Skin",
      "Mental health",
      "Substance use",
      "Crisis support",
    ]) {
      await expect(nav.getByRole("link", { name: gone })).toHaveCount(0);
    }
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
