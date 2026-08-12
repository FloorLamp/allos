import { test, expect } from "./fixtures";

test("creating a shared bottle confirms the write and cannot duplicate it", async ({
  page,
}, testInfo) => {
  const suffix = `${testInfo.repeatEachIndex}-${testInfo.retry}`;
  const itemName = `Shared picker supplement ${suffix}`;
  const bottleName = `Shared picker bottle ${suffix}`;

  await page.goto("/nutrition?tab=supplements");
  await page.getByTestId("supplement-add-toggle").click();
  const addDialog = page.getByRole("dialog", { name: "Add supplement" });
  await addDialog.getByLabel("Name").fill(itemName);
  await addDialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(addDialog).toHaveCount(0);

  const row = page.getByTestId("supplement-row").filter({ hasText: itemName });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "IntakeItem actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();

  const editDialog = page.getByRole("dialog", { name: `Edit ${itemName}` });
  const picker = editDialog.getByTestId("shared-supply-picker");
  const apply = picker.getByTestId("shared-supply-apply");
  await expect(apply).toBeDisabled();

  await picker.getByLabel("Shared supply").selectOption("__new__");
  await picker.getByLabel("New shared bottle name").fill(bottleName);
  await expect(apply).toBeEnabled();
  await apply.click();

  await expect(picker.getByTestId("shared-supply-success")).toHaveText(
    `Created and linked “${bottleName}”.`
  );
  await expect(picker.getByLabel("Shared supply")).not.toHaveValue("__new__");
  await expect(apply).toBeDisabled();
  await expect(picker.getByTestId("shared-supply-cabinet-link")).toBeVisible();

  await page.goto("/supplies");
  const bottle = page
    .getByTestId("shared-supply-card")
    .filter({ hasText: bottleName });
  await expect(bottle).toHaveCount(1);
  await expect(
    bottle.getByRole("link", {
      name: new RegExp(`Open ${itemName} for`),
    })
  ).toHaveAttribute("href", "/nutrition?tab=supplements");
});
