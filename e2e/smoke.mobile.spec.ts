import { test, expect } from "./fixtures";
import { followLink, openMobileDrawer } from "./helpers";

// The `mobile` project's own smoke (issue #1420) — and the reference spec for the
// `*.mobile.spec.ts` naming convention that opts a file INTO that project
// (playwright.config.ts). It asserts the phone shell itself, which the desktop
// projects structurally cannot see: the dock is the ONLY chrome, dock More mounts
// the slide-in drawer, the drawer carries the SAME navigation as the desktop
// sidebar (both render <SidebarContent>), and a drawer link navigates.
//
// Deliberately read-only over the shared seed — no writes, no counts of
// shared-seed rows, so it is repeat-safe and perturbs no neighbor (#868).
// Everything here is a viewport-conditional surface, so it is exactly the
// regression class the desktop suite misses: hiding More (or letting the
// drawer drift from the shared sidebar content) fails this spec and nothing else.

test("the dock is the phone's ONE chrome, and the desktop sidebar is hidden", async ({
  page,
}) => {
  await page.goto("/");

  // THE TOP BAR IS GONE (#2746's deferred question, answered by #4102). What used
  // to be a second permanently-visible strip — an identity bar and a magnifier —
  // folded into the dock: Search is a slot, identity moved to the drawer's top.
  // Named in the ABSENCE because that is the deletion: a bar that survived would
  // pass any assertion about the dock.
  await expect(page.getByTestId("search-mobile")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open menu" })).toHaveCount(0);
  await expect(page.getByTestId("quick-log-primary")).toHaveCount(0);
  await expect(page.getByTestId("profile-identity-bar-mobile")).toHaveCount(0);

  // …and the converse, in the same test, because an absence sweep passes just as
  // happily on a shell that lost its navigation altogether. The dock carries all
  // four slots plus the puck, Search among them.
  await expect(page.getByTestId("dock-slot-search")).toBeVisible();
  await expect(page.getByTestId("dock-slot-more")).toBeVisible();
  await expect(page.getByTestId("dock-log-puck")).toBeVisible();

  // CONTENT STARTS AT THE TOP. The ruling's own words — "the first page pixel is
  // at the viewport top on non-tab pages" — and the dashboard registers no
  // tab-first strip, so the shell's sticky chrome must contribute no height at
  // all. Measured as a RELATIONSHIP between the shell's box and the viewport's
  // top edge, not against a pixel constant.
  const chrome = page.getByTestId("shell-chrome");
  const chromeBox = await chrome.boundingBox();
  expect(
    chromeBox?.height ?? 0,
    "the shell's top chrome has no height on a page that registers no strip"
  ).toBe(0);

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
  // "Signed in as <username>" + Log out live at the drawer's bottom since #1801.
  // The PROFILE switcher came BACK to the drawer in #4102 — it had left for the
  // top bar, and the top bar has retired — so the drawer now carries exactly one
  // identity bar at its top. Exactly one, because "the sidebar remains the one
  // profile switcher" is the rule this move had to keep.
  await expect(drawer.getByTestId("signed-in-as")).toBeVisible();
  await expect(drawer.getByTestId("profile-identity-bar")).toHaveCount(1);

  // Escape closes it. The listener is the SHARED `useFocusTrap`'s since #3463 —
  // capture phase, and it yields to any nearer `[role="dialog"]` first — not
  // MobileNav's own `document` keydown handler, which is gone.
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
});

test("a drawer nav link navigates and closes the drawer", async ({ page }) => {
  await page.goto("/");
  const drawer = await openMobileDrawer(page);

  // A top-level row: #4965 moved Trends into the collapsed "Plan & review"
  // group, and "a drawer nav link navigates and closes the drawer" is a claim
  // about the drawer. The grouped children get their own drawer coverage in
  // e2e/nav-consolidation.spec.ts.
  await followLink(
    page,
    drawer.getByRole("link", { name: "History", exact: true }),
    /\/history/
  );
  // Navigation closes the drawer, leaving the dock's More route available.
  await expect(drawer).toHaveCount(0);
  await expect(page.getByTestId("dock-slot-more")).toBeVisible();
});
