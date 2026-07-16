import { test, expect } from "@playwright/test";

// #798 PRN redose notice + confirm flow. The seed (e2e/seed-events.ts) ships
// "PRN Redose Med (e2e)" — a PRN med with a CONFIRMED redose notice (6h interval,
// max 4/day) and ONE administration ~7h ago, so its redose window is OPEN and both
// the Medications card and the dashboard widget render the status line. The add-form
// test drives the confirm flow: pre-fill the label defaults, opt in, save.
const REDOSE_MED = "PRN Redose Med (e2e)";

test("medications card surfaces the redose window status line (#798)", async ({
  page,
}) => {
  await page.goto("/medications");

  const card = page.locator("div.card").filter({ hasText: REDOSE_MED });
  await expect(card).toBeVisible();

  const admin = card.getByTestId("prn-administrations");
  await expect(admin).toBeVisible();
  // The window is open (last dose ~7h ago > 6h interval), 1 of 4 today.
  const line = card.getByTestId("prn-redose-line");
  await expect(line).toBeVisible();
  await expect(line).toContainText("Redose OK");
  await expect(line).toContainText("1 of 4 today");
});

test("dashboard PRN widget mirrors the redose status line (#798)", async ({
  page,
}) => {
  await page.goto("/");
  const widget = page.getByTestId("quick-log-prn");
  await expect(widget).toBeVisible();
  const item = widget
    .getByTestId("quick-log-prn-item")
    .filter({ hasText: REDOSE_MED });
  await expect(item).toBeVisible();
  await expect(item.getByTestId("prn-redose-line")).toContainText("Redose OK");
});

test("med form: confirm flow pre-fills OTC label defaults and opts in (#798)", async ({
  page,
}) => {
  await page.goto("/medications");

  const addCard = page
    .locator("div.card")
    .filter({ hasText: "Add medication" });
  await expect(addCard).toBeVisible();

  // Name an ingredient the curated dataset knows so the pre-fill affordance appears.
  const name = "Ibuprofen e2e redose";
  await addCard.getByLabel("Name").fill(name);

  // Marking it PRN reveals the redose-notice block.
  await addCard.getByRole("checkbox", { name: /As needed/ }).check();
  const block = addCard.getByTestId("redose-block");
  await expect(block).toBeVisible();

  // "Use label defaults" pre-fills the CONFIRMED numbers (ibuprofen: 6h / max 4).
  await addCard.getByTestId("redose-prefill").click();
  await expect(addCard.getByTestId("redose-interval")).toHaveValue("6");
  await expect(addCard.getByTestId("redose-max")).toHaveValue("4");

  // The user explicitly opts in (the liability confirm) and saves.
  await addCard.getByTestId("redose-optin").check();
  await addCard.getByRole("button", { name: "Add", exact: true }).click();

  // The new PRN med appears among the current medications.
  await expect(
    page.locator("div.card").filter({ hasText: name })
  ).toBeVisible();
});
