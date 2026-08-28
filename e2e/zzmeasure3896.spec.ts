import { test } from "./fixtures";
import { loginAs } from "./nav";
import { E2E_LOGIN_DAILY, E2E_MEMBER_PASSWORD } from "./fixture-logins";

test("measure standing rows", async ({ browser }) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DAILY,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/");
    const rows = await page
      .getByTestId("dashboard-standing")
      .locator("[data-standing-family]")
      .evaluateAll((nodes) =>
        nodes.map((n) => {
          const box = (el: Element | null | undefined) => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return {
              t: Math.round(r.top),
              h: Math.round(r.height),
              l: Math.round(r.left),
              w: Math.round(r.width),
            };
          };
          return {
            key: n.getAttribute("data-standing-family"),
            trend: n.hasAttribute("data-standing-trend"),
            row: box(n),
            dd: box(n.querySelector("dd")),
            spark: box(n.querySelector("[data-testid='standing-sparkline']")),
            sum: box(
              n.querySelector(
                "[data-testid='standing-sparkline-details'] summary"
              )
            ),
          };
        })
      );
    console.log("MEASURED " + JSON.stringify(rows));
  } finally {
    await page.context().close();
  }
});
