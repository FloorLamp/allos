import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { E2E_LOGIN_DAILY, E2E_MEMBER_PASSWORD } from "./fixture-logins";

test("the dashboard renders one fixed instrument cluster and no editor", async ({
  page,
}) => {
  await page.goto("/");
  const main = page.getByRole("main");

  await expect(main.getByTestId("now-strip")).toBeVisible();
  await expect(main.getByTestId("dashboard-standing")).toBeVisible();
  await expect(main.getByTestId("dashboard-everything")).toBeVisible();
  const standing = main.getByTestId("dashboard-standing");
  expect(
    await standing
      .locator("[data-standing-section]")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-standing-section"))
      )
  ).toEqual(["today", "body", "longer-view"]);
  await expect(
    standing.locator('[data-standing-section="today"]')
  ).toBeVisible();
  await expect(
    standing.locator('[data-standing-section="body"]')
  ).toBeVisible();
  await expect(
    standing.locator('[data-standing-section="longer-view"]')
  ).toBeVisible();
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

test("clinical results render as dense individual facts", async ({ page }) => {
  await page.goto("/");
  const main = page.getByRole("main");
  const family = main.locator('[data-standing-family="clinical-results"]');
  const rows = family.locator(
    '[data-testid="dashboard-candidate"][data-candidate-id^="labs.latest:"]'
  );

  expect(await rows.count()).toBeGreaterThan(1);
  await expect(
    family.getByText("Recent clinical results", { exact: true })
  ).toBeVisible();
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

test("manual and external readings are both eligible for Standing", async ({
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
    await expect(external).toHaveAttribute("data-lane", "standing");
  } finally {
    await page.context().close();
  }
});

test("mobile and desktop expose the same Standing fact order", async ({
  page,
}) => {
  await page.goto("/");
  const facts = page
    .getByTestId("dashboard-standing")
    .getByTestId("dashboard-candidate");
  const desktop = await facts.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-fact-key"))
  );
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await facts.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-fact-key"))
  );
  expect(mobile).toEqual(desktop);
});

test("one nap produces one Standing total and leaves individual naps outside", async ({
  page,
}) => {
  await page.goto("/");
  const total = page.locator(
    '[data-testid="dashboard-candidate"][data-candidate-id^="sleep.nap-total:"]'
  );
  const naps = page.locator(
    '[data-testid="dashboard-candidate"][data-candidate-id^="sleep.nap:"]'
  );
  await expect(total).toHaveAttribute("data-lane", "standing");
  await expect(total).toContainText("1 nap");
  const napCount = await naps.count();
  expect(napCount).toBeGreaterThan(0);
  for (let index = 0; index < napCount; index += 1) {
    await expect(naps.nth(index)).not.toHaveAttribute("data-lane", "standing");
  }
});

test("the clinical family cap leaves its tail in Everything", async ({
  page,
}) => {
  await page.goto("/");
  const labs = page.locator(
    '[data-testid="dashboard-candidate"][data-candidate-id^="labs.latest:"]'
  );
  const standingCount = await labs.evaluateAll(
    (nodes) =>
      nodes.filter((node) => node.getAttribute("data-lane") === "standing")
        .length
  );
  const tailCount = await labs.evaluateAll(
    (nodes) =>
      nodes.filter((node) => node.getAttribute("data-lane") === "everything")
        .length
  );
  expect(standingCount).toBe(6);
  expect(tailCount).toBeGreaterThan(0);
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
