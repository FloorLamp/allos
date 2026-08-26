import { test, expect } from "./fixtures";
import { followLink, openMobileDrawer } from "./helpers";

// The `mobile` project's own smoke (issue #1420) — and the reference spec for the
// `*.mobile.spec.ts` naming convention that opts a file INTO that project
// (playwright.config.ts). It asserts the phone shell itself, which the desktop
// projects structurally cannot see: MobileNav's sticky top bar exists, dock More
// mounts the slide-in drawer, the drawer carries the SAME navigation as
// the desktop sidebar (both render <SidebarContent>), and a drawer link navigates.
//
// Deliberately read-only over the shared seed — no writes, no counts of
// shared-seed rows, so it is repeat-safe and perturbs no neighbor (#868).
// Everything here is a viewport-conditional surface, so it is exactly the
// regression class the desktop suite misses: hiding More (or letting the
// drawer drift from the shared sidebar content) fails this spec and nothing else.

test("the mobile top bar renders and the desktop sidebar is hidden", async ({
  page,
}) => {
  await page.goto("/");

  // MobileNav's bar (md:hidden) is identity + Search only after #2745/#2746.
  const bar = page.locator("header", {
    has: page.getByTestId("search-mobile"),
  });
  await expect(bar.getByTestId("search-mobile")).toBeVisible();
  await expect(bar.getByRole("button", { name: "Open menu" })).toHaveCount(0);
  await expect(page.getByTestId("quick-log-primary")).toHaveCount(0);
  await expect(page.getByTestId("dock-slot-more")).toBeVisible();
  await expect(page.getByTestId("dock-log-puck")).toBeVisible();

  // The desktop sidebar's nav links exist only inside the (unmounted) drawer at
  // this width, so nothing sidebar-ish is on screen before it is opened.
  await expect(page.getByRole("link", { name: /^Data/ })).toHaveCount(0);
});

test("dock More opens the drawer with the shared sidebar navigation", async ({
  page,
}) => {
  await page.goto("/");
  const drawer = await openMobileDrawer(page);

  // The drawer renders the SHARED <SidebarContent>, so the desktop nav entries
  // and the login controls are all reachable on a phone (the responsive-surface
  // rule in AGENTS.md — hand-mirrored branches are how the drawer once lost the
  // profile menu).
  // ^-anchored, not exact: the Data entry carries the import-review badge since
  // #1801, so its accessible name is "Data <n>" whenever one needs attention.
  await expect(drawer.getByRole("link", { name: /^Data/ })).toBeVisible();
  // "Signed in as <username>" + Log out live at the drawer's bottom since #1801;
  // the PROFILE switcher left the drawer for the top bar (asserted in
  // shell.mobile.spec.ts), so the drawer must NOT carry a second copy of it.
  await expect(drawer.getByTestId("signed-in-as")).toBeVisible();
  await expect(drawer.getByTestId("profile-identity-bar")).toHaveCount(0);

  // Escape closes it. The listener is the SHARED `useFocusTrap`'s since #3463 —
  // capture phase, and it yields to any nearer `[role="dialog"]` first — not
  // MobileNav's own `document` keydown handler, which is gone.
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
});

test("a drawer nav link navigates and closes the drawer", async ({ page }) => {
  await page.goto("/");
  const drawer = await openMobileDrawer(page);

  // A top-level row: #3079 moved Timeline into the collapsed "Plan & review"
  // group, and "a drawer nav link navigates and closes the drawer" is a claim
  // about the drawer. The grouped children get their own drawer coverage in
  // e2e/nav-consolidation.spec.ts.
  await followLink(
    page,
    drawer.getByRole("link", { name: "Trends", exact: true }),
    /\/trends/
  );
  // Navigation closes the drawer, leaving the dock's More route available.
  await expect(drawer).toHaveCount(0);
  await expect(page.getByTestId("dock-slot-more")).toBeVisible();
});
