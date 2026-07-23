import { test, expect } from "@playwright/test";
import { followLink } from "./helpers";
import { DISCLAIMER_SECTIONS } from "../lib/disclaimers";
import { CRISIS_LEAD_LINE } from "../lib/crisis-resources";

// The consolidated Disclaimer surface (issue #1049). The ~40 inline "informational,
// not medical advice" banners collapsed to ONE page (/disclaimer), reachable from a
// persistent footer link in the shared sidebar (both viewports). This spec is
// read-only against the shared authenticated fixture — it navigates and asserts, it
// mutates no rows, so it can't pollute neighbors.
test.describe("consolidated disclaimer surface (issue #1049)", () => {
  test("the persistent footer link resolves to /disclaimer on desktop and renders the full text", async ({
    page,
  }) => {
    await page.goto("/");
    // Exactly one Disclaimer link is in the accessibility tree per viewport: the
    // desktop sidebar's (the mobile drawer isn't mounted while closed, and the
    // hidden md:* / md:hidden branches are display:none, so out of the a11y tree).
    const footerLink = page.getByRole("link", { name: "Disclaimer" });
    await followLink(page, footerLink, /\/disclaimer$/);

    await expect(
      page.getByRole("heading", { name: "Disclaimer" })
    ).toBeVisible();
    const full = page.getByTestId("disclaimer-full");
    // A phrase from every canonical section renders (the single authoritative read).
    for (const section of DISCLAIMER_SECTIONS) {
      await expect(full).toContainText(section.title);
    }
    await expect(full).toContainText(/not medical advice/i);
    await expect(full).toContainText(/curated/i);
    await expect(full).toContainText(/emergency number/i);
  });

  test("the footer link is reachable from the mobile drawer too (responsive-surfaces rule)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    // Opening the drawer is a client-only state toggle (no Server-Action POST, no
    // navigation), so it can't go through settledClick/followLink and the button's
    // onClick isn't wired until hydration. Retry the open until the drawer's
    // Disclaimer link mounts — toPass is the sanctioned last resort for a
    // hydration-timed interaction with no POST to await.
    const drawerLink = page.getByRole("link", { name: "Disclaimer" });
    await expect(async () => {
      await page.getByRole("button", { name: "Open menu" }).click();
      await expect(drawerLink).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15000, intervals: [300, 700, 1500] }); // topass-ok: opening the mobile drawer is a client-only toggle with no POST/nav to await; retry past the pre-hydration swallow
    // The footer link renders in the drawer (the mobile surface) and points at the
    // canonical route. Assert its target and load it directly — navigating through
    // the drawer overlay is a timing race with no bearing on what this test proves.
    await expect(drawerLink).toHaveAttribute("href", "/disclaimer");
    await page.goto("/disclaimer");
    await expect(
      page.getByRole("heading", { name: "Disclaimer" })
    ).toBeVisible();
  });

  test("the crisis-resources safety line stays inline and non-dismissible (the #716 carve-out)", async ({
    page,
  }) => {
    // The crisis line is a safety contract, NOT passive legal copy — it was NOT swept
    // to /disclaimer. The always-available surface renders the crisis resources inline,
    // with no dismiss control. The generic "not medical advice" disclaimer was removed
    // from this surface (it lives on /disclaimer now) — the crisis RESOURCES stay.
    await page.goto("/crisis-resources");
    const panel = page.getByTestId("crisis-resources");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(CRISIS_LEAD_LINE);
    await expect(panel).not.toContainText(/not medical advice/i);
    // Non-dismissible: no dismiss/hide affordance on the crisis surface.
    await expect(
      panel.getByRole("button", { name: /dismiss|hide|snooze/i })
    ).toHaveCount(0);
  });
});
