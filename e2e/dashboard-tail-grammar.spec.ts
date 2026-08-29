import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { openDashboardAll } from "./helpers";
import { E2E_LOGIN_ROUTINEUSUAL, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// THE SHOW-EVERYTHING TAIL HAS ONE GRAMMAR (#3365).
//
// Cards act, lines report (#3077). In the browser that is three claims: the reporting
// groups render rows and not cards, same-origin atoms fold into ONE block with ONE
// header, and no card in the lane is headerless or repeats another card's title.
//
// EVERY ABSENCE ASSERTION BELOW CARRIES ITS POSITIVE CONTROL IN THE SAME TEST — a
// selector that cannot find the group would satisfy "no cards in here" on a tree
// where the tail vanished entirely, which is the failure this file exists to catch.
test.describe("the Show-everything tail's grammar (#3365)", () => {
  test("Read and Setup report as rows, and the recap folds into one block", async ({
    page,
  }) => {
    await page.goto("/");
    await openDashboardAll(page);

    for (const group of ["read", "setup"] as const) {
      const section = page.getByTestId(`dashboard-everything-${group}`);
      await expect(section).toHaveCount(1);
      // The control: the group is populated, so the card sweep below is looking at
      // something.
      const rows = section.getByTestId("dashboard-candidate");
      expect(await rows.count(), `${group} renders entries`).toBeGreaterThan(0);
      // …and every one of them is a row, not a card.
      await expect(section.locator(".card")).toHaveCount(0);
    }

    // The six shipped recap atoms are ONE block under ONE header.
    const recap = page.locator('[data-moment-key^="recap:"]');
    await expect(recap).toHaveCount(1);
    await expect(recap.locator("h4")).toHaveCount(1);
    expect(
      await recap.getByTestId("dashboard-candidate").count()
    ).toBeGreaterThan(1);
  });

  test("no two tail blocks share a moment header", async ({ page }) => {
    await page.goto("/");
    await openDashboardAll(page);
    const lane = page.getByTestId("dashboard-all-contents");

    // Every moment block states its moment once, and no two state the same one —
    // the six identical "Weekly recap" headers were the defect (#3365).
    const headers = await lane.locator("[data-moment-key] h4").allInnerTexts();
    // The control: there ARE headed blocks, so the uniqueness claim below is about a
    // populated set and not an empty one.
    expect(headers.length).toBeGreaterThan(0);
    expect([...new Set(headers)].length).toBe(headers.length);
  });

  // READ-ONLY on the composed-morning fixture: it looks at the offer and never taps
  // it, so e2e/routine-usual.spec.ts still finds its rows where it left them.
  test("the usual-routine card is titled by what it does, not by the readout's name", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_ROUTINEUSUAL,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/");
      await openDashboardAll(page);
      const card = page.getByTestId("usual-routine-atom");
      // The control: the offer is on screen, so the title claims below are about a
      // card that rendered.
      await expect(card).toBeVisible();
      await expect(card.locator("h3")).toHaveText(/^Your usual /);
      // "Nutrition today" headed BOTH this offer and the Read protein readout, so the
      // same words scrolled past twice meaning two different things (#3365). One
      // surface owns the name now, and it is never this one.
      await expect(card).not.toContainText("Nutrition today");
      await expect(
        page
          .getByTestId("dashboard-all-contents")
          .getByText("Nutrition today", { exact: true })
      ).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });
});
