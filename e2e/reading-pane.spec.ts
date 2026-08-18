import { test, expect } from "./fixtures";
import { followLink } from "./helpers";

// The Training Log is the activity index. Every row reaches the canonical
// activity page at every viewport; records no longer expand into a second
// desktop pane or a phone-only inline presentation.

test("activity rows open the canonical activity page", async ({ page }) => {
  await page.goto("/training?tab=log");
  const row = page
    .getByTestId("training-log-row")
    .filter({ hasText: "Push day" })
    .first(); // first-ok: newest seeded Push day; its strength parts prove the compact index reuses activity detail
  await expect(row).toBeVisible();
  await expect(row.getByTestId("activity-parts")).toBeVisible();
  await expect(row.getByTestId("training-log-strength-row")).not.toHaveCount(0);
  const id = (await row.getAttribute("id"))!.replace("activity-", "");
  await expect(row).toHaveAttribute("href", `/training/activity/${id}`);

  await followLink(page, row, new RegExp(`/training/activity/${id}$`));
  await expect(page.getByTestId("training-activity-page")).toBeVisible();
  await expect(page.getByTestId("activity-record-body")).toBeVisible();
  await expect(page.getByTestId("training-log-reading-pane")).toHaveCount(0);
});

test("an #activity-N deep link scrolls to the canonical row", async ({
  page,
}) => {
  await page.goto("/training?tab=log");
  const rows = page.getByTestId("training-log-row");
  await expect(rows.first()).toBeVisible(); // first-ok: presence gate before reading ids
  const targetId = (await rows.nth(1).getAttribute("id"))!.replace(
    "activity-",
    ""
  );

  await page.goto("about:blank");
  await page.goto(`/training?tab=log#activity-${targetId}`);
  const target = page.locator(`#activity-${targetId}`);
  await expect(target).toBeVisible();
  await expect(target).toHaveAttribute(
    "href",
    `/training/activity/${targetId}`
  );
});

test("phone rows use the same canonical destination", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/training?tab=log");
  const row = page.getByTestId("training-log-row").first(); // first-ok: any row proves the shared destination
  const id = (await row.getAttribute("id"))!.replace("activity-", "");

  await followLink(page, row, new RegExp(`/training/activity/${id}$`));
  await expect(page.getByTestId("training-activity-page")).toBeVisible();
  await expect(page.getByTestId("activity-record-body")).toBeVisible();
});
