import { test, expect } from "./fixtures";
import { followLink } from "./helpers";

// Issue #105: Trends renders only its active tab server-side. #3512 retires the
// Fitness tab into Training → Analyze, leaving Overview · Nutrition · Insights.
const INSIGHTS_MARKER = "Date to analyze";

test("direct navigation renders only the requested Trends section (#105/#3512)", async ({
  page,
}) => {
  await page.goto("/trends");
  await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.getByText(INSIGHTS_MARKER)).toHaveCount(0);
  await expect(page.getByTestId("trends-fitness")).toHaveCount(0);
  await expect(page.getByTestId("trend-mini-card").first()).toBeVisible(); // first-ok: proves the overview census mounted

  await page.goto("/trends?tab=insights");
  await expect(page.getByRole("tab", { name: "Insights" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.getByText(INSIGHTS_MARKER)).toBeVisible();
  await expect(page.getByTestId("trends-fitness")).toHaveCount(0);

  await page.goto("/trends?tab=nutrition");
  await expect(page.getByRole("tab", { name: "Nutrition" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.getByText(INSIGHTS_MARKER)).toHaveCount(0);
});

test("the Trends strip contains only Overview, Nutrition, and Insights (#3512)", async ({
  page,
}) => {
  await page.goto("/trends");
  const tabs = page.getByTestId("trends-tabs").getByRole("tab");
  await expect(tabs).toHaveText(["Overview", "Nutrition", "Insights"]);
  for (const gone of ["Biomarkers", "Body", "Fitness", "Compare"]) {
    await expect(
      page.getByRole("tab", { name: gone, exact: true })
    ).toHaveCount(0);
  }
});

test("body/vitals still fall back to the Overview census", async ({ page }) => {
  for (const stale of ["biomarkers", "body", "vitals"]) {
    await page.goto(`/trends?tab=${stale}`);
    await expect(page).toHaveURL(new RegExp(`\\/trends\\?tab=${stale}$`));
    await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(page.getByTestId("trends-section-body")).toBeVisible();
  }
});

test("clicking a live tab switches which section renders (#105)", async ({
  page,
}) => {
  await page.goto("/trends");
  const insights = page.getByRole("tab", { name: "Insights" });
  await expect(insights).toHaveJSProperty("tagName", "A");
  await expect(insights).toHaveAttribute("href", /tab=insights/);
  await followLink(page, insights, /tab=insights/);
  await expect(page.getByText(INSIGHTS_MARKER)).toBeVisible();

  await followLink(
    page,
    page.getByRole("tab", { name: "Nutrition" }),
    /tab=nutrition/
  );
  await expect(page.getByText(INSIGHTS_MARKER)).toHaveCount(0);
});
