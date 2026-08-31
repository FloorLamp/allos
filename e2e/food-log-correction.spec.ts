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
    await page.getByTestId("food-more-groups-summary").click();
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
  //    deliberately preserves `recorded_at`.
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

  // Leave the fixture as found, through the same affordance. The reload proves the
  // server re-derives an empty result from both tables rather than the client merely
  // having hidden two rows.
  await removeServingRow(page, untouchedId);
  await page.reload();
  await expect(page.getByTestId("food-log-bar")).toBeVisible();
  await expect(page.getByTestId(`ledger-serving-${correctedId}`)).toHaveCount(
    0
  );
  await expect(page.getByTestId(`ledger-serving-${untouchedId}`)).toHaveCount(
    0
  );
  await expect.poll(() => slotTotal(page, "Evening")).toBe(eveningBefore);
  await expect.poll(() => slotTotal(page, "Morning")).toBe(morningBefore);
});

test("removing one serving offers Undo, and Undo brings the serving back (#2038)", async ({
  page,
}) => {
  test.slow(); // the nutrition route compiles on first hit
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  await page.getByTestId("food-slot-midday").click();
  await expect(page.getByTestId("food-slot-chip")).toHaveText("Midday");
  await revealFoodGroup(page, "berries");

  const middayBefore = await slotTotal(page, "Midday");
  const idsBefore = await loggedIds(page);
  const countBefore = Number(
    (await page.getByTestId("count-berries").textContent())?.trim() || "0"
  );

  await page.getByTestId("log-berries").click();
  await expect(page.getByTestId("count-berries")).toHaveText(
    String(countBefore + 1)
  );
  await expect(loggedRows(page)).toHaveCount(idsBefore.length + 1);
  const eventId = await newRowId(page, idsBefore);

  // ⋯ → Remove this serving. Until #2038 this was permanent: the PRECISE control was
  // the unforgiving one, sitting beside a group "−" whose mistap costs one tap.
  const row = page.getByTestId(`ledger-serving-${eventId}`);
  await row.getByRole("button", { name: /^Actions for the/ }).click();
  await settledClick(
    page,
    page.getByTestId(`ledger-serving-remove-${eventId}`)
  );
  await expect(page.getByText("Serving removed.")).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(page.getByTestId("count-berries")).toHaveText(
    String(countBefore)
  );
  await expect.poll(() => slotTotal(page, "Midday")).toBe(middayBefore);

  // THE PIN: the toast carries an Undo, and taking it gives the serving back — both the
  // ledger row and the day counter it decremented.
  await settledClick(page, page.getByRole("button", { name: "Undo" }));
  await expect(page.getByText("Restored.")).toBeVisible();
  await expect(page.getByTestId("count-berries")).toHaveText(
    String(countBefore + 1)
  );
  await expect.poll(() => slotTotal(page, "Midday")).toBe(middayBefore + 1);
  // The restore re-inserts with a NEW id (the undo substrate's contract), so the row is
  // identified as the one row this test added rather than by its original id.
  await page.reload();
  await expect(page.getByTestId("food-log-bar")).toBeVisible();
  await expect(loggedRows(page)).toHaveCount(idsBefore.length + 1);
  const restoredId = await newRowId(page, idsBefore);
  await expect(
    page.getByTestId(`ledger-serving-${restoredId}`)
  ).toHaveAttribute("data-group", "berries");

  // Leave the fixture as found.
  await removeServingRow(page, restoredId);
  await page.reload();
  await expect(page.getByTestId("food-log-bar")).toBeVisible();
  await expect(loggedRows(page)).toHaveCount(idsBefore.length);
  await expect.poll(() => slotTotal(page, "Midday")).toBe(middayBefore);
});

test("the sheet corrects a serving's eating time; Meal follows the hour until touched; Not stated clears (#2227)", async ({
  page,
}) => {
  test.slow(); // the nutrition route compiles on first hit
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  await page.getByTestId("food-slot-morning").click();
  await expect(page.getByTestId("food-slot-chip")).toHaveText("Morning");
  await revealFoodGroup(page, "legumes");
  const idsBefore = await loggedIds(page);

  // An UNSTATED serving — the row this test will teach an eating time to.
  await page.getByTestId("log-legumes").click();
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

test("the correction sheet names the time it shows: eating time when stated, logged time otherwise (#2227)", async ({
  page,
}) => {
  test.slow(); // the nutrition route compiles on first hit
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  await page.getByTestId("food-slot-morning").click();
  await expect(page.getByTestId("food-slot-chip")).toHaveText("Morning");
  await revealFoodGroup(page, "nuts_seeds");

  const idsBefore = await loggedIds(page);

  // 1. A serving with NO eating-time statement: the honest default (#2019) — the row
  //    has only its tap instant.
  //
  // hydratedClick, not a bare click. HARDENING ON A SIGNATURE MATCH, AND NOT A
  // DIAGNOSED FIX — the distinction is the point, so the next reader does not inherit
  // a cause nobody established.
  //
  // What is known: this is the FIRST write-tap after a fresh /nutrition load (the
  // route compiles here — see `test.slow()`), it was the ONE write in this file not
  // going through hydratedClick/settledClick, and CI failed on the next line on
  // 2026-08-31 with `expected 7, received 6` — the signature a swallowed
  // pre-hydration tap produces, since actionability checks pass on an element that is
  // genuinely there and the loss only surfaces as a count that never moved.
  //
  // What is NOT known: that hydration is what bit. A slow write reads identically. The
  // shard was reproduced locally at its exact CI composition (byte-identical to main's
  // plan) and ran 139/139 green, and a CDP CPU throttle at 20x across the navigation
  // did not reach the window in 3 runs either way — so the failure is UNREPRODUCED
  // here and this change may not be what stops it recurring.
  await hydratedClick(page, page.getByTestId("log-nuts_seeds"));
  await expect(loggedRows(page)).toHaveCount(idsBefore.length + 1);
  const unstatedId = await newRowId(page, idsBefore);
  const idsWithFirst = await loggedIds(page);

  // 2. A serving logged UNDER a statement, through the bar's own control (#2053):
  //    the shared when-control's "Now" fills an absolute local time, a human answer
  //    that writes occurred_at via the real action path. A DIFFERENT group on purpose:
  //    a second tap of the same row inside the tap ledger's cooldown is absorbed as an
  //    accidental double.
  await revealFoodGroup(page, "berries");
  await hydratedClick(page, page.getByTestId("food-when-summary"));
  await page.getByTestId("food-when-now").click();
  await expect(page.getByTestId("food-when-time")).not.toHaveValue("");
  await page.getByTestId("log-berries").click();
  await expect(loggedRows(page)).toHaveCount(idsBefore.length + 2);
  const statedId = await newRowId(page, idsWithFirst);
  // The statement is sticky across taps by design — release it before anything else.
  await settledSelect(page, page.getByTestId("food-when-time"), "");

  // THE PIN, unstated half: the ⋯ menu's accessible name claims the LOGGED time and
  // the sheet opens with the "No eating time recorded" line — never a bare clock
  // wearing the wrong claim.
  const unstated = page.getByTestId(`ledger-serving-${unstatedId}`);
  await unstated.getByRole("button", { name: /serving logged at/ }).click();
  await page.getByTestId(`ledger-serving-correct-${unstatedId}`).click();
  await expect(page.getByTestId("food-correct-modal")).toBeVisible();
  await expect(page.getByTestId("food-correct-provenance")).toContainText(
    /No eating time recorded — logged at \d{2}:\d{2}\./
  );
  await page.getByTestId("food-correct-cancel").click();
  await expect(page.getByTestId("food-correct-modal")).toBeHidden();

  // THE PIN, stated half: the menu names the EATING time and the sheet opens with
  // "Ate at …" — the words "logged at" no longer sit over an eating time.
  const stated = page.getByTestId(`ledger-serving-${statedId}`);
  await stated.getByRole("button", { name: /serving eaten at/ }).click();
  await page.getByTestId(`ledger-serving-correct-${statedId}`).click();
  await expect(page.getByTestId("food-correct-modal")).toBeVisible();
  await expect(page.getByTestId("food-correct-provenance")).toContainText(
    /Ate at \d{2}:\d{2}\./
  );
  await expect(page.getByTestId("food-correct-provenance")).not.toContainText(
    "No eating time recorded"
  );
  await page.getByTestId("food-correct-cancel").click();
  await expect(page.getByTestId("food-correct-modal")).toBeHidden();

  // Leave the fixture as found.
  await removeServingRow(page, statedId);
  await removeServingRow(page, unstatedId);
});
