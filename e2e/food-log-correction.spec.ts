import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { hydratedClick, settledClick, settledSelect } from "./helpers";
import { frozenNow } from "./worker-env";
import { shiftDateStr } from "@/lib/date";

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
// the window by `recorded_at` — while a corrected serving deliberately keeps its original
// tap instant (lib/food-log-write.ts: "`recorded_at` is deliberately NOT edited"). So a
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
    await hydratedClick(page, page.getByTestId("food-more-groups-summary"));
    await expect(row).toBeVisible();
  }
}

// The day's serving ROWS. Scoped to <li data-group> inside the DAY LEDGER (#3987,
// which absorbed the LOGGED-TODAY list) so the group wrappers can never pad a count.
function loggedRows(page: Page) {
  return page.getByTestId("day-ledger").locator("li[data-group]");
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
  return added[0].replace("ledger-serving-", "");
}

// Remove ONE serving through the product's own ⋯ → "Remove this serving" (#1963),
// addressed by ledger id. The row going away is the assertion that the write landed: the
// action revalidates /nutrition, so the list the server re-derives from food_log_events
// is what re-renders.
async function removeServingRow(page: Page, eventId: string): Promise<void> {
  const row = page.getByTestId(`ledger-serving-${eventId}`);
  await hydratedClick(
    page,
    row.getByRole("button", { name: /^Actions for the/ })
  );
  await settledClick(
    page,
    page.getByTestId(`ledger-serving-remove-${eventId}`)
  );
  await expect(row).toHaveCount(0);
}

// HOW MANY SERVINGS THIS MEAL HOLDS, off the ledger that states them (#3987). The
// Meals cards' per-slot counter retired with the cards; the same quantity is the number
// of serving rows the meal's ledger group carries, and a meal with nothing in it has no
// group at all — which counts as zero, exactly as the card's "0" did.
async function slotTotal(page: Page, meal: string): Promise<number> {
  return page
    .getByTestId(`ledger-group-${meal.toLowerCase()}`)
    .locator("li[data-group]")
    .count();
}

test("a mis-slotted serving is corrected from the log and the meal tallies follow (#1934)", async ({
  page,
}) => {
  test.slow(); // the nutrition route compiles on first hit
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  // Log into Morning explicitly, so the correction has a known source window.
  // hydratedClick, not click: the meal selector is a CONTROLLED React button
  // (components/SegmentedControl.tsx renders `<button type="button" onClick>` with no
  // href and no form), so a tap dispatched before the handler attaches is lost with no
  // native fallback and no error — the chip assertion below then retries against the
  // unchanged slot and reports the derived window as wrong (#4830 on `e2e (4)`:
  // `Expected: "Evening" Received: "Midday"`, 14 retries). This is why #4339's
  // clearing of the `food-more-groups` taps does not transfer: THAT is an uncontrolled
  // `<details>` that toggles natively, so a pre-hydration tap survives it.
  await hydratedClick(page, page.getByTestId("food-slot-morning"));
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

  const row = page.getByTestId(`ledger-serving-${eventId}`);
  await expect(row).toHaveAttribute("data-slot", "Morning");
  await expect(row).toHaveAttribute("data-group", "nuts_seeds");
  await expect.poll(() => slotTotal(page, "Morning")).toBe(morningBefore + 1);

  // ⋯ → Correct this serving → move it to Evening.
  await row.getByRole("button", { name: /^Actions for the/ }).click();
  await page.getByTestId(`ledger-serving-correct-${eventId}`).click();
  await expect(page.getByTestId("food-correct-modal")).toBeVisible();
  await settledSelect(page, page.getByTestId("food-correct-slot"), "Evening");
  await settledClick(page, page.getByTestId("food-correct-save"));
  await expect(page.getByTestId("food-correct-modal")).toBeHidden();

  // THE PIN: the serving MOVED. Evening gained exactly one and Morning is back where
  // it started — an increment-without-decrement bug would leave Morning inflated.
  await expect.poll(() => slotTotal(page, "Evening")).toBe(eveningBefore + 1);
  await expect.poll(() => slotTotal(page, "Morning")).toBe(morningBefore);
  // The Morning button count for the group is back to its pre-tap value too.
  await expect(page.getByTestId("count-nuts_seeds")).toHaveText(
    String(countBefore)
  );
  // The Evening ledger group now names the group; the row itself re-files too.
  await expect(page.getByTestId("ledger-group-evening")).toContainText(
    "Nuts & seeds"
  );
  await expect(row).toHaveAttribute("data-slot", "Evening");

  // Leave the fixture as found — see the row-addressed note at the top of this file.
  // Since #1963 that is the product's own ⋯ → "Remove this serving", not a reach into
  // SQLite. The reload is what proves it: the server re-derives the list and the meal
  // tallies from the two tables, so the row being gone AND Evening being back at its
  // pre-test total together say the restore was complete, not just half-applied.
  await removeServingRow(page, eventId);
  await page.reload();
  await expect(page.getByTestId("food-log-bar")).toBeVisible();
  await expect(page.getByTestId(`ledger-serving-${eventId}`)).toHaveCount(0);
  await expect.poll(() => slotTotal(page, "Evening")).toBe(eveningBefore);
});

test("the ⋯ menu removes the corrected row it names, and Undo restores that row (#1963/#2038)", async ({
  page,
}) => {
  test.slow(); // the nutrition route compiles on first hit
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  // Capture the Evening baselines FIRST: `count-<slug>` always reads the active slot, so
  // the group's Evening figure has to be taken while Evening is selected.
  await hydratedClick(page, page.getByTestId("food-slot-evening"));
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
  //    deliberately preserves `recorded_at`.
  await page.getByTestId("food-slot-morning").click();
  await expect(page.getByTestId("food-slot-chip")).toHaveText("Morning");
  await revealFoodGroup(page, "shellfish");
  await hydratedClick(page, page.getByTestId("log-shellfish"));
  await expect(loggedRows(page)).toHaveCount(idsBefore.length + 1);
  const correctedId = await newRowId(page, idsBefore);
  const idsWithFirst = await loggedIds(page);

  // 2. The UNTOUCHED neighbour, tapped straight into Evening SECOND — the newest event
  //    in that window, and therefore the row the group-scoped "−" would take.
  await page.getByTestId("food-slot-evening").click();
  await expect(page.getByTestId("food-slot-chip")).toHaveText("Evening");
  await revealFoodGroup(page, "shellfish");
  await hydratedClick(page, page.getByTestId("log-shellfish"));
  await expect(loggedRows(page)).toHaveCount(idsBefore.length + 2);
  const untouchedId = await newRowId(page, idsWithFirst);

  // 3. Correct the Morning serving into Evening. Now both sit in Evening and the one the
  //    user just acted on is the OLDER of the two — the configuration this issue is about.
  const corrected = page.getByTestId(`ledger-serving-${correctedId}`);
  await corrected.getByRole("button", { name: /^Actions for the/ }).click();
  await page.getByTestId(`ledger-serving-correct-${correctedId}`).click();
  await expect(page.getByTestId("food-correct-modal")).toBeVisible();
  await settledSelect(page, page.getByTestId("food-correct-slot"), "Evening");
  await settledClick(page, page.getByTestId("food-correct-save"));
  await expect(page.getByTestId("food-correct-modal")).toBeHidden();
  await expect(corrected).toHaveAttribute("data-slot", "Evening");
  await expect.poll(() => slotTotal(page, "Evening")).toBe(eveningBefore + 2);
  await expect.poll(() => slotTotal(page, "Morning")).toBe(morningBefore);

  // 4. THE PIN. Remove the CORRECTED serving from its own ⋯ menu. The row that goes is
  //    the one that was named; the untouched neighbour — which the group-scoped "−"
  //    would have taken, because it is the newest tap in Evening — is still there.
  await corrected.getByRole("button", { name: /^Actions for the/ }).click();
  await settledClick(
    page,
    page.getByTestId(`ledger-serving-remove-${correctedId}`)
  );
  await expect(page.getByText("Serving removed.")).toBeVisible();
  await expect(corrected).toHaveCount(0);
  await expect(page.getByTestId(`ledger-serving-${untouchedId}`)).toBeVisible();

  // The tallies follow the row that actually left: Evening is down by exactly one and
  // Morning never moves (the serving had already left it).
  await expect.poll(() => slotTotal(page, "Evening")).toBe(eveningBefore + 1);
  await expect.poll(() => slotTotal(page, "Morning")).toBe(morningBefore);
  await expect(page.getByTestId("count-shellfish")).toHaveText(
    String(eveningCountBefore + 1)
  );

  // #2038: the precise row control is forgiving too. Undo restores the corrected
  // serving under a new id, while preserving the Evening slot it had when removed.
  //
  // EXACT, because `name` is a SUBSTRING match and this page also renders the day
  // ledger. A taken dose's control is named "Undo take" (#4753 renamed it from
  // "Mark not taken"), so a bare "Undo" resolves the toast AND every taken dose row
  // — three elements here, and a strict-mode violation rather than a wrong click.
  await settledClick(
    page,
    page.getByRole("button", { name: "Undo", exact: true })
  );
  await expect(page.getByText("Restored.")).toBeVisible();
  await expect.poll(() => slotTotal(page, "Evening")).toBe(eveningBefore + 2);
  await expect(page.getByTestId("count-shellfish")).toHaveText(
    String(eveningCountBefore + 2)
  );
  await page.reload();
  await expect(page.getByTestId("food-log-bar")).toBeVisible();
  const restoredId = await newRowId(page, [
    ...idsBefore,
    `ledger-serving-${untouchedId}`,
  ]);
  const restored = page.getByTestId(`ledger-serving-${restoredId}`);
  await expect(restored).toHaveAttribute("data-group", "shellfish");
  await expect(restored).toHaveAttribute("data-slot", "Evening");

  // Leave the fixture as found, through the same affordance. The final reload proves
  // the server re-derives the baseline from both tables rather than the client merely
  // hiding either row.
  await removeServingRow(page, restoredId);
  await removeServingRow(page, untouchedId);
  await page.reload();
  await expect(page.getByTestId("food-log-bar")).toBeVisible();
  await expect(page.getByTestId(`ledger-serving-${correctedId}`)).toHaveCount(
    0
  );
  await expect(page.getByTestId(`ledger-serving-${untouchedId}`)).toHaveCount(
    0
  );
  await expect(page.getByTestId(`ledger-serving-${restoredId}`)).toHaveCount(0);
  await expect.poll(() => slotTotal(page, "Evening")).toBe(eveningBefore);
  await expect.poll(() => slotTotal(page, "Morning")).toBe(morningBefore);
});

test("the sheet corrects a serving's eating time; Meal follows the hour until touched; Not stated clears (#2227)", async ({
  page,
}) => {
  test.slow(); // the nutrition route compiles on first hit
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  await hydratedClick(page, page.getByTestId("food-slot-morning"));
  await expect(page.getByTestId("food-slot-chip")).toHaveText("Morning");
  await revealFoodGroup(page, "legumes");
  const idsBefore = await loggedIds(page);

  // An UNSTATED serving — the row this test will teach an eating time to.
  await hydratedClick(page, page.getByTestId("log-legumes"));
  await expect(loggedRows(page)).toHaveCount(idsBefore.length + 1);
  const eventId = await newRowId(page, idsBefore);
  const row = page.getByTestId(`ledger-serving-${eventId}`);

  await row.getByRole("button", { name: /serving logged at/ }).click();
  await page.getByTestId(`ledger-serving-correct-${eventId}`).click();
  await expect(page.getByTestId("food-correct-modal")).toBeVisible();
  await expect(page.getByTestId("food-correct-provenance")).toContainText(
    "No eating time recorded"
  );

  // Move the pair's DAY to yesterday first: every hour of a past day is offerable,
  // so the hour choices below don't depend on what o'clock the frozen run is.
  const yesterday = shiftDateStr(frozenNow().toISOString().slice(0, 10), -1);
  const dateInput = page.getByTestId("food-correct-time-date");
  await dateInput.fill(yesterday);
  // Close the calendar panel the focus opened; the wrapper stops the Escape from
  // reaching the modal.
  await dateInput.press("Escape");

  // Decision 4: choosing an hour drags the Meal select with it (the seeded profile
  // has no custom schedule, so the default 11:00/15:00 boundaries hold)…
  const timeSelect = page.getByTestId("food-correct-time-time");
  const isoAt = async (hhmm: string) => {
    const iso = await timeSelect
      .locator("option", { hasText: new RegExp(`^${hhmm}$`) })
      .getAttribute("value");
    expect(iso, `the ${hhmm} option is offered`).toBeTruthy();
    return iso!;
  };
  await settledSelect(page, timeSelect, await isoAt("19:00"));
  await expect(page.getByTestId("food-correct-slot")).toHaveValue("Evening");
  await settledSelect(page, timeSelect, await isoAt("12:00"));
  await expect(page.getByTestId("food-correct-slot")).toHaveValue("Midday");

  // …until Meal is set BY HAND — from then on the hour stops moving it.
  await settledSelect(page, page.getByTestId("food-correct-slot"), "Morning");
  await settledSelect(page, timeSelect, await isoAt("19:00"));
  await expect(page.getByTestId("food-correct-slot")).toHaveValue("Morning");
  // Restore the coherent pairing before saving.
  await settledSelect(page, page.getByTestId("food-correct-slot"), "Evening");

  await settledClick(page, page.getByTestId("food-correct-save"));
  await expect(page.getByTestId("food-correct-modal")).toBeHidden();

  // The serving followed its corrected day; the LIST ROW now shows the eating time
  // (the row renders eatenAt ?? loggedTime, and this row now has an eatenAt).
  await page.getByTestId("food-day-yesterday").click();
  await expect(row).toBeVisible();
  // THE ROW STATES THE CLOCK; THE GROUP STATES THE MEAL (#3987). The meal used to be
  // repeated on every row beside its time; it is the heading the row now sits under,
  // which is the same fact said once.
  await expect(row).toContainText("19:00");
  await expect(page.getByTestId("ledger-group-evening")).toContainText(
    "Legumes & beans"
  );

  // Reopen: the sheet opens on the "Ate at" line and the select shows the hour.
  await row.getByRole("button", { name: /serving eaten at 19:00/ }).click();
  await page.getByTestId(`ledger-serving-correct-${eventId}`).click();
  await expect(page.getByTestId("food-correct-modal")).toBeVisible();
  await expect(page.getByTestId("food-correct-provenance")).toContainText(
    "Ate at 19:00."
  );

  // Decision 6: "Not stated" is the select's first option and choosing it CLEARS —
  // the honest default stays reachable, not a one-way ratchet into a guess.
  await settledSelect(page, timeSelect, "");
  await settledClick(page, page.getByTestId("food-correct-save"));
  await expect(page.getByTestId("food-correct-modal")).toBeHidden();
  // Back on the logged time: the row shows the tap clock again…
  // Back on a FILING-TIME clock, in #3958's grammar — "logged 13:36" says which
  // question the clock answers, where a bare time would claim an eating minute the
  // row no longer states.
  await expect(row).toContainText(/logged \d{1,2}:\d{2}/);
  // …and the sheet reopens on the honest opening line.
  await row.getByRole("button", { name: /serving logged at/ }).click();
  await page.getByTestId(`ledger-serving-correct-${eventId}`).click();
  await expect(page.getByTestId("food-correct-modal")).toBeVisible();
  await expect(page.getByTestId("food-correct-provenance")).toContainText(
    /No eating time recorded — logged at \d{2}:\d{2}\./
  );
  await page.getByTestId("food-correct-cancel").click();
  await expect(page.getByTestId("food-correct-modal")).toBeHidden();

  // Leave the fixture as found (still on the Yesterday view, where the row lives).
  await removeServingRow(page, eventId);
});
