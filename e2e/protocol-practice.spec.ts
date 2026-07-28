import { test, expect } from "./fixtures";
import { expectNoClippedContent, hydratedClick, settledClick } from "./helpers";
import { frozenNow } from "./worker-env";

// Recovery gear + practice adherence on protocols (issue #344). Creates a protocol
// that references a seeded recovery device ("E2E Protocol Sauna") and declares a
// practice (sport × 4/week), lands on the detail page, and asserts the Practice
// card renders the gear link (into the /equipment registry), the adherence line
// (the same weekly-count the routine widget uses), and the usage-during-window
// line. Self-cleaning (deleting the protocol also removes its OWNED practice
// target, so a CI retry re-creates cleanly).
//
// The practice type is SPORT deliberately: the base seed already has a
// `type=cardio, per_week=2` routine target, and the create-vs-reference rule
// (issue #344's row-ops decision) REFERENCES an existing type target WITHOUT
// clobbering its per-week — so a cardio practice here would (correctly) resolve to
// "N / 2", not the entered 4. No seeded or spec-created `type=sport` target
// exists, so sport drives the CREATE-owned path deterministically; the
// reference-existing semantics are pinned in the action tier
// (lib/__action_tests__/protocols.actions.test.ts).
// Runs authenticated as admin acting as profile 1.
test("protocol references recovery gear + tracks practice adherence (#344)", async ({
  page,
}) => {
  test.slow(); // next dev compiles these routes on first hit

  const uniqueName = `E2E Sauna Protocol ${frozenNow().getTime()}`;
  const start = new Date(frozenNow().getTime() - 14 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  await page.goto("/longevity#protocols");
  const main = page.getByRole("main");
  await main.getByTestId("new-protocol-toggle").click();
  const form = page.getByTestId("protocol-form");

  await form.getByLabel("Name").fill(uniqueName);
  await form.locator("#pr-start-new").fill(start);
  await page.keyboard.press("Escape"); // dismiss the date popover

  // Reference the seeded sauna and declare a sport 4×/week practice.
  await form
    .getByTestId("protocol-equipment")
    .selectOption({ label: "E2E Protocol Sauna" });
  await form.getByTestId("protocol-practice-type").selectOption("sport");
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

  // Adherence reads "N / 4 Sport sessions" — the created OWNED target carries the
  // per-week we entered (the create path, not a reference to a seeded target).
  const adherence = card.getByTestId("protocol-adherence");
  await expect(adherence).toContainText("/ 4");
  await expect(adherence).toContainText("Sport");
  await expect(card.getByTestId("protocol-usage")).toBeVisible();

  // Self-clean.
  await hydratedClick(
    page,
    detailMain.getByRole("button", { name: "More protocol actions" })
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
  await expect(page.getByRole("main")).not.toContainText(uniqueName);
});

// Wellness practice as protocol adherence (issue #1259): create a red-light protocol
// with a 3–5×/week RANGE target, land on the detail page, one-tap "Log session", and
// assert adherence ticks 0 → 1 with the range cadence shown. Self-cleaning (deleting the
// protocol removes its OWNED practice target), so a CI retry re-creates cleanly. The
// wellness-practice select value drives the CREATE-owned path (no seeded practice
// target), so the entered floor/ceiling are deterministic. Runs authenticated as admin
// acting as profile 1.
test("wellness practice: range target + one-tap logging (#1259)", async ({
  page,
}) => {
  test.slow(); // next dev compiles these routes on first hit

  const uniqueName = `E2E Red Light ${frozenNow().getTime()}`;
  // A UNIQUE custom practice name so this drives the CREATE-owned path deterministically
  // — the seed ships a "Red light therapy" practice target with logged sessions, and the
  // create-vs-reference rule (#344) would REFERENCE it (non-zero adherence); a fresh name
  // owns a fresh 0-count target.
  const practiceName = `E2E Practice ${frozenNow().getTime()}`;
  // A year-long window exercises the compact card heatmap's mobile density story
  // (#1588) while the unique practice keeps adherence deterministic.
  const start = new Date(frozenNow().getTime() - 370 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  await page.goto("/longevity#protocols");
  const main = page.getByRole("main");
  await main.getByTestId("new-protocol-toggle").click();
  const form = page.getByTestId("protocol-form");

  await form.getByLabel("Name", { exact: true }).fill(uniqueName);
  await form.locator("#pr-start-new").fill(start);
  await page.keyboard.press("Escape"); // dismiss the date popover

  // A 3–5×/week custom wellness practice (the CREATE-owned path).
  await form
    .getByTestId("protocol-practice-type")
    .selectOption({ label: "Other practice (custom)…" });
  await form.getByTestId("protocol-practice-custom").fill(practiceName);
  await form.getByTestId("protocol-practice-per-week").fill("3");
  await form.getByTestId("protocol-practice-per-week-max").fill("5");

  await form.getByRole("button", { name: "Create protocol" }).click();

  await page.waitForURL(/\/protocols\/\d+/);
  const detailMain = page.getByRole("main");
  await expect(detailMain.getByTestId("protocol-header")).toContainText(
    uniqueName
  );

  const card = detailMain.getByTestId("protocol-practice-card");
  const adherence = card.getByTestId("protocol-adherence");
  // Starts at 0 / 3–5, labeled by the practice name.
  await expect(adherence).toContainText("0 / 3–5");
  await expect(adherence).toContainText(`${practiceName} sessions`);

  // One-tap log a session — the shared write core, answered from its outcome.
  await settledClick(page, card.getByTestId("practice-log-button"));

  // Adherence ticks to 1 (one distinct day this week).
  await expect(adherence).toContainText("1 / 3–5");
  await expect(card.getByTestId("practice-today-count")).toContainText(
    "1 logged today"
  );
  await expect(card.getByTestId("protocol-usage")).toContainText("1 session");
  const history = card.getByTestId("practice-session-history");
  await expect(history.locator("tbody tr")).toHaveCount(1);

  // Ending makes the protocol historical, but correction controls remain available
  // (#1585; #1592 later removes only NEW-data affordances).
  await hydratedClick(
    page,
    detailMain.getByRole("button", { name: "More protocol actions" })
  );
  await page.getByRole("menu").getByRole("button", { name: "End now" }).click();
  await settledClick(
    page,
    page
      .getByTestId("confirm-dialog")
      .getByRole("button", { name: "End protocol" })
  );
  await expect(detailMain.getByTestId("protocol-header")).not.toContainText(
    "ongoing"
  );
  await expect(card.getByTestId("protocol-adherence")).toHaveCount(0);
  await expect(card.getByTestId("practice-log-button")).toHaveCount(0);
  await expect(history.getByTestId("practice-session-edit")).toBeVisible();
  await expect(history.getByTestId("practice-session-delete")).toBeVisible();

  // The ended record leaves behind a full-window event heatmap. A one-year
  // protocol remains contained at the narrow acceptance viewport, and the logged
  // event keeps its count intensity.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/longevity#protocols");
  const row = page
    .getByTestId("protocol-list")
    .locator("li")
    .filter({ hasText: uniqueName });
  const heatmap = row.getByTestId("protocol-heatmap");
  await expect(heatmap).toBeVisible();
  await expect(heatmap.locator('[data-count="1"]')).toHaveCount(1);
  await expect(heatmap.locator('[data-outside="true"]')).not.toHaveCount(0);
  await expectNoClippedContent(page);

  // Self-clean.
  const detailLink = row.getByRole("link");
  await expect(detailLink).toHaveAttribute("href", /\/protocols\/\d+/);
  await detailLink.press("Enter");
  await expect(page).toHaveURL(/\/protocols\/\d+/);
  await hydratedClick(
    page,
    page.getByRole("main").getByRole("button", {
      name: "More protocol actions",
    })
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
  await expect(page.getByRole("main")).not.toContainText(uniqueName);
});

test("activity and food protocols open their owning prefilled loggers (#1584)", async ({
  page,
}) => {
  test.slow();
  const start = new Date(frozenNow().getTime() - 14 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  async function createProtocol(
    name: string,
    practiceValue: "cardio" | "food_group:fatty_fish"
  ) {
    await page.goto("/longevity#protocols");
    await page.getByTestId("new-protocol-toggle").click();
    const form = page.getByTestId("protocol-form");
    await form.getByLabel("Name", { exact: true }).fill(name);
    await form.locator("#pr-start-new").fill(start);
    await page.keyboard.press("Escape");
    await form
      .getByTestId("protocol-practice-type")
      .selectOption(practiceValue);
    await form.getByTestId("protocol-practice-per-week").fill("3");
    await settledClick(
      page,
      form.getByRole("button", { name: "Create protocol" })
    );
    await page.waitForURL(/\/protocols\/\d+/);
    return page.url();
  }

  async function deleteCurrentProtocol() {
    const main = page.getByRole("main");
    await hydratedClick(
      page,
      main.getByRole("button", { name: "More protocol actions" })
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
  }

  const activityName = `E2E Cardio Protocol ${frozenNow().getTime()}`;
  await createProtocol(activityName, "cardio");
  const activityCard = page.getByTestId("protocol-practice-card");
  await settledClick(
    page,
    activityCard.getByRole("button", { name: "Log cardio session" })
  );
  const activityForm = page.getByTestId("activity-form");
  await expect(activityForm).toBeVisible();
  const cardioChip = activityForm.getByRole("button", {
    name: "Cardio",
    exact: true,
  });
  await expect(cardioChip).toHaveAttribute("aria-pressed", "true");
  const customActivity = `Protocol cardio ${frozenNow().getTime()}`;
  await activityForm.getByPlaceholder(/What did you do/).fill(customActivity);
  await activityForm
    .getByRole("button", { name: /Add .* as new activity/ })
    .click();
  await expect(
    activityForm.getByRole("button", { name: "Cardio", exact: true })
  ).toHaveAttribute("aria-pressed", "true");
  await activityForm.getByRole("button", { name: "Close" }).click();

  // Ending removes both the live weekly badge and every new-data action while
  // preserving the lifecycle menu and historical usage (#1592).
  const detailMain = page.getByRole("main");
  await hydratedClick(
    page,
    detailMain.getByRole("button", { name: "More protocol actions" })
  );
  await page.getByRole("menu").getByRole("button", { name: "End now" }).click();
  await settledClick(
    page,
    page
      .getByTestId("confirm-dialog")
      .getByRole("button", { name: "End protocol" })
  );
  await expect(activityCard.getByTestId("protocol-adherence")).toHaveCount(0);
  await expect(activityCard.getByTestId("protocol-log-button")).toHaveCount(0);
  await expect(activityCard.getByTestId("protocol-usage")).toBeVisible();
  await deleteCurrentProtocol();

  const foodName = `E2E Food Protocol ${frozenNow().getTime()}`;
  await createProtocol(foodName, "food_group:fatty_fish");
  const foodCard = page.getByTestId("protocol-practice-card");
  await settledClick(
    page,
    foodCard.getByRole("button", { name: "Log servings" })
  );
  const sheet = page.getByTestId("quick-entry-sheet");
  await expect(sheet).toBeVisible();
  await expect(
    sheet.locator(
      '[data-testid="food-group-fatty_fish"][data-prefilled="true"]'
    )
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await deleteCurrentProtocol();
});
