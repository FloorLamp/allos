import { test, expect } from "./fixtures";
import { expectNoClippedContent, hydratedClick, settledClick } from "./helpers";
import { frozenNow } from "./worker-env";

test("protocol creation is collapsed and templates seed inside the form (#1500)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/longevity#protocols");
  const main = page.getByRole("main");

  await expect(main.getByTestId("protocol-form")).toHaveCount(0);
  await expect(main.getByTestId("protocol-templates")).toHaveCount(0);
  const toggle = main.getByTestId("new-protocol-toggle");
  await expect(toggle).toBeVisible();
  await toggle.click();

  const dialog = page.getByRole("dialog", { name: "New protocol" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveClass(/max-w-4xl/);
  const form = dialog.getByTestId("protocol-form");
  await expect(form.getByLabel("Notes")).toHaveAttribute("rows", "5");
  const picker = form.getByTestId("protocol-template-picker");
  await picker.selectOption("sun-exposure");
  await expect(form.locator('input[name="name"]')).toHaveValue(
    "Daily daylight walk"
  );
  await expect(form.locator('textarea[name="notes"]')).toContainText(
    /observational/i
  );
  await expect(form.getByTestId("protocol-outcome-selected")).toContainText(
    "Vitamin D, 25-Hydroxy"
  );

  await picker.selectOption("");
  await expect(form.locator('input[name="name"]')).toHaveValue("");
  await expect(form.getByTestId("protocol-outcome-selected")).toHaveCount(0);
  await expectNoClippedContent(page);

  // Durable template links still expand and seed the form on arrival.
  await page.goto("/longevity?template=sun-exposure#protocols");
  const linkedForm = page.getByTestId("protocol-form");
  await expect(linkedForm).toBeVisible();
  await expect(linkedForm.getByTestId("protocol-template-picker")).toHaveValue(
    "sun-exposure"
  );
  await expect(linkedForm.locator('input[name="name"]')).toHaveValue(
    "Daily daylight walk"
  );
});

test("the outcome combobox saves stored and derived biomarkers (#1586)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const uniqueName = `E2E outcome picker ${frozenNow().getTime()}`;
  await page.goto("/longevity#protocols");
  const main = page.getByRole("main");
  await main.getByTestId("new-protocol-toggle").click();
  const form = page.getByTestId("protocol-form");
  await form.getByLabel("Name").fill(uniqueName);

  const search = form.getByLabel("Filter outcome metrics");
  await search.fill("LDL Cholesterol");
  await form
    .getByRole("button", { name: "LDL Cholesterol", exact: true })
    .click();
  await search.fill("Non-HDL Cholesterol");
  await form
    .getByRole("button", { name: "Non-HDL Cholesterol", exact: true })
    .click();

  const selected = form.getByTestId("protocol-outcome-selected");
  await expect(selected).toContainText("LDL Cholesterol");
  await expect(selected).toContainText("Non-HDL Cholesterol");
  await expectNoClippedContent(page);

  await settledClick(
    page,
    form.getByRole("button", { name: "Create protocol" })
  );
  await page.waitForURL(/\/protocols\/\d+/);
  const detail = page.getByRole("main");
  await expect(
    detail.getByTestId("protocol-outcome-biomarker:LDL Cholesterol")
  ).toBeVisible();
  await expect(
    detail.getByTestId("protocol-outcome-biomarker:Non-HDL Cholesterol")
  ).toBeVisible();

  await hydratedClick(
    page,
    detail.getByRole("button", { name: "More protocol actions" })
  );
  await page
    .getByRole("menu")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await settledClick(
    page,
    page
      .getByTestId("confirm-dialog")
      .getByRole("button", { name: "Delete protocol" })
  );
  await page.waitForURL(/\/longevity(?:#|$)/);
});
