import { test, expect } from "./fixtures";

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
  const facts = page.getByRole("main").getByTestId("needs-attention");
  const count = await facts.count();

  expect(count).toBeGreaterThan(1);
  await expect(facts.nth(0)).toBeVisible();
  for (let index = 0; index < Math.min(count, 5); index += 1) {
    await expect(
      facts
        .nth(index)
        .locator(
          "div[data-testid^='attention-item-']:not([data-testid='attention-item-detail']):not([data-testid='attention-item-actions'])"
        )
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
  const main = page.getByRole("main");

  const heading = main.getByRole("heading", {
    name: "Riley (child)",
    exact: true,
  });
  await expect(heading).toBeVisible();
  await expect(
    main.locator("article").filter({ has: heading }).getByRole("link", {
      name: "View",
    })
  ).toBeVisible();
});
