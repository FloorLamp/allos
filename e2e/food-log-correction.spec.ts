import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import Database from "better-sqlite3";
import { settledClick, settledSelect } from "./helpers";
import { workerDbPath } from "./worker-env";

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
//
// That last step is ROW-ADDRESSED on purpose (#1959). The bar's "−" is group-scoped —
// `bump(slug, -1)` → `undoFoodServingCore`, which pops the NEWEST event in the window by
// `logged_at` — while a corrected serving deliberately keeps its original tap instant
// (lib/food-log-write.ts: "`logged_at` is deliberately NOT edited"). So a serving moved
// INTO Evening is not necessarily the newest thing in Evening, and the group control can
// legitimately take a seeded neighbour instead. Asking it to pick this test's row was
// never a promise it makes; the teardown addresses the row the test wrote, by id.

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

// Give back the ONE serving this test logged, addressed by its event id. Mirrors the
// two-table discipline of `undoFoodServingCore`: the ledger row and the day counter move
// together, and the counter row is dropped at zero — so the profile is left exactly as
// found, not merely one row lighter.
function removeOwnServing(eventId: number): void {
  const db = new Database(workerDbPath());
  try {
    const row = db
      .prepare(
        `SELECT profile_id, date, group_key FROM food_log_events WHERE id = ?`
      )
      .get(eventId) as
      { profile_id: number; date: string; group_key: string } | undefined;
    // The row this test created must still be there; if it is not, the correction under
    // test lost it and the teardown should say so rather than silently no-op.
    if (!row) throw new Error(`food_log_events row ${eventId} is already gone`);
    db.prepare(`DELETE FROM food_log_events WHERE id = ?`).run(eventId);
    db.prepare(
      `UPDATE food_log SET servings = servings - 1
        WHERE profile_id = ? AND date = ? AND group_key = ? AND servings > 0`
    ).run(row.profile_id, row.date, row.group_key);
    db.prepare(
      `DELETE FROM food_log
        WHERE profile_id = ? AND date = ? AND group_key = ? AND servings <= 0`
    ).run(row.profile_id, row.date, row.group_key);
  } finally {
    db.close();
  }
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

  // Leave the fixture as found — see the row-addressed note at the top of this file.
  // The reload is what proves it: the server re-derives the list and the meal tallies
  // from the two tables, so the row being gone AND Evening being back at its pre-test
  // total together say the restore was complete, not just half-applied.
  removeOwnServing(Number(eventId));
  await page.reload();
  await expect(page.getByTestId("food-log-bar")).toBeVisible();
  await expect(page.getByTestId(newId!)).toHaveCount(0);
  await expect(page.getByTestId("food-slot-total-evening")).toHaveText(
    String(eveningBefore)
  );
});
