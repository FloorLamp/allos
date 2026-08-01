import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
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
//
// UNCHANGED by #1522 on purpose: the medicine-cabinet row this repo just deleted was
// a child of the Medical GROUP, not a top-level entry, so it never appeared in this
// list. The list that DID change is the Medical group's children, asserted below —
// "Medicine cabinet" moved from present to gone there.
const TOP_LEVEL_ORDER: (string | RegExp)[] = [
  "Dashboard",
  "Training",
  "Nutrition",
  "Timeline",
  "Trends",
  "Sleep",
  "Upcoming",
  "Household",
  "Wellness",
  "Longevity",
  "Medical",
  // The Data entry carries the import-review badge since #1801 (it is Data →
  // Review's count), so its text is "Data" plus a digit whenever the seeded
  // always-failing Strava integration is in a failed state. A prefix match keeps
  // the ORDER assertion about order rather than about that count.
  /^Data/,
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
  }).toPass({ timeout: 20_000, intervals: [300, 700, 1500] }); // topass-ok: re-tap the hamburger until the drawer opens past the pre-hydration swallow (#500) — opening is idempotent, no single re-click+await event
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

// ── Physical registries are reached from their consumers (#1522) ─────────────
// The shared ADMIN session is the fixture that matters here: it reaches 2+ profiles,
// which is the exact condition the old `requiresMultiProfile` "Medicine cabinet" row
// appeared under. Asserting its absence on a single-profile login would pass
// vacuously. Read-only — these cases only navigate and inspect the sidebar.

test("the medicine cabinet has no nav row, even for a multi-profile session (#1522)", async ({
  page,
}) => {
  await gotoExpandedMedical(page);
  const nav = page.locator("aside nav");
  // The group is expanded (Illness episodes proves it), so a surviving row WOULD be
  // visible — the absence below is a real observation, not a collapsed group.
  await expect(
    nav.getByRole("link", { name: "Illness episodes" })
  ).toBeVisible();
  await expect(nav.getByRole("link", { name: "Medications" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Medicine cabinet" })).toHaveCount(
    0
  );
});

test("a registry route reached from its consumers highlights its PARENT entry (#1522)", async ({
  page,
}) => {
  const nav = page.locator("aside nav");

  // The cabinet: no row of its own, so it lights Medications — and the Medical group
  // force-expands around it, which is what puts the lit entry on screen at all.
  await page.goto("/supplies");
  await expect(page.getByTestId("supplies-page")).toBeVisible();
  await expect(nav.getByRole("link", { name: "Medications" })).toHaveAttribute(
    "aria-current",
    "page"
  );
  // Exactly ONE entry claims the page — the child never lights itself, and the plain
  // prefix rule drags nothing else along.
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);

  // The equipment registry, whose pattern this follows, had the same orphan wart.
  await page.goto("/equipment");
  await expect(nav.getByRole("link", { name: "Training" })).toHaveAttribute(
    "aria-current",
    "page"
  );
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);

  // Sanity: an ordinary route still highlights itself, so the map didn't swallow
  // the normal rule.
  await page.goto("/timeline");
  await expect(nav.getByRole("link", { name: "Timeline" })).toHaveAttribute(
    "aria-current",
    "page"
  );
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
