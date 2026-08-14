import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { followLink } from "./helpers";
import { loginAs } from "./nav";
import { showLogRow } from "./log-sheet-helpers";
import { E2E_LOGIN_CHILD, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// The phone's bottom dock and its log sheet (issue #2651).
//
// EVERY assertion here is viewport-conditional: the dock is `md:hidden`, so the
// desktop projects structurally cannot see any of it. The file therefore carries
// the `*.mobile.spec.ts` name that opts it into the `mobile` project
// (playwright.config.ts — 390×844 with `hasTouch`), and the one desktop
// assertion below resizes explicitly and says so.
//
// Read-only over the shared seed: nothing here writes, and nothing counts
// shared-seed rows, so it is repeat-safe and perturbs no neighbour (#868). The
// two offer chips ("N doses due", "Resume workout") are deliberately NOT asserted
// present — they exist only when the profile genuinely has a due dose or a live
// session, and a spec that demanded either would be asserting seed state it does
// not own. What IS asserted is the invariant that survives every seed: the sheet
// opens, its long-tail grammar works, and the dock never campaigns.

// Open a bottom-dock overlay. Both triggers are pure `setOpen(true)` client
// toggles — no Server Action, no navigation — so neither settledClick nor
// followLink applies and a tap landing in the pre-hydration window is silently
// swallowed with nothing to await. Decision-tree case 4, exactly as
// `openMobileDrawer` documents it: re-tap until the surface mounts. Safe to
// repeat because both triggers only ever set TRUE, so a late tap cannot close
// what an earlier one opened.
//
// #2729 retired ten sibling re-click loops for hydratedClick and deliberately left
// this one. The set-TRUE-only property is what that sweep was testing FOR — it is
// the same property that makes `openMobileDrawer` a blessed loop — and it holds
// here by inspection of both handlers (`setLogSheetOpen(true)`, and the More slot's
// drawer open). The loops that had to go were the ones whose control TOGGLED
// (`setOpen((v) => !v)`, a native `<details>`) or whose second request CANCELLED
// the first (`useConfirm`); a re-tap here can do neither.
async function tapUntilOpen(
  page: Page,
  trigger: Locator,
  surface: Locator
): Promise<Locator> {
  await expect(async () => {
    if (!(await surface.isVisible())) await trigger.click();
    await expect(surface).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000, intervals: [300, 700, 1500] }); // topass-ok: re-tap past the pre-hydration swallow — a pure client toggle with no POST/navigation to settle on; set-true-only, so a late tap can't re-close it
  return surface;
}

test("the dock puts four destinations one tap away and marks the current one", async ({
  page,
}) => {
  await page.goto("/");

  const dock = page.getByTestId("mobile-dock");
  await expect(dock).toBeVisible();

  // Home · Training · Trends · More — the owner's resolved set (#2651). Named
  // individually rather than counted, so a slot silently swapped for another
  // fails here.
  await expect(dock.getByTestId("dock-slot-home")).toBeVisible();
  await expect(dock.getByTestId("dock-slot-training")).toBeVisible();
  await expect(dock.getByTestId("dock-slot-trends")).toBeVisible();
  await expect(dock.getByTestId("dock-slot-more")).toBeVisible();
  await expect(dock.getByTestId("dock-log-puck")).toBeVisible();

  // On the dashboard, Home is the page being viewed.
  await expect(dock.getByTestId("dock-slot-home")).toHaveAttribute(
    "aria-current",
    "page"
  );

  // ONE tap to a destination — the whole point of the issue. The previous cost
  // was hamburger → drawer row.
  await followLink(page, dock.getByTestId("dock-slot-trends"), /\/trends/);
  await expect(dock.getByTestId("dock-slot-trends")).toHaveAttribute(
    "aria-current",
    "page"
  );
  await expect(dock.getByTestId("dock-slot-home")).not.toHaveAttribute(
    "aria-current",
    "page"
  );
});

test("a route in the long tail lights no slot, and More opens the drawer that holds it", async ({
  page,
}) => {
  // Medications has no dock slot by design — it lives behind More.
  await page.goto("/medications");
  const dock = page.getByTestId("mobile-dock");
  await expect(dock).toHaveAttribute("data-active-slot", "");
  // More is a DISCLOSURE, so it must not claim to be the current page even
  // though the current page is reached through it.
  await expect(dock.getByTestId("dock-slot-more")).not.toHaveAttribute(
    "aria-current",
    "page"
  );

  // The drawer <aside> is identified by the close (✕) button only it renders —
  // the same handle openMobileDrawer uses, so this can never resolve to the
  // hidden desktop sidebar.
  const drawer = page.locator("aside", {
    has: page.getByRole("button", { name: "Close menu" }),
  });
  await tapUntilOpen(page, dock.getByTestId("dock-slot-more"), drawer);

  // It is the SAME drawer the hamburger opens — the shared <SidebarContent>,
  // demoted to the long tail rather than removed. ^-anchored because the Data
  // entry carries the import-review badge in its accessible name (#1801).
  await expect(drawer.getByRole("link", { name: /^Data/ })).toBeVisible();
  await expect(drawer.getByTestId("signed-in-as")).toBeVisible();
  // One drawer, not two: the dock's More and the top bar's hamburger share the
  // provider's boolean, so there can never be a second copy of the whole
  // navigation in the tree.
  await expect(drawer).toHaveCount(1);
  // …and while it is open, the button that opened it says so.
  await expect(dock.getByTestId("dock-slot-more")).toHaveAttribute(
    "aria-expanded",
    "true"
  );

  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
});

test("the puck opens the log sheet, whose segmented long tail reaches every log", async ({
  page,
}) => {
  await page.goto("/");
  const sheet = page.getByTestId("quick-log-sheet");
  await tapUntilOpen(page, page.getByTestId("dock-log-puck"), sheet);

  // The dashboard promotes no log of its own, so since #2709 the opening segment
  // is the one this profile has logged on the most DAYS over the trailing
  // quarter — no longer the registry's Train fallback.
  //
  // Which segment that IS depends on the seed's ledgers, and this spec does not
  // own them, so the assertion is the one the seed's SHAPE guarantees rather than
  // a count: the shared profile logs food and doses far more often than it logs
  // workouts by hand, so Train — the old answer — cannot be the new one. The exact
  // adaptive answer is proven on owned data in
  // e2e/log-sheet-default-segment.mobile.spec.ts and in the DB tier.
  const track = sheet.getByTestId("log-sheet-segments");
  await expect(track).toBeVisible();
  await expect(
    track.getByTestId("log-sheet-segment-train")
  ).not.toHaveAttribute("aria-pressed", "true");

  // The long tail: another domain is one segment tap away, no page visit needed.
  await sheet.getByTestId("log-sheet-segment-care").click();
  await expect(sheet.getByTestId("quick-log-log-dose")).toBeVisible();
  await expect(sheet.getByTestId("quick-log-add-document")).toBeVisible();
  // Segments are mutually exclusive — another segment's rows are gone, not
  // stacked below.
  await expect(sheet.getByTestId("quick-log-log-activity")).toHaveCount(0);
  await expect(sheet.getByTestId("quick-log-log-food")).toHaveCount(0);

  // A row still opens its EXISTING form in place (#1468) rather than navigating.
  await sheet.getByTestId("quick-log-log-dose").click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId("quick-entry-sheet")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test("the sheet opens on the segment the current route is about", async ({
  page,
}) => {
  // Nutrition promotes food (lib/quick-log.ts), so the puck lands on Food with
  // no segment tap at all — the whole reason the default is derived rather than
  // fixed.
  await page.goto("/nutrition");
  const sheet = page.getByTestId("quick-log-sheet");
  await tapUntilOpen(page, page.getByTestId("dock-log-puck"), sheet);
  await expect(sheet.getByTestId("quick-log-log-food")).toBeVisible();
  await expect(sheet.getByTestId("quick-log-log-activity")).toHaveCount(0);
});

test("an age-restricted profile gets the puck, and a sheet with no Train segment", async ({
  browser,
}) => {
  // #2651's owner ruling (2026-08-13). The dock shipped with the puck hidden for a
  // restricted profile, mirroring the top bar; that was reversed. Every entry the
  // sheet offers such a profile has already been through `quickLogMenu(true)`, so
  // hiding the door removed one-tap logging without adding a gate.
  //
  // A raw context from loginAs does NOT inherit the `mobile` project's `use`
  // block, so the phone viewport is restated or this silently runs at desktop
  // width where the dock does not render at all.
  const child = await loginAs(
    browser,
    { username: E2E_LOGIN_CHILD, password: E2E_MEMBER_PASSWORD },
    { viewport: { width: 390, height: 844 }, hasTouch: true }
  );
  try {
    await child.goto("/");
    const dock = child.getByTestId("mobile-dock");
    await expect(dock).toBeVisible();
    await expect(dock.getByTestId("dock-log-puck")).toBeVisible();
    // The slot substitution is unchanged: Timeline stands in for Training.
    await expect(dock.getByTestId("dock-slot-timeline")).toBeVisible();
    await expect(dock.getByTestId("dock-slot-training")).toHaveCount(0);

    const sheet = child.getByTestId("quick-log-sheet");
    await tapUntilOpen(child, child.getByTestId("dock-log-puck"), sheet);

    // What the ruling did NOT change: the activity entry is still gated away, so
    // the track carries no Train segment at all rather than an empty one.
    const track = sheet.getByTestId("log-sheet-segments");
    await expect(track).toBeVisible();
    await expect(track.getByTestId("log-sheet-segment-train")).toHaveCount(0);
    await expect(sheet.getByTestId("quick-log-log-activity")).toHaveCount(0);

    // And what it reinstates: a log this profile may make, one tap from the puck.
    const row = await showLogRow(sheet, "log-food");
    await expect(row).toBeVisible();
    await row.click();
    await expect(child.getByTestId("quick-entry-sheet")).toBeVisible();
  } finally {
    await child.close();
  }
});

test("the dock never campaigns, and never renders above `md`", async ({
  page,
}) => {
  await page.goto("/");
  const dock = page.getByTestId("mobile-dock");
  await expect(dock).toBeVisible();

  // No badge, no count, no dot — the dock is on screen for every second of every
  // page, so anything it displayed would be displayed forever (#2651: the
  // findings reach policy is unchanged by this chrome). Its entire text is the
  // four captions.
  await expect(dock).not.toHaveText(/\d/);

  // Explicitly a DESKTOP-width assertion inside the mobile project: at `md` and
  // up the sidebar is the navigation and the dock must be gone entirely, not
  // merely off-screen.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(dock).toBeHidden();
});
