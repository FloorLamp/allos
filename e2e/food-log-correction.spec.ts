import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { settledClick, settledSelect } from "./helpers";

// Correcting an already-logged serving from the food log (#1934).
//
// The one-tap bar could create and delete servings but never edit one, and
// delete-and-re-log is NOT equivalent — a re-log stamps the current window, so a
// serving tapped into the wrong meal could not be repaired faithfully. This drives the
// ⋯ row action on the day's serving list end to end and asserts what the issue actually
// cares about: the per-meal tallies (the same derivation the food nudge's "(n)" button
// counts read) MOVE with the serving rather than counting it twice.
//
// Fixture discipline: the test logs its OWN serving, identifies that row by the id that
// appears in the list (never an exact count over the shared seed), corrects it, and
// removes it again — so it leaves the shared profile exactly as it found it.

async function revealFoodGroup(page: Page, slug: string) {
  const row = page.getByTestId(`food-group-${slug}`);
  if (!(await row.isVisible())) {
    await page.getByTestId("food-more-groups-summary").click();
    await expect(row).toBeVisible();
  }
}

// The ids currently rendered in the day's serving list.
async function loggedIds(page: Page): Promise<string[]> {
  const ids = await page
    .locator('[data-testid^="food-logged-"]')
    .evaluateAll((nodes) =>
      nodes
        .map((n) => n.getAttribute("data-testid") ?? "")
        .filter((t) => /^food-logged-\d+$/.test(t))
    );
  return ids;
}

async function slotTotal(page: Page, meal: string): Promise<number> {
  const text = await page
    .getByTestId(`food-slot-total-${meal.toLowerCase()}`)
    .textContent();
  return Number((text ?? "0").trim());
}

test("a mis-slotted serving is corrected from the log and the meal tallies follow (#1934)", async ({
  page,
}) => {
  test.slow(); // the nutrition route compiles on first hit
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  // Log into Morning explicitly, so the correction has a known source window.
  await page.getByTestId("food-slot-morning").click();
  await expect(page.getByTestId("food-slot-chip")).toHaveText("Morning");
  await revealFoodGroup(page, "nuts_seeds");

  const morningBefore = await slotTotal(page, "Morning");
  const eveningBefore = await slotTotal(page, "Evening");
  const idsBefore = await loggedIds(page);
  const countBefore = Number(
    (await page.getByTestId("count-nuts_seeds").textContent())?.trim() || "0"
  );

  await page.getByTestId("log-nuts_seeds").click();
  await expect(page.getByTestId("count-nuts_seeds")).toHaveText(
    String(countBefore + 1)
  );
  // The server-rendered list gains exactly this tap's row.
  await expect(page.locator('[data-testid^="food-logged-"]')).toHaveCount(
    idsBefore.length + 1
  );
  const idsAfter = await loggedIds(page);
  const newId = idsAfter.find((id) => !idsBefore.includes(id));
  expect(newId).toBeTruthy();

  const row = page.getByTestId(newId!);
  await expect(row).toHaveAttribute("data-slot", "Morning");
  await expect(row).toHaveAttribute("data-group", "nuts_seeds");
  expect(await slotTotal(page, "Morning")).toBe(morningBefore + 1);

  // ⋯ → Correct this serving → move it to Evening.
  const eventId = newId!.replace("food-logged-", "");
  await row.getByRole("button", { name: /^Actions for the/ }).click();
  await page.getByTestId(`food-logged-correct-${eventId}`).click();
  await expect(page.getByTestId("food-correct-modal")).toBeVisible();
  await settledSelect(page, page.getByTestId("food-correct-slot"), "Evening");
  await settledClick(page, page.getByTestId("food-correct-save"));
  await expect(page.getByTestId("food-correct-modal")).toBeHidden();

  // THE PIN: the serving MOVED. Evening gained exactly one and Morning is back where
  // it started — an increment-without-decrement bug would leave Morning inflated.
  await expect(page.getByTestId("food-slot-total-evening")).toHaveText(
    String(eveningBefore + 1)
  );
  await expect(page.getByTestId("food-slot-total-morning")).toHaveText(
    String(morningBefore)
  );
  // The Morning button count for the group is back to its pre-tap value too.
  await expect(page.getByTestId("count-nuts_seeds")).toHaveText(
    String(countBefore)
  );
  // The Evening meal card now names the group; the row itself re-files too.
  await expect(
    page.getByTestId("food-meal-item-evening-nuts_seeds")
  ).toBeVisible();
  await expect(page.getByTestId(newId!)).toHaveAttribute(
    "data-slot",
    "Evening"
  );

  // Leave the fixture as found: undo the serving from the window it now lives in.
  await page.getByTestId("food-slot-evening").click();
  await expect(page.getByTestId("food-slot-chip")).toHaveText("Evening");
  await revealFoodGroup(page, "nuts_seeds");
  await page.getByTestId("undo-nuts_seeds").click();
  await expect(page.getByTestId(newId!)).toHaveCount(0);
  await expect(page.getByTestId("food-slot-total-evening")).toHaveText(
    String(eveningBefore)
  );
});
