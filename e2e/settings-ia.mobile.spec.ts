import { test, expect } from "./fixtures";
import { followLink } from "./helpers";

// The phone half of the Settings IA (#1462 §5, #1451.C). Runs in the `mobile`
// project (390×844, opted in by the `.mobile.spec.ts` filename).
//
// The bug this pins closed: Settings' second level used to be a horizontal TAB
// strip, and at 390px the admin entries (Server, AI logs, Errors, Audit) scrolled
// off the right edge with NO affordance that more tabs existed — an admin on a
// phone simply could not find them. #1462 didn't add a scroll hint; it removed the
// strip. The /settings INDEX now renders on every viewport, so every group is a
// full-width tappable row, and the desktop-only group nav deliberately carries
// nothing the index doesn't.
test.describe("Settings IA on a phone (#1462 / #1451.C)", () => {
  test("the index lists every group, admin groups included, with no clipped strip", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/settings");
    const index = page.getByTestId("settings-index");
    await expect(index).toBeVisible();

    // The old clipped tab strip is gone entirely.
    await expect(page.getByTestId("settings-group-nav")).toBeHidden();

    // Every admin group is a visible row inside the viewport — the thing that was
    // impossible before. `toBeVisible` alone isn't enough (an element scrolled off a
    // horizontally-clipped strip can still report visible), so assert each row's box
    // sits inside the 390px width.
    const width = page.viewportSize()?.width ?? 390;
    for (const id of ["people", "server", "logs"]) {
      const row = page.getByTestId(`settings-group-${id}`);
      await expect(row).toBeVisible();
      const box = await row.boundingBox();
      expect(box, `no box for settings-group-${id}`).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    }
  });

  test("index → group → back works with the breadcrumb (the phone's nav story)", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/settings");
    await followLink(
      page,
      page.getByTestId("settings-group-account"),
      /\/settings\/account$/
    );
    await expect(
      page.getByRole("heading", { name: "Account & security" })
    ).toBeVisible();
    // The desktop group nav must NOT render here — on a phone the index is the nav.
    await expect(page.getByTestId("settings-group-nav")).toBeHidden();

    await followLink(
      page,
      page.getByTestId("settings-breadcrumb"),
      /\/settings$/
    );
    await expect(page.getByTestId("settings-index")).toBeVisible();
  });

  test("a group with sub-pages exposes them on a phone too", async ({
    page,
  }) => {
    test.slow();
    // Logs & audit is the one group with sub-pages. They render in a strip INSIDE the
    // page (not in the desktop-only group nav), precisely so a phone can reach Errors
    // and Audit at all.
    await page.goto("/settings/logs");
    const subnav = page.getByTestId("settings-subpage-nav");
    await expect(subnav).toBeVisible();
    await followLink(
      page,
      subnav.getByRole("link", { name: "Audit" }),
      /\/settings\/audit$/
    );
    await expect(
      page.getByRole("heading", { name: "Logs & audit" })
    ).toBeVisible();
  });
});
