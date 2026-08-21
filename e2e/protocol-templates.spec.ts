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
  // The dialog declares itself a work surface, one size up from a confirm.
  //
  // Pinned on the DECLARED size rather than on `toHaveClass(/max-w-3xl/)`, which
  // is what this line used to say, for two reasons. It named a RENDERING of the
  // size decision instead of the decision, so it went red the moment #2774
  // replaced the per-host `max-w-*` overrides with a declared `size` even though
  // the dialog was as wide as it ever was. And at the 390px viewport this test
  // sets, the class it asserted CONSTRAINED NOTHING — the panel is a full-width
  // sheet there — so the assertion could not have failed for any reason a reader
  // would care about. What a size does to width is measured in
  // e2e/dialog-convergence.spec.ts, at a viewport where it is observable.
  await expect(dialog).toHaveAttribute("data-size", "md");
  const form = dialog.getByTestId("protocol-form");
  // The notes field lives behind the row's `notes` fact since #3219 — mounted at all
  // times, hidden while its panel is closed (which is what keeps it in the FormData
  // this form submits). Its shape is still assertable from here: neither
  // `toHaveAttribute` nor `toHaveValue` asks about visibility.
  await expect(form.getByLabel("Notes")).toHaveAttribute("rows", "4");
  const picker = form.getByTestId("protocol-template-picker");
  await picker.selectOption("sun-exposure");
  await expect(form.locator('input[name="name"]')).toHaveValue(
    "Daily daylight walk"
  );
  // Asked as a VALUE rather than as text content. The field is controlled now, so
  // what the template seeded lives in the textarea's value — `toContainText` reads
  // textContent, which is a different question and one a controlled textarea can
  // answer with an empty string.
  await expect(form.locator('textarea[name="notes"]')).toHaveValue(
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
  // The option rows are in the PORTALED listbox (#3271), not inside the form.
  const outcomeOptions = page.getByRole("listbox");
  await search.fill("LDL Cholesterol");
  await outcomeOptions
    .getByRole("button", { name: "LDL Cholesterol", exact: true })
    .click();
  await search.fill("Non-HDL Cholesterol");
  await outcomeOptions
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
    detail.getByTestId("protocol-outcome-result:LDL Cholesterol")
  ).toBeVisible();
  await expect(
    detail.getByTestId("protocol-outcome-result:Non-HDL Cholesterol")
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
