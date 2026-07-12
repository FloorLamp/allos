import { test, expect } from "@playwright/test";

// Recovery gear + practice adherence on protocols (issue #344). Creates a protocol
// that references a seeded recovery device ("E2E Protocol Sauna") and declares a
// practice (cardio × 4/week), lands on the detail page, and asserts the Practice
// card renders the gear link (into the /equipment registry), the adherence line
// (the same weekly-count the routine widget uses), and the usage-during-window
// line. Self-cleaning. Runs authenticated as admin acting as profile 1.
test("protocol references recovery gear + tracks practice adherence (#344)", async ({
  page,
}) => {
  test.slow(); // next dev compiles these routes on first hit

  const uniqueName = `E2E Sauna Protocol ${Date.now()}`;
  const start = new Date(Date.now() - 14 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  await page.goto("/protocols");
  const main = page.getByRole("main");
  const form = main.getByTestId("protocol-form");

  await form.getByLabel("Name").fill(uniqueName);
  await main.locator("#pr-start-new").fill(start);
  await page.keyboard.press("Escape"); // dismiss the date popover

  // Reference the seeded sauna and declare a cardio 4×/week practice.
  await form
    .getByTestId("protocol-equipment")
    .selectOption({ label: "E2E Protocol Sauna" });
  await form.getByTestId("protocol-practice-type").selectOption("cardio");
  await form.getByTestId("protocol-practice-per-week").fill("4");

  await form.getByRole("button", { name: "Create protocol" }).click();

  // Redirects to the detail page.
  await page.waitForURL(/\/protocols\/\d+/);
  const detailMain = page.getByRole("main");
  await expect(detailMain.getByTestId("protocol-header")).toContainText(
    uniqueName
  );

  // The Practice card renders the gear reference, adherence, and usage.
  const card = detailMain.getByTestId("protocol-practice-card");
  await expect(card).toBeVisible();

  const gearLink = card.getByTestId("protocol-gear-link");
  await expect(gearLink).toContainText("E2E Protocol Sauna");
  await expect(gearLink).toHaveAttribute("href", /\/equipment\/\d+$/);

  // Adherence reads "N / 4 Cardio sessions" — the per-week target is what we set.
  await expect(card.getByTestId("protocol-adherence")).toContainText("/ 4");
  await expect(card.getByTestId("protocol-usage")).toBeVisible();

  // Self-clean.
  page.on("dialog", (d) => d.accept());
  await detailMain.getByRole("button", { name: "Delete" }).click();
  await page.waitForURL(/\/protocols$/);
  await expect(page.getByRole("main")).not.toContainText(uniqueName);
});
