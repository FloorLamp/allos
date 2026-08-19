import { test, expect } from "./fixtures";
import { closeEditor, openFact } from "./intake-form-helpers";
import { settledClick, settledFill, settledSelect } from "./helpers";

// The product-fact exchange between a shared bottle and an intake item (#1705).
//
// Two claims, one per direction, each with SPEC-OWNED fixtures (a uniquely-named
// supplement and the bottle made from it), so nothing here counts or perturbs seed rows:
//
//   1. Making a bottle FROM an item inherits its product identity — the user does not
//      retype the strength they already entered.
//   2. Making an item FROM a bottle prefills those same facts and links on save, in one
//      step rather than create-then-find-the-link-control.

test("a bottle made from an item inherits its name and strength", async ({
  page,
}, testInfo) => {
  const suffix = `${testInfo.repeatEachIndex}-${testInfo.retry}`;
  const itemName = `Inherit source ${suffix}`;
  const strength = "5000 IU";

  await page.goto("/nutrition?tab=supplements");
  await page.getByTestId("supplement-add-toggle").click();
  const addDialog = page.getByRole("dialog", { name: "Add supplement" });
  await settledFill(page, addDialog.getByLabel("Name"), itemName);
  const doseEditor1 = await openFact(page, "dose", addDialog);
  await settledFill(page, doseEditor1.getByLabel("Amount"), strength);
  await closeEditor(page, addDialog);
  await addDialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(addDialog).toHaveCount(0);

  const row = page.getByTestId("supplement-row").filter({ hasText: itemName });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "Supplement actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();

  const editDialog = page.getByRole("dialog", { name: `Edit ${itemName}` });
  // The shared-supply control is the supply fact's editor now (#3216); its own
  // separate-submit, one-way count-migration design is untouched.
  const supplyEditor = await openFact(page, "supply", editDialog);
  const picker = supplyEditor.getByTestId("shared-supply-picker");
  await settledSelect(page, picker.getByLabel("Shared supply"), "__new__");
  // The affordance states what comes across BEFORE the write, not after it.
  await expect(picker.getByTestId("shared-supply-new-hint")).toContainText(
    "name and strength"
  );
  await picker.getByTestId("shared-supply-apply").click();
  await expect(picker.getByTestId("shared-supply-success")).toContainText(
    itemName
  );

  await page.goto("/supplies");
  const bottle = page
    .getByTestId("shared-supply-card")
    .filter({ hasText: itemName });
  await expect(bottle).toHaveCount(1);
  // The strength was never retyped — it came off the item's own dose amount.
  await expect(bottle.getByTestId("shared-supply-product")).toHaveText(
    strength
  );
});

test("adding a bottle for another person prefills its facts and links on save", async ({
  page,
}, testInfo) => {
  const suffix = `${testInfo.repeatEachIndex}-${testInfo.retry}`;
  const seedName = `Cabinet seed ${suffix}`;
  const bottleName = `Cabinet bottle ${suffix}`;
  const strength = "400 mg";
  const secondName = `${bottleName} for me`;

  // A bottle to add FROM: made through the shipped item → bottle flow, so this spec
  // owns every row it later reads.
  await page.goto("/nutrition?tab=supplements");
  await page.getByTestId("supplement-add-toggle").click();
  const addDialog = page.getByRole("dialog", { name: "Add supplement" });
  await settledFill(page, addDialog.getByLabel("Name"), seedName);
  const doseEditor2 = await openFact(page, "dose", addDialog);
  await settledFill(page, doseEditor2.getByLabel("Amount"), strength);
  await closeEditor(page, addDialog);
  await addDialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(addDialog).toHaveCount(0);

  const row = page.getByTestId("supplement-row").filter({ hasText: seedName });
  await row.getByRole("button", { name: "Supplement actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const editDialog = page.getByRole("dialog", { name: `Edit ${seedName}` });
  // The shared-supply control is the supply fact's editor now (#3216); its own
  // separate-submit, one-way count-migration design is untouched.
  const supplyEditor = await openFact(page, "supply", editDialog);
  const picker = supplyEditor.getByTestId("shared-supply-picker");
  await settledSelect(page, picker.getByLabel("Shared supply"), "__new__");
  await settledFill(
    page,
    picker.getByLabel("New shared bottle name"),
    bottleName
  );
  await picker.getByTestId("shared-supply-apply").click();
  await expect(picker.getByTestId("shared-supply-success")).toContainText(
    bottleName
  );

  // From the cabinet, add that bottle for a person — the acting profile leads the
  // selector, and submitting switches to the chosen profile before opening its form.
  await page.goto("/supplies");
  const bottle = page
    .getByTestId("shared-supply-card")
    .filter({ hasText: bottleName });
  await expect(bottle).toHaveCount(1);
  await settledClick(page, bottle.getByTestId("shared-supply-add-for-submit"));
  await expect(page).toHaveURL(/\/nutrition\?tab=supplements&supply=\d+/);

  // The add form is already open, already seeded, and already pointed at the bottle.
  const seeded = page.getByRole("dialog", { name: "Add supplement" });
  await expect(seeded.getByLabel("Name")).toHaveValue(bottleName);
  const doseEditor3 = await openFact(page, "dose", seeded);
  await expect(doseEditor3.getByLabel("Amount")).toHaveValue(strength);
  await closeEditor(page, seeded);
  // The bottle is a stated FACT of this item, on the chip row, before anything is
  // opened — a link the person never sees is a link they cannot correct (#1705).
  await expect(seeded.getByTestId("intake-fact-supply")).toContainText(
    bottleName
  );
  const supplyEditor2 = await openFact(page, "supply", seeded);
  await expect(
    supplyEditor2.getByTestId("shared-supply-new-item-note")
  ).toContainText(bottleName);
  // A pooled item keeps no private count, so that field is gone before the save.
  await expect(supplyEditor2.getByLabel("Quantity on hand")).toBeHidden();
  await closeEditor(page, seeded);

  await settledFill(page, seeded.getByLabel("Name"), secondName);
  await seeded.getByRole("button", { name: "Add", exact: true }).click();
  await expect(seeded).toHaveCount(0);

  // The new item draws from the bottle — the chip is the pooled read, not a private one.
  const created = page
    .getByTestId("supplement-row")
    .filter({ hasText: secondName });
  await expect(created).toHaveCount(1);
  await expect(created.getByTestId("shared-supply-chip")).toContainText(
    strength
  );

  // …and the cabinet now lists both takers of the one bottle.
  await page.goto("/supplies");
  const linked = page
    .getByTestId("shared-supply-card")
    .filter({ hasText: bottleName });
  await expect(linked.getByTestId("shared-supply-member-link")).toHaveCount(2);
});
