import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { settledClick, settledSelect } from "./helpers";

// The ⋯ row actions on the food log: CORRECT a logged serving (#1934) and REMOVE one
// (#1963).
//
// The one-tap bar could create and delete servings but never edit one, and
// delete-and-re-log is NOT equivalent — a re-log stamps the current window, so a
// serving tapped into the wrong meal could not be repaired faithfully. These tests drive
// the ⋯ row actions end to end and assert what the issues actually care about: the
// per-meal tallies (the same derivation the food nudge's "(n)" button counts read) MOVE
// with a corrected serving rather than counting it twice, and a REMOVAL takes the row it
// was named.
//
// Both removals here are ROW-ADDRESSED on purpose (#1959, #1963). The bar's "−" is
// group-scoped — `bump(slug, -1)` → `undoFoodServingCore`, which pops the NEWEST event in
// the window by `logged_at` — while a corrected serving deliberately keeps its original
// tap instant (lib/food-log-write.ts: "`logged_at` is deliberately NOT edited"). So a
// serving moved INTO Evening is not necessarily the newest thing in Evening, and the
// group control can legitimately take a seeded neighbour instead. Until #1963 that left
// the teardown below with no product affordance to use and it had to reach into SQLite;
// now it uses the same "Remove this serving" the second test is about — which is the
// point, since a spec forced through the database was the signal the product was missing
// a row-scoped delete.
//
// Fixture discipline: each test logs its OWN servings, identifies those rows by the ids
// that appear in the list (never an exact count over the shared seed), and removes them
// again — so it leaves the shared profile exactly as it found it.

async function revealFoodGroup(page: Page, slug: string) {
  const row = page.getByTestId(`food-group-${slug}`);
  if (!(await row.isVisible())) {
    await page.getByTestId("food-more-groups-summary").click();
    await expect(row).toBeVisible();
  }
}

// The day's serving ROWS. Scoped to <li data-group> inside the list so the section
// wrapper (whose test id shares the prefix) can never pad a count.
function loggedRows(page: Page) {
  return page.getByTestId("food-logged-list").locator("li[data-group]");
}

// The ids currently rendered in the day's serving list.
async function loggedIds(page: Page): Promise<string[]> {
  return loggedRows(page).evaluateAll((nodes) =>
    nodes.map((n) => n.getAttribute("data-testid") ?? "")
  );
}

// The bare event id of the ONE row added since `before`. Throws rather than returning
// undefined so a lost tap fails HERE, naming what went wrong, instead of surfacing later
// as a mystery selector timeout.
async function newRowId(page: Page, before: string[]): Promise<string> {
  const added = (await loggedIds(page)).filter((id) => !before.includes(id));
  if (added.length !== 1)
    throw new Error(
      `expected exactly one new serving row, saw ${added.length}: ${added.join(", ")}`
    );
  return added[0].replace("food-logged-", "");
}

// Remove ONE serving through the product's own ⋯ → "Remove this serving" (#1963),
// addressed by ledger id. The row going away is the assertion that the write landed: the
// action revalidates /nutrition, so the list the server re-derives from food_log_events
// is what re-renders.
async function removeServingRow(page: Page, eventId: string): Promise<void> {
  const row = page.getByTestId(`food-logged-${eventId}`);
  await row.getByRole("button", { name: /^Actions for the/ }).click();
  await settledClick(page, page.getByTestId(`food-logged-remove-${eventId}`));
  await expect(row).toHaveCount(0);
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
  await expect(loggedRows(page)).toHaveCount(idsBefore.length + 1);
  const eventId = await newRowId(page, idsBefore);

  const row = page.getByTestId(`food-logged-${eventId}`);
  await expect(row).toHaveAttribute("data-slot", "Morning");
  await expect(row).toHaveAttribute("data-group", "nuts_seeds");
  expect(await slotTotal(page, "Morning")).toBe(morningBefore + 1);

  // ⋯ → Correct this serving → move it to Evening.
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
  await expect(row).toHaveAttribute("data-slot", "Evening");

  // Leave the fixture as found — see the row-addressed note at the top of this file.
  // Since #1963 that is the product's own ⋯ → "Remove this serving", not a reach into
  // SQLite. The reload is what proves it: the server re-derives the list and the meal
  // tallies from the two tables, so the row being gone AND Evening being back at its
  // pre-test total together say the restore was complete, not just half-applied.
  await removeServingRow(page, eventId);
  await page.reload();
  await expect(page.getByTestId("food-log-bar")).toBeVisible();
  await expect(page.getByTestId(`food-logged-${eventId}`)).toHaveCount(0);
  await expect(page.getByTestId("food-slot-total-evening")).toHaveText(
    String(eveningBefore)
  );
});

test("the ⋯ menu removes the serving it names, even when a correction left it older than its neighbour (#1963)", async ({
  page,
}) => {
  test.slow(); // the nutrition route compiles on first hit
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  // Capture the Evening baselines FIRST: `count-<slug>` always reads the active slot, so
  // the group's Evening figure has to be taken while Evening is selected.
  await page.getByTestId("food-slot-evening").click();
  await expect(page.getByTestId("food-slot-chip")).toHaveText("Evening");
  await revealFoodGroup(page, "shellfish");
  const eveningCountBefore = Number(
    (await page.getByTestId("count-shellfish").textContent())?.trim() || "0"
  );
  const morningBefore = await slotTotal(page, "Morning");
  const eveningBefore = await slotTotal(page, "Evening");
  const idsBefore = await loggedIds(page);

  // 1. The serving that will be CORRECTED, tapped into Morning FIRST — so its tap
  //    instant is the older of the two, and it stays older, because a correction
  //    deliberately preserves `logged_at`.
  await page.getByTestId("food-slot-morning").click();
  await expect(page.getByTestId("food-slot-chip")).toHaveText("Morning");
  await revealFoodGroup(page, "shellfish");
  await page.getByTestId("log-shellfish").click();
  await expect(loggedRows(page)).toHaveCount(idsBefore.length + 1);
  const correctedId = await newRowId(page, idsBefore);
  const idsWithFirst = await loggedIds(page);

  // 2. The UNTOUCHED neighbour, tapped straight into Evening SECOND — the newest event
  //    in that window, and therefore the row the group-scoped "−" would take.
  await page.getByTestId("food-slot-evening").click();
  await expect(page.getByTestId("food-slot-chip")).toHaveText("Evening");
  await revealFoodGroup(page, "shellfish");
  await page.getByTestId("log-shellfish").click();
  await expect(loggedRows(page)).toHaveCount(idsBefore.length + 2);
  const untouchedId = await newRowId(page, idsWithFirst);

  // 3. Correct the Morning serving into Evening. Now both sit in Evening and the one the
  //    user just acted on is the OLDER of the two — the configuration this issue is about.
  const corrected = page.getByTestId(`food-logged-${correctedId}`);
  await corrected.getByRole("button", { name: /^Actions for the/ }).click();
  await page.getByTestId(`food-logged-correct-${correctedId}`).click();
  await expect(page.getByTestId("food-correct-modal")).toBeVisible();
  await settledSelect(page, page.getByTestId("food-correct-slot"), "Evening");
  await settledClick(page, page.getByTestId("food-correct-save"));
  await expect(page.getByTestId("food-correct-modal")).toBeHidden();
  await expect(corrected).toHaveAttribute("data-slot", "Evening");
  await expect(page.getByTestId("food-slot-total-evening")).toHaveText(
    String(eveningBefore + 2)
  );
  await expect(page.getByTestId("food-slot-total-morning")).toHaveText(
    String(morningBefore)
  );

  // 4. THE PIN. Remove the CORRECTED serving from its own ⋯ menu. The row that goes is
  //    the one that was named; the untouched neighbour — which the group-scoped "−"
  //    would have taken, because it is the newest tap in Evening — is still there.
  await corrected.getByRole("button", { name: /^Actions for the/ }).click();
  await settledClick(
    page,
    page.getByTestId(`food-logged-remove-${correctedId}`)
  );
  await expect(page.getByText("Serving removed.")).toBeVisible();
  await expect(corrected).toHaveCount(0);
  await expect(page.getByTestId(`food-logged-${untouchedId}`)).toBeVisible();

  // The tallies follow the row that actually left: Evening is down by exactly one and
  // Morning never moves (the serving had already left it).
  await expect(page.getByTestId("food-slot-total-evening")).toHaveText(
    String(eveningBefore + 1)
  );
  await expect(page.getByTestId("food-slot-total-morning")).toHaveText(
    String(morningBefore)
  );
  await expect(page.getByTestId("count-shellfish")).toHaveText(
    String(eveningCountBefore + 1)
  );

  // Leave the fixture as found, through the same affordance. The reload proves the
  // server re-derives an empty result from both tables rather than the client merely
  // having hidden two rows.
  await removeServingRow(page, untouchedId);
  await page.reload();
  await expect(page.getByTestId("food-log-bar")).toBeVisible();
  await expect(page.getByTestId(`food-logged-${correctedId}`)).toHaveCount(0);
  await expect(page.getByTestId(`food-logged-${untouchedId}`)).toHaveCount(0);
  await expect(page.getByTestId("food-slot-total-evening")).toHaveText(
    String(eveningBefore)
  );
  await expect(page.getByTestId("food-slot-total-morning")).toHaveText(
    String(morningBefore)
  );
});
