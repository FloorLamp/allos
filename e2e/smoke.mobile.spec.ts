import { test, expect } from "@playwright/test";
import { followLink, openMobileDrawer } from "./helpers";

// The `mobile` project's own smoke (issue #1420) — and the reference spec for the
// `*.mobile.spec.ts` naming convention that opts a file INTO that project
// (playwright.config.ts). It asserts the phone shell itself, which the desktop
// projects structurally cannot see: MobileNav's sticky top bar exists, the
// hamburger mounts the slide-in drawer, the drawer carries the SAME navigation as
// the desktop sidebar (both render <SidebarContent>), and a drawer link navigates.
//
// Deliberately read-only over the shared seed — no writes, no counts of
// shared-seed rows, so it is repeat-safe and perturbs no neighbor (#868).
// Everything here is a viewport-conditional surface, so it is exactly the
// regression class the desktop suite misses: hiding the hamburger (or letting the
// drawer drift from the shared sidebar content) fails this spec and nothing else.

test("the mobile top bar renders and the desktop sidebar is hidden", async ({
  page,
}) => {
  await page.goto("/");

  // MobileNav's bar (md:hidden) — hamburger + the quick "log activity" entry.
  // Scoped to the bar itself (the <header> holding the hamburger) so the dashboard's
  // own "Log activity →" card button can't satisfy either assertion.
  const bar = page.locator("header", {
    has: page.getByRole("button", { name: "Open menu" }),
  });
  await expect(bar.getByRole("button", { name: "Open menu" })).toBeVisible();
  await expect(
    bar.getByRole("button", { name: "Log activity", exact: true })
  ).toBeVisible();

  // The desktop sidebar's nav links exist only inside the (unmounted) drawer at
  // this width, so nothing sidebar-ish is on screen before it is opened.
  await expect(
    page.getByRole("link", { name: "Data", exact: true })
  ).toHaveCount(0);
});

test("the hamburger opens the drawer with the shared sidebar navigation", async ({
  page,
}) => {
  await page.goto("/");
  const drawer = await openMobileDrawer(page);

  // The drawer renders the SHARED <SidebarContent>, so the desktop nav entries
  // and the profile switcher are all reachable on a phone (the responsive-surface
  // rule in AGENTS.md — hand-mirrored branches are how the drawer once lost the
  // profile menu).
  await expect(
    drawer.getByRole("link", { name: "Data", exact: true })
  ).toBeVisible();
  await expect(drawer.getByTestId("user-menu-trigger")).toBeVisible();

  // Escape closes it (MobileNav's keydown handler).
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
});

test("a drawer nav link navigates and closes the drawer", async ({ page }) => {
  await page.goto("/");
  const drawer = await openMobileDrawer(page);

  await followLink(
    page,
    drawer.getByRole("link", { name: "Timeline", exact: true }),
    /\/timeline/
  );
  // Navigation closes the drawer (MobileNav's pathname effect), leaving the bar.
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
});
