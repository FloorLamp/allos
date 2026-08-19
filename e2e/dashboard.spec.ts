import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { E2E_LOGIN_DAILY, E2E_MEMBER_PASSWORD } from "./fixture-logins";

test("the atomic dashboard uses one reading order and no editor", async ({
  page,
}) => {
  await page.goto("/");
  const main = page.getByRole("main");

  await expect(main.getByTestId("now-strip")).toBeVisible();
  await expect(main.getByTestId("dashboard-standing")).toBeVisible();
  await expect(main.getByTestId("dashboard-everything")).toBeVisible();
  await expect(main.getByTestId("dashboard-standing")).toHaveClass(
    /grid-cols-1/
  );
  await expect(
    main.getByRole("button", { name: "Edit dashboard" })
  ).toHaveCount(0);
  await expect(main.getByText("Customize", { exact: true })).toHaveCount(0);
});

test("attention facts render as separate atoms", async ({ page }) => {
  await page.goto("/");
  const facts = page.locator(
    '[data-testid="dashboard-candidate"][data-candidate-id^="attention.fact:"]'
  );
  const count = await facts.count();

  expect(count).toBeGreaterThan(1);
  await expect(facts.nth(0)).toBeVisible();
  for (let index = 0; index < Math.min(count, 5); index += 1) {
    await expect(
      facts.nth(index).getByTestId("dashboard-attention-atom")
    ).toHaveCount(1);
  }
});

test("lab readings render individually", async ({ page }) => {
  await page.goto("/");
  const main = page.getByRole("main");
  const rows = main.getByTestId("recent-lab-row");
  const headings = main.getByText("Recent labs", { exact: true });

  expect(await rows.count()).toBeGreaterThan(1);
  await expect(headings).toHaveCount(await rows.count());
});

test("household access renders one fact per other profile", async ({
  page,
}) => {
  await page.goto("/");
  const facts = page.locator(
    '[data-testid="dashboard-candidate"][data-candidate-id^="household.attention:"]'
  );
  expect(await facts.count()).toBeGreaterThan(0);
  const ids = await facts.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-candidate-id"))
  );
  expect(new Set(ids).size).toBe(ids.length);
});

test("manual and external readings receive different placement", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DAILY,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/");
    const manual = page.locator(
      '[data-testid="dashboard-candidate"][data-candidate-id^="weight.latest:"]'
    );
    const external = page.locator(
      '[data-testid="dashboard-candidate"][data-candidate-id^="activity.steps:"]'
    );

    await expect(manual).toHaveAttribute("data-engagement", "manual");
    await expect(manual).toHaveAttribute("data-lane", "standing");
    await expect(external).toHaveAttribute("data-engagement", "external");
    await expect(external).toHaveAttribute("data-lane", "everything");
  } finally {
    await page.context().close();
  }
});

test("every applicable fact appears in exactly one atomic lane", async ({
  page,
}) => {
  await page.goto("/");
  const candidates = page.getByRole("main").getByTestId("dashboard-candidate");
  const factKeys = await candidates.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-fact-key"))
  );
  expect(factKeys.every(Boolean)).toBe(true);
  expect(new Set(factKeys).size).toBe(factKeys.length);
});
